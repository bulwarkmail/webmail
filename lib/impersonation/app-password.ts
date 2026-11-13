import { fetchJmapSession, postJmap, rebaseApiUrl } from '@/lib/stalwart/jmap-api';
import { logger } from '@/lib/logger';

const STALWART_USING = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'];

/**
 * How long an impersonation handoff stays valid. Stalwart enforces it through
 * the app password's `expiresAt`, so the session ends even if the browser
 * keeps the cookie alive.
 */
export const IMPERSONATION_SESSION_TTL_SEC = 8 * 60 * 60;

/** Every impersonation app password's description starts with this. */
export const IMPERSONATION_DESCRIPTION_PREFIX = 'Support session ';

export class ImpersonationCredentialError extends Error {
  /** The HTTP status of Stalwart's answer, when it answered with an error status. */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ImpersonationCredentialError';
    if (status !== undefined) this.status = status;
  }
}

export interface ImpersonationCredential {
  id: string;
  secret: string;
  expiresAt: string;
}

/** Basic auth header for Stalwart master-user login as `mailbox`. */
export function masterAuthHeader(mailbox: string, masterUser: string, masterPassword: string): string {
  return `Basic ${Buffer.from(`${mailbox}%${masterUser}:${masterPassword}`).toString('base64')}`;
}

/** JMAP UTCDate: no fractional seconds (RFC 8620 section 1.4). */
function utcDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function pickAccountId(primaryAccounts: Record<string, string> | undefined): string | null {
  if (!primaryAccounts) return null;
  return (
    primaryAccounts['urn:ietf:params:jmap:mail'] ??
    primaryAccounts['urn:stalwart:jmap'] ??
    Object.values(primaryAccounts)[0] ??
    null
  );
}

async function callStalwart(
  serverUrl: string,
  authHeader: string,
  methodCall: [string, Record<string, unknown>, string],
  trusted = true,
): Promise<Record<string, unknown>> {
  const session = await fetchJmapSession(serverUrl, authHeader, { trusted });
  const accountId = pickAccountId(session?.primaryAccounts);
  if (!session || !accountId) {
    throw new ImpersonationCredentialError('Could not open the target mailbox with the master credential');
  }
  const apiUrl = rebaseApiUrl(session, serverUrl) ?? `${serverUrl}/jmap/`;
  const [method, args, callId] = methodCall;
  const response = await postJmap(
    apiUrl,
    authHeader,
    JSON.stringify({ using: STALWART_USING, methodCalls: [[method, { accountId, ...args }, callId]] }),
    { trusted },
  );
  if (!response.ok) {
    throw new ImpersonationCredentialError(`Stalwart answered HTTP ${response.status}`, response.status);
  }
  const data = (await response.json()) as { methodResponses?: [string, Record<string, unknown>, string][] };
  const result = data.methodResponses?.[0];
  if (!result || result[0] === 'error') {
    const detail = result?.[1] as { type?: string; description?: string } | undefined;
    throw new ImpersonationCredentialError(detail?.description || detail?.type || 'Unexpected JMAP response');
  }
  return result[1];
}

/**
 * Create an app password on the mailbox `authHeader` opens. Without
 * `expiresAt` it lives until the user deletes it. Without `permissions` it
 * has the account's rights; with them only those (Stalwart's `Replace`; it
 * refuses any the account lacks). `trusted` is false for a user-chosen
 * server, which must be reached through the rebinding-safe fetch.
 */
export async function createAppPassword(opts: {
  serverUrl: string;
  authHeader: string;
  description: string;
  expiresAt?: string;
  permissions?: Record<string, true>;
  trusted?: boolean;
}): Promise<{ id: string; secret: string }> {
  const result = await callStalwart(
    opts.serverUrl,
    opts.authHeader,
    [
      'x:AppPassword/set',
      {
        create: {
          imp: {
            description: opts.description,
            ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
            ...(opts.permissions ? { permissions: { '@type': 'Replace', permissions: opts.permissions } } : {}),
          },
        },
      },
      '0',
    ],
    opts.trusted ?? true,
  );
  const created = (result.created as Record<string, { id?: string; secret?: string }> | undefined)?.imp;
  if (!created?.id || !created.secret) {
    const failed = (result.notCreated as Record<string, { type?: string; description?: string }> | undefined)?.imp;
    throw new ImpersonationCredentialError(failed?.description || failed?.type || 'App password was not created');
  }
  if (opts.permissions) await keepOnlyIfLimited({ ...opts, id: created.id, permissions: opts.permissions });
  return { id: created.id, secret: created.secret };
}

/**
 * Read back what Stalwart made, and delete it again unless it is limited to
 * the permissions asked for. A server that ignored `permissions` (an older
 * release) would otherwise hand out the account's full rights unnoticed.
 */
async function keepOnlyIfLimited(opts: {
  serverUrl: string;
  authHeader: string;
  id: string;
  permissions: Record<string, true>;
  trusted?: boolean;
}): Promise<void> {
  let limited = false;
  try {
    const result = await callStalwart(
      opts.serverUrl,
      opts.authHeader,
      ['x:AppPassword/get', { ids: [opts.id], properties: ['permissions'] }, '0'],
      opts.trusted ?? true,
    );
    const item = (result.list as { id?: string; permissions?: unknown }[] | undefined)?.find((p) => p.id === opts.id);
    limited = isLimitedTo(item?.permissions, opts.permissions);
  } catch {
    // Not readable is not known to be limited.
  }
  if (limited) return;
  try {
    await deleteAppPassword({ serverUrl: opts.serverUrl, authHeader: opts.authHeader, id: opts.id, trusted: opts.trusted });
  } catch {
    // Reported below; the user can still delete it under Settings → Security.
  }
  throw new ImpersonationCredentialError('The mail server did not limit the app password to the permissions asked for');
}

/** `Replace` with no permission beyond those asked for (Stalwart may grant fewer, never more). */
function isLimitedTo(stored: unknown, asked: Record<string, true>): boolean {
  if (!stored || typeof stored !== 'object') return false;
  const { '@type': type, permissions } = stored as { '@type'?: unknown; permissions?: unknown };
  if (type !== 'Replace' || !permissions || typeof permissions !== 'object') return false;
  return Object.entries(permissions).every(([name, on]) => on !== true || asked[name] === true);
}

/** Delete an app password on the mailbox `authHeader` opens. */
export async function deleteAppPassword(opts: {
  serverUrl: string;
  authHeader: string;
  id: string;
  trusted?: boolean;
}): Promise<void> {
  const result = await callStalwart(
    opts.serverUrl,
    opts.authHeader,
    ['x:AppPassword/set', { destroy: [opts.id] }, '0'],
    opts.trusted ?? true,
  );
  const destroyed = result.destroyed as string[] | undefined;
  if (!destroyed?.includes(opts.id)) {
    const failed = (result.notDestroyed as Record<string, { type?: string; description?: string }> | undefined)?.[opts.id];
    throw new ImpersonationCredentialError(failed?.description || failed?.type || 'App password was not deleted');
  }
}

/**
 * Use the master credential server-side, once, to create an expiring app
 * password on the target mailbox. The browser only ever receives this app
 * password: it opens that one mailbox and stops working at `expiresAt`,
 * while the master password signs in as every mailbox and never expires.
 */
export async function mintImpersonationCredential(opts: {
  serverUrl: string;
  mailbox: string;
  masterUser: string;
  masterPassword: string;
  description: string;
  now?: Date;
}): Promise<ImpersonationCredential> {
  const now = opts.now ?? new Date();
  const expiresAt = utcDate(new Date(now.getTime() + IMPERSONATION_SESSION_TTL_SEC * 1000));
  const authHeader = masterAuthHeader(opts.mailbox, opts.masterUser, opts.masterPassword);
  await pruneExpiredImpersonationCredentials(opts.serverUrl, authHeader, now);
  try {
    const created = await createAppPassword({
      serverUrl: opts.serverUrl,
      authHeader,
      description: opts.description,
      expiresAt,
    });
    return { ...created, expiresAt };
  } catch (error) {
    // Stalwart may have created it all the same (an answer that couldn't be
    // read, say), and nothing would ever delete it: find it by its description,
    // which names this handoff alone.
    await deleteByDescription(opts.serverUrl, authHeader, opts.description);
    throw error;
  }
}

/** Delete the mailbox's app passwords that carry exactly `description`. Best effort. */
async function deleteByDescription(serverUrl: string, authHeader: string, description: string): Promise<void> {
  try {
    const result = await callStalwart(serverUrl, authHeader, ['x:AppPassword/get', { ids: null }, '0']);
    const list = (result.list as { id?: string; description?: string }[] | undefined) ?? [];
    const ids = list.filter((p) => p.id && p.description === description).map((p) => p.id as string);
    if (ids.length > 0) await callStalwart(serverUrl, authHeader, ['x:AppPassword/set', { destroy: ids }, '0']);
  } catch (error) {
    // Expires on its own (expiresAt), and carries the handoff's description.
    // A fixed text and the status only: the error can quote Stalwart's answer.
    logger.warn('Impersonation app password not deleted after a failed hand-off; it expires on its own', {
      status: error instanceof ImpersonationCredentialError && error.status !== undefined ? error.status : null,
    });
  }
}

/**
 * Delete the mailbox's own expired impersonation app passwords. Stalwart keeps
 * an app password after its `expiresAt` and counts it against the mailbox's
 * limit (5 by default), so a mailbox opened that many times through the
 * handoff could never be opened again. Only passwords this module made, by
 * their description, and only expired ones go: the user's own app passwords
 * and a session still running are never touched. Best effort: a failure here
 * leaves the handoff to try as before.
 */
async function pruneExpiredImpersonationCredentials(serverUrl: string, authHeader: string, now: Date): Promise<void> {
  try {
    const result = await callStalwart(serverUrl, authHeader, ['x:AppPassword/get', { ids: null }, '0']);
    const list = (result.list as { id?: string; description?: string; expiresAt?: string }[] | undefined) ?? [];
    const expired = list
      .filter((p) => p.id && p.description?.startsWith(IMPERSONATION_DESCRIPTION_PREFIX))
      .filter((p) => p.expiresAt && Date.parse(p.expiresAt) <= now.getTime())
      .map((p) => p.id as string);
    if (expired.length > 0) {
      await callStalwart(serverUrl, authHeader, ['x:AppPassword/set', { destroy: expired }, '0']);
    }
  } catch {
    // The create below reports anything that matters.
  }
}

/** Best-effort revocation of a credential minted by {@link mintImpersonationCredential}. */
export async function revokeImpersonationCredential(opts: {
  serverUrl: string;
  mailbox: string;
  masterUser: string;
  masterPassword: string;
  id: string;
}): Promise<void> {
  await callStalwart(
    opts.serverUrl,
    masterAuthHeader(opts.mailbox, opts.masterUser, opts.masterPassword),
    ['x:AppPassword/set', { destroy: [opts.id] }, '0'],
  );
}
