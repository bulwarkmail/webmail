/**
 * Budget for the unauthenticated login pre-check (/api/auth/verify).
 *
 * Every probe that route sends reaches the JMAP server from this server's
 * address. Without a limit anyone could use it as a password oracle, and
 * enough wrong passwords would trip the JMAP server's authentication
 * limiter (Stalwart's fail2ban) against the webmail's own address, locking
 * out every user at once. A probe that turns out right is refunded, so only
 * wrong passwords use up the budget.
 *
 * Over budget the route answers `inconclusive`: the browser then probes the
 * JMAP server itself, from its own address, exactly as it did before the
 * pre-check existed.
 *
 * With a shared store (#1066) the counts live there, so every replica spends
 * the same budget. If the store can't be reached, `reserve` throws
 * StoreUnavailableError and the caller refuses the attempt.
 */

import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { getStore, isSharedMode, type CounterLimit } from '@/lib/shared-store';
import { logger } from '@/lib/logger';
import { parseV6Groups } from '@/lib/security/ip-ranges';

const WINDOW_MS = 15 * 60 * 1000;
const CLIENT_MAX_FAILURES = 5;
/**
 * The client key comes from X-Forwarded-For, which a client can write itself
 * when nothing sits in front of the app, so there is a ceiling across all
 * clients too.
 */
const GLOBAL_MAX_FAILURES = 30;
const MAX_TRACKED_CLIENTS = 10_000;

interface Budget {
  used: number;
  resetAt: number;
}

export interface FailureBudgetOptions {
  /** Names this budget's counters in the shared store. */
  name: string;
  /** Failures one client may cause per window. */
  clientMax: number;
  /** Failures all clients together may cause per window; `Infinity` for no ceiling. */
  globalMax: number;
  windowMs?: number;
}

/** Gives a reserved attempt back. Never throws; calling it twice refunds once. */
export type BudgetRefund = () => Promise<void>;

export interface FailureBudget {
  /**
   * Reserve one attempt for `client`. Resolves to null when the client or
   * the whole server is over budget; otherwise to a function that refunds
   * the attempt, to be called when the credentials turned out to be right.
   * Rejects with StoreUnavailableError when the shared store is down.
   */
  reserve(client: string, now?: number): Promise<BudgetRefund | null>;
}

/** A client address as a counter key: as it is when it's short and printable, else hashed. */
function clientKey(client: string): string {
  return /^[\x21-\x7e]{1,128}$/.test(client) ? client : `h:${createHash('sha256').update(client).digest('base64url')}`;
}

export function createFailureBudget(options: FailureBudgetOptions): FailureBudget {
  const windowMs = options.windowMs ?? WINDOW_MS;
  const clients = new Map<string, Budget>();
  let global: Budget = { used: 0, resetAt: 0 };

  function fresh(budget: Budget | undefined, now: number): Budget {
    return budget && budget.resetAt > now ? budget : { used: 0, resetAt: now + windowMs };
  }

  function prune(now: number): void {
    for (const [key, budget] of clients) {
      if (budget.resetAt <= now) clients.delete(key);
    }
    // Still full of live windows: drop the oldest.
    while (clients.size >= MAX_TRACKED_CLIENTS) {
      const oldest = clients.keys().next().value;
      if (oldest === undefined) break;
      clients.delete(oldest);
    }
  }

  // One process: today's in-memory windows.
  function reserveLocal(client: string, now: number): BudgetRefund | null {
    global = fresh(global, now);
    const own = fresh(clients.get(client), now);
    if (global.used >= options.globalMax || own.used >= options.clientMax) return null;

    if (!clients.has(client)) prune(now);
    own.used++;
    global.used++;
    clients.set(client, own);

    const reservedGlobal = global;
    let refunded = false;
    return async () => {
      if (refunded) return;
      refunded = true;
      own.used = Math.max(0, own.used - 1);
      reservedGlobal.used = Math.max(0, reservedGlobal.used - 1);
    };
  }

  // Several replicas: one atomic reservation over the client's and the
  // global counter; a refused attempt counts nowhere.
  async function reserveShared(client: string, now: number): Promise<BudgetRefund | null> {
    const limits: CounterLimit[] = [{ key: `budget:${options.name}:client:${clientKey(client)}`, max: options.clientMax, windowMs }];
    if (Number.isFinite(options.globalMax)) {
      limits.push({ key: `budget:${options.name}:all`, max: options.globalMax, windowMs });
    }
    const store = getStore();
    const result = await store.counters.reserve(limits, now);
    if (!result.ok) return null;
    let refunded = false;
    return async () => {
      if (refunded) return;
      refunded = true;
      try {
        // Only from the windows the attempt was counted in.
        await store.counters.refund(limits.map((limit, i) => ({ key: limit.key, resetAt: result.resetAts[i] })), now);
      } catch (error) {
        // The attempt stays counted: the safe side.
        logger.warn('Could not refund a sign-in attempt', {
          budget: options.name,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    };
  }

  return {
    async reserve(client: string, now: number = Date.now()): Promise<BudgetRefund | null> {
      return isSharedMode() ? reserveShared(client, now) : reserveLocal(client, now);
    },
  };
}

const verifyBudget = createFailureBudget({ name: 'verify', clientMax: CLIENT_MAX_FAILURES, globalMax: GLOBAL_MAX_FAILURES });

/**
 * Reserve one probe for `client`. Resolves to null when the client or the
 * whole server is over budget; otherwise to a function that refunds the
 * probe, to be called when the credentials turned out to be right.
 */
export function reserveVerifyProbe(client: string, now: number = Date.now()): Promise<BudgetRefund | null> {
  return verifyBudget.reserve(client, now);
}

/**
 * The sign-in routes themselves (/api/auth/session, /api/auth/stalwart-context,
 * /api/auth/totp-token-exchange) forward the credential to the mail server
 * exactly like the pre-check does, so they are the same password oracle and
 * burn the same upstream failure allowance. They have no browser-side
 * fallback, so a client over budget gets a 429 instead of an answer. There is
 * no global ceiling here: one would let a handful of wrong passwords lock
 * every user out of signing in for the window, which is the outcome this
 * guards against. The real client address is forwarded upstream instead (see
 * lib/auth/client-address.ts), so a mail server that trusts this host
 * attributes the failures to the client that caused them.
 */
const loginBudget = createFailureBudget({ name: 'login', clientMax: CLIENT_MAX_FAILURES, globalMax: Infinity });

/**
 * Networks on LOGIN_RATE_LIMIT_ALLOWLIST skip the sign-in budget. Everyone
 * behind one NAT address (an office, a branch) shares a client key, so one
 * person retrying an old password would otherwise block every colleague
 * there from signing in for the rest of the window. The list is parsed again
 * only when the variable changes. An entry it cannot use is logged and
 * ignored, so a malformed one exempts nobody.
 */
interface Allowlist {
  v4: BlockList;
  v6: BlockList;
}

let allowlist: { raw: string; networks: Allowlist | null } | undefined;

/** An IPv4 address written as IPv6 (::ffff:192.0.2.1), in any spelling. */
function isV4Mapped(address: string): boolean {
  const groups = parseV6Groups(address);
  return !!groups && groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
}

function addAllowlistEntry(networks: Allowlist, entry: string): boolean {
  const slash = entry.indexOf('/');
  const address = slash < 0 ? entry : entry.slice(0, slash);
  const family = isIP(address);
  // A zone id names an interface of this host, never a remote client. IPv4
  // networks must be written as IPv4: a client is matched only against its
  // own family, so ::ffff:192.0.2.0/120 would silently match nobody.
  if (family === 0 || address.includes('%') || (family === 6 && isV4Mapped(address))) return false;
  const list = family === 6 ? networks.v6 : networks.v4;
  const type = family === 6 ? 'ipv6' : 'ipv4';
  try {
    if (slash < 0) {
      list.addAddress(address, type);
      return true;
    }
    // Plain digits without a leading zero, so neither "/" nor "/00" becomes /0.
    const prefix = entry.slice(slash + 1);
    if (!/^(0|[1-9]\d{0,2})$/.test(prefix) || Number(prefix) > (family === 6 ? 128 : 32)) return false;
    list.addSubnet(address, Number(prefix), type);
    return true;
  } catch {
    return false;
  }
}

function allowlistedNetworks(): Allowlist | null {
  const raw = process.env.LOGIN_RATE_LIMIT_ALLOWLIST ?? '';
  if (allowlist?.raw === raw) return allowlist.networks;
  const networks: Allowlist = { v4: new BlockList(), v6: new BlockList() };
  let entries = 0;
  for (const entry of raw.split(/[\s,]+/).filter(Boolean)) {
    if (addAllowlistEntry(networks, entry)) entries++;
    else logger.warn('LOGIN_RATE_LIMIT_ALLOWLIST: ignoring an invalid entry', { entry });
  }
  allowlist = { raw, networks: entries > 0 ? networks : null };
  return allowlist.networks;
}

/**
 * True when `client` is an address inside a network on
 * LOGIN_RATE_LIMIT_ALLOWLIST. A client is matched only against entries of its
 * own family: ::/0 covers every IPv6 client and no IPv4 one, and an
 * IPv4-mapped client counts as its IPv4 address. A zone id is refused; it
 * never belongs to a remote client, and Node may shorten a long address in
 * front of it.
 */
export function isExemptFromLoginBudget(client: string): boolean {
  const networks = allowlistedNetworks();
  const family = isIP(client);
  if (!networks || family === 0 || client.includes('%')) return false;
  if (family === 4) return networks.v4.check(client, 'ipv4');
  return isV4Mapped(client) ? networks.v4.check(client, 'ipv6') : networks.v6.check(client, 'ipv6');
}

export async function reserveLoginAttempt(client: string, now: number = Date.now()): Promise<BudgetRefund | null> {
  // Nothing reserved, so nothing to refund.
  if (isExemptFromLoginBudget(client)) return async () => {};
  return loginBudget.reserve(client, now);
}

/** Seconds a client over budget is told to wait (Retry-After). */
export const LOGIN_BUDGET_RETRY_AFTER_SECONDS = Math.ceil(WINDOW_MS / 1000);
