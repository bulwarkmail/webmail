import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { getStalwartCredentials, type StalwartCredentials } from '@/lib/stalwart/credentials';
import { fetchJmapServer } from '@/lib/stalwart/server-fetch';
import { configManager } from '@/lib/admin/config-manager';
import { isConfigReadOnly, ConfigReadOnlyError } from '@/lib/admin/paths';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import { locales as ALL_LOCALES } from '@/i18n/routing';

const CLIENT_ID = 'bulwark-webmail';
const CLIENT_DESCRIPTION = 'Bulwark Webmail (auto-configured)';
const JMAP_TIMEOUT_MS = 10_000;

interface JmapMethodCall {
  using: string[];
  methodCalls: Array<[string, Record<string, unknown>, string]>;
}

interface JmapMethodResponse {
  methodResponses?: Array<[string, Record<string, unknown>, string]>;
}

type ServerCreds = Pick<StalwartCredentials, 'serverUrl' | 'authHeader' | 'trusted'>;

async function fetchWithTimeout(
  url: string,
  init: Parameters<typeof fetch>[1],
  trusted: boolean,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JMAP_TIMEOUT_MS);
  try {
    return await fetchJmapServer(url, { ...init, signal: controller.signal }, trusted);
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
    headers: { 'Authorization': creds.authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, creds.trusted);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`JMAP HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<JmapMethodResponse>;
}

async function getStalwartAccountId(creds: ServerCreds): Promise<string | null> {
  const res = await fetchWithTimeout(`${creds.serverUrl}/.well-known/jmap`, {
    method: 'GET',
    headers: { 'Authorization': creds.authHeader },
  }, creds.trusted);
  if (!res.ok) return null;
  const session = await res.json() as { primaryAccounts?: Record<string, string> };
  return session.primaryAccounts?.['urn:stalwart:jmap']
    ?? session.primaryAccounts?.['urn:ietf:params:jmap:mail']
    ?? Object.values(session.primaryAccounts ?? {})[0]
    ?? null;
}

function buildRedirectUris(origin: string, localeList: readonly string[]): Record<string, true> {
  const out: Record<string, true> = {};
  for (const loc of localeList) {
    out[`${origin}/${loc}/auth/callback`] = true;
  }
  return out;
}

interface SetupRequestBody {
  origin?: string;
  issuerUrl?: string;
  locales?: string[];
  oauthOnly?: boolean;
}

interface SetError {
  type?: string;
  properties?: unknown[];
}

/** A Stalwart that doesn't know the firstParty field (0.16) refused the set. */
function refusedFirstParty(res: JmapMethodResponse): boolean {
  const body = res.methodResponses?.[0]?.[1] as
    | { notCreated?: Record<string, SetError>; notUpdated?: Record<string, SetError> }
    | undefined;
  return Object.values({ ...body?.notCreated, ...body?.notUpdated }).some((error) =>
    error?.type === 'invalidPatch'
    && Array.isArray(error.properties)
    && error.properties.some((p) => String(p).replace(/^\//, '') === 'firstParty'));
}

function isValidOriginUrl(value: string): boolean {
  return /^https?:\/\/[^/]+$/.test(value);
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
    const creds = await getStalwartCredentials(request);
    if (!creds) {
      return NextResponse.json(
        { error: 'No Stalwart session available. Sign in to your mail account in another tab and retry.' },
        { status: 400 },
      );
    }

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

    const accountId = await getStalwartAccountId(creds);
    if (!accountId) {
      return NextResponse.json(
        { error: 'Could not resolve Stalwart account from JMAP session.' },
        { status: 502 },
      );
    }

    const queryRes = await jmapCall(creds, {
      using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
      methodCalls: [[
        'x:OAuthClient/query',
        { accountId, filter: { clientId: CLIENT_ID } },
        '0',
      ]],
    });

    const queryEntry = queryRes.methodResponses?.[0];
    if (!queryEntry || queryEntry[0] === 'error') {
      return NextResponse.json({
        error: 'Stalwart denied OAuthClient/query - your Stalwart account likely lacks admin permissions.',
        detail: queryEntry?.[1],
      }, { status: 403 });
    }
    const existingIds = (queryEntry[1].ids as string[] | undefined) ?? [];

    const secret = randomBytes(32).toString('base64url');
    const redirectUris = buildRedirectUris(origin, localeList);

    const action: 'created' | 'updated' = existingIds.length > 0 ? 'updated' : 'created';
    // Stalwart 1.0 gives a client full access to the account (its Stalwart
    // settings too: password, TOTP, app passwords) only when it is first-party;
    // any other client gets just the data scopes it was granted. 0.16 has no
    // such field and refuses it as an invalid patch, so the setup retries
    // without it there.
    const buildSetArgs = (firstParty: boolean): Record<string, unknown> => {
      const extra = firstParty ? { firstParty: true } : {};
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
              contacts: { [creds.username]: true },
              ...extra,
            },
          },
        };
    };
    const callSet = (firstParty: boolean) => jmapCall(creds, {
      using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
      methodCalls: [['x:OAuthClient/set', buildSetArgs(firstParty), '0']],
    });

    let setRes = await callSet(true);
    if (refusedFirstParty(setRes)) setRes = await callSet(false);

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
            using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
            methodCalls: [['x:OAuthClient/set', { accountId, destroy: [createdId] }, '0']],
          }).catch((rollbackError) => {
            logger.error('Admin OAuth setup rollback failed', {
              error: rollbackError instanceof Error ? rollbackError.message : 'Unknown error',
            });
          });
        }
      }
      throw error;
    }

    await auditLog('admin.oauth_setup', {
      action,
      clientId: CLIENT_ID,
      origin,
      issuer: issuerUrl,
      redirectUriCount: localeList.length,
      oauthOnly,
    }, ip);

    logger.info('Admin OAuth setup', {
      action,
      clientId: CLIENT_ID,
      origin,
      issuer: issuerUrl,
      locales: localeList.length,
    });

    return NextResponse.json({
      ok: true,
      action,
      clientId: CLIENT_ID,
      origin,
      issuerUrl,
      redirectUriCount: localeList.length,
    });
  } catch (error) {
    logger.error('Admin OAuth setup error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
