/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

let readOnly = false;
let saveError: Error | null = null;
let stalwart016 = false;
let signedIn = true;
let mobileRefused = false;
// Stalwart 1.0.3: lists its own scopes in discovery and has no firstParty.
let stalwart103 = false;
let superuser = true;
let savedConfig: Record<string, unknown> | null = null;
let storedConfig: Record<string, string> = {};
// Registry ids of the clients Stalwart already has, by client id.
let existing: Record<string, string> = {};
const jmapCalls: Array<[string, Record<string, unknown>]> = [];

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: async () => ({ ok: true }),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: async () => (signedIn
    ? {
      serverUrl: 'https://mail.example.org',
      authHeader: 'Basic x',
      trusted: true,
      username: 'admin@example.org',
    }
    : null),
}));
vi.mock('@/lib/admin/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin/paths')>()),
  isConfigReadOnly: () => readOnly,
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: string) => storedConfig[key] ?? fallback,
    setAdminConfig: async (updates: Record<string, unknown>) => {
      if (saveError) throw saveError;
      savedConfig = updates;
    },
  },
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: async () => {} }));
vi.mock('@/lib/stalwart/server-fetch', () => ({
  fetchJmapServer: async (url: string, init: { body?: string }) => {
    if (url.endsWith('/.well-known/jmap')) {
      return Response.json({ primaryAccounts: { 'urn:stalwart:jmap': 'a' } });
    }
    if (url.endsWith('/.well-known/oauth-authorization-server')) {
      return Response.json({ scopes_supported: stalwart103 ? SCOPES_1_0_3 : SCOPES_1_0_2 });
    }
    const [name, args] = JSON.parse(init.body!).methodCalls[0];
    jmapCalls.push([name, args]);
    if (name === 'x:OAuthClient/query') {
      const id = existing[(args.filter as { clientId: string }).clientId];
      return Response.json({ methodResponses: [[name, { ids: id ? [id] : [] }, '0']] });
    }
    if (mobileRefused && JSON.stringify(args).includes('bulwark-mobile')) {
      return Response.json({ methodResponses: [[name, { notCreated: { mobile: { type: 'invalidProperties', properties: ['redirectUris'] } } }, '0']] });
    }
    // Stalwart 0.16 has no firstParty and refuses it (answer seen in its source:
    // PatchError "Invalid property" -> invalidPatch naming the path).
    if (stalwart016 && JSON.stringify(args).includes('firstParty')) {
      return Response.json({ methodResponses: [[name, { notCreated: { new: { type: 'invalidPatch', description: 'Invalid property', properties: ['firstParty'] } } }, '0']] });
    }
    // 1.0.3 lets only a superuser allow full access (validate_oauth_client:
    // invalidProperties naming scopes).
    if (stalwart103 && !superuser && JSON.stringify(args).includes('"full":true')) {
      return Response.json({ methodResponses: [[name, { notCreated: { new: { type: 'invalidProperties', description: 'Only a superuser can register a client with full access.', properties: ['scopes'] } } }, '0']] });
    }
    return Response.json({ methodResponses: [[name, { created: { new: { id: 'h' } } }, '0']] });
  },
}));

import { GET, POST } from '../route';

const SCOPES_1_0_2 = [
  'openid',
  'offline_access',
  'urn:ietf:params:oauth:scope:mail',
  'urn:ietf:params:oauth:scope:contacts',
  'urn:ietf:params:oauth:scope:calendars',
  'urn:ietf:params:oauth:scope:files',
];
const SCOPES_1_0_3 = [
  ...SCOPES_1_0_2.slice(0, 5),
  'urn:stalwart:oauth:scope:security',
  'urn:stalwart:oauth:scope:settings',
  'urn:stalwart:oauth:scope:full',
  'urn:ietf:params:oauth:scope:files',
];
const DATA_SCOPES = { mail: true, contacts: true, calendars: true, files: true };

function setup() {
  return POST(new NextRequest('http://localhost/api/admin/oauth/setup', {
    method: 'POST',
    body: JSON.stringify({ origin: 'https://webmail.example.org', issuerUrl: 'https://mail.example.org' }),
  }));
}

beforeEach(() => {
  readOnly = false;
  saveError = null;
  stalwart016 = false;
  signedIn = true;
  mobileRefused = false;
  stalwart103 = false;
  superuser = true;
  savedConfig = null;
  storedConfig = {};
  existing = {};
  jmapCalls.length = 0;
});

const setCalls = () => jmapCalls.filter(([name]) => name === 'x:OAuthClient/set').map(([, args]) => args);

describe('POST /api/admin/oauth/setup', () => {
  it('creates the client on Stalwart when the config is writable', async () => {
    const res = await setup();
    expect(res.status).toBe(200);
    expect(jmapCalls.slice(0, 2).map(([name]) => name)).toEqual(['x:OAuthClient/query', 'x:OAuthClient/set']);
    expect((setCalls()[0].create as Record<string, Record<string, unknown>>).new.clientId).toBe('bulwark-webmail');
  });

  it('registers a public first-party client for Bulwark Mobile on Stalwart 1.0 (#1459)', async () => {
    const res = await setup();
    expect(res.status).toBe(200);
    expect((await res.json()).mobileClient).toBe('created');
    const mobile = (setCalls()[1].create as Record<string, Record<string, unknown>>).mobile;
    expect(mobile).toMatchObject({
      clientId: 'bulwark-mobile',
      firstParty: true,
      redirectUris: { 'org.bulwarkmail.mobile:/auth/callback': true },
    });
    // The app has no secret to send; a client with one fails its token exchange.
    expect(mobile).not.toHaveProperty('secret');
  });

  it('takes over an existing Bulwark Mobile client and drops its secret', async () => {
    existing = { 'bulwark-mobile': 'm' };
    const res = await setup();
    expect((await res.json()).mobileClient).toBe('updated');
    const update = (setCalls()[1].update as Record<string, Record<string, unknown>>).m;
    expect(update).toMatchObject({ secret: null, firstParty: true, redirectUris: { 'org.bulwarkmail.mobile:/auth/callback': true } });
  });

  it('still sets up the webmail when Stalwart refuses the mobile client', async () => {
    mobileRefused = true;
    const res = await setup();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.mobileClient).toBe('failed');
  });

  it('never adds the mobile redirect URI to the webmail client', async () => {
    await setup();
    const webmail = (setCalls()[0].create as Record<string, Record<string, unknown>>).new;
    expect(Object.keys(webmail.redirectUris as object).every((uri) => uri.startsWith('https://webmail.example.org/'))).toBe(true);
  });

  it('registers a first-party client, which Stalwart 1.0 gives full access', async () => {
    const res = await setup();
    expect(res.status).toBe(200);
    const create = (jmapCalls[1][1].create as Record<string, Record<string, unknown>>).new;
    expect(create.firstParty).toBe(true);
  });

  it('registers the client without firstParty on Stalwart 0.16, which has no such field', async () => {
    stalwart016 = true;
    const res = await setup();
    expect(res.status).toBe(200);
    // No mobile client either: first-party clients are a 1.0 thing.
    expect(jmapCalls.map(([name]) => name)).toEqual(['x:OAuthClient/query', 'x:OAuthClient/set', 'x:OAuthClient/set']);
    const create = (jmapCalls[2][1].create as Record<string, Record<string, unknown>>).new;
    expect(create.clientId).toBe('bulwark-webmail');
    expect(create).not.toHaveProperty('firstParty');
    expect((await res.json()).mobileClient).toBe('skipped');
  });

  it('leaves the requested scopes alone before Stalwart 1.0.3', async () => {
    await setup();
    expect(savedConfig).not.toHaveProperty('oauthExtraScopes');
    expect(savedConfig).not.toHaveProperty('oauthScopes');
  });

  describe('on Stalwart 1.0.3, which dropped firstParty (#1527)', () => {
    beforeEach(() => { stalwart103 = true; });

    it('allows the client the data scopes and full access instead of firstParty', async () => {
      const res = await setup();
      expect(res.status).toBe(200);
      const create = (setCalls()[0].create as Record<string, Record<string, unknown>>).new;
      expect(create.scopes).toEqual({ ...DATA_SCOPES, full: true });
      expect(create).not.toHaveProperty('firstParty');
      expect((await res.json()).stalwartScopes).toEqual(['urn:stalwart:oauth:scope:full']);
    });

    it('has the sign-in ask for the full scope the client now allows', async () => {
      storedConfig = { oauthExtraScopes: 'offline_access' };
      await setup();
      expect(savedConfig?.oauthExtraScopes).toBe('offline_access urn:stalwart:oauth:scope:full');
      expect(savedConfig).not.toHaveProperty('oauthScopes');
    });

    it('adds the scope to an explicit scope list, which replaces the extra scopes', async () => {
      storedConfig = { oauthScopes: 'openid offline_access' };
      await setup();
      expect(savedConfig?.oauthScopes).toBe('openid offline_access urn:stalwart:oauth:scope:full');
      expect(savedConfig).not.toHaveProperty('oauthExtraScopes');
    });

    it('updates an existing client with the scopes and gives the mobile client the same', async () => {
      existing = { 'bulwark-webmail': 'w', 'bulwark-mobile': 'm' };
      const res = await setup();
      expect((await res.json()).mobileClient).toBe('updated');
      const [webmail, mobile] = setCalls();
      expect((webmail.update as Record<string, Record<string, unknown>>).w.scopes).toEqual({ ...DATA_SCOPES, full: true });
      const mobileUpdate = (mobile.update as Record<string, Record<string, unknown>>).m;
      expect(mobileUpdate.scopes).toEqual({ ...DATA_SCOPES, full: true });
      expect(mobileUpdate).not.toHaveProperty('firstParty');
    });

    it('falls back to security and settings when the admin may not allow full access', async () => {
      superuser = false;
      storedConfig = { oauthExtraScopes: 'urn:stalwart:oauth:scope:full' };
      const res = await setup();
      expect(res.status).toBe(200);
      const [refused, webmail, mobile] = setCalls();
      expect((refused.create as Record<string, Record<string, unknown>>).new.scopes).toEqual({ ...DATA_SCOPES, full: true });
      expect((webmail.create as Record<string, Record<string, unknown>>).new.scopes)
        .toEqual({ ...DATA_SCOPES, security: true, settings: true });
      expect((mobile.create as Record<string, Record<string, unknown>>).mobile.scopes)
        .toEqual({ ...DATA_SCOPES, security: true, settings: true });
      // Asking for full now would fail every sign-in with invalid_scope.
      expect(savedConfig?.oauthExtraScopes).toBe('urn:stalwart:oauth:scope:security urn:stalwart:oauth:scope:settings');
      expect((await res.json()).stalwartScopes).toEqual([
        'urn:stalwart:oauth:scope:security',
        'urn:stalwart:oauth:scope:settings',
      ]);
    });
  });

  it('tells the admin to sign in to the webmail when no mail account is signed in here', async () => {
    signedIn = false;
    const res = await setup();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Sign in to this webmail.*Stalwart web admin does not count/);
    expect(jmapCalls).toEqual([]);
  });

  it('refuses in read-only mode without sending anything to Stalwart (#1250)', async () => {
    readOnly = true;
    const res = await setup();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/read-only/);
    expect(jmapCalls).toEqual([]);
  });

  it('destroys the client it just created when saving the config fails', async () => {
    saveError = new Error('EROFS');
    const res = await setup();
    expect(res.status).toBe(500);
    expect(jmapCalls.at(-1)).toEqual(['x:OAuthClient/set', { accountId: 'a', destroy: ['h'] }]);
  });
});

describe('GET /api/admin/oauth/setup', () => {
  const check = () => GET(new NextRequest('http://localhost/api/admin/oauth/setup'));

  it('names the mail account the setup would run as', async () => {
    const res = await check();
    expect(await res.json()).toEqual({ signedIn: true, username: 'admin@example.org' });
  });

  it('says so when no mail account is signed in to this webmail', async () => {
    signedIn = false;
    const res = await check();
    expect(await res.json()).toEqual({ signedIn: false });
  });

  it('never hands the credential to the page', async () => {
    const body = JSON.stringify(await (await check()).json());
    expect(body).not.toContain('Basic');
  });
});
