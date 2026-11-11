import { generateCodeVerifier, generateCodeChallenge, generateState } from '@/lib/oauth/pkce';
import { IS_LITE_STALWART, getLiteInjectedClientId } from '@/lib/lite';
import {
  STALWART_LOOPBACK_REDIRECT_URI,
  readStalwartLoginResponse,
  stalwartClientRegistration,
  stalwartLoginBody,
  type StalwartLoginOutcome,
} from '@/lib/auth/stalwart-login-request';

/**
 * Cookie-free sessions for the static Lite build.
 *
 * The regular build keeps refresh tokens and "remember me" passwords in
 * encrypted cookies written by /api/auth/*. Lite has no server, so it does
 * what Stalwart's own web admin does: authenticate against the mail server's
 * structured login endpoint straight from the browser
 *
 *   POST <server>/api/auth   (password + optional MFA token, PKCE challenge)
 *     -> authorization code
 *   POST <server>/auth/token (grant_type=authorization_code)
 *     -> access token (memory) + refresh token
 *
 * (or, for an account an external OpenID provider signs in, through that
 * provider's redirect flow: lib/auth/lite-oauth.ts)
 *
 * and renew with `grant_type=refresh_token`. The tokens are what persists:
 * localStorage when the user ticked "remember me", sessionStorage (this tab
 * only) otherwise. The current access token is kept beside the refresh token
 * so a reload resumes with it instead of renewing early. Servers without
 * /api/auth (older Stalwart, other JMAP servers) fall back to Basic auth;
 * those sessions can only survive a reload inside the same tab.
 *
 * Neither token is in web storage as text. Each is sealed (AES-GCM) with a
 * key that is created non-extractable and kept in IndexedDB; web storage
 * holds the sealed token and the fields around it (server, user name, client
 * id), which stay readable. The page keeps the tokens it uses in memory and
 * unseals a stored one when it has none, or when another tab stored a newer
 * one. A browser that can't seal (no WebCrypto on a plain http:// address,
 * IndexedDB blocked) keeps the session in the page's memory only.
 *
 * What that does, as LITE-README.md says: what web storage and IndexedDB hold
 * is of no use outside this browser profile, and a script that reads web
 * storage finds no token. A script running on the origin while the profile
 * holds the key can still use the key the way this module does.
 */

/**
 * OAuth client id registered with Stalwart. Mirrors DEFAULT_CLIENT_ID in
 * lib/oauth/token-exchange.ts, which cannot be imported here: that module
 * reads secrets from the filesystem and must stay out of the browser bundle.
 */
export const LITE_CLIENT_ID = 'bulwark-webmail';

/**
 * The client id Lite presents to Stalwart: the `oauthClientId` of the
 * Stalwart `Application` that serves the bundle (injected into the root
 * index.html, see lib/lite.ts) when there is one, else `LITE_CLIENT_ID`.
 */
export function getLiteClientId(): string {
  return getLiteInjectedClientId() || LITE_CLIENT_ID;
}

export type LiteLoginErrorCode =
  | 'endpoint_missing'
  | 'totp_required'
  | 'invalid_credentials'
  | 'login_failed'
  | 'token_exchange_failed'
  | 'refresh_rejected';

export class LiteLoginError extends Error {
  constructor(readonly code: LiteLoginErrorCode, readonly status?: number, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'LiteLoginError';
  }
}

export interface LiteTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string | null;
  /** The client the tokens belong to, when the login chose it; refreshes must present it. */
  clientId?: string;
}

interface StoredRefreshToken {
  serverUrl: string;
  username: string;
  refreshToken: string;
  /** Client the token was issued to; refreshes must present the same one. */
  clientId?: string;
  /**
   * Where the token is renewed when that is not `<serverUrl>/auth/token`: an
   * OAuth sign-in through the external provider Stalwart delegates a domain
   * to (lib/auth/lite-oauth.ts) is refreshed at that provider.
   */
  tokenEndpoint?: string;
  /** RFC 7009 endpoint that revokes the token on sign-out, when discovery named one. */
  revocationEndpoint?: string;
}

interface StoredAccessToken {
  accessToken: string;
  /** Unix seconds. */
  expiresAt: number;
}

/**
 * A token as web storage holds it. `id` is new with every token, so a page can
 * tell whether the token it holds in memory is still the stored one (another
 * tab may have renewed it). `sealed` is the token sealed with the key, and
 * null for the moment between saving and sealing.
 */
interface SealedRecord {
  id: string;
  sealed: string | null;
}

type RefreshRecord = Omit<StoredRefreshToken, 'refreshToken'> & SealedRecord;

/**
 * A slot's token as this page holds it. `pageOnly`: there is no record behind
 * it, because this browser can't seal, so it ends with the page.
 */
interface Held<T> {
  id: string;
  value: T;
  persistent: boolean;
  pageOnly?: boolean;
}

const heldRefresh = new Map<number, Held<StoredRefreshToken>>();
const heldAccess = new Map<number, Held<StoredAccessToken>>();

/** A password (Basic auth) or the access token of a token login (Bearer auth). */
type StoredBasicSession =
  | { serverUrl: string; username: string; password: string; token?: undefined }
  | { serverUrl: string; username: string; token: string; password?: undefined };

const REFRESH_KEY_PREFIX = 'bulwark-lite:refresh:';
const ACCESS_KEY_PREFIX = 'bulwark-lite:access:';
const BASIC_KEY_PREFIX = 'bulwark-lite:basic:';

/**
 * Seconds of life a cached access token needs left to be reused. Mirrors
 * ACCESS_TOKEN_MIN_REMAINING_SECONDS in lib/oauth/tokens.ts, which cannot be
 * imported here (server-only): inside this window the scheduled renewal is
 * due anyway, and providers that gate refresh on `nbf` have opened by then.
 */
const ACCESS_TOKEN_MIN_REMAINING_SECONDS = 60;

function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function storage(kind: 'local' | 'session'): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function readJson<T>(store: Storage | null, key: string): T | null {
  try {
    const raw = store?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Whether the value was written. */
function writeJson(store: Storage | null, key: string, value: unknown): boolean {
  try {
    if (!store) return false;
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Storage full or blocked: the session simply won't survive a reload.
    return false;
  }
}

function remove(store: Storage | null, key: string): void {
  try {
    store?.removeItem(key);
  } catch {
    // ignore
  }
}

/** The slot's record under `prefix`: localStorage (remembered) first, then sessionStorage (this tab). */
function findRecord(prefix: string, slot: number): { record: Record<string, unknown>; persistent: boolean } | null {
  for (const persistent of [true, false]) {
    const record = readJson<unknown>(storage(persistent ? 'local' : 'session'), `${prefix}${slot}`);
    if (record && typeof record === 'object') return { record: record as Record<string, unknown>, persistent };
  }
  return null;
}

function removeRecords(prefix: string, slot: number): void {
  remove(storage('local'), `${prefix}${slot}`);
  remove(storage('session'), `${prefix}${slot}`);
}

/** Slots with a record under `prefix`, in either storage. */
function slotsWithRecords(prefix: string): number[] {
  const slots = new Set<number>();
  for (const kind of ['local', 'session'] as const) {
    const store = storage(kind);
    try {
      for (let i = 0; store && i < store.length; i++) {
        const key = store.key(i);
        if (!key?.startsWith(prefix)) continue;
        const slot = Number(key.slice(prefix.length));
        if (Number.isInteger(slot) && slot >= 0) slots.add(slot);
      }
    } catch {
      // Unreadable storage holds nothing we can use.
    }
  }
  return [...slots];
}

function isSealedRecord(record: Record<string, unknown>): record is Record<string, unknown> & SealedRecord {
  return typeof record.id === 'string' && (record.sealed === null || typeof record.sealed === 'string');
}

/** A refresh token record from before tokens were sealed: the token in plain text. */
function isPlainRefreshRecord(record: Record<string, unknown>): record is Record<string, unknown> & StoredRefreshToken {
  return !isSealedRecord(record) && typeof record.refreshToken === 'string' && record.refreshToken !== '';
}

function refreshFields(record: RefreshRecord): Omit<StoredRefreshToken, 'refreshToken'> {
  const { id: _id, sealed: _sealed, ...fields } = record;
  return fields;
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

const KEY_DB_NAME = 'bulwark-lite-keys';
const KEY_STORE = 'keys';
const TOKEN_KEY_ID = 'tokens';

/** How long a page waits for another tab that is still sealing the token it just stored. */
const SEAL_WAIT_MS = 50;
const SEAL_WAIT_ATTEMPTS = 40;

function canSeal(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && !!indexedDB && typeof crypto !== 'undefined' && !!crypto.subtle;
  } catch {
    return false;
  }
}

// One step at a time, so deleting the key never overtakes a seal or an unseal that came first.
let keyQueue: Promise<unknown> = Promise.resolve();

function inKeyQueue<T>(work: () => Promise<T>): Promise<T> {
  const run = keyQueue.then(work, work);
  keyQueue = run.catch(() => undefined);
  return run;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withKeyDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const open = indexedDB.open(KEY_DB_NAME, 1);
  open.onupgradeneeded = () => {
    if (!open.result.objectStoreNames.contains(KEY_STORE)) open.result.createObjectStore(KEY_STORE);
  };
  const db = await requestResult(open);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/** The sealing key, made on first use when `create`. Not extractable: script can use it here, but not copy it out. */
function tokenKey(create: boolean): Promise<CryptoKey | null> {
  return withKeyDb(async (db) => {
    const found = await requestResult(db.transaction(KEY_STORE, 'readonly').objectStore(KEY_STORE).get(TOKEN_KEY_ID)) as CryptoKey | undefined;
    if (found || !create) return found ?? null;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const store = db.transaction(KEY_STORE, 'readwrite').objectStore(KEY_STORE);
    // Another tab may have made one meanwhile: keep theirs.
    const raced = await requestResult(store.get(TOKEN_KEY_ID)) as CryptoKey | undefined;
    if (raced) return raced;
    await requestResult(store.put(key, TOKEN_KEY_ID));
    return key;
  });
}

function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** `text` sealed with the key (IV first), or null when this browser can't seal. */
function seal(text: string): Promise<string | null> {
  return inKeyQueue(async () => {
    try {
      const key = await tokenKey(true);
      if (!key) return null;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
      const out = new Uint8Array(iv.length + data.length);
      out.set(iv);
      out.set(data, iv.length);
      return toBase64(out);
    } catch {
      return null;
    }
  });
}

/** The text of a sealed token, or null when the key is gone or the data is not ours. */
function unseal(sealed: string): Promise<string | null> {
  return inKeyQueue(async () => {
    try {
      const key = await tokenKey(false);
      if (!key) return null;
      const bytes = fromBase64(sealed);
      return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12)));
    } catch {
      return null;
    }
  });
}

/**
 * Deletes the key once no slot here has a token record left. A tab of another
 * window that keeps its session to itself (no "remember me") can't be seen
 * from here: it keeps its session until it reloads.
 */
function forgetKeyIfUnused(): void {
  if (!canSeal()) return;
  void inKeyQueue(async () => {
    if (slotsWithRecords(REFRESH_KEY_PREFIX).length > 0 || slotsWithRecords(ACCESS_KEY_PREFIX).length > 0) return;
    await new Promise<void>((resolve) => {
      try {
        const request = indexedDB.deleteDatabase(KEY_DB_NAME);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      } catch {
        resolve();
      }
    });
  });
}

function newRecordId(): string {
  const bytes = new Uint8Array(12);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Stores a slot's token: the record without it at once, so the slot is taken
 * and a copy from before is gone, then the sealed token once it is sealed, if
 * the record is still this one. Resolves when that is done. Without sealing,
 * the token stays in this page only.
 */
function storeSealed<T>(
  prefix: string,
  held: Map<number, Held<T>>,
  slot: number,
  value: T,
  secret: string,
  fields: object,
  persistent: boolean,
): Promise<void> {
  const key = `${prefix}${slot}`;
  const store = storage(persistent ? 'local' : 'session');
  const id = newRecordId();
  removeRecords(prefix, slot);
  if (!canSeal() || !writeJson(store, key, { ...fields, id, sealed: null })) {
    held.set(slot, { id, value, persistent, pageOnly: true });
    return Promise.resolve();
  }
  held.set(slot, { id, value, persistent });
  return seal(secret).then((sealed) => {
    const current = readJson<Record<string, unknown>>(store, key);
    if (current?.id !== id) return;
    if (sealed && writeJson(store, key, { ...current, sealed })) return;
    remove(store, key);
    const mine = held.get(slot);
    if (mine?.id === id) mine.pageOnly = true;
  });
}

/** The slot's sealed record, waiting a little while another tab is still sealing it. */
async function readSealedRecord(prefix: string, slot: number): Promise<{ record: Record<string, unknown> & SealedRecord & { sealed: string }; persistent: boolean } | null> {
  for (let attempt = 0; ; attempt++) {
    const found = findRecord(prefix, slot);
    if (!found || !isSealedRecord(found.record)) return null;
    const { record, persistent } = found;
    if (typeof record.sealed === 'string') return { record: { ...record, sealed: record.sealed }, persistent };
    if (attempt >= SEAL_WAIT_ATTEMPTS) return null;
    await new Promise((resolve) => setTimeout(resolve, SEAL_WAIT_MS));
  }
}

/** Whether the slot's stored record is the one `held` came from. */
function holds<T>(held: Held<T> | undefined, record: Record<string, unknown>): held is Held<T> {
  return !!held && !held.pageOnly && held.id === record.id;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

let sweeping = false;

/**
 * Tokens a browser kept in plain form before they were sealed: sealed on the
 * first read, the plain copies removed at once, so the user stays signed in.
 */
function sealPlainTokens(): void {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const slot of slotsWithRecords(REFRESH_KEY_PREFIX)) readLiteRefreshToken(slot);
    for (const slot of slotsWithRecords(ACCESS_KEY_PREFIX)) readLiteAccessToken(slot);
  } finally {
    sweeping = false;
  }
}

/**
 * Persists a refresh token for an account slot. `persistent` (remember me)
 * survives browser restarts; otherwise the token lives with the tab.
 */
export function saveLiteRefreshToken(
  slot: number,
  entry: StoredRefreshToken,
  persistent: boolean,
): void {
  void storeRefreshToken(slot, entry, persistent);
}

function storeRefreshToken(slot: number, entry: StoredRefreshToken, persistent: boolean): Promise<void> {
  const value = { ...entry, serverUrl: trimUrl(entry.serverUrl) };
  const { refreshToken, ...fields } = value;
  return storeSealed(REFRESH_KEY_PREFIX, heldRefresh, slot, value, refreshToken, fields, persistent);
}

/**
 * The slot's refresh token, when this page holds the stored one: it saved or
 * unsealed it. Null otherwise, including for a token another tab stored that
 * this page has not unsealed yet (liteRefreshTokens does that).
 */
export function readLiteRefreshToken(slot: number): StoredRefreshToken | null {
  sealPlainTokens();
  const found = findRecord(REFRESH_KEY_PREFIX, slot);
  const held = heldRefresh.get(slot);
  if (!found) return held?.pageOnly ? held.value : null;
  const { record, persistent } = found;
  if (isPlainRefreshRecord(record)) {
    const { serverUrl, username, refreshToken, clientId, tokenEndpoint, revocationEndpoint } = record;
    const entry: StoredRefreshToken = {
      serverUrl, username, refreshToken,
      ...(clientId !== undefined ? { clientId } : {}),
      ...(tokenEndpoint !== undefined ? { tokenEndpoint } : {}),
      ...(revocationEndpoint !== undefined ? { revocationEndpoint } : {}),
    };
    void storeRefreshToken(slot, entry, persistent);
    return heldRefresh.get(slot)?.value ?? entry;
  }
  if (!isSealedRecord(record) || !holds(held, record)) return null;
  return { ...refreshFields(record as unknown as RefreshRecord), refreshToken: held.value.refreshToken };
}

/**
 * How the slot's account signed in, from the readable fields of its record:
 * an OAuth sign-in (lib/auth/lite-oauth.ts) records the endpoint its token is
 * renewed at, a password sign-in at Stalwart's own login does not. Both end
 * as a token session, so the auth store calls either one `oauth`. Null when
 * the slot holds no refresh token.
 */
export function liteSignInMethod(slot: number): 'password' | 'oauth' | null {
  const found = findRecord(REFRESH_KEY_PREFIX, slot);
  const held = heldRefresh.get(slot);
  const fields: Record<string, unknown> | undefined = found?.record ?? (held?.pageOnly ? { ...held.value } : undefined);
  if (!fields) return null;
  return typeof fields.tokenEndpoint === 'string' && fields.tokenEndpoint ? 'oauth' : 'password';
}

/** {@link readLiteRefreshToken}, unsealing the stored token when this page doesn't hold it. */
async function loadLiteRefreshToken(slot: number): Promise<StoredRefreshToken | null> {
  const known = readLiteRefreshToken(slot);
  if (known) return known;
  const found = await readSealedRecord(REFRESH_KEY_PREFIX, slot);
  if (!found) return null;
  const token = await unseal(found.record.sealed);
  if (!token) return null;
  const entry = { ...refreshFields(found.record as unknown as RefreshRecord), refreshToken: token };
  const now = findRecord(REFRESH_KEY_PREFIX, slot);
  if (now && now.record.id === found.record.id) heldRefresh.set(slot, { id: found.record.id, value: entry, persistent: now.persistent });
  return entry;
}

/**
 * The slot's refresh token for a sign-out or a replacement: what this page
 * holds, a token from before sealing, or the stored one unsealed. Read before
 * the slot is cleared, so the unsealing is queued before the key can go.
 */
function takeLiteRefreshToken(slot: number): Promise<StoredRefreshToken | null> {
  const found = findRecord(REFRESH_KEY_PREFIX, slot);
  const held = heldRefresh.get(slot);
  if (!found) return Promise.resolve(held?.pageOnly ? held.value : null);
  const { record } = found;
  if (isPlainRefreshRecord(record)) return Promise.resolve(record);
  if (!isSealedRecord(record)) return Promise.resolve(null);
  const fields = refreshFields(record as unknown as RefreshRecord);
  if (holds(held, record)) return Promise.resolve({ ...fields, refreshToken: held.value.refreshToken });
  if (typeof record.sealed !== 'string') return Promise.resolve(null);
  return unseal(record.sealed).then((token) => (token ? { ...fields, refreshToken: token } : null));
}

/** Where the slot's refresh token currently lives, so a rotation stays put. */
function refreshTokenIsPersistent(slot: number): boolean {
  const found = findRecord(REFRESH_KEY_PREFIX, slot);
  return found ? found.persistent : heldRefresh.get(slot)?.persistent ?? false;
}

/**
 * Records whose refresh token the slot holds. An OAuth sign-in stores the
 * token before it knows the account: only the JMAP session names it. The
 * name is one of the readable fields, so the sealed token stays as it is.
 */
export function nameLiteRefreshToken(slot: number, username: string): void {
  readLiteRefreshToken(slot);
  const found = findRecord(REFRESH_KEY_PREFIX, slot);
  const held = heldRefresh.get(slot);
  if (!found) {
    if (held?.pageOnly) held.value = { ...held.value, username };
    return;
  }
  const { record, persistent } = found;
  if (!isSealedRecord(record)) return;
  if (record.username !== username) writeJson(storage(persistent ? 'local' : 'session'), `${REFRESH_KEY_PREFIX}${slot}`, { ...record, username });
  if (holds(held, record)) held.value = { ...held.value, username };
}

/** Forgets the slot's refresh token and the access token cached beside it. */
export function clearLiteRefreshToken(slot: number): void {
  removeRecords(REFRESH_KEY_PREFIX, slot);
  removeRecords(ACCESS_KEY_PREFIX, slot);
  heldRefresh.delete(slot);
  heldAccess.delete(slot);
  forgetKeyIfUnused();
}

/**
 * Caches the slot's current access token, so a reload resumes with it rather
 * than spending the refresh token. Providers that stamp refresh tokens with
 * `nbf` (Rauthy: iat + access token lifetime - 60s) refuse an early renewal,
 * and a refused renewal ends the session (#552). `persistent` follows the
 * refresh token: a remembered session reopened in a new tab needs it too.
 * Stored sealed like the refresh token; this page keeps it in memory.
 */
export function saveLiteAccessToken(slot: number, accessToken: string, expiresIn: number, persistent: boolean): void {
  void storeAccessToken(slot, accessToken, expiresIn, persistent);
}

function storeAccessToken(slot: number, accessToken: string, expiresIn: number, persistent: boolean): Promise<void> {
  const value: StoredAccessToken = { accessToken, expiresAt: Math.floor(Date.now() / 1000) + expiresIn };
  return storeSealed(ACCESS_KEY_PREFIX, heldAccess, slot, value, accessToken, { expiresAt: value.expiresAt }, persistent);
}

function usableAccessToken(entry: Partial<StoredAccessToken> | null | undefined): { accessToken: string; expiresIn: number } | null {
  if (!entry || typeof entry.accessToken !== 'string' || !entry.accessToken || typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt)) return null;
  const expiresIn = entry.expiresAt - Math.floor(Date.now() / 1000);
  return expiresIn >= ACCESS_TOKEN_MIN_REMAINING_SECONDS ? { accessToken: entry.accessToken, expiresIn } : null;
}

/**
 * The slot's cached access token, while it has more than a minute to live and
 * this page holds the stored one. A token another tab stored is unsealed by
 * liteRefreshTokens.
 */
export function readLiteAccessToken(slot: number): { accessToken: string; expiresIn: number } | null {
  sealPlainTokens();
  const found = findRecord(ACCESS_KEY_PREFIX, slot);
  const held = heldAccess.get(slot);
  if (!found) return usableAccessToken(held?.pageOnly ? held.value : null);
  const { record, persistent } = found;
  if (!isSealedRecord(record)) {
    // From before sealing: the plain copy goes now, a token with life left is sealed.
    removeRecords(ACCESS_KEY_PREFIX, slot);
    const plain = usableAccessToken(record as Partial<StoredAccessToken>);
    if (plain) void storeAccessToken(slot, plain.accessToken, plain.expiresIn, persistent);
    return plain;
  }
  return usableAccessToken(holds(held, record) ? held.value : null);
}

/**
 * A stored access token this page doesn't hold yet, unsealed: after a reload,
 * or when another tab has just renewed. Null when this page already holds the
 * stored one, so a renewal it asks for goes ahead.
 */
async function adoptStoredAccessToken(slot: number): Promise<{ accessToken: string; expiresIn: number } | null> {
  const found = await readSealedRecord(ACCESS_KEY_PREFIX, slot);
  if (!found || holds(heldAccess.get(slot), found.record)) return null;
  const expiresAt = found.record.expiresAt;
  if (!usableAccessToken({ accessToken: '-', expiresAt: expiresAt as number })) return null;
  const token = await unseal(found.record.sealed);
  if (!token) return null;
  const value: StoredAccessToken = { accessToken: token, expiresAt: expiresAt as number };
  const now = findRecord(ACCESS_KEY_PREFIX, slot);
  if (now && now.record.id === found.record.id) heldAccess.set(slot, { id: found.record.id, value, persistent: now.persistent });
  return usableAccessToken(value);
}

/**
 * Basic-auth fallback for servers without token login, and access-token
 * logins: the credentials stay with this tab (sessionStorage) so a reload
 * does not end the session.
 */
export function saveLiteBasicSession(slot: number, entry: StoredBasicSession): void {
  writeJson(storage('session'), `${BASIC_KEY_PREFIX}${slot}`, { ...entry, serverUrl: trimUrl(entry.serverUrl) });
}

export function readLiteBasicSession(slot: number): StoredBasicSession | null {
  const entry = readJson<StoredBasicSession>(storage('session'), `${BASIC_KEY_PREFIX}${slot}`);
  return entry && (typeof entry.password === 'string' || typeof entry.token === 'string') ? entry : null;
}

export function clearLiteBasicSession(slot: number): void {
  remove(storage('session'), `${BASIC_KEY_PREFIX}${slot}`);
}

export function clearLiteSlot(slot: number): void {
  clearLiteRefreshToken(slot);
  clearLiteBasicSession(slot);
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

// Sign-out waits for this, so an unresponsive endpoint must not hold it up.
const REVOCATION_TIMEOUT_MS = 3000;

/** The revocation endpoint a Stalwart server advertises, if any. */
async function discoverRevocationEndpoint(serverUrl: string): Promise<string | null> {
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
    try {
      const response = await fetch(`${serverUrl}${path}`, { signal: AbortSignal.timeout(REVOCATION_TIMEOUT_MS) });
      if (!response.ok) continue;
      const endpoint = ((await response.json()) as { revocation_endpoint?: unknown }).revocation_endpoint;
      return typeof endpoint === 'string' && /^https?:\/\//.test(endpoint) ? endpoint : null;
    } catch {
      // Try the next document.
    }
  }
  return null;
}

async function revokeRefreshToken(entry: StoredRefreshToken): Promise<void> {
  // A token from an external provider is only revoked where its own
  // discovery said; Stalwart's own tokens can be looked up.
  const endpoint = entry.revocationEndpoint
    ?? (entry.tokenEndpoint ? null : await discoverRevocationEndpoint(trimUrl(entry.serverUrl)));
  if (!endpoint) return;
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: entry.refreshToken,
        token_type_hint: 'refresh_token',
        client_id: entry.clientId || getLiteClientId(),
      }).toString(),
      signal: AbortSignal.timeout(REVOCATION_TIMEOUT_MS),
      // Finishes even when sign-out navigates away first.
      keepalive: true,
      redirect: 'error',
    });
  } catch {
    // Best effort: the token is gone from this browser either way.
  }
}

/**
 * Sign a slot out: forget its credentials at once, then revoke its refresh
 * token so a copy taken from this browser's storage stops working too.
 * `revoke: false` (config.json `oauthRevokeOnSignOut`) only forgets it, so
 * Stalwart 1.0 keeps the consent for the next sign-in (#1388).
 */
export async function revokeLiteSlot(slot: number, revoke = true): Promise<void> {
  const taken = takeLiteRefreshToken(slot);
  clearLiteSlot(slot);
  const entry = await taken;
  if (entry && revoke) await revokeRefreshToken(entry);
}

/**
 * Stalwart's own token rather than one from an external provider it hands the
 * sign-in to. Stalwart's endpoints are moved onto the server's origin when
 * they are discovered (lib/auth/lite-oauth.ts), and a password sign-in stores
 * no endpoint at all.
 */
function isStalwartToken(entry: StoredRefreshToken): boolean {
  if (!entry.tokenEndpoint) return true;
  try {
    return new URL(entry.tokenEndpoint).origin === new URL(trimUrl(entry.serverUrl)).origin;
  } catch {
    return false;
  }
}

/**
 * Revokes a refresh token no account will use again, so it doesn't stay on
 * the server as one more connected app until it expires (#1571). Only
 * Stalwart's own tokens: there every sign-in is a grant of its own, and while
 * one is left the next sign-in needs no consent. An external provider may tie
 * the old and the new token to one session and end both.
 */
function retireRefreshToken(entry: StoredRefreshToken | null, revoke: boolean, keep?: string): Promise<void> {
  if (!entry || !revoke || entry.refreshToken === keep || !isStalwartToken(entry)) return Promise.resolve();
  return revokeRefreshToken(entry);
}

/**
 * {@link saveLiteRefreshToken} for a new sign-in: the token the slot held
 * before (the same account signing in again) is revoked. `revoke` is
 * config.json `oauthRevokeOnSignOut`.
 */
export async function replaceLiteRefreshToken(
  slot: number,
  entry: StoredRefreshToken,
  persistent: boolean,
  revoke: boolean,
): Promise<void> {
  const previous = takeLiteRefreshToken(slot);
  const stored = storeRefreshToken(slot, entry, persistent);
  const [replaced] = await Promise.all([previous, stored]);
  return retireRefreshToken(replaced, revoke, entry.refreshToken);
}

/** {@link clearLiteRefreshToken}, revoking the token it forgets. */
export function retireLiteRefreshToken(slot: number, revoke: boolean): Promise<void> {
  const previous = takeLiteRefreshToken(slot);
  clearLiteRefreshToken(slot);
  return previous.then((entry) => retireRefreshToken(entry, revoke));
}

/** {@link clearLiteSlot} for a slot no account holds any more, revoking its token. */
export function retireLiteSlot(slot: number, revoke: boolean): Promise<void> {
  const previous = takeLiteRefreshToken(slot);
  clearLiteSlot(slot);
  return previous.then((entry) => retireRefreshToken(entry, revoke));
}

/** {@link revokeLiteSlot} for every slot. */
export async function revokeAllLiteSessions(revoke = true): Promise<void> {
  const slots = new Set([...slotsWithRecords(REFRESH_KEY_PREFIX), ...heldRefresh.keys()]);
  const taken = [...slots].map(takeLiteRefreshToken);
  clearAllLiteSessions();
  const entries = (await Promise.all(taken)).filter((entry): entry is StoredRefreshToken => entry !== null);
  if (revoke) await Promise.all(entries.map(revokeRefreshToken));
}

export function clearAllLiteSessions(): void {
  for (const kind of ['local', 'session'] as const) {
    const store = storage(kind);
    if (!store) continue;
    const keys: string[] = [];
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key && [REFRESH_KEY_PREFIX, ACCESS_KEY_PREFIX, BASIC_KEY_PREFIX].some((prefix) => key.startsWith(prefix))) keys.push(key);
      }
    } catch {
      continue;
    }
    keys.forEach((key) => remove(store, key));
  }
  heldRefresh.clear();
  heldAccess.clear();
  forgetKeyIfUnused();
}

// ---------------------------------------------------------------------------
// Stalwart endpoints
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
}

interface LiteLoginClient {
  clientId: string;
  redirectUri: string;
}

/**
 * Clients this page registered at a Stalwart 1.0 that knows no client by the
 * default name, per server. Registering again would return the same id.
 */
const registeredClients = new Map<string, string>();

/** Test hook. */
export function resetLiteRegisteredClients(): void {
  registeredClients.clear();
}

async function registerLiteClient(base: string): Promise<string | null> {
  try {
    const response = await fetch(`${base}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stalwartClientRegistration()),
    });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => ({}))) as { client_id?: unknown };
    if (typeof body.client_id !== 'string' || !body.client_id) return null;
    registeredClients.set(base, body.client_id);
    return body.client_id;
  } catch {
    return null;
  }
}

/** POST /api/auth for an authorization code. */
async function requestLiteLoginCode(
  base: string,
  params: { username: string; password: string; totp?: string },
  client: LiteLoginClient,
  challenge: string,
): Promise<StalwartLoginOutcome> {
  const state = generateState();
  const loginResponse = await fetch(`${base}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(stalwartLoginBody({
      username: params.username,
      password: params.password,
      totp: params.totp,
      clientId: client.clientId,
      redirectUri: client.redirectUri,
      codeChallenge: challenge,
      state,
    })),
  });

  if (!loginResponse.ok) {
    if (loginResponse.status === 404 || loginResponse.status === 405 || loginResponse.status === 501) {
      throw new LiteLoginError('endpoint_missing', loginResponse.status);
    }
    const detail = (await loginResponse.text().catch(() => '')).slice(0, 200);
    throw new LiteLoginError('login_failed', loginResponse.status, detail);
  }
  return readStalwartLoginResponse(await loginResponse.json().catch(() => ({})), state);
}

/**
 * Password (+ optional TOTP) login against Stalwart's structured endpoint.
 * Mirrors app/api/auth/totp-token-exchange/route.ts, minus the server hop:
 * like it, the login registers a client of its own at a Stalwart 1.0 that
 * knows none by the default name.
 */
export async function liteTokenLogin(params: {
  serverUrl: string;
  username: string;
  password: string;
  totp?: string;
  redirectUri: string;
  clientId?: string;
}): Promise<LiteTokens> {
  const base = trimUrl(params.serverUrl);
  const explicitClientId = params.clientId || getLiteInjectedClientId();
  const registered = explicitClientId ? undefined : registeredClients.get(base);
  let client: LiteLoginClient = registered
    ? { clientId: registered, redirectUri: STALWART_LOOPBACK_REDIRECT_URI }
    : { clientId: explicitClientId || LITE_CLIENT_ID, redirectUri: params.redirectUri };
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);

  let login = await requestLiteLoginCode(base, params, client, challenge);
  // Stalwart 1.0 checks the client before the credentials, so the first
  // attempt costs no failed sign-in.
  if (login.kind === 'rejected' && login.error === 'invalid_client' && !explicitClientId && !registered) {
    const clientId = await registerLiteClient(base);
    if (clientId) {
      client = { clientId, redirectUri: STALWART_LOOPBACK_REDIRECT_URI };
      login = await requestLiteLoginCode(base, params, client, challenge);
    }
  }
  switch (login.kind) {
    case 'code':
      break;
    case 'mfa_required':
      throw new LiteLoginError('totp_required', 401);
    case 'invalid_credentials':
      throw new LiteLoginError('invalid_credentials', 401);
    case 'rejected':
      throw new LiteLoginError('login_failed', 400, [login.error, login.description].filter(Boolean).join(': '));
  }

  const tokenResponse = await fetch(`${base}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: login.code,
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      code_verifier: verifier,
    }).toString(),
  });
  const tokens = (await tokenResponse.json().catch(() => ({}))) as TokenResponse;
  if (!tokenResponse.ok || !tokens.access_token) {
    throw new LiteLoginError('token_exchange_failed', tokenResponse.status, tokens.error);
  }
  return {
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in || 3600,
    refreshToken: tokens.refresh_token ?? null,
    clientId: client.clientId,
  };
}

/**
 * Second half of the OAuth redirect flow (lib/auth/lite-oauth.ts): trades the
 * authorization code for tokens at the endpoint discovery named, which is
 * Stalwart's own `/auth/token` or the external provider's. Mirrors the POST
 * branch of app/api/auth/token/route.ts, minus the server hop; a public
 * client, so PKCE stands in for the secret.
 */
export async function liteExchangeAuthorizationCode(params: {
  tokenEndpoint: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
}): Promise<LiteTokens> {
  const response = await fetch(params.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      client_id: params.clientId,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    }).toString(),
  });
  const tokens = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !tokens.access_token) {
    throw new LiteLoginError('token_exchange_failed', response.status, tokens.error);
  }
  return {
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in || 3600,
    refreshToken: tokens.refresh_token ?? null,
  };
}

/**
 * Renews the slot's access token. A rejected refresh token clears the slot and
 * throws `refresh_rejected`; a network failure or 5xx propagates untouched so
 * callers treat it as an outage, not a sign-out.
 */
export async function liteRefreshTokens(slot: number, clientIdOverride?: string): Promise<LiteTokens> {
  const stored = await loadLiteRefreshToken(slot);
  if (!stored) throw new LiteLoginError('refresh_rejected', 401, 'no refresh token');
  // A reload starts with no access token in memory, and another tab may have
  // renewed a moment ago: a stored token this page has not used yet saves a
  // renewal, which a provider can refuse this soon (#552).
  const adopted = await adoptStoredAccessToken(slot);
  if (adopted) return { accessToken: adopted.accessToken, expiresIn: adopted.expiresIn, refreshToken: stored.refreshToken };
  const clientId = clientIdOverride || stored.clientId || getLiteClientId();

  const response = await fetch(stored.tokenEndpoint || `${stored.serverUrl}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
      client_id: clientId,
    }).toString(),
  });

  // Only a definitive refusal (400/401/403) ends the session, as in the
  // server build. A rate limit (429), a request timeout (408) or a 5xx is an
  // outage: the refresh token stays, so the session resumes once the server
  // answers again.
  const refused = response.status === 400 || response.status === 401 || response.status === 403;
  if (!response.ok && !refused) {
    throw new LiteLoginError('token_exchange_failed', response.status);
  }
  const tokens = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !tokens.access_token) {
    clearLiteRefreshToken(slot);
    throw new LiteLoginError('refresh_rejected', response.status || 401, tokens.error);
  }
  const persistent = refreshTokenIsPersistent(slot);
  const expiresIn = tokens.expires_in || 3600;
  const writes = [storeAccessToken(slot, tokens.access_token, expiresIn, persistent)];
  if (tokens.refresh_token && tokens.refresh_token !== stored.refreshToken) {
    writes.push(storeRefreshToken(slot, { ...stored, refreshToken: tokens.refresh_token }, persistent));
  }
  // Stored before the renewal lock is let go, so the next tab finds the new tokens.
  await Promise.all(writes);
  return {
    accessToken: tokens.access_token,
    expiresIn,
    refreshToken: tokens.refresh_token ?? stored.refreshToken,
  };
}

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

const probeCache = new Map<string, Promise<boolean | null>>();

/**
 * Whether `serverUrl` exposes Stalwart's structured login (and therefore
 * "remember me" across browser restarts). `null` means the probe could not
 * tell (unreachable, CORS blocked) - callers then attempt token login anyway
 * and fall back on `endpoint_missing`.
 */
export function probeLiteTokenLogin(serverUrl: string): Promise<boolean | null> {
  const base = trimUrl(serverUrl);
  if (!/^https?:\/\//.test(base)) return Promise.resolve(false);
  // Served by Stalwart itself (an Application bundle, 0.16+): the page's own
  // origin has /api/auth. Probing would only log a 400 for the empty body.
  if (IS_LITE_STALWART && typeof window !== 'undefined' && base === window.location.origin) return Promise.resolve(true);
  let pending = probeCache.get(base);
  if (!pending) {
    pending = fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
      .then((res) => !(res.status === 404 || res.status === 405 || res.status === 501))
      .catch(() => null);
    probeCache.set(base, pending);
  }
  return pending;
}

/** Test hook. */
export function resetLiteProbeCache(): void {
  probeCache.clear();
}

/** Test hook: resolves once every token store, seal and unseal started so far is done. */
export async function settleLiteTokenStorage(): Promise<void> {
  await inKeyQueue(async () => undefined);
}

/** Test hook: forgets the tokens this page holds in memory, as a reload does. */
export function forgetLiteTokenMemory(): void {
  heldRefresh.clear();
  heldAccess.clear();
}
