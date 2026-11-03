import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { configManager } from '@/lib/admin/config-manager';
import { resolvePolicy } from '@/lib/admin/policy-scopes';
import { strictDeviceSubject } from '@/lib/admin/server-device-policy';
import { forwardedClientHeaders, loginClientAddress } from '@/lib/auth/client-address';
import { loginFingerprint } from '@/lib/pwa-notify/login-fingerprint';
import { UPSTREAM_JSON_MAX_BYTES, UpstreamBodyTooLargeError, readBodyCapped, readJsonCapped } from '@/lib/security/capped-body';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { DisallowedUrlError } from '@/lib/security/url-guard';
import { readStalwartAuthContextFromStore, type StalwartAuthContext } from '@/lib/stalwart/auth-context';
import { rebaseApiUrl } from '@/lib/stalwart/jmap-api';
import type { SettingsPolicy } from '@/lib/admin/types';
import { fetchJmapServer, isTrustedJmapServerUrl } from '@/lib/stalwart/server-fetch';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];
const MAIL_CAPABILITY = 'urn:ietf:params:jmap:mail';
const MAX_BODY_BYTES = 4096;
/** RFC 8620 ids, which is all an email or account id can be. */
const JMAP_ID = /^[A-Za-z0-9_-]{1,255}$/;
const MAILBOX_PROPERTIES = ['id', 'name', 'parentId', 'role', 'myRights'];

type ArchiveMode = 'single' | 'year' | 'month';

interface ActionRequest {
  action: 'mark-read' | 'archive';
  accountId: string;
  emailId: string;
  login: string;
  archiveMode: ArchiveMode;
  timeZone?: string;
}

interface JmapMailbox {
  id: string;
  name: string;
  parentId?: string | null;
  role?: string | null;
  myRights?: { mayAddItems?: boolean };
}

type MethodResponse = [string, Record<string, unknown>, string];

const fail = (status: number, error: string) =>
  NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });

function validTimeZone(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return undefined;
  }
}

async function readActionRequest(request: Request): Promise<ActionRequest | null> {
  const bytes = await readBodyCapped(request, MAX_BODY_BYTES);
  if (!bytes) return null;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const { action, accountId, emailId, login, archiveMode } = body;
  if (action !== 'mark-read' && action !== 'archive') return null;
  if (typeof accountId !== 'string' || !JMAP_ID.test(accountId)) return null;
  if (typeof emailId !== 'string' || !JMAP_ID.test(emailId)) return null;
  if (typeof login !== 'string' || !login) return null;
  return {
    action,
    accountId,
    emailId,
    login,
    archiveMode: archiveMode === 'year' || archiveMode === 'month' ? archiveMode : 'single',
    timeZone: validTimeZone(body.timeZone),
  };
}

function emailSetOutcome(set: Record<string, unknown> | undefined, emailId: string): 'updated' | 'notFound' | 'refused' {
  const { updated, notUpdated } = (set ?? {}) as {
    updated?: Record<string, unknown> | null;
    notUpdated?: Record<string, { type?: string }> | null;
  };
  if (updated && Object.prototype.hasOwnProperty.call(updated, emailId)) return 'updated';
  return notUpdated?.[emailId]?.type === 'notFound' ? 'notFound' : 'refused';
}

/** The signed-in logins this browser's cookies name as `login`: the notification's own, or none. */
async function loginsNamed(login: string): Promise<StalwartAuthContext[]> {
  const cookieStore = await cookies();
  const found: StalwartAuthContext[] = [];
  for (let slot = 0; slot < MAX_ACCOUNT_SLOTS; slot++) {
    const ctx = readStalwartAuthContextFromStore(cookieStore, slot);
    if (ctx && (await loginFingerprint(ctx.serverUrl, ctx.username)) === login) found.push(ctx);
  }
  return found;
}

/**
 * The policy for this login's scopes. The worker's copies of the settings
 * decide what a toast offers; this decides what works. Null when the scopes
 * can't be worked out, and then nothing is done from here.
 */
async function policyFor(ctx: StalwartAuthContext, trusted: boolean): Promise<SettingsPolicy | null> {
  await configManager.ensureLoaded();
  const subject = await strictDeviceSubject({ ...ctx, trusted });
  return subject ? resolvePolicy(configManager.getPolicy(), subject).policy : null;
}

/** The year and month a message falls in where the user is. */
function dateParts(receivedAt: string, timeZone: string | undefined): { year: string; month: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone ?? 'UTC', year: 'numeric', month: '2-digit' })
    .formatToParts(new Date(receivedAt));
  return {
    year: parts.find((part) => part.type === 'year')?.value ?? '',
    month: parts.find((part) => part.type === 'month')?.value ?? '',
  };
}

/**
 * Where Archive files a message, as the app's own Archive does
 * (JMAPClient.archiveEmails, ensureArchiveMailbox): the Archive folder, or a
 * year or year/month folder in it, creating what isn't there. Creation ids
 * resolve in the request that carries the Mailbox/set.
 */
function archiveDestination(
  mailboxes: JmapMailbox[],
  mode: ArchiveMode,
  receivedAt: string,
  timeZone: string | undefined,
): { destination: string; create: Record<string, Record<string, unknown>> } {
  const create: Record<string, Record<string, unknown>> = {};
  const archive = mailboxes.find((m) => m.role === 'archive')
    ?? mailboxes.find((m) => m.name.toLowerCase() === 'archive');
  let destination = archive?.id ?? '#archive';
  if (!archive) create.archive = { name: 'Archive', parentId: null, role: 'archive' };

  const descend = (name: string, cid: string) => {
    const existing = destination.startsWith('#')
      ? undefined
      : mailboxes.find((m) => m.parentId === destination && m.name === name);
    if (existing) {
      destination = existing.id;
      return;
    }
    create[cid] = { name, parentId: destination };
    destination = `#${cid}`;
  };
  if (mode !== 'single') {
    const { year, month } = dateParts(receivedAt, timeZone);
    descend(year, 'year');
    if (mode === 'month') descend(month, 'month');
  }
  return { destination, create };
}

/**
 * POST /api/push/action
 *
 * A notification's Mark read or Archive when no tab is open to do it. The
 * service worker has no login of its own, only the context cookie, whose
 * token a page refreshes and which ends with the browser session. Every
 * refusal here means the same to the worker: open the message in the app.
 *
 * Like /api/push/preview it never hands the worker a credential. The cookie
 * is sent because the request is same-origin; the proxy and this handler both
 * refuse any other. Plugins run in pages, so the worker doesn't come here while
 * an enabled plugin may stop or watch these actions.
 */
export async function POST(request: NextRequest) {
  const rejected = rejectCrossOriginRequest(request);
  if (rejected) return rejected;
  try {
    const body = await readActionRequest(request);
    if (!body) return fail(400, 'Invalid request');

    const logins = await loginsNamed(body.login);
    if (logins.length === 0) return fail(401, 'Not authenticated');
    if (logins.length > 1) return fail(409, 'Login is in more than one cookie slot');
    const ctx = logins[0];

    const serverUrl = ctx.serverUrl.replace(/\/+$/, '');
    const trusted = await isTrustedJmapServerUrl(serverUrl);
    const forwarded = forwardedClientHeaders(loginClientAddress(request));
    const sessionRes = await fetchJmapServer(`${serverUrl}/.well-known/jmap`, {
      headers: { Authorization: ctx.authHeader, ...forwarded },
    }, trusted);
    // An expired token (only a page refreshes it), or a password changed since.
    if (sessionRes.status === 401 || sessionRes.status === 403) return fail(401, 'Not authenticated');
    if (!sessionRes.ok) return fail(502, 'JMAP session failed');
    const session = (await readJsonCapped(sessionRes, UPSTREAM_JSON_MAX_BYTES)) as {
      apiUrl?: string;
      primaryAccounts?: Record<string, string>;
      accounts?: Record<string, { accountCapabilities?: Record<string, { mayCreateTopLevelMailbox?: boolean }> }>;
    };
    const apiUrl = rebaseApiUrl(session, serverUrl);
    if (!apiUrl) return fail(502, 'JMAP session failed');
    // The worker named this account; it has to be one this login can reach.
    const { accountId, emailId } = body;
    const account = session.accounts && Object.prototype.hasOwnProperty.call(session.accounts, accountId)
      ? session.accounts[accountId]
      : undefined;
    if (!account && session.primaryAccounts?.[MAIL_CAPABILITY] !== accountId) {
      return fail(403, 'Account is not in this login');
    }

    // A session limit is the page's to apply (activity, sign-in time): acting
    // from here would keep a login going past it. The app opens and applies it.
    const policy = await policyFor(ctx, trusted);
    const limits = policy?.organisation?.session;
    if (!policy || (limits?.maxHours ?? 0) > 0 || (limits?.idleMinutes ?? 0) > 0) return fail(401, 'Not authenticated');
    if (body.action === 'archive' && policy.features?.archiveActionEnabled === false) return fail(403, 'Archive is turned off');

    const jmap = async (methodCalls: unknown[]): Promise<MethodResponse[] | null> => {
      const res = await fetchJmapServer(apiUrl, {
        method: 'POST',
        headers: { Authorization: ctx.authHeader, 'Content-Type': 'application/json', ...forwarded },
        body: JSON.stringify({ using: USING, methodCalls }),
      }, trusted);
      if (!res.ok) return null;
      const data = (await readJsonCapped(res, UPSTREAM_JSON_MAX_BYTES)) as { methodResponses?: MethodResponse[] };
      return Array.isArray(data.methodResponses) ? data.methodResponses : null;
    };
    const result = (responses: MethodResponse[], name: string, id: string) =>
      responses.find(([method, , callId]) => method === name && callId === id)?.[1];

    const readFolders = async (): Promise<JmapMailbox[] | null> => {
      const read = await jmap([['Mailbox/get', { accountId, ids: null, properties: MAILBOX_PROPERTIES }, 'mailboxes']]);
      const list = read && result(read, 'Mailbox/get', 'mailboxes')?.list;
      return Array.isArray(list) ? (list as JmapMailbox[]) : null;
    };

    const read = await jmap([
      ['Mailbox/get', { accountId, ids: null, properties: MAILBOX_PROPERTIES }, 'mailboxes'],
      ['Email/get', { accountId, ids: [emailId], properties: ['id', 'receivedAt', 'mailboxIds'] }, 'email'],
    ]);
    if (!read) return fail(502, 'JMAP request failed');
    let mailboxes = result(read, 'Mailbox/get', 'mailboxes')?.list as JmapMailbox[] | undefined;
    const emails = result(read, 'Email/get', 'email')?.list as { receivedAt?: string; mailboxIds?: Record<string, boolean> }[] | undefined;
    if (!Array.isArray(mailboxes) || !Array.isArray(emails)) return fail(502, 'JMAP request failed');
    const email = emails[0];
    if (!email?.receivedAt) return fail(404, 'Message not found');
    // Since the notification it may have gone to Trash or Junk: not for a toast
    // to bring back or to mark. The app opens it.
    const bins = new Set(mailboxes.filter((m) => m.role === 'trash' || m.role === 'junk').map((m) => m.id));
    if (Object.keys(email.mailboxIds ?? {}).some((id) => bins.has(id))) return fail(409, 'Message is in Trash or Junk');

    let answer: ReturnType<typeof emailSetOutcome> = 'refused';
    const createdFolders: string[] = [];
    // Twice at most: another client may make the same folder between our read
    // and our write, and then the folder is there to file into.
    for (let attempt = 0; attempt < 2; attempt++) {
      let update: Record<string, unknown> = { 'keywords/$seen': true };
      let create: Record<string, Record<string, unknown>> = {};
      if (body.action === 'archive') {
        const planned = archiveDestination(mailboxes, body.archiveMode, email.receivedAt, body.timeZone);
        // Only an explicit refusal stops it, as in the app.
        if (planned.create.archive && account?.accountCapabilities?.[MAIL_CAPABILITY]?.mayCreateTopLevelMailbox === false) {
          return fail(403, 'Archive folder is missing');
        }
        if (mailboxes.find((m) => m.id === planned.destination)?.myRights?.mayAddItems === false) {
          return fail(403, 'Archive folder is read-only');
        }
        create = planned.create;
        update = { mailboxIds: { [planned.destination]: true } };
      }
      const written = await jmap([
        ...(Object.keys(create).length > 0 ? [['Mailbox/set', { accountId, create }, 'folders']] : []),
        ['Email/set', { accountId, update: { [emailId]: update } }, 'write'],
      ]);
      if (!written) return fail(502, 'JMAP request failed');
      const folders = result(written, 'Mailbox/set', 'folders') as {
        created?: Record<string, { id?: string }> | null;
        notCreated?: Record<string, unknown> | null;
      } | undefined;
      // Deepest first, for removing them again.
      for (const cid of ['month', 'year', 'archive']) {
        const id = folders?.created?.[cid]?.id;
        if (id) createdFolders.push(id);
      }
      answer = emailSetOutcome(result(written, 'Email/set', 'write'), emailId);
      if (answer !== 'refused' || Object.keys(folders?.notCreated ?? {}).length === 0 || attempt > 0) break;
      const fresh = await readFolders();
      if (!fresh) break;
      mailboxes = fresh;
    }

    if (answer === 'updated') return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    // Nothing went in: no empty folder left behind. The server refuses to
    // destroy one someone else has filed into since.
    if (createdFolders.length > 0) await jmap([['Mailbox/set', { accountId, destroy: createdFolders }, 'cleanup']]).catch(() => null);
    if (answer === 'notFound') return fail(404, 'Message not found');
    return fail(502, 'JMAP server refused the change');
  } catch (error) {
    if (error instanceof DisallowedUrlError) {
      logger.warn('push action refused non-public server address', { error: error.message });
      return fail(502, 'JMAP server address is not allowed');
    }
    if (error instanceof UpstreamBodyTooLargeError) {
      logger.warn('push action: JMAP response too large', { maxBytes: error.maxBytes });
      return fail(502, 'JMAP server response is too large');
    }
    const err = error as Error & { cause?: { code?: string; message?: string } };
    logger.error('push action failed', { error: err?.message ?? 'Unknown error', causeCode: err?.cause?.code });
    return fail(500, 'Internal error');
  }
}
