import { createHmac, timingSafeEqual } from 'node:crypto';

export class ImpersonationJwtError extends Error {
  status: number;
  code: string;
  constructor(code: string, message: string, status: number = 401) {
    super(message);
    this.name = 'ImpersonationJwtError';
    this.code = code;
    this.status = status;
  }
}

export interface ImpersonationClaims {
  iss: string;
  iat: number;
  exp: number;
  nbf?: number;
  jti: string;
  mailbox: string;
  tenant_id?: string;
  actor_user_id?: string;
}

const MAX_TOKEN_LIFETIME_SEC = 300;
const CLOCK_SKEW_SEC = 60;
const MIN_SECRET_LENGTH = 32;

/**
 * How long after it is first redeemed a token can still verify: `iat` may
 * run CLOCK_SKEW_SEC ahead, `exp` is at most MAX_TOKEN_LIFETIME_SEC after
 * `iat`, and `exp` is honoured for another CLOCK_SKEW_SEC.
 */
export const IMPERSONATION_REPLAY_WINDOW_SEC = MAX_TOKEN_LIFETIME_SEC + 2 * CLOCK_SKEW_SEC;

function base64UrlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? 0 : 4 - (input.length % 4);
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return Buffer.from(b64, 'base64');
}

function parseSegment(segment: string): unknown {
  try {
    return JSON.parse(base64UrlDecode(segment).toString('utf8'));
  } catch {
    throw new ImpersonationJwtError('malformed', 'Malformed JWT segment', 400);
  }
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ImpersonationJwtError('claims', `Missing or invalid '${field}' claim`);
  }
  return value;
}

function assertNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ImpersonationJwtError('claims', `Missing or invalid '${field}' claim`);
  }
  return value;
}

/**
 * Verify an HS256 JWT for master-user impersonation. Returns the validated
 * claims on success; throws ImpersonationJwtError otherwise.
 *
 * Caller must perform replay-protection (jti tracking) on the returned claims.
 */
export function verifyImpersonationJwt(
  token: string,
  secret: string,
  options: { expectedIssuer?: string; now?: number } = {},
): ImpersonationClaims {
  if (typeof token !== 'string' || token.length === 0) {
    throw new ImpersonationJwtError('malformed', 'Missing token', 400);
  }
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new ImpersonationJwtError(
      'config',
      `BULWARK_JWT_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
      500,
    );
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new ImpersonationJwtError('malformed', 'Token must have 3 segments', 400);
  }
  const [headerB64, payloadB64, sigB64] = parts;

  // Header - reject anything but HS256 BEFORE attempting signature verification.
  const header = parseSegment(headerB64) as Record<string, unknown>;
  if (header.alg !== 'HS256') {
    throw new ImpersonationJwtError('alg', `Unsupported alg '${String(header.alg)}'`);
  }
  if (header.typ !== undefined && header.typ !== 'JWT') {
    throw new ImpersonationJwtError('alg', `Unsupported typ '${String(header.typ)}'`);
  }

  // Signature - constant-time compare.
  const expected = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
  const provided = base64UrlDecode(sigB64);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new ImpersonationJwtError('signature', 'Invalid signature');
  }

  // Claims.
  const payload = parseSegment(payloadB64) as Record<string, unknown>;
  const iss = assertString(payload.iss, 'iss');
  if (options.expectedIssuer && iss !== options.expectedIssuer) {
    throw new ImpersonationJwtError('iss', `Unexpected issuer '${iss}'`);
  }
  const iat = assertNumber(payload.iat, 'iat');
  const exp = assertNumber(payload.exp, 'exp');
  const jti = assertString(payload.jti, 'jti');
  const mailbox = assertString(payload.mailbox, 'mailbox');

  // Mailbox MUST NOT contain '%' or ':' - those would inject into the
  // master-user auth header.
  if (mailbox.includes('%') || mailbox.includes(':')) {
    throw new ImpersonationJwtError('mailbox', "mailbox must not contain '%' or ':'");
  }

  const nowSec = options.now ?? Math.floor(Date.now() / 1000);

  if (typeof payload.nbf === 'number' && nowSec + CLOCK_SKEW_SEC < payload.nbf) {
    throw new ImpersonationJwtError('nbf', 'Token not yet valid');
  }
  if (nowSec - CLOCK_SKEW_SEC > exp) {
    throw new ImpersonationJwtError('exp', 'Token expired');
  }
  if (iat - CLOCK_SKEW_SEC > nowSec) {
    throw new ImpersonationJwtError('iat', 'Token issued in the future');
  }
  // Hard ceiling on lifetime - refuse long-lived handoff tokens even if the
  // signer asked for one.
  if (exp - iat > MAX_TOKEN_LIFETIME_SEC) {
    throw new ImpersonationJwtError('lifetime', `Token lifetime exceeds ${MAX_TOKEN_LIFETIME_SEC}s ceiling`);
  }

  const claims: ImpersonationClaims = { iss, iat, exp, jti, mailbox };
  if (typeof payload.nbf === 'number') claims.nbf = payload.nbf;
  if (typeof payload.tenant_id === 'string') claims.tenant_id = payload.tenant_id;
  if (typeof payload.actor_user_id === 'string') claims.actor_user_id = payload.actor_user_id;
  return claims;
}

// ─── Replay protection ──────────────────────────────────────────
// In-memory LRU keyed by jti. Entries expire automatically once their
// underlying JWT could no longer be replayed (exp + skew). This is the fast
// path; consumeImpersonationJti() in replay-store.ts backs it with marker
// files in the state directory so a restart or another replica sharing the
// state volume still refuses a used token.

const REPLAY_CACHE_MAX = 4096;

class ReplayCache {
  private entries = new Map<string, number>(); // jti -> exp epoch seconds

  /** Returns true if jti was not previously seen and has been recorded. */
  consume(jti: string, exp: number, now: number = Math.floor(Date.now() / 1000)): boolean {
    this.prune(now);
    if (this.entries.has(jti)) return false;
    if (this.entries.size >= REPLAY_CACHE_MAX) {
      // Evict the oldest entry - Map preserves insertion order.
      const first = this.entries.keys().next().value;
      if (first !== undefined) this.entries.delete(first);
    }
    this.entries.set(jti, exp);
    return true;
  }

  private prune(now: number): void {
    for (const [jti, exp] of this.entries) {
      if (exp + CLOCK_SKEW_SEC < now) {
        this.entries.delete(jti);
      } else {
        // Insertion order means later entries are no older than this one - but
        // exp isn't strictly monotonic with insertion, so we can't break here.
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

export const impersonationReplayCache = new ReplayCache();
