import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { getStalwartCredentials, type StalwartCredentials } from '@/lib/stalwart/credentials';
import { fetchJmapServer } from '@/lib/stalwart/server-fetch';
import { isStalwartApiKey } from '@/lib/stalwart/api-key';
import { configManager } from '@/lib/admin/config-manager';
import { parseJmapServers, resolveTrustedJmapUrl } from '@/lib/admin/jmap-servers';
import { isConfigReadOnly, ConfigReadOnlyError } from '@/lib/admin/paths';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import { configWriteErrorResponse } from '@/lib/admin/config-read-only-response';
import { forwardedClientHeaders } from '@/lib/auth/client-address';
import {
  LOGIN_BUDGET_RETRY_AFTER_SECONDS,
  reserveAdminSignInAttempt,
  type BudgetRefund,
} from '@/lib/auth/verify-budget';
import { locales as ALL_LOCALES } from '@/i18n/routing';
import {
  STALWART_SCOPE_FULL,
  STALWART_SCOPE_SECURITY,
  STALWART_SCOPE_SETTINGS,
  withStalwartScopes,
} from '@/lib/oauth/scopes';

const CLIENT_ID = 'bulwark-webmail';
const CLIENT_DESCRIPTION = 'Bulwark Webmail (auto-configured)';
// Bulwark Mobile's own client (#1459). The webmail's can't serve the app: it
// has a secret, which Stalwart wants at the token endpoint and the app
// doesn't have. The redirect is the app's App Store and Play id as a
// private-use scheme (RFC 8252), which the iOS and Android apps register.
const MOBILE_CLIENT_ID = 'bulwark-mobile';
const MOBILE_CLIENT_DESCRIPTION = 'Bulwark Mobile (auto-configured)';
const MOBILE_REDIRECT_URI = 'org.bulwarkmail.mobile:/auth/callback';
const JMAP_TIMEOUT_MS = 10_000;
const STALWART_USING = ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'];

interface JmapMethodCall {
  using: string[];
  methodCalls: Array<[string, Record<string, unknown>, string]>;
}

interface JmapMethodResponse {
  methodResponses?: Array<[string, Record<string, unknown>, string]>;
}

type ServerCreds = Pick<StalwartCredentials, 'serverUrl' | 'authHeader' | 'trusted'> & {
  /** Sent with every request, for the admin's own sign-in (X-Forwarded-For). */
  headers?: Record<string, string>;
  /**
   * The admin's own sign-in, typed in for this request: it has its own
   * failure budget here instead of the one for stored cookie credentials.
   */
  typedIn?: boolean;
};

async function fetchWithTimeout(
  url: string,
  init: Parameters<typeof fetch>[1],
  creds: Pick<ServerCreds, 'trusted' | 'typedIn'>,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JMAP_TIMEOUT_MS);
  try {
    return await fetchJmapServer(url, { ...init, signal: controller.signal }, creds.trusted, {
      storedCredential: !creds.typedIn,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function jmapCall(
  creds: ServerCreds,
  body: JmapMethodCall,
): Promise<JmapMethodResponse> {
  const res = await fetchWithTimeout(`${creds.serverUrl}/jmap/`, {
    method: 'POST',
    headers: { ...creds.headers, 'Authorization': creds.authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, creds);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new StalwartHttpError(res.status, text.slice(0, 200));
  }
  return res.json() as Promise<JmapMethodResponse>;
}

/** Stalwart answered a JMAP call with an HTTP error. Its message holds no credential. */
class StalwartHttpError extends Error {
  constructor(readonly status: number, body: string) {
    super(`JMAP HTTP ${status} ${body}`);
    this.name = 'StalwartHttpError';
  }
}

/**
 * What of an error may be logged. Other errors can quote the request: a
 * header error names the whole Authorization value, the admin's password
 * or API key with it.
 */
function loggableError(error: unknown): string {
  if (error instanceof StalwartHttpError) return error.message;
  return error instanceof Error ? error.name : 'Unknown error';
}

type JmapSessionAccount =
  | { ok: true; accountId: string; username?: string }
  | { ok: false; status: number };

async function getStalwartAccount(creds: ServerCreds): Promise<JmapSessionAccount> {
  const res = await fetchWithTimeout(`${creds.serverUrl}/.well-known/jmap`, {
    method: 'GET',
    headers: { ...creds.headers, 'Authorization': creds.authHeader },
  }, creds);
  if (!res.ok) return { ok: false, status: res.status };
  const session = await res.json() as { primaryAccounts?: Record<string, string>; username?: unknown };
  const accountId = session.primaryAccounts?.['urn:stalwart:jmap']
    ?? session.primaryAccounts?.['urn:ietf:params:jmap:mail']
    ?? Object.values(session.primaryAccounts ?? {})[0];
  if (!accountId) return { ok: false, status: res.status };
  return { ok: true, accountId, username: typeof session.username === 'string' ? session.username : undefined };
}

/**
 * The admin-configured Stalwart, the only server the admin's own sign-in is
 * ever sent to: the session's when it is one of the configured servers,
 * otherwise the main one. Spelled as the config has it, not as the
 * session cookie does.
 */
async function adminCredentialServer(session: StalwartCredentials | null): Promise<string | null> {
  await configManager.ensureLoaded();
  const configured = configManager.get<string>('jmapServerUrl', '')
    || process.env.JMAP_SERVER_URL
    || process.env.NEXT_PUBLIC_JMAP_SERVER_URL
    || '';
  if (session?.trusted) {
    const servers = parseJmapServers(configManager.get<unknown>('jmapServers', []));
    const resolved = resolveTrustedJmapUrl(session.serverUrl, configured, servers);
    if (resolved) return resolved.trim().replace(/\/+$/, '');
  }
  return configured ? configured.trim().replace(/\/+$/, '') : null;
}

/**
 * Authorization for the admin's own Stalwart sign-in (#1611). A Stalwart API
 * key ("API_...") is a bearer token; a password or app password goes with the
 * username as Basic auth. Stalwart limits neither to OAuth scopes, so they
 * reach the OAuthClient objects that a webmail session token, which carries
 * only the data scopes, can't since 1.0.3. Basic auth has no field for a
 * TOTP code: an account with two-step verification needs an app password or
 * an API key.
 */
function adminCredentialHeader(username: string, secret: string): string {
  if (isStalwartApiKey(secret)) return `Bearer ${secret}`;
  return `Basic ${Buffer.from(`${username}:${secret}`, 'utf8').toString('base64')}`;
}

/**
 * The callback URIs the sign-in sends, one per locale. A build with
 * NEXT_PUBLIC_BASE_PATH serves them under that path (#1551).
 */
function buildRedirectUris(origin: string, localeList: readonly string[]): Record<string, true> {
  const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
  const out: Record<string, true> = {};
  for (const loc of localeList) {
    out[`${origin}${basePath}/${loc}/auth/callback`] = true;
  }
  return out;
}

interface SetupRequestBody {
  origin?: string;
  issuerUrl?: string;
  locales?: string[];
  oauthOnly?: boolean;
  /**
   * A Stalwart admin's own sign-in, used for this setup instead of the
   * webmail session and never stored or logged (#1611).
   */
  stalwartUsername?: string;
  /** Password, app password or API key of `stalwartUsername`. */
  stalwartSecret?: string;
}

interface SetError {
  type?: string;
  properties?: unknown[];
}

/**
 * Stalwart refused the set over `property`: 0.16 answers a field it doesn't
 * know (firstParty) with invalidPatch, 1.0.3 a scope the account may not
 * allow (full) with invalidProperties.
 */
function refusedProperty(res: JmapMethodResponse, property: string): boolean {
  const body = res.methodResponses?.[0]?.[1] as
    | { notCreated?: Record<string, SetError>; notUpdated?: Record<string, SetError> }
    | undefined;
  return Object.values({ ...body?.notCreated, ...body?.notUpdated }).some((error) =>
    (error?.type === 'invalidPatch' || error?.type === 'invalidProperties')
    && Array.isArray(error.properties)
    && error.properties.some((p) => {
      const path = String(p).replace(/^\//, '');
      return path === property || path.startsWith(`${property}/`);
    }));
}

/**
 * How the clients get at the account beyond mail, contacts, calendars and
 * files, and the Stalwart scopes the webmail then has to ask for.
 * - Stalwart 1.0.3 dropped firstParty (#1527): a token is unrestricted only
 *   with the `full` scope, which the client must allow and the sign-in must
 *   request. Only a superuser may allow it, so an admin who isn't one gets
 *   `security` and `settings` (Settings > Security works, the admin panel
 *   doesn't). The data scopes are allowed explicitly too: the webmail asks
 *   for them, and a scope the client doesn't allow fails the sign-in.
 * - Stalwart 1.0.0 to 1.0.2 give a first-party client everything.
 * - 0.16 has neither and gives every client everything.
 */
interface ClientAccess {
  fields: Record<string, unknown>;
  request: string[];
}
const DATA_SCOPES = { mail: true, contacts: true, calendars: true, files: true };
const FULL_SCOPES: ClientAccess = {
  fields: { scopes: { ...DATA_SCOPES, full: true } },
  request: [STALWART_SCOPE_FULL],
};
const ACCOUNT_SCOPES: ClientAccess = {
  fields: { scopes: { ...DATA_SCOPES, security: true, settings: true } },
  request: [STALWART_SCOPE_SECURITY, STALWART_SCOPE_SETTINGS],
};
const FIRST_PARTY: ClientAccess = { fields: { firstParty: true }, request: [] };
const NO_EXTRA_ACCESS: ClientAccess = { fields: {}, request: [] };

/**
 * Whether the server has Stalwart 1.0.3's scopes. Stalwart publishes no
 * version, but it lists the scopes in its discovery document from 1.0.3 on.
 */
async function hasStalwartScopes(creds: ServerCreds): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${creds.serverUrl}/.well-known/oauth-authorization-server`, {
      method: 'GET',
    }, creds);
    if (!res.ok) return false;
    const metadata = await res.json() as { scopes_supported?: unknown };
    return Array.isArray(metadata.scopes_supported) && metadata.scopes_supported.includes(STALWART_SCOPE_FULL);
  } catch {
    return false;
  }
}

/**
 * A public client for Bulwark Mobile with the webmail's access, so the app's
 * own sign-in reaches the account's Stalwart settings too. The client the
 * app registers for itself otherwise gets the data scopes only. An existing
 * one is taken over as the webmail's is, its secret dropped.
 */
async function setUpMobileClient(
  creds: ServerCreds,
  accountId: string,
  contact: string,
  access: ClientAccess,
): Promise<'created' | 'updated' | 'failed'> {
  try {
    const queryRes = await jmapCall(creds, {
      using: STALWART_USING,
      methodCalls: [['x:OAuthClient/query', { accountId, filter: { clientId: MOBILE_CLIENT_ID } }, '0']],
    });
    const queryEntry = queryRes.methodResponses?.[0];
    if (!queryEntry || queryEntry[0] === 'error') return 'failed';
    const existingId = ((queryEntry[1].ids as string[] | undefined) ?? [])[0];

    const fields = {
      description: MOBILE_CLIENT_DESCRIPTION,
      redirectUris: { [MOBILE_REDIRECT_URI]: true },
      ...access.fields,
    };
    const setRes = await jmapCall(creds, {
      using: STALWART_USING,
      methodCalls: [['x:OAuthClient/set', existingId
        ? { accountId, update: { [existingId]: { ...fields, secret: null } } }
        : { accountId, create: { mobile: { clientId: MOBILE_CLIENT_ID, contacts: { [contact]: true }, ...fields } } },
      '0']],
    });
    const setEntry = setRes.methodResponses?.[0];
    const setBody = setEntry?.[1] as { notCreated?: Record<string, unknown>; notUpdated?: Record<string, unknown> } | undefined;
    if (!setEntry || setEntry[0] === 'error'
      || Object.keys(setBody?.notCreated ?? {}).length > 0
      || Object.keys(setBody?.notUpdated ?? {}).length > 0) {
      logger.warn('Admin OAuth setup: mobile client refused', { detail: JSON.stringify(setEntry?.[1] ?? null).slice(0, 300) });
      return 'failed';
    }
    return existingId ? 'updated' : 'created';
  } catch (error) {
    logger.warn('Admin OAuth setup: mobile client failed', { error: loggableError(error) });
    return 'failed';
  }
}

function isValidOriginUrl(value: string): boolean {
  return /^https?:\/\/[^/]+$/.test(value);
}

// Without an admin sign-in in the request, the setup acts as the mail
// account signed in to this webmail: a login to the Stalwart web admin sets
// no cookie here.
const NOT_SIGNED_IN =
  'Sign in to this webmail with a Stalwart admin account in this browser, or enter a Stalwart admin sign-in below, then retry. '
  + 'A login to the Stalwart web admin does not count.';

// Stalwart 1.0.3 lets a token manage OAuth clients only with the full scope,
// which no webmail sign-in asks for until this setup has run.
const SESSION_REFUSED =
  'Stalwart refused the token of your webmail session for managing OAuth clients. '
  + 'Since Stalwart 1.0.3 that needs full access, which the webmail sign-in does not have. '
  + 'Enter a Stalwart admin sign-in below and try again.';

const CREDENTIAL_REFUSED =
  'Stalwart did not accept this sign-in. With two-step verification on, the password alone does not work: '
  + 'create an app password or API key in the Stalwart web admin and enter that instead.';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;

const TOO_MANY_SIGN_INS =
  'Too many Stalwart sign-ins failed from your address. Wait 15 minutes, then try again.';

/** Which mail account the setup would run as, so the page can say before it starts. */
export async function GET(request: NextRequest) {
  const auth = await requireAdminAuth(request);
  if ('error' in auth) return auth.error;
  const creds = await getStalwartCredentials(request);
  return NextResponse.json(creds ? { signedIn: true, username: creds.username } : { signedIn: false });
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdminAuth(request);
    if ('error' in auth) return auth.error;

    // The setup ends by saving the client secret here. Refuse before
    // touching Stalwart, or a read-only config leaves an orphaned client
    // (or a rotated secret nobody stored) on the server.
    if (isConfigReadOnly()) {
      return NextResponse.json(
        { error: new ConfigReadOnlyError('set up OAuth').message },
        { status: 409 },
      );
    }

    const ip = getClientIP(request);
    const session = await getStalwartCredentials(request);

    const body = await request.json() as SetupRequestBody;
    const origin = (body.origin ?? '').trim().replace(/\/+$/, '');
    if (!isValidOriginUrl(origin)) {
      return NextResponse.json(
        { error: 'Webmail origin must be a URL like "https://webmail.example.com" with no path.' },
        { status: 400 },
      );
    }
    const issuerUrl = (body.issuerUrl ?? origin).trim().replace(/\/+$/, '');
    if (!isValidOriginUrl(issuerUrl)) {
      return NextResponse.json(
        { error: 'Stalwart issuer URL must be a URL like "https://mail.example.com" with no path.' },
        { status: 400 },
      );
    }
    const localeList = Array.isArray(body.locales) && body.locales.length > 0
      ? body.locales.filter(l => typeof l === 'string' && /^[a-z]{2,5}(-[A-Za-z0-9]+)*$/.test(l))
      : Array.from(ALL_LOCALES);
    if (localeList.length === 0) {
      return NextResponse.json({ error: 'No valid locales supplied.' }, { status: 400 });
    }
    const oauthOnly = body.oauthOnly === true;

    // The admin's own sign-in, when the dialog sent one: for this request
    // only, to the configured Stalwart only, never stored or logged.
    const adminSecret = typeof body.stalwartSecret === 'string' ? body.stalwartSecret : '';
    const adminUsername = typeof body.stalwartUsername === 'string' ? body.stalwartUsername.trim() : '';
    const usesApiKey = isStalwartApiKey(adminSecret);
    let creds: ServerCreds;
    if (adminSecret) {
      // An API key goes into the header as it is, and a header error would
      // quote it.
      if (CONTROL_CHARACTER.test(adminSecret) || CONTROL_CHARACTER.test(adminUsername)) {
        return NextResponse.json(
          { error: 'The Stalwart sign-in contains a line break or another control character. Enter it again without one.', needsAdminCredential: true },
          { status: 400 },
        );
      }
      if (!usesApiKey && (!adminUsername || adminUsername.includes(':'))) {
        return NextResponse.json(
          { error: 'Enter the Stalwart username that goes with this password.', needsAdminCredential: true },
          { status: 400 },
        );
      }
      const serverUrl = await adminCredentialServer(session);
      if (!serverUrl) {
        return NextResponse.json(
          { error: 'No Stalwart server is configured for this webmail, so the sign-in has nowhere to go.' },
          { status: 400 },
        );
      }
      creds = {
        serverUrl,
        authHeader: adminCredentialHeader(adminUsername, adminSecret),
        trusted: true,
        headers: forwardedClientHeaders(ip),
        typedIn: true,
      };
    } else if (session) {
      creds = session;
    } else {
      return NextResponse.json({ error: NOT_SIGNED_IN, needsAdminCredential: true }, { status: 400 });
    }

    // Each try of the admin's sign-in is a login at Stalwart from this
    // server's address, so wrong ones are limited per client.
    let refundSignIn: BudgetRefund | null = null;
    if (creds.typedIn) {
      refundSignIn = await reserveAdminSignInAttempt(ip);
      if (!refundSignIn) {
        return NextResponse.json(
          { error: TOO_MANY_SIGN_INS, needsAdminCredential: true },
          { status: 429, headers: { 'Retry-After': String(LOGIN_BUDGET_RETRY_AFTER_SECONDS) } },
        );
      }
    }

    const account = await getStalwartAccount(creds);
    // Stalwart took the sign-in: only refused ones use up the budget.
    if (account.ok) await refundSignIn?.();
    if (!account.ok) {
      if (adminSecret && (account.status === 401 || account.status === 403)) {
        return NextResponse.json({ error: CREDENTIAL_REFUSED, needsAdminCredential: true }, { status: 403 });
      }
      return NextResponse.json(
        { error: 'Could not resolve Stalwart account from JMAP session.' },
        { status: 502 },
      );
    }
    const { accountId } = account;
    // Named as a contact of the clients it creates.
    const owner = adminSecret ? (account.username || adminUsername) : (session?.username ?? '');

    const queryRes = await jmapCall(creds, {
      using: STALWART_USING,
      methodCalls: [[
        'x:OAuthClient/query',
        { accountId, filter: { clientId: CLIENT_ID } },
        '0',
      ]],
    });

    const queryEntry = queryRes.methodResponses?.[0];
    if (!queryEntry || queryEntry[0] === 'error') {
      // A session token on Stalwart 1.0.3 or later is refused even for a
      // superuser (#1611); the admin's own sign-in is not limited that way.
      const error = adminSecret
        ? 'Stalwart denied OAuthClient/query - this Stalwart account lacks admin permissions.'
        : await hasStalwartScopes(creds)
          ? SESSION_REFUSED
          : 'Stalwart denied OAuthClient/query - your Stalwart account likely lacks admin permissions. '
            + 'Enter a Stalwart admin sign-in below to run the setup as that account.';
      return NextResponse.json({ error, detail: queryEntry?.[1], needsAdminCredential: true }, { status: 403 });
    }
    const existingIds = (queryEntry[1].ids as string[] | undefined) ?? [];

    const secret = randomBytes(32).toString('base64url');
    const redirectUris = buildRedirectUris(origin, localeList);

    const action: 'created' | 'updated' = existingIds.length > 0 ? 'updated' : 'created';
    // See ClientAccess. 0.16 refuses firstParty as an invalid patch, and a
    // 1.0.3 admin who isn't a superuser the full scope, so the setup retries
    // with less there.
    const buildSetArgs = (access: ClientAccess): Record<string, unknown> => {
      const extra = access.fields;
      return action === 'updated'
        ? {
          accountId,
          update: {
            [existingIds[0]]: {
              secret,
              redirectUris,
              description: CLIENT_DESCRIPTION,
              ...extra,
            },
          },
        }
        : {
          accountId,
          create: {
            new: {
              clientId: CLIENT_ID,
              description: CLIENT_DESCRIPTION,
              secret,
              redirectUris,
              contacts: { [owner]: true },
              ...extra,
            },
          },
        };
    };
    const callSet = (access: ClientAccess) => jmapCall(creds, {
      using: STALWART_USING,
      methodCalls: [['x:OAuthClient/set', buildSetArgs(access), '0']],
    });

    const [preferred, fallback, refusable]: [ClientAccess, ClientAccess, string] = await hasStalwartScopes(creds)
      ? [FULL_SCOPES, ACCOUNT_SCOPES, 'scopes']
      : [FIRST_PARTY, NO_EXTRA_ACCESS, 'firstParty'];
    let access = preferred;
    let setRes = await callSet(access);
    if (refusedProperty(setRes, refusable)) {
      access = fallback;
      setRes = await callSet(access);
    }

    const setEntry = setRes.methodResponses?.[0];
    if (!setEntry || setEntry[0] === 'error') {
      return NextResponse.json({
        error: 'Stalwart denied OAuthClient/set - admin permissions required.',
        detail: setEntry?.[1],
      }, { status: 403 });
    }
    const setBody = setEntry[1] as {
      created?: Record<string, { id?: string }>;
      notCreated?: Record<string, unknown>;
      notUpdated?: Record<string, unknown>;
    };
    if (setBody.notCreated && Object.keys(setBody.notCreated).length > 0) {
      return NextResponse.json(
        { error: 'Stalwart refused to create the OAuth client.', detail: setBody.notCreated },
        { status: 502 },
      );
    }
    if (setBody.notUpdated && Object.keys(setBody.notUpdated).length > 0) {
      return NextResponse.json(
        { error: 'Stalwart refused to update the OAuth client.', detail: setBody.notUpdated },
        { status: 502 },
      );
    }

    await configManager.ensureLoaded();
    const updates: Record<string, unknown> = {
      oauthEnabled: true,
      oauthClientId: CLIENT_ID,
      oauthClientSecret: secret,
      oauthIssuerUrl: issuerUrl,
    };
    if (oauthOnly) updates.oauthOnly = true;
    // Ask for the Stalwart scopes the client now allows, and none it doesn't.
    // An explicit scope list replaces the extra scopes, so they go there.
    if (access.request.length > 0) {
      const explicit = configManager.get<string>('oauthScopes', '');
      if (explicit) {
        updates.oauthScopes = withStalwartScopes(explicit, access.request);
      } else {
        updates.oauthExtraScopes = withStalwartScopes(configManager.get<string>('oauthExtraScopes', ''), access.request);
      }
    }
    try {
      await configManager.setAdminConfig(updates);
    } catch (error) {
      // Don't leave a client behind that this install never stored. An
      // updated client can't be restored: Stalwart doesn't hand back the
      // old secret.
      if (action === 'created') {
        const createdId = setBody.created?.new?.id;
        if (createdId) {
          await jmapCall(creds, {
            using: STALWART_USING,
            methodCalls: [['x:OAuthClient/set', { accountId, destroy: [createdId] }, '0']],
          }).catch((rollbackError) => {
            logger.error('Admin OAuth setup rollback failed', { error: loggableError(rollbackError) });
          });
        }
      }
      throw error;
    }

    // Only Stalwart 1.0 restricts clients, so 0.16 needs no mobile client. The
    // webmail is set up by now, so a refused mobile client is reported, not
    // an error.
    const mobileClient = access !== NO_EXTRA_ACCESS
      ? await setUpMobileClient(creds, accountId, owner, access)
      : 'skipped';

    await auditLog('admin.oauth_setup', {
      action,
      clientId: CLIENT_ID,
      origin,
      issuer: issuerUrl,
      redirectUriCount: localeList.length,
      oauthOnly,
      mobileClient,
      stalwartScopes: access.request,
      signIn: adminSecret ? (usesApiKey ? 'apiKey' : 'password') : 'session',
    }, ip);

    logger.info('Admin OAuth setup', {
      action,
      clientId: CLIENT_ID,
      origin,
      issuer: issuerUrl,
      locales: localeList.length,
      mobileClient,
      stalwartScopes: access.request,
    });

    return NextResponse.json({
      ok: true,
      action,
      clientId: CLIENT_ID,
      origin,
      issuerUrl,
      redirectUriCount: localeList.length,
      mobileClient,
      mobileClientId: MOBILE_CLIENT_ID,
      mobileRedirectUri: MOBILE_REDIRECT_URI,
      stalwartScopes: access.request,
    });
  } catch (error) {
    const refused = configWriteErrorResponse(error);
    if (refused) return refused;
    logger.error('Admin OAuth setup error', { error: loggableError(error) });
    return NextResponse.json(
      {
        error: error instanceof StalwartHttpError
          ? `Stalwart answered with HTTP ${error.status}.`
          : 'The OAuth setup failed. The server log has the error type.',
      },
      { status: 500 },
    );
  }
}
