import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { getClientIP } from '@/lib/admin/session';
import { canSeeInstanceDetails } from '@/lib/auth/instance-details';
import { getStore } from '@/lib/shared-store';
import { readStalwartAuthContextFromStore } from '@/lib/stalwart/auth-context';

/**
 * Who /api/bimi and /api/favicon answer. Only the mail view uses them, as
 * <img> and fetch() on the webmail's own pages, signed in; for anyone else
 * they would make this server ask DNS and outside hosts about names the
 * caller picks, and fill the caches all users share.
 */

/** Uncached lookups one signed-in user may start per minute, per route. */
export const LOOKUPS_PER_MINUTE = 60;

/** For refusals and for "nothing looked up yet": never kept by a cache. */
export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * A refusal for a request the sender icon routes don't serve, or null.
 * A browser marks where a request comes from in Sec-Fetch-Site: only the
 * webmail's own pages (same-origin) are served, not another site, a
 * sandboxed plugin frame or an address typed into the address bar. A
 * request without the header (an older browser) is judged by its session
 * alone. The session is checked as /api/plugins checks it.
 */
export async function refuseSenderIconRequest(request: NextRequest): Promise<NextResponse | null> {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return new NextResponse(null, { status: 403, headers: NO_STORE });
  if (!(await canSeeInstanceDetails(request))) return new NextResponse(null, { status: 401, headers: NO_STORE });
  return null;
}

/** The mailbox the request is signed in to, else the client's address. */
function budgetOwner(request: NextRequest): string {
  // The context reader only calls get() on the jar, which the request's own cookies have.
  const jar = request.cookies as unknown as Parameters<typeof readStalwartAuthContextFromStore>[0];
  for (let slot = 0; slot < MAX_ACCOUNT_SLOTS; slot++) {
    const context = readStalwartAuthContextFromStore(jar, slot);
    if (context) return `user:${context.serverUrl}\n${context.accountName ?? context.username}`;
  }
  return `ip:${getClientIP(request)}`;
}

/**
 * Whether the caller may start one more uncached lookup on `route` now.
 * Counted per signed-in mailbox (60 a minute), so one user can't hold all
 * of the server's lookup slots. When the count can't be kept (the shared
 * store is down) the answer is no.
 */
export async function takeLookupBudget(request: NextRequest, route: 'bimi' | 'favicon'): Promise<boolean> {
  const owner = createHash('sha256').update(budgetOwner(request)).digest('base64url').slice(0, 22);
  try {
    const { ok } = await getStore().counters.reserve([
      { key: `sender-icon-lookups:${route}:${owner}`, max: LOOKUPS_PER_MINUTE, windowMs: 60_000 },
    ]);
    return ok;
  } catch {
    return false;
  }
}
