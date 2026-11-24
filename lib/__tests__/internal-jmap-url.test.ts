import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// #1294: Bulwark's server reaches the JMAP server under an internal URL
// while browsers keep the public one.

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn(),
  },
}));

import { configManager } from '@/lib/admin/config-manager';
import { rewriteToInternalUrl, serverSideJmapUrl } from '@/lib/stalwart/internal-url';
import { fetchJmapServer } from '@/lib/stalwart/server-fetch';
import { verifyJmapAuth } from '@/lib/auth/verify-jmap-auth';
import { parseJmapServers, redactJmapServers } from '@/lib/admin/jmap-servers';

const mockGet = configManager.get as unknown as Mock;
let plainFetch: Mock;

function configure(values: Record<string, unknown>) {
  mockGet.mockImplementation((key: string, fallback?: unknown) => (key in values ? values[key] : fallback));
}

beforeEach(() => {
  plainFetch = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', plainFetch);
  mockGet.mockReset();
  configure({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rewriteToInternalUrl', () => {
  const map = [{ publicUrl: 'https://mail.example.com', internalUrl: 'http://stalwart:8080' }];

  it('maps the public origin and anything below it', () => {
    expect(rewriteToInternalUrl('https://mail.example.com/.well-known/jmap', map)).toBe('http://stalwart:8080/.well-known/jmap');
    expect(rewriteToInternalUrl('https://MAIL.example.com:443/jmap/?x=1', map)).toBe('http://stalwart:8080/jmap/?x=1');
    expect(rewriteToInternalUrl('https://mail.example.com', map)).toBe('http://stalwart:8080/');
  });

  it('leaves other hosts, schemes and ports alone', () => {
    expect(rewriteToInternalUrl('https://evil.example.com/jmap', map)).toBe('https://evil.example.com/jmap');
    expect(rewriteToInternalUrl('http://mail.example.com/jmap', map)).toBe('http://mail.example.com/jmap');
    expect(rewriteToInternalUrl('https://mail.example.com:8443/jmap', map)).toBe('https://mail.example.com:8443/jmap');
    expect(rewriteToInternalUrl('not a url', map)).toBe('not a url');
  });

  it('matches a public URL with a path only at a segment boundary', () => {
    const withPath = [{ publicUrl: 'https://example.com/mail/', internalUrl: 'http://stalwart:8080/' }];
    expect(rewriteToInternalUrl('https://example.com/mail/jmap/session', withPath)).toBe('http://stalwart:8080/jmap/session');
    expect(rewriteToInternalUrl('https://example.com/mailbox/jmap', withPath)).toBe('https://example.com/mailbox/jmap');
  });
});

describe('serverSideJmapUrl', () => {
  it('is the URL itself without an internal URL', async () => {
    configure({ jmapServerUrl: 'https://mail.example.com' });
    expect(serverSideJmapUrl('https://mail.example.com/jmap/')).toBe('https://mail.example.com/jmap/');
  });

  it('uses JMAP_INTERNAL_SERVER_URL for the main server and internalUrl for a list entry', async () => {
    configure({
      jmapServerUrl: 'https://mail.example.com',
      jmapInternalServerUrl: 'http://stalwart:8080',
      jmapServers: [{ id: 'b', label: 'B', url: 'https://other.example.org', internalUrl: 'http://other-stalwart:8080/' }],
    });
    expect(serverSideJmapUrl('https://mail.example.com/jmap/')).toBe('http://stalwart:8080/jmap/');
    expect(serverSideJmapUrl('https://other.example.org/.well-known/jmap')).toBe('http://other-stalwart:8080/.well-known/jmap');
  });
});

describe('server-side requests', () => {
  beforeEach(() => {
    configure({ jmapServerUrl: 'https://mail.example.com', jmapInternalServerUrl: 'http://stalwart:8080' });
  });

  it('fetchJmapServer sends a configured server\'s requests to its internal URL', async () => {
    await fetchJmapServer('https://mail.example.com/jmap/', { method: 'POST' }, true, { storedCredential: false });
    expect(plainFetch.mock.calls[0][0]).toBe('http://stalwart:8080/jmap/');
  });

  it('fetchJmapServer leaves a user-chosen server on the guarded path', async () => {
    const guarded = await import('@/lib/security/url-guard');
    const spy = vi.spyOn(guarded, 'fetchPublicUrl').mockResolvedValue(new Response('{}') as never);
    await fetchJmapServer('https://elsewhere.example.net/jmap/', {}, false, { storedCredential: false }).catch(() => {});
    expect(plainFetch.mock.calls.map((c) => String(c[0]))).not.toContain('http://stalwart:8080/jmap/');
    spy.mockRestore();
  });

  it('sign-in verification reads the session over the internal URL, also after a redirect', async () => {
    plainFetch
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: '/jmap/session' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ apiUrl: 'https://mail.example.com/jmap/', accounts: {}, primaryAccounts: {} }), { status: 200 }));
    await verifyJmapAuth('https://mail.example.com', 'Basic dTpw', { trusted: true });
    expect(plainFetch.mock.calls.map((c) => String(c[0]))).toEqual([
      'http://stalwart:8080/.well-known/jmap',
      'http://stalwart:8080/jmap/session',
    ]);
  });
});

describe('password sign-in', () => {
  it('posts the login and the token request to the internal URL', async () => {
    configure({ jmapServerUrl: 'https://mail.example.com', jmapInternalServerUrl: 'http://stalwart:8080' });
    plainFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url === 'http://stalwart:8080/api/auth') return Response.json({ type: 'authenticated', client_code: 'c', iss: 'https://mail.example.com' });
      if (url === 'http://stalwart:8080/auth/token') return Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
      return new Response('not found', { status: 404 });
    });
    const { stalwartPasswordLogin } = await import('@/lib/auth/stalwart-password-login');
    const result = await stalwartPasswordLogin({
      serverUrl: 'https://mail.example.com', username: 'a@example.com', password: 'p', totp: '123456',
      clientId: 'webmail', redirectUri: 'https://webmail.example/en/auth/callback', trusted: true,
    });
    expect(result).toMatchObject({ ok: true });
    const urls = plainFetch.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain('http://stalwart:8080/auth/token');
    expect(urls.some((u) => u.startsWith('https://mail.example.com'))).toBe(false);
  });
});

describe('jmapServers internalUrl', () => {
  it('is kept for the server and never sent to the browser', () => {
    const servers = parseJmapServers([{ id: 'a', label: 'A', url: 'https://mail.example.com', internalUrl: 'http://stalwart:8080/' }]);
    expect(servers[0].internalUrl).toBe('http://stalwart:8080');
    expect(JSON.stringify(redactJmapServers(servers))).not.toContain('stalwart:8080');
    expect(parseJmapServers([{ id: 'a', label: 'A', url: 'https://mail.example.com', internalUrl: 'file:///etc' }])[0]).not.toHaveProperty('internalUrl');
  });
});
