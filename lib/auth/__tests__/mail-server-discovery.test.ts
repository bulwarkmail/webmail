// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { emailDomain, normalizeServerInput, serverHostLabel, unsupportedProvider } from '../mail-server-address';
import { discoverMailServer, type DiscoveryDeps } from '../discover-mail-server';

describe('what people type', () => {
  it('takes the domain of a complete address only', () => {
    expect(emailDomain('Sam@Example.ORG ')).toBe('example.org');
    expect(emailDomain('sam@example')).toBe('');
    expect(emailDomain('sam@')).toBe('');
    expect(emailDomain('sam')).toBe('');
    expect(emailDomain('sam@127.0.0.1')).toBe('');
    expect(emailDomain('a@b@mail.example.org')).toBe('mail.example.org');
  });

  it('accepts a server with or without https://', () => {
    expect(normalizeServerInput('mail.example.org')).toBe('https://mail.example.org');
    expect(normalizeServerInput(' mail.example.org:8443/ ')).toBe('https://mail.example.org:8443');
    expect(normalizeServerInput('https://mail.example.org/')).toBe('https://mail.example.org');
    expect(normalizeServerInput('http://192.168.1.5:8080')).toBe('http://192.168.1.5:8080');
    expect(normalizeServerInput('mail example')).toBeNull();
    expect(normalizeServerInput('ftp://mail.example.org')).toBeNull();
    expect(normalizeServerInput('https://user:pw@mail.example.org')).toBeNull();
    expect(normalizeServerInput('')).toBeNull();
  });

  it('shows a server without its scheme', () => {
    expect(serverHostLabel('https://mail.example.org')).toBe('mail.example.org');
    expect(serverHostLabel('https://mail.example.org:8443')).toBe('mail.example.org:8443');
  });

  it('names the providers that offer no JMAP', () => {
    expect(unsupportedProvider('gmail.com')).toBe('Gmail');
    expect(unsupportedProvider('googlemail.com')).toBe('Gmail');
    expect(unsupportedProvider('hotmail.de')).toBe('Outlook.com');
    expect(unsupportedProvider('outlook.com')).toBe('Outlook.com');
    expect(unsupportedProvider('icloud.com')).toBe('iCloud Mail');
    expect(unsupportedProvider('me.com')).toBe('iCloud Mail');
    expect(unsupportedProvider('example.org')).toBeNull();
    expect(unsupportedProvider('fastmail.com')).toBeNull();
  });
});

type Answer = { status: number; headers?: Record<string, string>; body?: string };

function deps(answers: Record<string, Answer>, srv: { name: string; port: number; priority: number; weight: number }[] | Error = []) {
  const asked: string[] = [];
  const d: DiscoveryDeps = {
    fetch: vi.fn(async (url: string) => {
      asked.push(url);
      const a = answers[url];
      if (!a) throw new Error('ENOTFOUND');
      const headers = new Map(Object.entries(a.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      return { status: a.status, headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null }, text: async () => a.body ?? '' };
    }),
    resolveSrv: vi.fn(async () => {
      if (srv instanceof Error) throw srv;
      return srv;
    }),
  };
  return { d, asked };
}

const SESSION = { status: 200, headers: { 'content-type': 'application/json' }, body: '{"capabilities":{"urn:ietf:params:jmap:core":{}}}' };

describe('finding the server', () => {
  it('follows the well-known redirect to the server that answers', async () => {
    const { d } = deps({
      'https://example.org/.well-known/jmap': { status: 307, headers: { location: 'https://mail.example.org/jmap/session' } },
      'https://mail.example.org/jmap/session': { status: 401, headers: { 'www-authenticate': 'Basic realm="x"' } },
    });
    expect(await discoverMailServer('sam@example.org', d)).toBe('https://mail.example.org');
  });

  it('takes the anonymous session Stalwart answers with', async () => {
    const { d } = deps({
      'https://example.org/.well-known/jmap': { status: 307, headers: { location: '/jmap/session' } },
      'https://example.org/jmap/session': SESSION,
    });
    expect(await discoverMailServer('sam@example.org', d)).toBe('https://example.org');
  });

  it('falls back to the SRV record, on its port', async () => {
    const { d, asked } = deps(
      { 'https://jmap.example.net:8443/.well-known/jmap': SESSION },
      [{ name: 'jmap.example.net.', port: 8443, priority: 10, weight: 0 }],
    );
    expect(await discoverMailServer('sam@example.org', d)).toBe('https://jmap.example.net:8443');
    expect(asked[0]).toBe('https://example.org/.well-known/jmap');
  });

  it("doesn't take a web page or a 404 for a mail server", async () => {
    const { d } = deps({
      'https://example.org/.well-known/jmap': { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>' },
    });
    expect(await discoverMailServer('sam@example.org', d)).toBeNull();
    const second = deps({ 'https://example.org/.well-known/jmap': { status: 404 } });
    expect(await discoverMailServer('sam@example.org', second.d)).toBeNull();
    const json = deps({ 'https://example.org/.well-known/jmap': { status: 200, headers: { 'content-type': 'application/json' }, body: '{"hello":1}' } });
    expect(await discoverMailServer('sam@example.org', json.d)).toBeNull();
  });

  it('never follows a redirect down to plain http', async () => {
    const { d } = deps({
      'https://example.org/.well-known/jmap': { status: 302, headers: { location: 'http://mail.example.org/jmap/session' } },
      'http://mail.example.org/jmap/session': SESSION,
    }, new Error('ENODATA'));
    expect(await discoverMailServer('sam@example.org', d)).toBeNull();
  });

  it('asks nothing for something that is not an address', async () => {
    const { d, asked } = deps({});
    expect(await discoverMailServer('sam', d)).toBeNull();
    expect(await discoverMailServer('sam@localhost', d)).toBeNull();
    expect(asked).toEqual([]);
  });

  it('gives up on a redirect loop', async () => {
    const { d, asked } = deps({
      'https://example.org/.well-known/jmap': { status: 307, headers: { location: 'https://example.org/.well-known/jmap' } },
    });
    expect(await discoverMailServer('sam@example.org', d)).toBeNull();
    expect(asked.length).toBeLessThanOrEqual(4);
  });
});
