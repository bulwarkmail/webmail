import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { configManager } from '@/lib/admin/config-manager';
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

async function fetchWithTimeout(url: string, init: Parameters<typeof fetch>[1]): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JMAP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function jmapCall(
  serverUrl: string,
  authHeader: string,
  body: JmapMethodCall,
): Promise<JmapMethodResponse> {
  const res = await fetchWithTimeout(`${serverUrl}/jmap/`, {
    method: 'POST',
    headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`JMAP HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<JmapMethodResponse>;
}

async function getStalwartAccountId(
  serverUrl: string,
  authHeader: string,
): Promise<string | null> {
  const res = await fetchWithTimeout(`${serverUrl}/.well-known/jmap`, {
    method: 'GET',
    headers: { 'Authorization': authHeader },
  });
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

function isValidOriginUrl(value: string): boolean {
  return /^https?:\/\/[^/]+$/.test(value);
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdminAuth();
    if ('error' in auth) return auth.error;

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

    const accountId = await getStalwartAccountId(creds.serverUrl, creds.authHeader);
    if (!accountId) {
      return NextResponse.json(
        { error: 'Could not resolve Stalwart account from JMAP session.' },
        { status: 502 },
      );
    }

    const queryRes = await jmapCall(creds.serverUrl, creds.authHeader, {
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

    let setArgs: Record<string, unknown>;
    let action: 'created' | 'updated';
    if (existingIds.length > 0) {
      const targetId = existingIds[0];
      action = 'updated';
      setArgs = {
        accountId,
        update: {
          [targetId]: {
            secret,
            redirectUris,
            description: CLIENT_DESCRIPTION,
          },
        },
      };
    } else {
      action = 'created';
      setArgs = {
        accountId,
        create: {
          new: {
            clientId: CLIENT_ID,
            description: CLIENT_DESCRIPTION,
            secret,
            redirectUris,
            contacts: { [creds.username]: true },
          },
        },
      };
    }

    const setRes = await jmapCall(creds.serverUrl, creds.authHeader, {
      using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
      methodCalls: [['x:OAuthClient/set', setArgs, '0']],
    });

    const setEntry = setRes.methodResponses?.[0];
    if (!setEntry || setEntry[0] === 'error') {
      return NextResponse.json({
        error: 'Stalwart denied OAuthClient/set - admin permissions required.',
        detail: setEntry?.[1],
      }, { status: 403 });
    }
    const setBody = setEntry[1] as {
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
    await configManager.setAdminConfig(updates);

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
