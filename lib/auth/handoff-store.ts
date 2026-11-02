import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { RedeemBundle } from '@/lib/auth/pair-bundle';
import { isMobileCodeChallenge } from '@/lib/auth/mobile-handoff';
import { createFailureBudget, type BudgetRefund } from '@/lib/auth/verify-budget';
import { decryptPayload, encryptPayload } from '@/lib/auth/crypto';
import { getStore, isSharedMode } from '@/lib/shared-store';
import { logger } from '@/lib/logger';

// One-time codes for the browser sign-in hand-off to the mobile app
// (lib/auth/mobile-handoff.ts, bulwarkmail.org/docs/development/mobile-handoff). The app opens the
// login page with a PKCE `mobile_code_challenge`; once the user has signed in
// and confirmed, the sign-in (an OAuth bundle, or username + password) is
// parked here and the browser opens the app's callback link with nothing but
// a random code. The app redeems that code at /api/auth/handoff/redeem with
// the verifier behind its challenge. A custom-scheme link can be caught by
// another app on the device; the code alone is worthless to it.
//
// A code can be redeemed for 60 seconds from the moment the user confirms,
// and only once. Any redeem attempt spends it, including one with the wrong
// verifier, so a code that leaked cannot be tried twice.
//
// The password flow parks on confirmation (the page holds the password), so
// its code is live at once. The SSO flow parks in /api/auth/sso/complete,
// before the user has seen the confirmation: that code waits, unusable, for
// up to five minutes until the page confirms it (/api/auth/handoff/confirm),
// and its 60 seconds start then.
//
// Spent and expired records stay a while without their sign-in, so a late
// redeem is told "expired" rather than "invalid".
//
// One process keeps the codes in a Map pinned on globalThis, like the pairing
// store (lib/auth/pairing-store.ts). With a shared store (#1066) they live
// there instead, sealed with the session key and under the code's hash, so
// the page's confirm and the app's redeem may reach any replica: the SSO
// hand-off is three requests from two clients. While the store is down every
// function rejects with StoreUnavailableError; nothing is parked or redeemed.

export const HANDOFF_TTL_MS = 60 * 1000;
/** How long an SSO sign-in waits for the user to confirm the hand-off. */
export const HANDOFF_CONFIRM_TTL_MS = 5 * 60 * 1000;
const TOMBSTONE_MS = 10 * 60 * 1000;
const CODE_BYTES = 32; // 256 bits
/** Records at most; the oldest gives way when a new one comes in. */
const MAX_RECORDS = 2000;
/** The store's TTL only cleans up; every record carries its own expiry. */
const CLEANUP_MS = 60 * 1000;

/** RFC 7636 §4.1: 43 to 128 unreserved characters. */
const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CODE_RE = /^[0-9a-f]{64}$/;

export const isHandoffCodeChallenge = isMobileCodeChallenge;

export function isHandoffCodeVerifier(value: unknown): value is string {
  return typeof value === 'string' && CODE_VERIFIER_RE.test(value);
}

export function isHandoffCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_RE.test(value);
}

interface HandoffRecord {
  /** Null once redeemed (or tried) or expired. */
  bundle: RedeemBundle | null;
  state: string;
  challenge: string;
  /** Whether the user confirmed the hand-off; only confirmed codes redeem. */
  confirmed: boolean;
  issuedAt: number;
  expiresAt: number;
  forgetAt: number;
}

export type HandoffRedeemResult =
  | { ok: true; bundle: RedeemBundle; state: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'verifier_mismatch' };

const STORE_KEY = '__bulwarkMobileHandoffStore';

function store(): Map<string, HandoffRecord> {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: Map<string, HandoffRecord> };
  if (!g[STORE_KEY]) g[STORE_KEY] = new Map();
  return g[STORE_KEY];
}

// Wipe sign-ins past their expiry and forget tombstones past theirs. Called
// on every operation, so memory stays bounded without a timer.
function sweep(now: number): void {
  const codes = store();
  for (const [code, record] of codes) {
    if (record.expiresAt <= now) record.bundle = null;
    if (record.forgetAt <= now) codes.delete(code);
  }
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function newRecord(
  bundle: RedeemBundle,
  options: { challenge: string; state: string; awaitConfirm?: boolean },
  now: number,
): HandoffRecord {
  const expiresAt = now + (options.awaitConfirm ? HANDOFF_CONFIRM_TTL_MS : HANDOFF_TTL_MS);
  return {
    bundle,
    state: options.state,
    challenge: options.challenge,
    confirmed: !options.awaitConfirm,
    issuedAt: now,
    expiresAt,
    forgetAt: expiresAt + TOMBSTONE_MS,
  };
}

/** The user confirmed: the code redeems for the next 60 seconds. */
function confirmed(record: HandoffRecord, now: number): HandoffRecord {
  const expiresAt = now + HANDOFF_TTL_MS;
  return { ...record, confirmed: true, expiresAt, forgetAt: expiresAt + TOMBSTONE_MS };
}

/** What a redeem attempt of `record` (spent by the attempt) gets. */
function redeemOutcome(record: HandoffRecord, bundle: RedeemBundle | null, verifier: string, now: number): HandoffRedeemResult {
  if (!bundle) return { ok: false, reason: record.expiresAt <= now ? 'expired' : 'invalid' };
  if (!record.confirmed) return { ok: false, reason: 'invalid' };
  const expected = Buffer.from(record.challenge, 'ascii');
  const actual = Buffer.from(s256(verifier), 'ascii');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'verifier_mismatch' };
  }
  if (bundle.flow === 'oauth' && typeof bundle.expires_in === 'number') {
    const elapsed = Math.floor((now - record.issuedAt) / 1000);
    return { ok: true, bundle: { ...bundle, expires_in: Math.max(0, bundle.expires_in - elapsed) }, state: record.state };
  }
  return { ok: true, bundle, state: record.state };
}

// ─── shared store ──────────────────────────────────────────────────────────

const sharedKey = (code: string) => `handoff:${createHash('sha256').update(code).digest('hex')}`;

function seal(record: HandoffRecord): string {
  return encryptPayload({ r: record }, 'handoff-store');
}

/** The record, or null when missing, past its tombstone or unreadable. */
function open(sealed: string | null, now: number): HandoffRecord | null {
  if (sealed === null) return null;
  const payload = decryptPayload(sealed, 'handoff-store');
  const record = payload && typeof payload.r === 'object' && payload.r !== null ? (payload.r as HandoffRecord) : null;
  return record && record.forgetAt > now ? record : null;
}

const ttl = (record: HandoffRecord, now: number) => Math.max(record.forgetAt - now, 0) + CLEANUP_MS;

// ─── API ───────────────────────────────────────────────────────────────────

/**
 * Park a sign-in for the app; returns the code the browser hands over. With
 * `awaitConfirm` the code only becomes redeemable through confirmHandoff.
 */
export async function stashHandoff(
  bundle: RedeemBundle,
  options: { challenge: string; state: string; awaitConfirm?: boolean },
  now = Date.now(),
): Promise<string> {
  const code = randomBytes(CODE_BYTES).toString('hex');
  const record = newRecord(bundle, options, now);
  if (isSharedMode()) {
    // Each code is spent by a single redeem and dies on its own; the create
    // budget bounds how many one client parks.
    await getStore().kv.set(sharedKey(code), seal(record), { ttlMs: ttl(record, now) });
    return code;
  }
  sweep(now);
  const codes = store();
  // Map keeps insertion order, so the first key is the oldest.
  while (codes.size >= MAX_RECORDS) {
    const oldest = codes.keys().next().value;
    if (oldest === undefined) break;
    codes.delete(oldest);
  }
  codes.set(code, record);
  return code;
}

/**
 * The user confirmed the hand-off of a code parked with `awaitConfirm`: it
 * can be redeemed for the next 60 seconds. False when there is nothing (left)
 * to confirm.
 */
export async function confirmHandoff(code: string, now = Date.now()): Promise<boolean> {
  if (isSharedMode()) {
    const result = { ok: false };
    await getStore().kv.update(sharedKey(code), (current) => {
      result.ok = false;
      const record = open(current, now);
      if (!record || !record.bundle || record.expiresAt <= now || record.confirmed) return undefined;
      result.ok = true;
      return seal(confirmed(record, now));
    }, { ttlMs: HANDOFF_TTL_MS + TOMBSTONE_MS + CLEANUP_MS });
    return result.ok;
  }
  sweep(now);
  const record = store().get(code);
  if (!record || !record.bundle || record.confirmed) return false;
  store().set(code, confirmed(record, now));
  return true;
}

/**
 * Hand out the sign-in behind `code` when `verifier` matches its challenge.
 * The code is spent by the attempt, whatever its outcome. `expires_in` of an
 * OAuth bundle counts down from when it was parked.
 */
export async function redeemHandoff(code: string, verifier: string, now = Date.now()): Promise<HandoffRedeemResult> {
  if (isSharedMode()) {
    const kv = getStore().kv;
    // Taken in one step: of two attempts, only one sees the sign-in.
    const record = open(await kv.take(sharedKey(code)), now);
    if (!record) return { ok: false, reason: 'invalid' };
    const bundle = record.expiresAt > now ? record.bundle : null;
    // A tombstone goes back, so a late attempt is told "expired". The code is
    // spent already: if the tombstone can't be written, the answer stands.
    const spent = { ...record, bundle: null };
    try {
      await kv.set(sharedKey(code), seal(spent), { ttlMs: ttl(spent, now), ifAbsent: true });
    } catch (error) {
      logger.warn('Mobile hand-off tombstone not written', { error: error instanceof Error ? error.message : 'Unknown error' });
    }
    return redeemOutcome(record, bundle, verifier, now);
  }
  sweep(now);
  const record = store().get(code);
  if (!record) return { ok: false, reason: 'invalid' };
  const bundle = record.bundle;
  record.bundle = null;
  return redeemOutcome(record, bundle, verifier, now);
}

/** Test hook: forget everything. */
export function resetHandoffStoreForTests(): void {
  store().clear();
}

// Per-client limits on the routes. Codes carry 256 bits and die on the first
// attempt, so guessing is hopeless either way; these keep one client from
// filling the store or hammering the redeem route.
const createBudget = createFailureBudget({ name: 'handoff-create', clientMax: 10, globalMax: Infinity });
const redeemBudget = createFailureBudget({ name: 'handoff-redeem', clientMax: 10, globalMax: Infinity });

/** Count one parked sign-in for `client`; false when it is over its limit. */
export async function reserveHandoffCreate(client: string, now = Date.now()): Promise<boolean> {
  return (await createBudget.reserve(client, now)) !== null;
}

/**
 * Reserve one redeem attempt for `client`: null when it is over its limit,
 * otherwise a refund to call when the redeem succeeded (only failures count).
 */
export function reserveHandoffRedeem(client: string, now = Date.now()): Promise<BudgetRefund | null> {
  return redeemBudget.reserve(client, now);
}
