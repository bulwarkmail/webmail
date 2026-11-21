import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { cleanPreview } from '@/lib/utils';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { readPushAuthContext } from '@/lib/stalwart/push-auth-context';
import { renewPushAuthHeader } from '@/lib/stalwart/push-token-renewal';
import type { StalwartAuthContext } from '@/lib/stalwart/auth-context';
import {
  getStalwartCredentials,
  type StalwartCredentials,
} from '@/lib/stalwart/credentials';
import { fetchJmapServer, isTrustedJmapServerUrl } from '@/lib/stalwart/server-fetch';
import { rebaseApiUrl } from '@/lib/stalwart/jmap-api';
import { forwardedClientHeaders, loginClientAddress } from '@/lib/auth/client-address';
import { DisallowedUrlError } from '@/lib/security/url-guard';
import { UPSTREAM_JSON_MAX_BYTES, UpstreamBodyTooLargeError, readJsonCapped } from '@/lib/security/capped-body';
import { serverDevicePolicy } from '@/lib/admin/server-device-policy';
import { loginFingerprint } from '@/lib/pwa-notify/login-fingerprint';
import { NOTE_KEYWORD } from '@/lib/team-mailboxes/hidden-folders';
import { NOTE_HEADER_PROPERTIES as H, mentionKeyword, parseMentions, stripAngles } from '@/lib/team-mailboxes/note-format';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Team notes (lib/team-mailboxes/note-format.ts) ─────────────────────────

/**
 * How far back a push without a message id looks for a note that mentions the
 * login: as long as the relay keeps a push (its TTL). The service worker tells
 * each note once.
 */
const MENTION_LOOKBACK_MS = 60 * 60_000;

/** What says a message is a note and whom it mentions; nothing about its author or topic. */
const NOTE_PROPERTIES = ['keywords', 'messageId', H.kind, H.mentions, H.for, H.thread];

/** "You were mentioned": the note, and the message it is about. */
interface NoteMention {
  noteId: string;
  /**
   * The note's own Message-ID: Undo brings a deleted note back with a new id
   * and the same Message-ID, and the service worker tells it once by either.
   */
  messageId?: string;
  /** The conversation the note is about, in this account. */
  threadId?: string;
  /** Message-ID of the message it is about (or `jmap:<account>/<id>`). */
  forKey: string;
  /** The message it is about, in this account, when it could be found. */
  emailId?: string;
  /** Who wrote it; left out under "Push without sender and subject". */
  from?: string;
  /** What it is about, without "Note: "; left out under that policy too. */
  subject?: string;
}

/** The mention as the service worker gets it. */
type MentionAnswer = Omit<NoteMention, 'forKey'>;

type RawEmail = Record<string, unknown>;
type MethodResponse = [string, Record<string, unknown>, string];

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isNote(raw: RawEmail): boolean {
  return (raw.keywords as Record<string, unknown> | undefined)?.[NOTE_KEYWORD] === true;
}

/**
 * The mention of `principalId` in this note, or null. Only a note of kind
 * `note` mentions anyone: an `assigned` entry names its assignee in the same
 * header, and that is no mention.
 */
function mentionIn(raw: RawEmail, principalId: string, redacted: boolean, own: readonly string[]): NoteMention | null {
  if (textValue(raw[H.kind])?.toLowerCase() !== 'note') return null;
  if (!parseMentions(raw[H.mentions]).includes(principalId)) return null;
  const noteId = textValue(raw.id);
  const forKey = stripAngles(textValue(raw[H.for]) ?? '');
  if (!noteId || !forKey) return null;
  const sender = Array.isArray(raw.from) ? (raw.from[0] as { name?: unknown; email?: unknown } | undefined) : undefined;
  // Mentioning yourself tells nobody. Without the sender read (the policy), the server checks it.
  if (own.includes(textValue(sender?.email)?.toLowerCase() ?? '')) return null;
  const mention: NoteMention = { noteId, forKey };
  const messageId = Array.isArray(raw.messageId) && typeof raw.messageId[0] === 'string' ? stripAngles(raw.messageId[0]) : '';
  if (messageId) mention.messageId = messageId;
  const threadId = textValue(raw[H.thread]);
  if (threadId) mention.threadId = threadId;
  if (!redacted) {
    const from = textValue(sender?.name) ?? textValue(sender?.email);
    if (from) mention.from = from;
    const subject = typeof raw.subject === 'string' ? raw.subject.replace(/^\s*Note:\s?/, '').trim() : '';
    if (subject) mention.subject = subject;
  }
  return mention;
}

/**
 * The addresses a note by this login is written from: the login's own
 * (lib/team-mailboxes/note-format.ts writes From as the login address).
 * Only real addresses, since a `from` filter matches words too.
 */
function ownAddresses(target: { username: string; accountName?: string }): string[] {
  return [...new Set([target.username, target.accountName].map((a) => (a ?? '').trim().toLowerCase()).filter((a) => a.includes('@')))];
}

/** "Not written by this login", as a server-side condition: nothing about the sender is read. */
function notFrom(own: readonly string[]): Record<string, unknown>[] {
  return own.length > 0 ? [{ operator: 'NOT', conditions: own.map((address) => ({ from: address })) }] : [];
}

/** A message that isn't a note goes back as before, without what was read to tell. */
function withoutNoteProperties<T extends object>(email: T): T {
  const rest = { ...email } as Record<string, unknown>;
  for (const property of NOTE_PROPERTIES) delete rest[property];
  return rest as T;
}

/**
 * For a push without a message id in a group account: the newest note of the
 * last hour that mentions this login (the service worker announces each note
 * once), and the newest note and the newest Inbox message, whose times say
 * which of them came last. Times are the server's, so a push that arrives
 * late still compares the same.
 */
function noteLookups(accountId: string, principalId: string, own: readonly string[], inboxId: string | undefined, redacted: boolean, now: number): unknown[] {
  const since = (ms: number) => new Date(now - ms).toISOString();
  const calls: unknown[] = [
    ['Email/query', {
      accountId,
      filter: {
        operator: 'AND',
        conditions: [{ hasKeyword: NOTE_KEYWORD }, { hasKeyword: mentionKeyword(principalId) }, { after: since(MENTION_LOOKBACK_MS) }, ...notFrom(own)],
      },
      sort: [{ property: 'receivedAt', isAscending: false }],
      limit: 1,
    }, 'mq'],
    ['Email/get', {
      accountId,
      '#ids': { resultOf: 'mq', name: 'Email/query', path: '/ids' },
      properties: [...(redacted ? ['id', 'receivedAt'] : ['id', 'receivedAt', 'from', 'subject']), ...NOTE_PROPERTIES],
    }, 'mg'],
    ...newestOf(accountId, { hasKeyword: NOTE_KEYWORD }, 'n'),
    ...(inboxId ? newestOf(accountId, { inMailbox: inboxId }, 'i') : []),
  ];
  return calls;
}

/** The newest message matching `filter`, with its time only: `<prefix>q` and `<prefix>g`. */
function newestOf(accountId: string, filter: Record<string, unknown>, prefix: string): unknown[] {
  return [
    ['Email/query', { accountId, filter, sort: [{ property: 'receivedAt', isAscending: false }], limit: 1 }, `${prefix}q`],
    ['Email/get', { accountId, '#ids': { resultOf: `${prefix}q`, name: 'Email/query', path: '/ids' }, properties: ['id', 'receivedAt'] }, `${prefix}g`],
  ];
}

/**
 * The message a note is about, for the click. Header queries find nothing on
 * Stalwart (headers aren't indexed by default), so it goes by the note's
 * thread header: Thread/get, then the message with the note's Message-ID, or
 * the thread's newest when none matches. Without a thread, the mention still
 * goes out and the click opens the Inbox.
 */
async function messageOfNote(
  mention: NoteMention,
  accountId: string,
  request: (calls: unknown[]) => Promise<MethodResponse[]>,
): Promise<NoteMention> {
  const ownKey = `jmap:${accountId}/`;
  if (mention.forKey.startsWith(ownKey)) {
    const emailId = mention.forKey.slice(ownKey.length);
    return emailId ? { ...mention, emailId } : mention;
  }
  if (!mention.threadId) return mention;
  try {
    const responses = await request([
      ['Thread/get', { accountId, ids: [mention.threadId] }, 'th'],
      ['Email/get', { accountId, '#ids': { resultOf: 'th', name: 'Thread/get', path: '/list/*/emailIds' }, properties: ['id', 'messageId'] }, 'tm'],
    ]);
    const thread = responses.find(([name, , id]) => name === 'Thread/get' && id === 'th')?.[1];
    const emailIds = ((thread?.list as Array<{ emailIds?: unknown }> | undefined)?.[0]?.emailIds ?? []) as unknown[];
    const ids = emailIds.filter((id): id is string => typeof id === 'string');
    const messages = (responses.find(([name, , id]) => name === 'Email/get' && id === 'tm')?.[1]?.list ?? []) as Array<{ id?: unknown; messageId?: unknown }>;
    const match = messages.find((m) => Array.isArray(m.messageId)
      && m.messageId.some((value) => typeof value === 'string' && stripAngles(value) === mention.forKey));
    // Thread/get lists the messages oldest first.
    const emailId = typeof match?.id === 'string' ? match.id : ids[ids.length - 1];
    return emailId ? { ...mention, emailId } : mention;
  } catch (error) {
    logger.warn('push preview: the message of a note could not be found', { error: (error as Error)?.message });
    return mention;
  }
}

interface ResolvedTarget {
  authHeader: string;
  apiUrl: string;
  accountId: string;
  /** See StalwartCredentials.trusted - false routes through the guarded fetch. */
  trusted: boolean;
  /** The login, for its device policy. */
  serverUrl: string;
  username: string;
  accountName?: string;
  /**
   * The login's own principal id (its primary mail account id): who the push
   * is for, which a team note's mentions name.
   */
  principalId: string;
  /**
   * Cookie slot of the login that owns the account. Handed back so a click
   * on the notification opens the message in that login: the worker knows
   * only the JMAP account id, which can repeat across servers.
   */
  slot?: number;
}

type CookieStore = Awaited<ReturnType<typeof cookies>>;

/**
 * The login's JMAP session, and the Authorization header that opened it. A
 * token sign-in's access token expires within the hour, and with no tab open
 * nothing renews it: the mail server turns it away and the push gets the
 * worker's generic notification (#1509). Renewed here then, once, when
 * `mayRenew` says this is the login the push is for.
 */
async function openSession(
  cookieStore: CookieStore,
  slot: number,
  ctx: StalwartAuthContext,
  serverUrl: string,
  trusted: boolean,
  forwarded: Record<string, string>,
  basePath: string | undefined,
  mayRenew: boolean,
): Promise<{ res: Response; authHeader: string }> {
  const get = (authHeader: string) => fetchJmapServer(`${serverUrl}/.well-known/jmap`, {
    headers: { Authorization: authHeader, ...forwarded },
  }, trusted);
  const res = await get(ctx.authHeader);
  if (res.status !== 401 || !mayRenew) return { res, authHeader: ctx.authHeader };
  const renewed = await renewPushAuthHeader(cookieStore, slot, ctx, basePath);
  if (!renewed) return { res, authHeader: ctx.authHeader };
  return { res: await get(renewed), authHeader: renewed };
}

// When the SW passes ?accountId=, we need the slot whose JMAP session owns
// that account - not just "the first signed-in slot", which is what
// getStalwartCredentials() defaults to. Probe each candidate's session in
// parallel and return the first match, the login whose own account it is
// ahead of the others: an account with a folder shared out is listed in the
// session of everyone it is shared with, who sees only that folder - not its
// Inbox, nor the message that just arrived there.
//
// Ids repeat across servers (and a group account is listed by each member), so
// the account id alone can leave several logins. On one server, the push's label
// names the login that registered it and settles it. Not across servers: logins
// with the same account id share one relay record in this browser (lib/web-push.ts
// keys it by account id), so the label is only whoever registered last. Whatever
// doesn't fit answers 'ambiguous' rather than guess: a wrong guess previews another
// login's mail and opens it there.
async function resolveTargetForAccount(accountId: string, login: string | null, forwarded: Record<string, string>, basePath: string | undefined): Promise<ResolvedTarget | 'ambiguous' | null> {
  const cookieStore = await cookies();
  const contexts: { slot: number; ctx: StalwartAuthContext }[] = [];
  for (let slot = 0; slot < MAX_ACCOUNT_SLOTS; slot++) {
    const ctx = await readPushAuthContext(cookieStore, slot);
    if (ctx) contexts.push({ slot, ctx });
  }
  // Renewing writes a slot's rotated tokens into this answer. Every expired
  // login at once could outgrow a proxy's header buffer, and an answer lost
  // after the providers rotated leaves the browser with spent refresh tokens.
  // So only the login the push names, or the only one there is (#1509).
  const named = login?.toLowerCase();
  const mayRenew = (ctx: StalwartAuthContext) => (named
    ? ctx.username.toLowerCase() === named || ctx.accountName?.toLowerCase() === named
    : contexts.length === 1);
  const probes: Promise<{ target: ResolvedTarget; own: boolean } | null>[] = [];
  for (const { slot, ctx } of contexts) {
    const serverUrl = ctx.serverUrl.replace(/\/+$/, '');
    probes.push(
      (async () => {
        try {
          const trusted = await isTrustedJmapServerUrl(serverUrl);
          const { res, authHeader } = await openSession(cookieStore, slot, ctx, serverUrl, trusted, forwarded, basePath, mayRenew(ctx));
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
            target: { authHeader, apiUrl, accountId, trusted, slot, serverUrl, username: ctx.username, accountName: ctx.accountName, principalId: mailAccountId },
            own: mailAccountId === accountId,
          };
        } catch {
          return null;
        }
      })(),
    );
  }
  const results = (await Promise.all(probes)).filter((r) => r !== null);
  if (login && results.length > 0) {
    const name = login.toLowerCase();
    const named = results.filter((r) => r.target.username.toLowerCase() === name || r.target.accountName?.toLowerCase() === name);
    const servers = new Set(results.map((r) => r.target.serverUrl));
    if (named.length !== 1 || servers.size > 1) return 'ambiguous';
    return named[0].target;
  }
  const owners = results.filter((r) => r.own);
  if (owners.length === 1) return owners[0].target;
  if (results.length === 1) return results[0].target;
  return results.length > 1 ? 'ambiguous' : null;
}

async function resolveDefaultTarget(creds: StalwartCredentials, forwarded: Record<string, string>, basePath: string | undefined): Promise<ResolvedTarget | null> {
  const { res: sessionRes, authHeader } = await openSession(await cookies(), creds.slot, creds, creds.serverUrl, creds.trusted, forwarded, basePath, true);
  if (!sessionRes.ok) return null;
  const session = (await readJsonCapped(sessionRes, UPSTREAM_JSON_MAX_BYTES)) as {
    apiUrl?: string;
    primaryAccounts?: Record<string, string>;
  };
  const apiUrl = rebaseApiUrl(session, creds.serverUrl);
  const accountId = session.primaryAccounts?.['urn:ietf:params:jmap:mail'];
  if (!apiUrl || !accountId) return null;
  return { authHeader, apiUrl, accountId, trusted: creds.trusted, serverUrl: creds.serverUrl, username: creds.username, accountName: creds.accountName, principalId: accountId };
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
  // The preview may renew a login's token (#1509), which spends its refresh
  // token at the provider. GET passes the same-origin gate of the other auth
  // routes, so a page elsewhere could make the browser do that with a link.
  // The service worker's own fetch is same-origin.
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin') {
    return NextResponse.json({ error: 'Cross-origin request' }, { status: 403 });
  }
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
    const basePath = request.nextUrl.basePath;

    let target: ResolvedTarget | null = null;
    let authHeader: string;
    if (requestedAccountId) {
      const resolved = await resolveTargetForAccount(requestedAccountId, request.nextUrl.searchParams.get('login'), forwarded, basePath);
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
      target = await resolveDefaultTarget(creds, forwarded, basePath);
      if (!target) {
        return NextResponse.json({ error: 'JMAP session failed' }, { status: 502 });
      }
      authHeader = target.authHeader;
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
    // Organisation > Devices > Push without sender and subject, for this
    // login's scopes (worked out from its own session): the message's
    // sender, subject and text are never read, so they can't reach the
    // notification, the push service or the lock screen. Unknown counts as on.
    // `locked=1`: the app lock hides content on this device. The worker still
    // asks, so a team note can stay silent or say only "you were mentioned",
    // and the answer is the one this policy gives.
    const locked = request.nextUrl.searchParams.get('locked') === '1';
    const redacted = locked || await serverDevicePolicy({
      serverUrl: target.serverUrl,
      authHeader,
      username: target.username,
      accountName: target.accountName,
      trusted,
    }).then((devices) => devices.pushWithoutContent, () => true);
    const emailProperties = redacted
      ? ['id', 'threadId', 'receivedAt']
      : ['id', 'threadId', 'from', 'subject', 'preview', 'receivedAt'];

    // Team notes live in group accounts and wake every member's push (Stalwart
    // 0.16 sends a plain state change for each). Without a message id, the
    // account is searched for a fresh note that mentions this login.
    const principalId = target.principalId.toLowerCase();
    const lookForNotes = !requestedEmailId && accountId.toLowerCase() !== principalId;
    // A note this login wrote never tells it of itself.
    const own = ownAddresses(target);

    if (!inboxId && !requestedEmailId && !lookForNotes) {
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
                { notKeyword: NOTE_KEYWORD },
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
        // Whether it is a team note, and whom it mentions: neither says who
        // wrote it or what it is about.
        { accountId, ids: [requestedEmailId], properties: [...emailProperties, ...NOTE_PROPERTIES] },
        'delivered',
      ]);
    }
    // Not part of the mail answer: when these fail, the push is told about as before.
    const noteCalls: unknown[] = lookForNotes ? noteLookups(accountId, principalId, own, inboxId, redacted, Date.now()) : [];
    const requestBody = {
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [...methodCalls, ...noteCalls],
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
    // The Inbox's unread count as the server gave it, for the app badge
    // (public/sw.js). Only a real total: the ids list stops at the limit.
    let inboxUnread: number | undefined;
    for (const [method, body, callId] of data.methodResponses) {
      if (method === 'Email/query' && callId === 'eq') {
        // A server that leaves out the optional total still lists the ids.
        const query = body as { total?: number; ids?: unknown[] };
        unreadTotal = typeof query.total === 'number' ? query.total : (query.ids?.length ?? 0);
        if (typeof query.total === 'number') inboxUnread = query.total;
      }
      if (method === 'Email/get' && (callId === 'eg' || callId === 'delivered')) {
        const list = (body as { list?: EmailLite[] }).list ?? [];
        if (callId === 'delivered') delivered = list[0] ?? null;
        else email = list[0] ?? null;
      }
    }

    const headers = { 'Cache-Control': 'no-store' };
    const login = async () => (target.slot !== undefined ? { login: await loginFingerprint(target.serverUrl, target.username) } : {});
    const withSlot = target.slot !== undefined ? { slot: target.slot } : {};
    const jmap = async (calls: unknown[]): Promise<MethodResponse[]> => {
      const res = await fetchJmapServer(apiUrl, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/json', ...forwarded },
        body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'], methodCalls: calls }),
      }, trusted);
      if (!res.ok) return [];
      return ((await readJsonCapped(res, UPSTREAM_JSON_MAX_BYTES)) as { methodResponses?: MethodResponse[] }).methodResponses ?? [];
    };
    // What goes back: never the Message-ID of the message the note is about.
    const findMessage = async (mention: NoteMention): Promise<MentionAnswer> => {
      const { forKey: _forKey, ...answer } = await messageOfNote(mention, accountId, jmap);
      return answer;
    };

    // A team note that arrived: only the members it mentions hear of it, and
    // nobody hears of it as mail.
    if (delivered && isNote(delivered)) {
      let mentioned = mentionIn(delivered, principalId, redacted, own);
      // The sender wasn't read (the policy): ask the server whether this login
      // wrote it. Each note is a thread of its own (no In-Reply-To or References).
      if (mentioned && redacted && own.length > 0 && delivered.threadId) {
        const answer = await jmap([['Email/query', {
          accountId,
          filter: { operator: 'AND', conditions: [{ inThread: delivered.threadId }, { hasKeyword: NOTE_KEYWORD }, ...notFrom(own)] },
          limit: 1,
        }, 'own']]).catch(() => []);
        const ids = answer.find(([name, , id]) => name === 'Email/query' && id === 'own')?.[1]?.ids;
        // Can't tell: told, as a mention is worth more than a stray one.
        if (Array.isArray(ids) && !ids.includes(delivered.id)) mentioned = null;
      }
      if (!mentioned) return NextResponse.json({ skip: true }, { headers });
      // `skip` too: whatever else the worker makes of it, this is no mail.
      return NextResponse.json({
        skip: true,
        mention: await findMessage(mentioned),
        ...(redacted ? { redacted: true } : {}),
        ...withSlot,
        ...(await login()),
      }, { headers });
    }
    if (delivered) delivered = withoutNoteProperties(delivered);

    // No message named (a state change): the newest note of the last minutes
    // that mentions this login, and whether a note rather than mail woke us.
    let mention: MentionAnswer | null = null;
    let noteWokeUs = false;
    if (lookForNotes) {
      const mentionList = resultOf('Email/get', 'mg')?.list;
      const found = Array.isArray(mentionList) ? (mentionList[0] as Record<string, unknown> | undefined) : undefined;
      const candidate = found && isNote(found) ? mentionIn(found, principalId, redacted, own) : null;
      if (candidate) mention = await findMessage(candidate);
      // A note newer than anything in the Inbox: nothing came there since.
      // Either lookup failing leaves the answer as it was (the mail).
      const newestAt = (prefix: string): number | null | undefined => {
        const list = resultOf('Email/get', `${prefix}g`)?.list;
        if (!Array.isArray(list)) return undefined;
        const at = Date.parse(String((list[0] as { receivedAt?: unknown } | undefined)?.receivedAt ?? ''));
        return Number.isFinite(at) ? at : null;
      };
      const noteAt = newestAt('n');
      const mailAt = inboxId ? newestAt('i') : null;
      noteWokeUs = typeof noteAt === 'number' && mailAt !== undefined && (mailAt === null || noteAt > mailAt);
    }
    // A note woke us and no mail came with it: the Inbox's newest unread
    // message is old news, so it isn't offered.
    if (noteWokeUs) {
      return NextResponse.json({
        skip: true,
        ...(mention ? { mention } : {}),
        ...(redacted ? { redacted: true } : {}),
        ...withSlot,
        ...(mention ? await login() : {}),
      }, { headers });
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
    // Whatever the server sent anyway, only what a click needs goes back.
    if (redacted && email) email = { id: email.id, threadId: email.threadId, receivedAt: email.receivedAt ?? null };

    return NextResponse.json({
      email,
      unreadTotal,
      ...(inboxUnread !== undefined ? { inboxUnread } : {}),
      ...(redacted ? { redacted: true } : {}),
      ...withSlot,
      // For the notification's buttons, which must not land on whoever signs
      // into this slot later (app/api/push/action).
      ...(email || mention ? await login() : {}),
      // The service worker announces it once (by note id), then the mail as usual.
      ...(mention ? { mention } : {}),
    }, {
      // SW already gates on its own logic - don't let push events get
      // cached and served stale.
      headers,
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
