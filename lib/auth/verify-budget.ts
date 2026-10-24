import { BlockList, isIP } from 'node:net';
import { logger } from '@/lib/logger';
import { parseV6Groups } from '@/lib/security/ip-ranges';

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
 */

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
  /** Failures one client may cause per window. */
  clientMax: number;
  /** Failures all clients together may cause per window; `Infinity` for no ceiling. */
  globalMax: number;
  windowMs?: number;
}

export interface FailureBudget {
  /**
   * Reserve one attempt for `client`. Returns null when the client or the
   * whole server is over budget; otherwise a function that refunds the
   * attempt, to be called when the credentials turned out to be right.
   */
  reserve(client: string, now?: number): (() => void) | null;
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

  return {
    reserve(client: string, now: number = Date.now()): (() => void) | null {
      global = fresh(global, now);
      const own = fresh(clients.get(client), now);
      if (global.used >= options.globalMax || own.used >= options.clientMax) return null;

      if (!clients.has(client)) prune(now);
      own.used++;
      global.used++;
      clients.set(client, own);

      const reservedGlobal = global;
      let refunded = false;
      return () => {
        if (refunded) return;
        refunded = true;
        own.used = Math.max(0, own.used - 1);
        reservedGlobal.used = Math.max(0, reservedGlobal.used - 1);
      };
    },
  };
}

const verifyBudget = createFailureBudget({ clientMax: CLIENT_MAX_FAILURES, globalMax: GLOBAL_MAX_FAILURES });

/**
 * Reserve one probe for `client`. Returns null when the client or the whole
 * server is over budget; otherwise a function that refunds the probe, to be
 * called when the credentials turned out to be right.
 */
export function reserveVerifyProbe(client: string, now: number = Date.now()): (() => void) | null {
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
const loginBudget = createFailureBudget({ clientMax: CLIENT_MAX_FAILURES, globalMax: Infinity });

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

export function reserveLoginAttempt(client: string, now: number = Date.now()): (() => void) | null {
  // Nothing reserved, so nothing to refund.
  if (isExemptFromLoginBudget(client)) return () => {};
  return loginBudget.reserve(client, now);
}

/** Seconds a client over budget is told to wait (Retry-After). */
export const LOGIN_BUDGET_RETRY_AFTER_SECONDS = Math.ceil(WINDOW_MS / 1000);
