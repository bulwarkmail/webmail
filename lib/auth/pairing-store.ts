import { createHash, randomBytes } from 'crypto';
import { decryptPayload, encryptPayload } from '@/lib/auth/crypto';
import { getStore, isSharedMode, isStoreUnavailableError } from '@/lib/shared-store';
import { logger } from '@/lib/logger';

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
// One process keeps everything in a Map pinned on globalThis, so dev HMR and
// duplicate module evaluation (route bundles) share one instance. With a
// shared store (#1066) the records live there instead, sealed with the
// session key, so the phone's redeem, the desktop's status polls and a
// sign-out can each reach any replica. Every function then rejects with
// StoreUnavailableError while the store is down: nothing is issued or
// redeemed.

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
  /** Shared mode: when this process last swept the shared disposal list. */
  sharedSweptAt?: number;
  /** Shared mode: the minute sweep of the process holding the disposer. */
  sweepTimer?: ReturnType<typeof setInterval>;
  /** Shared mode: grants a sign-out couldn't discard (store down), until they'd expire anyway. */
  pendingDiscards?: Map<string, number>;
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
  startSweepTimer();
}

function dispose(grant: PairingGrant): void {
  try {
    store().disposer?.(grant);
  } catch {
    // Best effort; the grant is gone either way.
  }
}

// ─── one process ───────────────────────────────────────────────────────────

function wipe(record: GrantRecord): void {
  const grant = record.grant;
  record.grant = null;
  if (grant) dispose(grant);
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

function stashGrantLocal(grant: PairingGrant, owner: string, now: number): string {
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

function isGrantAvailableLocal(grantId: string, owner: string, now: number): boolean {
  sweep(now);
  const record = store().grants.get(grantId);
  return !!record && record.grant !== null && record.owner === owner && record.expiresAt > now;
}

function discardGrantLocal(grantId: string, now: number): void {
  sweep(now);
  const record = store().grants.get(grantId);
  if (record) wipe(record);
}

function createPairingCodeLocal(
  grantId: string,
  owner: string,
  webmailBase: string | null,
  now: number,
): { code: string; statusId: string; expiresIn: number } | null {
  if (!isGrantAvailableLocal(grantId, owner, now)) return null;
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

function redeemPairingCodeLocal(code: string, now: number): RedeemResult {
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

function getPairingStatusLocal(statusId: string, now: number): PairingStatus {
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

// ─── shared store ──────────────────────────────────────────────────────────
//
// One grant record holds everything a redeem decides on: the secret, which
// code is the current one and which code redeemed it. Redeeming is one
// atomic update of that record, so of two phones (or replicas) racing with
// the same code, or with two codes of the grant, exactly one gets it. Code
// records only point at their grant and never change. Codes are stored
// under their hash: whoever reads the store can't redeem one.
//
// A grant that expires unredeemed may hold an app password that must be
// deleted on the mail server. Each such grant is therefore also listed in a
// sealed disposal list, with everything the disposer needs, and the list
// never expires. The process that registered the disposer (the one that
// mints grants) sweeps it every minute, and every pairing request sweeps it
// too: an expired entry whose grant was neither redeemed nor discarded is
// disposed of, and the entry is removed only once that succeeded. Grant
// records of app-password grants are kept a day after they are forgotten,
// so the sweep can still tell a redeemed grant from an abandoned one.

interface SharedGrantRecord extends GrantRecord {
  /** Hash of the newest code: the only one that can be redeemed. */
  current: string | null;
  /** Hash of the code that redeemed the grant. */
  redeemed: string | null;
  /** Codes issued for the grant, oldest first, as [code hash, status id]. */
  codes: Array<[string, string]>;
  /** The secret was handed to the disposer (expired or discarded). */
  disposed?: boolean;
}

interface SharedCodeRecord {
  grantId: string;
  statusId: string;
  webmailBase: string | null;
  expiresAt: number;
  forgetAt: number;
}

interface DisposalEntry {
  grantId: string;
  expiresAt: number;
  /** What the disposer needs, in case the grant record is gone by then. */
  grant: PairingGrant;
}

/** The store's TTL only cleans up; every record carries its own expiry. */
const CLEANUP_MS = 60 * 1000;
/** App-password grant records outlive their tombstone by this much (see above). */
const DISPOSAL_RECORD_MS = 24 * 60 * 60 * 1000;
/** How often one replica looks for expired grants to dispose of, at most. */
const SWEEP_EVERY_MS = 10 * 1000;
/** How often the process holding the disposer sweeps without any request. */
const SWEEP_TIMER_MS = 60 * 1000;
const DISPOSALS_KEY = 'pairing:disposals';
const grantKey = (grantId: string) => `pairing:grant:${grantId}`;
const codeKey = (codeHash: string) => `pairing:code:${codeHash}`;
const statusKey = (statusId: string) => `pairing:status:${statusId}`;

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function seal(value: unknown): string {
  return encryptPayload({ r: value }, 'pairing-store');
}

/** The sealed value, or null when missing or unreadable (another key, tampering). */
function open<T>(sealed: string | null): T | null {
  if (sealed === null) return null;
  const payload = decryptPayload(sealed, 'pairing-store');
  return payload && typeof payload.r === 'object' && payload.r !== null ? (payload.r as T) : null;
}

const ttl = (until: number, now: number) => Math.max(until - now, 0) + CLEANUP_MS;

/** A grant whose unredeemed end must delete something on the mail server. */
function needsDisposal(grant: PairingGrant): boolean {
  return grant.flow === 'password' && grant.credential === 'app-password' && !!grant.appPasswordId;
}

/** The grant's secret while it can still be handed out. */
function liveGrant(record: SharedGrantRecord, now: number): PairingGrant | null {
  return record.expiresAt > now ? record.grant : null;
}

async function readGrant(grantId: string, now: number): Promise<SharedGrantRecord | null> {
  const record = open<SharedGrantRecord>(await getStore().kv.get(grantKey(grantId)));
  return record && record.forgetAt > now ? record : null;
}

async function readCode(codeHash: string, now: number): Promise<SharedCodeRecord | null> {
  const record = open<SharedCodeRecord>(await getStore().kv.get(codeKey(codeHash)));
  return record && record.forgetAt > now ? record : null;
}

type WipeOutcome = 'wiped' | 'redeemed' | 'gone' | 'missing';

/**
 * Take the secret out of a grant record and hand it to the disposer, once
 * across replicas: the one update that finds the secret disposes of it.
 */
async function wipeShared(grantId: string): Promise<WipeOutcome> {
  const out: { grant: PairingGrant | null; outcome: WipeOutcome } = { grant: null, outcome: 'missing' };
  await getStore().kv.update(grantKey(grantId), (current) => {
    out.grant = null;
    const record = open<SharedGrantRecord>(current);
    if (!record) {
      out.outcome = 'missing';
      return undefined;
    }
    if (!record.grant) {
      out.outcome = record.redeemed ? 'redeemed' : 'gone';
      return undefined;
    }
    out.grant = record.grant;
    out.outcome = 'wiped';
    return seal({ ...record, grant: null, current: null, disposed: true });
  });
  if (out.grant) dispose(out.grant);
  return out.outcome;
}

/** Read the disposal list; null when it exists but can't be read (kept as it is). */
function openDisposals(current: string | null): DisposalEntry[] | null {
  if (current === null) return [];
  const entries = open<DisposalEntry[]>(current);
  return Array.isArray(entries) ? entries : null;
}

function logUnreadableDisposals(): void {
  logger.error('Pairing: the app-password disposal list in the shared store is unreadable (another session secret?); left as it is');
}

/** Remove one entry; true when this call removed it. */
async function removeDisposal(grantId: string): Promise<boolean> {
  const out = { removed: false, unreadable: false };
  await getStore().kv.update(DISPOSALS_KEY, (current) => {
    out.removed = false;
    const entries = openDisposals(current);
    out.unreadable = entries === null;
    if (!entries) return undefined;
    const rest = entries.filter((entry) => entry.grantId !== grantId);
    if (rest.length === entries.length) return undefined;
    out.removed = true;
    return rest.length > 0 ? seal(rest) : null;
  });
  if (out.unreadable) logUnreadableDisposals();
  return out.removed;
}

/** Retry discards a sign-out couldn't write while the store was down. */
async function flushPendingDiscards(now: number): Promise<void> {
  const pending = store().pendingDiscards;
  if (!pending) return;
  for (const [grantId, until] of [...pending]) {
    if (until <= now) {
      // Its grant has expired anyway; an app password is in the disposal list.
      pending.delete(grantId);
      continue;
    }
    await wipeShared(grantId);
    await removeDisposal(grantId).catch(() => false);
    pending.delete(grantId);
  }
}

async function sweepShared(now: number): Promise<void> {
  const s = store();
  await flushPendingDiscards(now);
  // Without a disposer (this process never loaded lib/auth/pair-grant.ts)
  // the entries are left for a replica that can dispose of them.
  if (!s.disposer) return;
  if (s.sharedSweptAt !== undefined && now >= s.sharedSweptAt && now - s.sharedSweptAt < SWEEP_EVERY_MS) return;
  s.sharedSweptAt = now;
  const entries = openDisposals(await getStore().kv.get(DISPOSALS_KEY));
  if (!entries) {
    logUnreadableDisposals();
    return;
  }
  for (const entry of entries.filter((e) => e.expiresAt <= now)) {
    try {
      const outcome = await wipeShared(entry.grantId);
      // Without its record (it outlived even the extra day) the entry
      // decides: whoever removes it disposes of the grant.
      const removed = await removeDisposal(entry.grantId);
      if (outcome === 'missing' && removed) dispose(entry.grant);
    } catch (error) {
      // Left in the list for the next sweep.
      logger.warn('Pairing: expired grant not disposed of yet', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}

/** Sweep every minute in this process, without waiting for a pairing request. */
function startSweepTimer(): void {
  const s = store();
  if (s.sweepTimer || !isSharedMode()) return;
  s.sweepTimer = setInterval(() => {
    if (!isSharedMode()) return;
    sweepShared(Date.now()).catch((error) => {
      logger.debug('Pairing sweep failed', { error: error instanceof Error ? error.message : 'Unknown error' });
    });
  }, SWEEP_TIMER_MS);
  s.sweepTimer.unref?.();
}

async function stashGrantShared(grant: PairingGrant, owner: string, now: number): Promise<string> {
  const id = randomBytes(ID_BYTES).toString('hex');
  const record: SharedGrantRecord = {
    grant,
    owner,
    expiresAt: now + GRANT_TTL_MS,
    forgetAt: now + GRANT_TTL_MS + TOMBSTONE_MS,
    current: null,
    redeemed: null,
    codes: [],
  };
  const disposable = needsDisposal(grant);
  try {
    await sweepShared(now);
    if (disposable) {
      // Listed for disposal before it exists, so no such grant is ever unlisted.
      const out = { unreadable: false };
      await getStore().kv.update(DISPOSALS_KEY, (current) => {
        const entries = openDisposals(current);
        out.unreadable = entries === null;
        if (!entries) return undefined;
        return seal([...entries, { grantId: id, expiresAt: record.expiresAt, grant } satisfies DisposalEntry]);
      });
      if (out.unreadable) {
        logUnreadableDisposals();
        throw new Error('The pairing disposal list is unreadable');
      }
    }
    const keepFor = disposable ? ttl(record.forgetAt + DISPOSAL_RECORD_MS, now) : ttl(record.forgetAt, now);
    await getStore().kv.set(grantKey(id), seal(record), { ttlMs: keepFor });
  } catch (error) {
    // Not kept, so no phone can redeem it: an app password minted for it
    // must not stay behind on the mail server.
    dispose(grant);
    throw error;
  }
  return id;
}

async function isGrantAvailableShared(grantId: string, owner: string, now: number): Promise<boolean> {
  await sweepShared(now);
  const record = await readGrant(grantId, now);
  return !!record && liveGrant(record, now) !== null && record.owner === owner;
}

async function createPairingCodeShared(
  grantId: string,
  owner: string,
  webmailBase: string | null,
  now: number,
): Promise<{ code: string; statusId: string; expiresIn: number } | null> {
  await sweepShared(now);
  const grant = await readGrant(grantId, now);
  if (!grant || !liveGrant(grant, now) || grant.owner !== owner) return null;

  const code = randomBytes(CODE_BYTES).toString('hex');
  const hash = hashCode(code);
  const statusId = randomBytes(ID_BYTES).toString('hex');
  // A code never outlives its grant.
  const expiresAt = Math.min(now + CODE_TTL_MS, grant.expiresAt);
  const forgetAt = expiresAt + TOMBSTONE_MS;
  const kv = getStore().kv;
  await kv.set(codeKey(hash), seal({ grantId, statusId, webmailBase, expiresAt, forgetAt } satisfies SharedCodeRecord), { ttlMs: ttl(forgetAt, now) });
  await kv.set(statusKey(statusId), hash, { ttlMs: ttl(forgetAt, now) });

  // Make it the grant's current code, if the grant is still there to pair.
  const outcome: { issued: boolean; forgotten: Array<[string, string]> } = { issued: false, forgotten: [] };
  await kv.update(grantKey(grantId), (current) => {
    outcome.issued = false;
    outcome.forgotten = [];
    const record = open<SharedGrantRecord>(current);
    if (!record || record.forgetAt <= now || !liveGrant(record, now) || record.owner !== owner) return undefined;
    outcome.issued = true;
    // Each new QR replaces the last; only the newest few replaced ones are remembered.
    const previous = record.codes;
    outcome.forgotten = previous.slice(0, Math.max(0, previous.length - SUPERSEDED_KEPT));
    return seal({ ...record, current: hash, codes: [...previous.slice(outcome.forgotten.length), [hash, statusId]] });
  });
  // Not issued after all (the grant went meanwhile): the new code goes too.
  const forgotten = outcome.issued ? outcome.forgotten : [[hash, statusId]];
  for (const [oldHash, oldStatus] of forgotten) {
    await kv.del(codeKey(oldHash));
    await kv.del(statusKey(oldStatus));
  }
  if (!outcome.issued) return null;
  return { code, statusId, expiresIn: Math.max(0, Math.floor((expiresAt - now) / 1000)) };
}

async function redeemPairingCodeShared(code: string, now: number): Promise<RedeemResult> {
  await sweepShared(now);
  const hash = hashCode(code);
  const codeRecord = await readCode(hash, now);
  if (!codeRecord) return { ok: false, reason: 'invalid' };
  const out: { result: RedeemResult } = { result: { ok: false, reason: 'expired' } };
  await getStore().kv.update(grantKey(codeRecord.grantId), (current) => {
    const record = open<SharedGrantRecord>(current);
    if (!record || record.forgetAt <= now) {
      out.result = { ok: false, reason: 'expired' };
      return undefined;
    }
    if (record.redeemed === hash) {
      out.result = { ok: false, reason: 'used' };
      return undefined;
    }
    const grant = liveGrant(record, now);
    if (record.current !== hash || codeRecord.expiresAt <= now || !grant) {
      out.result = { ok: false, reason: record.redeemed ? 'used' : 'expired' };
      return undefined;
    }
    out.result = { ok: true, grant, webmailBase: codeRecord.webmailBase };
    return seal({ ...record, grant: null, current: null, redeemed: hash });
  });
  // Nothing left to dispose of; the sweep would see the redeemed record anyway.
  if (out.result.ok && needsDisposal(out.result.grant)) await removeDisposal(codeRecord.grantId).catch(() => false);
  return out.result;
}

async function getPairingStatusShared(statusId: string, now: number): Promise<PairingStatus> {
  await sweepShared(now);
  const hash = await getStore().kv.get(statusKey(statusId));
  const codeRecord = hash ? await readCode(hash, now) : null;
  if (!hash || !codeRecord) return 'unknown';
  const grant = await readGrant(codeRecord.grantId, now);
  if (grant?.redeemed === hash) return 'redeemed';
  if (!grant || grant.current !== hash || codeRecord.expiresAt <= now) return 'expired';
  // Its grant was discarded (sign-out, a newer step-up): the code is dead.
  if (!liveGrant(grant, now)) return 'expired';
  return 'pending';
}

async function discardGrantShared(grantId: string, now: number): Promise<void> {
  try {
    await sweepShared(now);
    await wipeShared(grantId);
  } catch (error) {
    if (isStoreUnavailableError(error)) {
      // Retried by the next sweep once the store is back, so a QR left on
      // screen at sign-out doesn't stay redeemable.
      const s = store();
      (s.pendingDiscards ??= new Map()).set(grantId, now + GRANT_TTL_MS);
      startSweepTimer();
    }
    throw error;
  }
  await removeDisposal(grantId).catch(() => false);
}

// ─── API ───────────────────────────────────────────────────────────────────

/** Keep the step-up result until a code for it is redeemed or it expires. */
export async function stashGrant(grant: PairingGrant, owner: string, now = Date.now()): Promise<string> {
  return isSharedMode() ? stashGrantShared(grant, owner, now) : stashGrantLocal(grant, owner, now);
}

/** Whether `grantId` can still be paired, by the account it was minted for. */
export async function isGrantAvailable(grantId: string, owner: string, now = Date.now()): Promise<boolean> {
  return isSharedMode() ? isGrantAvailableShared(grantId, owner, now) : isGrantAvailableLocal(grantId, owner, now);
}

/** Drop a grant (sign-out, a new step-up): its codes stop working. */
export async function discardGrant(grantId: string, now = Date.now()): Promise<void> {
  if (isSharedMode()) await discardGrantShared(grantId, now);
  else discardGrantLocal(grantId, now);
}

/**
 * Issue a code for an available grant. Earlier codes of the same grant are
 * superseded, so only the QR on screen can be redeemed. Returns null when the
 * grant is gone, so the caller asks for a new step-up.
 */
export async function createPairingCode(
  grantId: string,
  owner: string,
  webmailBase: string | null,
  now = Date.now(),
): Promise<{ code: string; statusId: string; expiresIn: number } | null> {
  return isSharedMode()
    ? createPairingCodeShared(grantId, owner, webmailBase, now)
    : createPairingCodeLocal(grantId, owner, webmailBase, now);
}

/**
 * Hand out the grant behind `code`, once. A code nobody issued is `invalid`;
 * one that timed out, or was replaced by a newer QR, is `expired`; one that
 * was redeemed before (by any code of its grant) is `used`. Distinguishing
 * them leaks nothing useful: codes carry 256 bits and cannot be guessed.
 */
export async function redeemPairingCode(code: string, now = Date.now()): Promise<RedeemResult> {
  return isSharedMode() ? redeemPairingCodeShared(code, now) : redeemPairingCodeLocal(code, now);
}

/** What the desktop shows for its QR: still waiting, used by the phone, or dead. */
export async function getPairingStatus(statusId: string, now = Date.now()): Promise<PairingStatus> {
  return isSharedMode() ? getPairingStatusShared(statusId, now) : getPairingStatusLocal(statusId, now);
}

/** Test hook: forget everything this process holds. */
export function resetPairingStoreForTests(): void {
  const s = store();
  s.grants.clear();
  s.codes.clear();
  s.statusIndex.clear();
  s.sharedSweptAt = undefined;
  if (s.sweepTimer) clearInterval(s.sweepTimer);
  s.sweepTimer = undefined;
  s.pendingDiscards = undefined;
}
