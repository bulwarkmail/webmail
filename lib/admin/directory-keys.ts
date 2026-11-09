// Checks the extension directory's signature on a marketplace bundle before
// it is installed.
//
// The directory signs a release statement for every approved bundle with an
// online key (headers X-Bundle-Statement, X-Bundle-Signature,
// X-Bundle-Signature-Key). Its online keys are listed in a keyring at
// /api/v2/keys, signed by an offline root key. The root keys are pinned
// here for the official directory; a self-hosted directory configures its
// own (extensionDirectoryRootKeys). Rotating the online key needs no
// webmail release; only a new root key does.
//
// With root keys known, an unsigned or badly signed bundle is refused. With
// none (a custom directory that set none), bundles install as before.
import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { canonicalJson } from '@/lib/extension-package';
import { isStoreUnavailableError } from '@/lib/shared-store';
import { DIRECTORY_KEYRINGS_ID, directoryKeyringDocs } from './extension-store';

export const OFFICIAL_DIRECTORY = 'https://extensions.bulwarkmail.org';

/** keyId (first 16 hex of SHA-256 of the raw key) -> raw Ed25519 public key, base64. */
export const PINNED_ROOT_KEYS: Readonly<Record<string, string>> = {
  bfcd5e1fcf810a7d: 'SyGlNKHBY4T7Z7BmDP80G8Eh58yn6W32SpKUHpRzHk4=',
};

const STATEMENT_TYPE = 'https://extensions.bulwarkmail.org/release/v1';
const KEYRING_TYPE = 'https://extensions.bulwarkmail.org/keyring/v1';
const KEYRING_TTL_MS = 10 * 60_000;

export function keyIdOf(raw: Uint8Array): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function publicKey(rawB64: string) {
  const raw = Buffer.from(rawB64, 'base64');
  if (raw.length !== 32) throw new Error('not an Ed25519 public key');
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
}

function ed25519Verify(rawPublicB64: string, data: string, signatureB64: string): boolean {
  try {
    return nodeVerify(null, Buffer.from(data, 'utf8'), publicKey(rawPublicB64), Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

/** Root keys for a directory: the pinned ones for the official directory, plus configured ones. */
export function rootKeysFor(directoryUrl: string, configured: string | undefined | null): Record<string, string> {
  const keys: Record<string, string> = {};
  if (new URL(directoryUrl).origin === OFFICIAL_DIRECTORY) Object.assign(keys, PINNED_ROOT_KEYS);
  for (const part of (configured ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const raw = Buffer.from(part, 'base64');
    if (raw.length === 32) keys[keyIdOf(raw)] = part;
  }
  return keys;
}

interface KeyringKey { keyId: string; publicKey: string; status: 'active' | 'retired' | 'revoked' }
interface Keyring { _type: string; rootKeyId: string; issuedAt: string; keys: KeyringKey[]; signature: string }

export function verifyKeyring(doc: Keyring, rootKeys: Record<string, string>): boolean {
  if (!doc || doc._type !== KEYRING_TYPE || typeof doc.signature !== 'string') return false;
  const root = rootKeys[doc.rootKeyId];
  if (!root) return false;
  const { signature, ...body } = doc;
  return ed25519Verify(root, canonicalJson(body), signature);
}

// Per replica and per module copy, for up to KEYRING_TTL_MS (10 min): a key
// the directory revokes still verifies here for that long, on each replica.
// The anti-rollback dates below are shared by every replica.
const keyringCache = new Map<string, { at: number; keys: KeyringKey[] }>();

/** Clears cached keyrings (tests, and after a directory rotates its key). */
export function clearKeyringCache(): void {
  keyringCache.clear();
}

async function onlineKeys(directoryUrl: string, rootKeys: Record<string, string>, fetchImpl: typeof fetch): Promise<KeyringKey[]> {
  const origin = new URL(directoryUrl).origin;
  const cached = keyringCache.get(origin);
  if (cached && Date.now() - cached.at < KEYRING_TTL_MS) return cached.keys;
  const res = await fetchImpl(new URL('/api/v2/keys', directoryUrl).toString(), { signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`the directory's keyring could not be loaded (${res.status})`);
  const doc = (await res.json()) as Keyring;
  if (!verifyKeyring(doc, rootKeys)) throw new Error("the directory's keyring is not signed by a trusted root key");
  await assertKeyringIsCurrent(origin, doc.issuedAt);
  keyringCache.set(origin, { at: Date.now(), keys: doc.keys });
  return doc.keys;
}

/**
 * A root-signed keyring stays valid forever on its own, so whoever controls
 * the directory host (or the path to it) could serve an old one in which a
 * since-revoked online key is still active, and sign bundles with that
 * leaked key. The newest `issuedAt` seen per directory is kept in the admin
 * state (S/directory-keyrings.json, or the shared store: one record for
 * every replica); an older keyring is refused. Checked and recorded in one
 * update, so two installs at once can't put an older date back.
 *
 * A record that can't be read (a broken file, a read error, the shared
 * store down) refuses the keyring: treating it as empty would let exactly
 * the replay through that it exists to stop.
 */
async function assertKeyringIsCurrent(origin: string, issuedAt: string): Promise<void> {
  const issued = Date.parse(issuedAt);
  if (!Number.isFinite(issued)) throw new Error("the directory's keyring has no valid issue date");
  await directoryKeyringDocs().update(DIRECTORY_KEYRINGS_ID, (current) => {
    const seen = current ? parseSeen(current) : {};
    const previous = Date.parse(seen[origin] ?? '');
    if (Number.isFinite(previous) && issued < previous) {
      throw new Error(`the directory's keyring (issued ${issuedAt}) is older than the one seen before (${seen[origin]})`);
    }
    if (Number.isFinite(previous) && issued === previous) return undefined;
    return JSON.stringify({ ...seen, [origin]: new Date(issued).toISOString() });
  });
}

function parseSeen(data: Buffer): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString('utf-8'));
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('the keyring dates recorded before could not be read');
  }
  return parsed as Record<string, string>;
}

export type SignatureCheck =
  | { status: 'verified'; keyId: string; commit: string | null; repo: string | null }
  | { status: 'unsigned' }
  | { status: 'invalid'; reason: string };

/**
 * Check the signature headers of a bundle downloaded from the directory.
 * `required` is true when root keys are known for this directory.
 */
export async function checkBundleSignature(opts: {
  directoryUrl: string;
  configuredRootKeys?: string | null;
  slug: string;
  version: string;
  kind: 'plugin' | 'theme';
  bytes: ArrayBuffer | Uint8Array;
  headers: Headers;
  fetchImpl?: typeof fetch;
}): Promise<SignatureCheck> {
  const rootKeys = rootKeysFor(opts.directoryUrl, opts.configuredRootKeys);
  const required = Object.keys(rootKeys).length > 0;
  const statementB64 = opts.headers.get('x-bundle-statement');
  const signature = opts.headers.get('x-bundle-signature');
  const keyId = opts.headers.get('x-bundle-signature-key');
  if (!statementB64 || !signature || !keyId) {
    return required ? { status: 'invalid', reason: 'the bundle is not signed by the directory' } : { status: 'unsigned' };
  }
  if (!required) return { status: 'unsigned' };

  let statement: { _type?: string; slug?: string; version?: string; kind?: string; bundle?: { sha256?: string; size?: number }; source?: { repo?: string; commit?: string | null } };
  let statementText: string;
  try {
    statementText = Buffer.from(statementB64, 'base64').toString('utf8');
    statement = JSON.parse(statementText);
  } catch {
    return { status: 'invalid', reason: 'the signature statement is unreadable' };
  }
  if (statement._type !== STATEMENT_TYPE) return { status: 'invalid', reason: 'unknown signature statement' };
  // The statement must be the canonical form the directory signed.
  if (canonicalJson(statement) !== statementText) return { status: 'invalid', reason: 'the signature statement is not canonical' };

  let keys: KeyringKey[];
  try {
    keys = await onlineKeys(opts.directoryUrl, rootKeys, opts.fetchImpl ?? fetch);
  } catch (err) {
    // The shared store being down says nothing about the bundle: the
    // install answers 503 instead of calling it badly signed.
    if (isStoreUnavailableError(err)) throw err;
    return { status: 'invalid', reason: err instanceof Error ? err.message : String(err) };
  }
  const key = keys.find((k) => k.keyId === keyId);
  if (!key) return { status: 'invalid', reason: `signed with an unknown key (${keyId})` };
  if (key.status === 'revoked') return { status: 'invalid', reason: `signed with a revoked key (${keyId})` };
  if (!ed25519Verify(key.publicKey, statementText, signature)) return { status: 'invalid', reason: 'the signature does not match' };

  const bytes = opts.bytes instanceof Uint8Array ? opts.bytes : new Uint8Array(opts.bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (statement.bundle?.sha256 !== sha256 || statement.bundle?.size !== bytes.byteLength) {
    return { status: 'invalid', reason: 'the downloaded bundle is not the one the directory signed' };
  }
  if (statement.slug !== opts.slug || statement.version !== opts.version || statement.kind !== opts.kind) {
    return { status: 'invalid', reason: `the signature is for ${statement.slug} ${statement.version}, not ${opts.slug} ${opts.version}` };
  }
  return { status: 'verified', keyId, commit: statement.source?.commit ?? null, repo: statement.source?.repo ?? null };
}
