import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { cleanPreview } from '@/lib/utils';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { readStalwartAuthContextFromStore } from '@/lib/stalwart/auth-context';
import {
  getStalwartCredentials,
  type StalwartCredentials,
} from '@/lib/stalwart/credentials';
import { fetchJmapServer, isTrustedJmapServerUrl } from '@/lib/stalwart/server-fetch';
import { rebaseApiUrl } from '@/lib/stalwart/jmap-api';
import { forwardedClientHeaders, loginClientAddress } from '@/lib/auth/client-address';
import { DisallowedUrlError } from '@/lib/security/url-guard';
import { UPSTREAM_JSON_MAX_BYTES, UpstreamBodyTooLargeError, readJsonCapped } from '@/lib/security/capped-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ResolvedTarget {
  authHeader: string;
  apiUrl: string;
  accountId: string;
  /** See StalwartCredentials.trusted - false routes through the guarded fetch. */
  trusted: boolean;
  /**
   * Cookie slot of the login that owns the account. Handed back so a click
   * on the notification opens the message in that login: the worker knows
   * only the JMAP account id, which can repeat across servers.
   */
  slot?: number;
}

// When the SW passes ?accountId=, we need the slot whose JMAP session owns
// that account - not just "the first signed-in slot", which is what
// getStalwartCredentials() defaults to. Probe each candidate's session in
// parallel and return the first match, the login whose own account it is
// ahead of the others: an account with a folder shared out is listed in the
// session of everyone it is shared with, who sees only that folder - not its
// Inbox, nor the message that just arrived there.
//
// The push names nothing but the account id, and ids repeat across servers
// (and a group account is listed by each member). When that leaves more than
// one login, answer 'ambiguous' rather than guess: a wrong guess previews
// another login's mail and opens it there.
async function resolveTargetForAccount(accountId: string, forwarded: Record<string, string>): Promise<ResolvedTarget | 'ambiguous' | null> {
  const cookieStore = await cookies();
  const probes: Promise<{ target: ResolvedTarget; own: boolean } | null>[] = [];
  for (let slot = 0; slot < MAX_ACCOUNT_SLOTS; slot++) {
    const ctx = readStalwartAuthContextFromStore(cookieStore, slot);
    if (!ctx) continue;
    const serverUrl = ctx.serverUrl.replace(/\/+$/, '');
    probes.push(
      (async () => {
        try {
          const trusted = await isTrustedJmapServerUrl(serverUrl);
          const res = await fetchJmapServer(`${serverUrl}/.well-known/jmap`, {
            headers: { Authorization: ctx.authHeader, ...forwarded },
          }, trusted);
          if (!res.ok) return null;
          const session = (await readJsonCapped(res, UPSTREAM_JSON_MAX_BYTES)) as {
            apiUrl?: string;
            primaryAccounts?: Record<string, string>;
            accounts?: Record<string, unknown>;
          };
          const mailAccountId = session.primaryAccounts?.['urn:ietf:params:jmap:mail'];
          // On the host this process reaches, not the server's public one (#627).
          const apiUrl = rebaseApiUrl(session, serverUrl);
          if (!apiUrl || !mailAccountId) return null;
          // Shared and group mailboxes are never the primary mail account -
          // they only appear in session.accounts. Accept those too, or the
          // SW falls back to a generic "New mail" notification for them. (#839)
          const isSharedAccount =
            accountId !== mailAccountId &&
            Object.prototype.hasOwnProperty.call(session.accounts ?? {}, accountId);
          if (mailAccountId !== accountId && !isSharedAccount) return null;
          return {
            target: { authHeader: ctx.authHeader, apiUrl, accountId, trusted, slot },
            own: mailAccountId === accountId,
          };
        } catch {
          return null;
        }
      })(),
    );
  }
  const results = (await Promise.all(probes)).filter((r) => r !== null);
  const owners = results.filter((r) => r.own);
  if (owners.length === 1) return owners[0].target;
  if (results.length === 1) return results[0].target;
  return results.length > 1 ? 'ambiguous' : null;
}

async function resolveDefaultTarget(creds: StalwartCredentials, forwarded: Record<string, string>): Promise<ResolvedTarget | null> {
  const sessionRes = await fetchJmapServer(`${creds.serverUrl}/.well-known/jmap`, {
    headers: { Authorization: creds.authHeader, ...forwarded },
  }, creds.trusted);
  if (!sessionRes.ok) return null;
  const session = (await readJsonCapped(sessionRes, UPSTREAM_JSON_MAX_BYTES)) as {
    apiUrl?: string;
    primaryAccounts?: Record<string, string>;
  };
  const apiUrl = rebaseApiUrl(session, creds.serverUrl);
  const accountId = session.primaryAccounts?.['urn:ietf:params:jmap:mail'];
  if (!apiUrl || !accountId) return null;
  return { authHeader: creds.authHeader, apiUrl, accountId, trusted: creds.trusted };
}

/**
 * GET /api/push/preview
 *
 * Called from the service worker when a Web Push wake-up arrives. Fetches the
 * latest unread email so the SW can build an enriched system notification
 * (sender, subject, avatar) without ever exposing JMAP credentials to the
 * SW context.
 *
 * The relay's push payload is intentionally minimal (just a state-change
 * ping), so this is what makes "From: Alice / Subject: …" appear instead of
 * a generic "New mail" string.
 */
export async function GET(request: NextRequest) {
  try {
    // SW passes ?accountId=<jmap-account-id> derived from the push payload's
    // StateChange so multi-account browsers fetch from the right slot. Older
    // clients (and the manual /api/push/preview probe) omit it and fall back
    // to the first signed-in slot.
    const requestedAccountId = request.nextUrl.searchParams.get('accountId');
    // With a server-side delivery filter (draft-ietf-jmap-emailpush) the push
    // carries the id of the message that was actually delivered, so the SW
    // asks for that one instead of guessing "newest unread in the Inbox" -
    // which is wrong whenever Sieve filed the new message into a folder.
    const requestedEmailId = request.nextUrl.searchParams.get('emailId');
    const forwarded = forwardedClientHeaders(loginClientAddress(request));

    let target: ResolvedTarget | null = null;
    let authHeader: string;
    if (requestedAccountId) {
      const resolved = await resolveTargetForAccount(requestedAccountId, forwarded);
      if (!resolved) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
      }
      // The service worker shows its generic notification, and a click opens
      // the app without switching login.
      if (resolved === 'ambiguous') {
        return NextResponse.json({ error: 'Account is in more than one signed-in login' }, { status: 409 });
      }
      target = resolved;
      authHeader = target.authHeader;
    } else {
      const creds = await getStalwartCredentials(request);
      if (!creds) {
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
      }
      target = await resolveDefaultTarget(creds, forwarded);
      if (!target) {
        return NextResponse.json({ error: 'JMAP session failed' }, { status: 502 });
      }
      authHeader = creds.authHeader;
    }

    const { apiUrl, accountId, trusted } = target;

    const inboxRes = await fetchJmapServer(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        ...forwarded,
      },
      body: JSON.stringify({
        using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
        methodCalls: [
          [
            'Mailbox/query',
            { accountId, filter: { role: 'inbox' }, limit: 1 },
            'mb',
          ],
        ],
      }),
    }, trusted);

    if (!inboxRes.ok) {
      return NextResponse.json({ error: 'JMAP mailbox query failed' }, { status: 502 });
    }

    const inboxData = (await readJsonCapped(inboxRes, UPSTREAM_JSON_MAX_BYTES)) as {
      methodResponses: [string, Record<string, unknown>, string][];
    };

    const inboxBody = inboxData.methodResponses.find(
      ([method, , callId]) => method === 'Mailbox/query' && callId === 'mb',
    )?.[1] as { ids?: string[] } | undefined;

    // A method-level JMAP error still has HTTP 200. Do not turn it into
    // an empty Inbox: the service worker would silently discard the push.
    if (!Array.isArray(inboxBody?.ids)) {
      return NextResponse.json({ error: 'JMAP mailbox query failed' }, { status: 502 });
    }

    const inboxId = inboxBody.ids[0];
    const emailProperties = ['id', 'threadId', 'from', 'subject', 'preview', 'receivedAt'];

    if (!inboxId && !requestedEmailId) {
      return NextResponse.json({
        email: null,
        unreadTotal: 0,
      }, {
        headers: {
          'Cache-Control': 'no-store',
        },
      });
    }

    // Pull the most recent unread message from the resolved Inbox mailbox
    // (and its unread total for the "+N more" line). When the SW named the
    // delivered message, fetch that one too and prefer it.
    const methodCalls: unknown[] = [];
    if (inboxId) {
      methodCalls.push(
        [
          'Email/query',
          {
            accountId,
            filter: {
              operator: 'AND',
              conditions: [
                { inMailbox: inboxId },
                { notKeyword: '$seen' },
              ],
            },
            sort: [{ property: 'receivedAt', isAscending: false }],
            limit: 1,
            calculateTotal: true,
          },
          'eq',
        ],
        [
          'Email/get',
          {
            accountId,
            '#ids': { resultOf: 'eq', name: 'Email/query', path: '/ids' },
            properties: emailProperties,
          },
          'eg',
        ],
      );
    }
    if (requestedEmailId) {
      methodCalls.push([
        'Email/get',
        { accountId, ids: [requestedEmailId], properties: emailProperties },
        'delivered',
      ]);
    }
    const requestBody = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls,
    };

    const jmapRes = await fetchJmapServer(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        ...forwarded,
      },
      body: JSON.stringify(requestBody),
    }, trusted);
    if (!jmapRes.ok) {
      return NextResponse.json({ error: 'JMAP request failed' }, { status: 502 });
    }
    const data = (await readJsonCapped(jmapRes, UPSTREAM_JSON_MAX_BYTES)) as {
      methodResponses: [string, Record<string, unknown>, string][];
    };

    // Missing/failed method responses are preview failures, not proof that
    // there is no unread mail. A non-2xx response lets the SW show its fallback.
    // The message the server named, once read, is a complete preview on its
    // own, whatever became of the Inbox lookups next to it.
    const resultOf = (name: string, id: string) =>
      data.methodResponses.find(([method, , callId]) => method === name && callId === id)?.[1];
    const failed = (methodCalls as [string, unknown, string][]).some(([name, , id]) => {
      const result = resultOf(name, id);
      return !result || (name === 'Email/query' ? !Array.isArray(result.ids) : !Array.isArray(result.list));
    });
    const deliveredList = resultOf('Email/get', 'delivered')?.list;
    if (failed && !(Array.isArray(deliveredList) && deliveredList.length > 0)) {
      return NextResponse.json({ error: 'JMAP email query failed' }, { status: 502 });
    }

    type EmailLite = {
      id: string;
      threadId: string;
      from?: { name?: string | null; email?: string }[] | null;
      subject?: string | null;
      preview?: string | null;
      receivedAt?: string | null;
    };

    let email: EmailLite | null = null;
    let delivered: EmailLite | null = null;
    let unreadTotal = 0;
    for (const [method, body, callId] of data.methodResponses) {
      if (method === 'Email/query') {
        // A server that leaves out the optional total still lists the ids.
        const query = body as { total?: number; ids?: unknown[] };
        unreadTotal = typeof query.total === 'number' ? query.total : (query.ids?.length ?? 0);
      }
      if (method === 'Email/get') {
        const list = (body as { list?: EmailLite[] }).list ?? [];
        if (callId === 'delivered') delivered = list[0] ?? null;
        else email = list[0] ?? null;
      }
    }
    // The message the server said it delivered beats "newest unread in the
    // Inbox" - it may have been filed elsewhere by Sieve. Keep the Inbox
    // unread total for the group line; count the delivered one if it isn't
    // already in it (unread total is Inbox-scoped).
    if (delivered) {
      if (!email || email.id !== delivered.id) {
        unreadTotal = Math.max(unreadTotal, 1);
      }
      email = delivered;
    } else if (requestedEmailId) {
      // The server named the message that arrived and it could not be read -
      // deleted since, or filed where this login cannot see it. "Newest unread
      // in the Inbox" is then some other message, and announcing it would be
      // confidently wrong. Name no message: the unread total still comes back,
      // so the SW posts its generic toast instead of staying silent.
      email = null;
    }

    // Some servers build the preview from HTML without skipping <style>; a
    // notification that opens on a style sheet says nothing.
    if (email?.preview) email = { ...email, preview: cleanPreview(email.preview) };

    return NextResponse.json({
      email,
      unreadTotal,
      ...(target.slot !== undefined ? { slot: target.slot } : {}),
    }, {
      headers: {
        // SW already gates on its own logic - don't let push events get
        // cached and served stale.
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof DisallowedUrlError) {
      logger.warn('push preview refused non-public server address', { error: error.message });
      return NextResponse.json({ error: 'JMAP server address is not allowed' }, { status: 502 });
    }
    if (error instanceof UpstreamBodyTooLargeError) {
      logger.warn('push preview: JMAP response too large', { maxBytes: error.maxBytes });
      return NextResponse.json({ error: 'JMAP server response is too large' }, { status: 502 });
    }
    // `fetch failed` from undici is too generic to debug - the real reason
    // (ENOTFOUND, ECONNREFUSED, TLS error, …) is on `error.cause`.
    const err = error as Error & { cause?: { code?: string; message?: string } };
    logger.error('push preview failed', {
      error: err?.message ?? 'Unknown error',
      causeCode: err?.cause?.code,
      causeMessage: err?.cause?.message,
    });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
