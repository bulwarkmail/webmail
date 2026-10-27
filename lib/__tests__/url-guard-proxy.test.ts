// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect as netConnect, type AddressInfo } from 'node:net';

/**
 * #1367: with NODE_USE_ENV_PROXY=1 and HTTP(S)_PROXY set, Node's own fetch
 * goes through the proxy, but fetchPublicUrl (iCal subscriptions and other
 * caller-supplied URLs) connected directly. It now resolves and checks the
 * address itself, then asks the proxy for a tunnel to exactly that address,
 * so the private-address guard still holds.
 *
 * The fake proxy below records every CONNECT and tunnels it to a local origin
 * server, whatever address was asked for.
 */

const lookup = vi.fn();

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return {
    ...actual,
    default: { ...actual, lookup: (...args: unknown[]) => lookup(...args) },
    lookup: (...args: unknown[]) => lookup(...args),
  };
});

// TEST-NET-1: passes the guard, but nothing answers there, so only the proxy
// can make a request to it succeed.
const PUBLIC_IP = '192.0.2.10';

describe('fetchPublicUrl behind an outbound proxy', () => {
  let origin: Server;
  let originPort: number;
  let originHosts: string[] = [];
  let proxy: Server;
  let proxyPort: number;
  let tunnels: Array<{ target: string; auth: string | undefined }> = [];

  beforeAll(async () => {
    origin = createServer((req, res) => {
      originHosts.push(req.headers.host ?? '');
      res.writeHead(200, { 'content-type': 'text/calendar' });
      res.end('BEGIN:VCALENDAR\nEND:VCALENDAR\n');
    });
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
    originPort = (origin.address() as AddressInfo).port;

    proxy = createServer((_req, res) => { res.writeHead(405); res.end(); });
    proxy.on('connect', (req, client, head) => {
      tunnels.push({ target: req.url ?? '', auth: req.headers['proxy-authorization'] });
      const upstream = netConnect(originPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(async () => {
    proxy.closeAllConnections();
    origin.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  });

  beforeEach(() => {
    lookup.mockReset();
    originHosts = [];
    tunnels = [];
    for (const name of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY', 'NODE_USE_ENV_PROXY']) {
      vi.stubEnv(name, undefined);
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const useProxy = (auth = '') => {
    vi.stubEnv('NODE_USE_ENV_PROXY', '1');
    vi.stubEnv('HTTP_PROXY', `http://${auth}127.0.0.1:${proxyPort}`);
  };

  it('tunnels through the proxy to the address it checked, keeping the Host header', async () => {
    useProxy();
    lookup.mockResolvedValue([{ address: PUBLIC_IP, family: 4 }]);
    const { fetchPublicUrl } = await import('@/lib/security/url-guard');

    const res = await fetchPublicUrl(`http://cal.example:${originPort}/a.ics`, { signal: AbortSignal.timeout(3000) });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('BEGIN:VCALENDAR');
    expect(tunnels.map((t) => t.target)).toEqual([`${PUBLIC_IP}:${originPort}`]);
    expect(originHosts).toEqual([`cal.example:${originPort}`]);
  });

  it('sends the proxy credentials from the proxy URL', async () => {
    useProxy('us%40er:p%3Ass@');
    lookup.mockResolvedValue([{ address: PUBLIC_IP, family: 4 }]);
    const { fetchPublicUrl } = await import('@/lib/security/url-guard');

    const res = await fetchPublicUrl(`http://cal.example:${originPort}/a.ics`, { signal: AbortSignal.timeout(3000) });
    await res.text();
    expect(tunnels[0]?.auth).toBe(`Basic ${Buffer.from('us@er:p:ss').toString('base64')}`);
  });

  it('refuses a name that resolves to a private address, with a proxy', async () => {
    useProxy();
    lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const { fetchPublicUrl, DisallowedUrlError } = await import('@/lib/security/url-guard');

    await expect(fetchPublicUrl(`http://rebind.example:${originPort}/a.ics`)).rejects.toBeInstanceOf(DisallowedUrlError);
    expect(tunnels).toEqual([]);
    expect(originHosts).toEqual([]);
  });

  it('refuses a private literal address, with a proxy', async () => {
    useProxy();
    const { fetchPublicUrl, DisallowedUrlError } = await import('@/lib/security/url-guard');

    await expect(fetchPublicUrl(`http://10.1.2.3:${originPort}/a.ics`)).rejects.toBeInstanceOf(DisallowedUrlError);
    expect(tunnels).toEqual([]);
  });

  it('refuses a name that resolves to a private address, without a proxy', async () => {
    lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const { fetchPublicUrl, DisallowedUrlError } = await import('@/lib/security/url-guard');

    await expect(fetchPublicUrl(`http://rebind.example:${originPort}/a.ics`)).rejects.toBeInstanceOf(DisallowedUrlError);
    expect(tunnels).toEqual([]);
    expect(originHosts).toEqual([]);
  });
});

describe('which proxy a URL uses', () => {
  beforeEach(() => {
    for (const name of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY', 'NODE_USE_ENV_PROXY']) {
      vi.stubEnv(name, undefined);
    }
  });
  afterEach(() => vi.unstubAllEnvs());

  it('uses none unless Node is told to use the environment proxy, as Node fetch does', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.corp:3128');
    const { envProxyFor } = await import('@/lib/security/url-guard');
    expect(envProxyFor(new URL('https://cal.example/a.ics'))).toBeNull();
    vi.stubEnv('NODE_USE_ENV_PROXY', '1');
    expect(envProxyFor(new URL('https://cal.example/a.ics'))?.href).toBe('http://proxy.corp:3128/');
  });

  it('picks the proxy by scheme, https falling back to the http proxy', async () => {
    vi.stubEnv('NODE_USE_ENV_PROXY', '1');
    vi.stubEnv('HTTP_PROXY', 'http://plain.corp:3128');
    const { envProxyFor } = await import('@/lib/security/url-guard');
    expect(envProxyFor(new URL('https://cal.example/a.ics'))?.host).toBe('plain.corp:3128');
    vi.stubEnv('https_proxy', 'http://tls.corp:3128');
    expect(envProxyFor(new URL('https://cal.example/a.ics'))?.host).toBe('tls.corp:3128');
    expect(envProxyFor(new URL('http://cal.example/a.ics'))?.host).toBe('plain.corp:3128');
  });

  it('skips hosts listed in NO_PROXY', async () => {
    vi.stubEnv('NODE_USE_ENV_PROXY', '1');
    vi.stubEnv('HTTP_PROXY', 'http://plain.corp:3128');
    vi.stubEnv('NO_PROXY', 'intra.example, .corp.example,cal.example:8443');
    const { envProxyFor } = await import('@/lib/security/url-guard');
    expect(envProxyFor(new URL('http://intra.example/a.ics'))).toBeNull();
    expect(envProxyFor(new URL('http://a.intra.example/a.ics'))).toBeNull();
    expect(envProxyFor(new URL('http://x.corp.example/a.ics'))).toBeNull();
    expect(envProxyFor(new URL('https://cal.example:8443/a.ics'))).toBeNull();
    expect(envProxyFor(new URL('https://cal.example/a.ics'))).not.toBeNull();
    expect(envProxyFor(new URL('http://other.example/a.ics'))).not.toBeNull();
    vi.stubEnv('NO_PROXY', '*');
    expect(envProxyFor(new URL('http://other.example/a.ics'))).toBeNull();
  });
});
