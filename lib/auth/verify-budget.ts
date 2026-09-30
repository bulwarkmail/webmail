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

const clients = new Map<string, Budget>();
let global: Budget = { used: 0, resetAt: 0 };

function fresh(budget: Budget | undefined, now: number): Budget {
  return budget && budget.resetAt > now ? budget : { used: 0, resetAt: now + WINDOW_MS };
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

/**
 * Reserve one probe for `client`. Returns null when the client or the whole
 * server is over budget; otherwise a function that refunds the probe, to be
 * called when the credentials turned out to be right.
 */
export function reserveVerifyProbe(client: string, now: number = Date.now()): (() => void) | null {
  global = fresh(global, now);
  const own = fresh(clients.get(client), now);
  if (global.used >= GLOBAL_MAX_FAILURES || own.used >= CLIENT_MAX_FAILURES) return null;

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
}
