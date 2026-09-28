import { fetchJmapSession, postJmap, rebaseApiUrl } from '@/lib/stalwart/jmap-api';

const STALWART_USING = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'];

/**
 * How long an impersonation handoff stays valid. Stalwart enforces it through
 * the app password's `expiresAt`, so the session ends even if the browser
 * keeps the cookie alive.
 */
export const IMPERSONATION_SESSION_TTL_SEC = 8 * 60 * 60;

export class ImpersonationCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImpersonationCredentialError';
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
    throw new ImpersonationCredentialError(`Stalwart answered HTTP ${response.status}`);
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
 * `expiresAt` it lives until the user deletes it. `trusted` is false for a
 * user-chosen server, which must be reached through the rebinding-safe fetch.
 */
export async function createAppPassword(opts: {
  serverUrl: string;
  authHeader: string;
  description: string;
  expiresAt?: string;
  trusted?: boolean;
}): Promise<{ id: string; secret: string }> {
  const result = await callStalwart(
    opts.serverUrl,
    opts.authHeader,
    [
      'x:AppPassword/set',
      { create: { imp: { description: opts.description, ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}) } } },
      '0',
    ],
    opts.trusted ?? true,
  );
  const created = (result.created as Record<string, { id?: string; secret?: string }> | undefined)?.imp;
  if (!created?.id || !created.secret) {
    const failed = (result.notCreated as Record<string, { type?: string; description?: string }> | undefined)?.imp;
    throw new ImpersonationCredentialError(failed?.description || failed?.type || 'App password was not created');
  }
  return { id: created.id, secret: created.secret };
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
  const created = await createAppPassword({
    serverUrl: opts.serverUrl,
    authHeader: masterAuthHeader(opts.mailbox, opts.masterUser, opts.masterPassword),
    description: opts.description,
    expiresAt,
  });
  return { ...created, expiresAt };
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
