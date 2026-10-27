// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

import {
  STALWART_LOOPBACK_REDIRECT_URI,
  resetStalwartDefaultClients,
  stalwartDefaultClientId,
  stalwartPasswordLogin,
} from '@/lib/auth/stalwart-password-login';

// Stalwart 1.0 changed its structured login: the authorization request goes in
// as a query string (`query`), the answer carries the redirect location with
// the code instead of `client_code`, and only clients it knows may sign in.
// The answers below are the ones both servers gave live (0.16.27, 1.0.0).

const SERVER = 'https://mail.example.org';
const REDIRECT = 'https://webmail.example/en/auth/callback';

interface Call { url: string; method: string; body: string }
let calls: Call[];

type Handler = (call: Call) => Response;

function stub(handler: Handler) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? '') };
    calls.push(call);
    return handler(call);
  }));
}

/** Stalwart 1.0's /api/auth: knows `known` clients, answers with the redirect location. */
function v1(known: string[], registered = 'swc1.registered'): Handler {
  return (call) => {
    if (call.url === `${SERVER}/api/auth`) {
      const body = JSON.parse(call.body);
      if (typeof body.query !== 'string') {
        return Response.json({ type: 'about:blank', status: 400, title: 'Invalid parameters', detail: 'JSON deserialization failed' }, { status: 400 });
      }
      const q = new URLSearchParams(body.query);
      if (!known.includes(q.get('client_id') ?? '')) {
        return Response.json({ type: 'invalid', error: 'invalid_client', description: 'Unknown client id' });
      }
      if (body.consent !== true) {
        return Response.json({ type: 'redirect', location: `${q.get('redirect_uri')}?error=access_denied&state=${q.get('state')}` });
      }
      return Response.json({
        type: 'authenticated',
        location: `${q.get('redirect_uri')}?code=v1-code&state=${encodeURIComponent(q.get('state') ?? '')}&iss=${encodeURIComponent(SERVER)}`,
      });
    }
    if (call.url === `${SERVER}/auth/register`) {
      return Response.json({ client_id: registered, redirect_uris: JSON.parse(call.body).redirect_uris }, { status: 201 });
    }
    if (call.url.startsWith(`${SERVER}/api/auth/client?`)) {
      const q = new URL(call.url).searchParams;
      return known.includes(q.get('client_id') ?? '')
        ? Response.json({ name: null, scopes: [] })
        : Response.json({ error: 'invalid_client', description: 'Unknown client id', redirect: false });
    }
    if (call.url === `${SERVER}/auth/token`) {
      const p = new URLSearchParams(call.body);
      return p.get('code') === 'v1-code'
        ? Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
        : Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    return new Response('not found', { status: 404 });
  };
}

/** Stalwart 0.16's /api/auth: any client id, answers with client_code. */
const v016: Handler = (call) => {
  if (call.url === `${SERVER}/api/auth`) return Response.json({ type: 'authenticated', client_code: 'old-code', iss: SERVER });
  if (call.url === `${SERVER}/auth/token`) return Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
  return Response.json({ type: 'about:blank', status: 404, title: 'Not Found' }, { status: 404 });
};

function login(clientId: string, registerUnknownClient = false) {
  return stalwartPasswordLogin({
    serverUrl: SERVER,
    username: 'alice@example.org',
    password: 'hunter2',
    totp: '123456',
    clientId,
    redirectUri: REDIRECT,
    trusted: true,
    registerUnknownClient,
  });
}

const tokenParams = () => new URLSearchParams(calls.find((c) => c.url === `${SERVER}/auth/token`)!.body);

beforeEach(() => {
  calls = [];
  resetStalwartDefaultClients();
});

describe('stalwartPasswordLogin on Stalwart 1.0', () => {
  it('signs in with a client the server knows, reading the code from the location', async () => {
    stub(v1(['webmail']));
    const result = await login('webmail');

    expect(result).toMatchObject({ ok: true, clientId: 'webmail' });
    expect(tokenParams().get('code')).toBe('v1-code');
    expect(tokenParams().get('redirect_uri')).toBe(REDIRECT);
    const body = JSON.parse(calls[0].body);
    expect(new URLSearchParams(body.query).get('scope')).toContain('urn:ietf:params:oauth:scope:mail');
  });

  it('registers its own client when the default one is unknown, then signs in with it', async () => {
    stub(v1(['swc1.registered']));
    const result = await login('bulwark-webmail', true);

    expect(result).toMatchObject({ ok: true, clientId: 'swc1.registered' });
    const register = JSON.parse(calls.find((c) => c.url === `${SERVER}/auth/register`)!.body);
    expect(register.redirect_uris).toEqual([STALWART_LOOPBACK_REDIRECT_URI]);
    expect(register.token_endpoint_auth_method).toBe('none');
    expect(tokenParams().get('client_id')).toBe('swc1.registered');
    expect(tokenParams().get('redirect_uri')).toBe(STALWART_LOOPBACK_REDIRECT_URI);
    expect(tokenParams().get('client_secret')).toBeNull();
  });

  it('reuses the registered client for the next sign-in', async () => {
    stub(v1(['swc1.registered']));
    await login('bulwark-webmail', true);
    calls = [];
    await login('bulwark-webmail', true);

    expect(calls.map((c) => c.url)).toEqual([`${SERVER}/api/auth`, `${SERVER}/auth/token`]);
  });

  it('does not register for an admin-configured client', async () => {
    stub(v1([]));
    const result = await login('configured-client');

    expect(result).toMatchObject({ ok: false, error: 'login_rejected', detail: 'invalid_client: Unknown client id' });
    expect(calls.some((c) => c.url.endsWith('/auth/register'))).toBe(false);
  });

  it('reports an authorization error the server sends to the redirect URI', async () => {
    stub((call) => call.url === `${SERVER}/api/auth`
      ? Response.json({ type: 'redirect', location: `${REDIRECT}?error=invalid_scope&error_description=The+requested+scope+is+not+allowed&state=x` })
      : v1(['webmail'])(call));
    const result = await login('webmail');

    expect(result).toMatchObject({ ok: false, error: 'login_rejected', detail: 'invalid_scope: The requested scope is not allowed' });
  });

  it('keeps the credential verdicts', async () => {
    stub(() => Response.json({ type: 'mfaRequired' }));
    expect(await login('webmail')).toMatchObject({ ok: false, error: 'totp_required' });
    stub(() => Response.json({ type: 'failure' }));
    expect(await login('webmail')).toMatchObject({ ok: false, error: 'invalid_credentials' });
  });
});

describe('stalwartPasswordLogin on Stalwart 0.16', () => {
  it('signs in with the default client and the field-style request', async () => {
    stub(v016);
    const result = await login('bulwark-webmail', true);

    expect(result).toMatchObject({ ok: true, clientId: 'bulwark-webmail' });
    const body = JSON.parse(calls[0].body);
    expect(body).toMatchObject({ clientId: 'bulwark-webmail', redirectUri: REDIRECT, codeChallengeMethod: 'S256', mfaToken: '123456' });
    expect(tokenParams().get('code')).toBe('old-code');
    expect(calls.some((c) => c.url.endsWith('/auth/register'))).toBe(false);
  });
});

describe('stalwartDefaultClientId', () => {
  it('keeps the default client on 0.16, which has no client check', async () => {
    stub(v016);
    expect(await stalwartDefaultClientId(SERVER, 'bulwark-webmail', true)).toBe('bulwark-webmail');
    expect(calls.some((c) => c.url.endsWith('/auth/register'))).toBe(false);
  });

  it('names the registered client on 1.0, where the default one is unknown', async () => {
    stub(v1(['swc1.registered']));
    expect(await stalwartDefaultClientId(SERVER, 'bulwark-webmail', true)).toBe('swc1.registered');
  });

  it('keeps a default client the admin registered on 1.0', async () => {
    stub(v1(['bulwark-webmail']));
    expect(await stalwartDefaultClientId(SERVER, 'bulwark-webmail', true)).toBe('bulwark-webmail');
  });
});
