import { randomBytes } from 'crypto';

// Cross-device login pairing ("Link mobile app"). A signed-in desktop proves
// who it is again (password + TOTP, or a fresh IdP login), which mints a
// *grant*: sign-in material for the phone that is independent of the
// desktop's own session. /api/auth/pair/create then issues a short-lived,
// single-use *code* for that grant, rendered as a QR. The app scans it and
// redeems the code at /api/auth/pair/redeem for the grant. The code itself
// carries no secrets; the grant never leaves the server until its code is
// redeemed, exactly once.
//
// A grant outlives a single code (the desktop may show a new QR after the
// first one expired without asking for the password again), but it is handed
// out at most once: redeeming any of its codes consumes it and invalidates
// the others.
//
// Records are kept after they stop being usable, as tombstones without their
// secrets, so a late scan can be told "already used" rather than "expired",
// and the desktop can poll whether its code was redeemed.
//
// Storage is an in-process Map, pinned on globalThis so dev HMR and duplicate
// module evaluation (route bundles) share one instance. That is sufficient for
// the single-instance deployments this webmail targets; a multi-instance
// deployment needs sticky sessions or a shared store keyed the same way.

export type PairingGrant =
  | {
      flow: 'oauth';
      /** JMAP server the phone connects to. */
      serverUrl: string;
      /** Server entry the grant was minted against, for the refresh proxy. */
      serverId: string | null;
      accessToken: string;
      refreshToken?: string;
      /** Access token lifetime in seconds, counted from `issuedAt`. */
      expiresIn?: number;
      issuedAt: number;
      /** The token endpoint that minted the grant (never a proxy URL). */
      tokenEndpoint: string;
      clientId: string;
      /** Refreshing needs a client secret the phone must not have. */
      confidential: boolean;
      /** The token endpoint belongs to an admin-configured server or issuer. */
      trusted: boolean;
    }
  | {
      flow: 'password';
      serverUrl: string;
      username: string;
      /** An app password minted for the phone, or the account password. */
      password: string;
      credential: 'app-password' | 'account-password';
      /** The app password's id, to delete it if the phone never picks it up. */
      appPasswordId?: string;
      /** The server is admin-configured (else: rebinding-safe fetch). */
      trusted?: boolean;
    };

export type PairingStatus = 'pending' | 'redeemed' | 'expired' | 'unknown';

export type RedeemResult =
  | { ok: true; grant: PairingGrant; webmailBase: string | null }
  | { ok: false; reason: 'invalid' | 'expired' | 'used' };

/** How long a grant stays available for new codes after the step-up. */
export const GRANT_TTL_MS = 5 * 60 * 1000;
/** How long one code can be scanned. */
export const CODE_TTL_MS = 2 * 60 * 1000;
/** How long spent records are remembered, for status polls and late scans. */
const TOMBSTONE_MS = 10 * 60 * 1000;
const CODE_BYTES = 32; // 256 bits of entropy
const ID_BYTES = 16;
/** Replaced codes kept per grant (for "expired" answers); older ones are forgotten. */
const SUPERSEDED_KEPT = 3;

interface GrantRecord {
  grant: PairingGrant | null; // null once consumed or expired
  expiresAt: number;
  /** Which signed-in account the step-up was for: `<slot>:<username>`. */
  owner: string;
  forgetAt: number;
}

interface CodeRecord {
  grantId: string;
  statusId: string;
  webmailBase: string | null;
  expiresAt: number;
  state: 'pending' | 'redeemed' | 'superseded';
  forgetAt: number;
}

interface Store {
  grants: Map<string, GrantRecord>;
  codes: Map<string, CodeRecord>;
  statusIndex: Map<string, string>; // statusId -> code
  /** Called with a grant that dies unredeemed (see registerGrantDisposer). */
  disposer?: (grant: PairingGrant) => void;
}

const STORE_KEY = '__bulwarkPairingStore';

function store(): Store {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: Store };
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = { grants: new Map(), codes: new Map(), statusIndex: new Map() };
  }
  return g[STORE_KEY];
}

/**
 * Clean-up for grants that die without being redeemed: an app password
 * minted for the phone must not stay valid on the server. Kept on the
 * globalThis store, so every route bundle's sweep reaches it.
 */
export function registerGrantDisposer(disposer: (grant: PairingGrant) => void): void {
  store().disposer = disposer;
}

function wipe(record: GrantRecord): void {
  const grant = record.grant;
  record.grant = null;
  if (!grant) return;
  try {
    store().disposer?.(grant);
  } catch {
    // Best effort; the grant is gone either way.
  }
}

// Wipe secrets of anything past its expiry and forget tombstones past theirs.
// Called on every operation so memory stays bounded without a timer.
function sweep(now: number): void {
  const { grants, codes, statusIndex } = store();
  for (const [id, record] of grants) {
    if (record.expiresAt <= now) wipe(record);
    if (record.forgetAt <= now) grants.delete(id);
  }
  for (const [code, record] of codes) {
    if (record.forgetAt <= now) {
      codes.delete(code);
      statusIndex.delete(record.statusId);
    }
  }
}

/** Keep the step-up result until a code for it is redeemed or it expires. */
export function stashGrant(grant: PairingGrant, owner: string, now = Date.now()): string {
  sweep(now);
  const id = randomBytes(ID_BYTES).toString('hex');
  store().grants.set(id, {
    grant,
    owner,
    expiresAt: now + GRANT_TTL_MS,
    forgetAt: now + GRANT_TTL_MS + TOMBSTONE_MS,
  });
  return id;
}

/** Whether `grantId` can still be paired, by the account it was minted for. */
export function isGrantAvailable(grantId: string, owner: string, now = Date.now()): boolean {
  sweep(now);
  const record = store().grants.get(grantId);
  return !!record && record.grant !== null && record.owner === owner && record.expiresAt > now;
}

/** Drop a grant (sign-out, a new step-up): its codes stop working. */
export function discardGrant(grantId: string, now = Date.now()): void {
  sweep(now);
  const record = store().grants.get(grantId);
  if (record) wipe(record);
}

/**
 * Issue a code for an available grant. Earlier codes of the same grant are
 * superseded, so only the QR on screen can be redeemed. Returns null when the
 * grant is gone, so the caller asks for a new step-up.
 */
export function createPairingCode(
  grantId: string,
  owner: string,
  webmailBase: string | null,
  now = Date.now(),
): { code: string; statusId: string; expiresIn: number } | null {
  if (!isGrantAvailable(grantId, owner, now)) return null;
  const { codes, statusIndex, grants } = store();
  const superseded: string[] = [];
  for (const [existing, record] of codes) {
    if (record.grantId !== grantId) continue;
    if (record.state === 'pending') record.state = 'superseded';
    if (record.state === 'superseded') superseded.push(existing);
  }
  // Each new QR replaces the last; remembering every replaced one would let a
  // session grow the store without bound within its step-up window.
  for (const old of superseded.slice(0, Math.max(0, superseded.length - SUPERSEDED_KEPT))) {
    statusIndex.delete(codes.get(old)!.statusId);
    codes.delete(old);
  }
  const code = randomBytes(CODE_BYTES).toString('hex');
  const statusId = randomBytes(ID_BYTES).toString('hex');
  // A code never outlives its grant.
  const expiresAt = Math.min(now + CODE_TTL_MS, grants.get(grantId)!.expiresAt);
  codes.set(code, {
    grantId,
    statusId,
    webmailBase,
    expiresAt,
    state: 'pending',
    forgetAt: expiresAt + TOMBSTONE_MS,
  });
  statusIndex.set(statusId, code);
  return { code, statusId, expiresIn: Math.max(0, Math.floor((expiresAt - now) / 1000)) };
}

/**
 * Hand out the grant behind `code`, once. A code nobody issued is `invalid`;
 * one that timed out, or was replaced by a newer QR, is `expired`; one that
 * was redeemed before (by any code of its grant) is `used`. Distinguishing
 * them leaks nothing useful: codes carry 256 bits and cannot be guessed.
 */
export function redeemPairingCode(code: string, now = Date.now()): RedeemResult {
  sweep(now);
  const { codes, grants } = store();
  const record = codes.get(code);
  if (!record) return { ok: false, reason: 'invalid' };
  if (record.state === 'redeemed') return { ok: false, reason: 'used' };
  const grantRecord = grants.get(record.grantId);
  if (record.state === 'superseded' || record.expiresAt <= now) {
    return { ok: false, reason: grantRecord && grantRecord.grant === null && wasRedeemed(record.grantId) ? 'used' : 'expired' };
  }
  if (!grantRecord || grantRecord.grant === null) {
    return { ok: false, reason: wasRedeemed(record.grantId) ? 'used' : 'expired' };
  }
  const grant = grantRecord.grant;
  grantRecord.grant = null;
  record.state = 'redeemed';
  for (const other of codes.values()) {
    if (other !== record && other.grantId === record.grantId && other.state === 'pending') {
      other.state = 'superseded';
    }
  }
  return { ok: true, grant, webmailBase: record.webmailBase };
}

function wasRedeemed(grantId: string): boolean {
  for (const record of store().codes.values()) {
    if (record.grantId === grantId && record.state === 'redeemed') return true;
  }
  return false;
}

/** What the desktop shows for its QR: still waiting, used by the phone, or dead. */
export function getPairingStatus(statusId: string, now = Date.now()): PairingStatus {
  sweep(now);
  const { statusIndex, codes, grants } = store();
  const code = statusIndex.get(statusId);
  const record = code ? codes.get(code) : undefined;
  if (!record) return 'unknown';
  if (record.state === 'redeemed') return 'redeemed';
  if (record.state === 'superseded' || record.expiresAt <= now) return 'expired';
  // Its grant was discarded (sign-out, a newer step-up): the code is dead.
  if (!grants.get(record.grantId)?.grant) return 'expired';
  return 'pending';
}

/** Test hook: forget everything. */
export function resetPairingStoreForTests(): void {
  const s = store();
  s.grants.clear();
  s.codes.clear();
  s.statusIndex.clear();
}
