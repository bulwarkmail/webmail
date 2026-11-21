import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { verifyCurrentAdminSession } from '@/lib/admin/session';
import { ADMIN_SESSION_COOKIE } from '@/lib/admin/types';
import { loginClientAddress } from '@/lib/auth/client-address';
import { decryptSession } from '@/lib/auth/crypto';
import { canSeeInstanceDetails } from '@/lib/auth/instance-details';
import { sessionCookieName } from '@/lib/auth/session-cookie';
import { hasSessionSecret } from '@/lib/auth/session-secret';
import { getStore } from '@/lib/shared-store';
import { readStalwartAuthContextFromStore } from '@/lib/stalwart/auth-context';

/**
 * Who /api/bimi and /api/favicon answer, and how much each caller may ask
 * of them. The mail view uses both, as <img> and fetch() on the webmail's
 * own pages, signed in. The mobile app (0.1.88 and later) loads brand logos
 * from /api/bimi with its native HTTP client and no webmail session. For
 * anyone else these routes would make this server ask DNS and outside hosts
 * about names the caller picks, and fill the caches all users share.
 *
 * The server can't tell the app from another client that sends the same
 * request, and a client address is whatever a caller with many addresses
 * (or, on a server reached without a reverse proxy, with an
 * X-Forwarded-For of its own) makes it. So all callers without a session
 * together get a small share that signed-in users never draw on: the
 * ceilings here and in lib/bimi/lookup.ts (SESSIONLESS_MAX_IN_FLIGHT,
 * SESSIONLESS_MAX_DRAWINGS, SESSIONLESS_CACHE_MAX).
 */

/** Uncached lookups one signed-in mailbox may start per minute, per route. */
export const LOOKUPS_PER_MINUTE = 60;
/**
 * The same for a client without a session (the mobile app), per client
 * address. Keeps one app, or several behind one address, from using up the
 * minute of all the others below.
 */
export const SESSIONLESS_LOOKUPS_PER_MINUTE = 30;
/**
 * Uncached lookups all clients without a session may start per minute,
 * whatever addresses they come from. Protects the DNS servers and logo
 * hosts this server would otherwise ask on a stranger's behalf without
 * bound, and its own outbound connections.
 */
export const SESSIONLESS_LOOKUPS_PER_MINUTE_TOTAL = 60;
/**
 * Lookups one caller may have running at once, per route: well below what
 * the routes run in all (64), so one caller can't take every slot.
 */
export const RUNNING_PER_CALLER = 16;
/**
 * The same for one client address without a session. All of them together
 * run at most SESSIONLESS_MAX_IN_FLIGHT (lib/bimi/lookup.ts).
 */
export const SESSIONLESS_RUNNING_PER_CALLER = 4;
/** A running lookup that is never given back (a crash) stops counting after this. */
const RUNNING_WINDOW_MS = 5 * 60_000;

/** For refusals and for "nothing looked up yet": never kept by a cache. */
export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * Headers by which a browser says where a request comes from. A native
 * HTTP client sends none of them. A browser leaves them all out of an image
 * request when it has no fetch metadata to send (a webmail on plain http,
 * an older browser) and the page asked for no referrer.
 */
const BROWSER_CONTEXT_HEADERS = ['origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'];
/**
 * How every browser's User-Agent starts. A page or frame can't change it on
 * a request to another origin; the app's HTTP clients (OkHttp, CFNetwork)
 * send their own.
 */
const BROWSER_USER_AGENT = /^\s*mozilla\//i;

export interface SenderIconCaller {
  /** Whose budgets a lookup spends, hashed: every mailbox (and the admin) signed in, or one client address. */
  owners: string[];
  /** No session: the mobile app. It gets the logo itself and nothing more. */
  sessionless: boolean;
}

export type SenderIconAccess = { caller: SenderIconCaller } | { refusal: NextResponse };

const ownerKey = (owner: string) => createHash('sha256').update(owner).digest('base64url').slice(0, 22);

function mailboxOwner(serverUrl: string, username: string): string {
  return `mailbox:${serverUrl.trim().replace(/\/+$/, '').toLowerCase()}\n${username.trim().toLowerCase()}`;
}

/**
 * Every identity the server can verify in the request's cookies: each
 * slot's context and remembered session (by mail server and login name, so
 * one mailbox is one owner whichever slot or cookie holds it), and the
 * admin. Nothing the caller writes in a header counts.
 */
async function sessionOwners(request: NextRequest): Promise<string[]> {
  if (!hasSessionSecret()) return [];
  // The context reader only calls get() on the jar, which the request's own cookies have.
  const jar = request.cookies as unknown as Parameters<typeof readStalwartAuthContextFromStore>[0];
  const owners = new Set<string>();
  for (let slot = 0; slot < MAX_ACCOUNT_SLOTS; slot++) {
    const context = readStalwartAuthContextFromStore(jar, slot);
    if (context) owners.add(mailboxOwner(context.serverUrl, context.username));
    const remembered = request.cookies.get(sessionCookieName(slot))?.value;
    const session = remembered ? decryptSession(remembered) : null;
    if (session) owners.add(mailboxOwner(session.serverUrl, session.username));
  }
  const admin = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  if (admin && (await verifyCurrentAdminSession(admin)) !== null) owners.add('admin');
  return [...owners].map(ownerKey);
}

/**
 * Who is asking, or the refusal. A browser marks where a request comes from
 * in Sec-Fetch-Site: only the webmail's own pages (same-origin) are served,
 * not another site, a sandboxed plugin frame or an address typed into the
 * address bar; a request without the header (an older browser) is judged by
 * its session alone. The session is checked as /api/plugins checks it.
 *
 * Without a session, /api/bimi still serves a request that carries none of
 * the headers a browser page or frame sends (Origin, Referer, Sec-Fetch-*)
 * and no browser's User-Agent: that is the mobile app, or a client built to
 * look like it. It is counted per client address as the sign-in limits
 * count it, and with every other such caller against the ceilings they
 * share.
 */
export async function senderIconAccess(request: NextRequest, route: 'bimi' | 'favicon'): Promise<SenderIconAccess> {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return { refusal: new NextResponse(null, { status: 403, headers: NO_STORE }) };
  if (await canSeeInstanceDetails(request)) {
    const owners = await sessionOwners(request);
    // No owner only where no session can be told apart (no session secret).
    return { caller: { owners: owners.length > 0 ? owners : [ownerKey(`address:${loginClientAddress(request)}`)], sessionless: false } };
  }
  if (
    route === 'bimi'
    && BROWSER_CONTEXT_HEADERS.every((name) => !request.headers.has(name))
    && !BROWSER_USER_AGENT.test(request.headers.get('user-agent') ?? '')
  ) {
    return { caller: { owners: [ownerKey(`sessionless:${loginClientAddress(request)}`)], sessionless: true } };
  }
  return { refusal: new NextResponse(null, { status: 401, headers: NO_STORE }) };
}

export interface LookupLease {
  /**
   * Whether the caller may start one more uncached lookup now: within every
   * owner's budget for the minute and under its count of running lookups,
   * and for a caller without a session within the minute all of them share.
   * When the counts can't be kept (the shared store is down) the answer is no.
   */
  take(): Promise<boolean>;
  /** The lookup is over: its running count is given back. */
  release(): Promise<void>;
}

/** One lookup's share of the caller's budget and running count on `route`. */
export function lookupLease(caller: SenderIconCaller, route: 'bimi' | 'favicon'): LookupLease {
  const perMinute = caller.sessionless ? SESSIONLESS_LOOKUPS_PER_MINUTE : LOOKUPS_PER_MINUTE;
  const running = caller.sessionless ? SESSIONLESS_RUNNING_PER_CALLER : RUNNING_PER_CALLER;
  let held: Array<{ key: string; resetAt: number }> = [];
  return {
    async take() {
      const budgets = caller.owners.map((owner) => ({ key: `sender-icon-lookups:${route}:${owner}`, max: perMinute, windowMs: 60_000 }));
      // One reservation covers every count: when the shared minute is spent, no address's counter is touched.
      if (caller.sessionless) budgets.push({ key: `sender-icon-lookups:${route}:sessionless`, max: SESSIONLESS_LOOKUPS_PER_MINUTE_TOTAL, windowMs: 60_000 });
      const counts = caller.owners.map((owner) => ({ key: `sender-icon-running:${route}:${owner}`, max: running, windowMs: RUNNING_WINDOW_MS }));
      try {
        const result = await getStore().counters.reserve([...budgets, ...counts]);
        if (!result.ok) return false;
        held = counts.map((count, i) => ({ key: count.key, resetAt: result.resetAts[budgets.length + i] }));
        return true;
      } catch {
        return false;
      }
    },
    async release() {
      const entries = held;
      held = [];
      if (entries.length > 0) await getStore().counters.refund(entries).catch(() => {});
    },
  };
}
