import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.fn();
const undiciFetch = vi.fn();

vi.mock('undici', () => ({
  Agent: class MockAgent {
    constructor(public opts: unknown) {}
  },
  fetch: (...args: unknown[]) => undiciFetch(...args),
}));

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return {
    ...actual,
    default: { ...actual, lookup: (...args: unknown[]) => lookup(...args) },
    lookup: (...args: unknown[]) => lookup(...args),
  };
});

describe('isPublicHttpUrl', () => {
  beforeEach(() => {
    lookup.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function load() {
    const mod = await import('@/lib/security/url-guard');
    return mod.isPublicHttpUrl;
  }

  it('accepts public https URLs whose DNS resolves to a public address', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('https://example.com/jmap')).toBe(true);
  });

  it('rejects malformed URLs', async () => {
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('not a url')).toBe(false);
    expect(await isPublicHttpUrl('')).toBe(false);
  });

  it('rejects non-http(s) protocols', async () => {
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('file:///etc/passwd')).toBe(false);
    expect(await isPublicHttpUrl('gopher://example.com/')).toBe(false);
    expect(await isPublicHttpUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects URLs with embedded credentials', async () => {
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('https://user:pass@example.com/')).toBe(false);
    expect(await isPublicHttpUrl('https://user@example.com/')).toBe(false);
  });

  it('rejects loopback hostnames without DNS', async () => {
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('http://localhost/')).toBe(false);
    expect(await isPublicHttpUrl('http://service.localhost/')).toBe(false);
    expect(await isPublicHttpUrl('http://server.local/')).toBe(false);
    expect(await isPublicHttpUrl('http://kube.internal/api')).toBe(false);
    expect(await isPublicHttpUrl('http://1.0.0.127.in-addr.arpa/')).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects literal IPv4 loopback and RFC-1918 ranges', async () => {
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('http://127.0.0.1/')).toBe(false);
    expect(await isPublicHttpUrl('http://10.0.0.5/')).toBe(false);
    expect(await isPublicHttpUrl('http://10.255.255.255/')).toBe(false);
    expect(await isPublicHttpUrl('http://172.16.0.1/')).toBe(false);
    expect(await isPublicHttpUrl('http://172.31.255.254/')).toBe(false);
    expect(await isPublicHttpUrl('http://192.168.1.1/')).toBe(false);
    expect(await isPublicHttpUrl('http://0.0.0.0/')).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects literal AWS / GCP / Azure metadata IP', async () => {
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(await isPublicHttpUrl('http://169.254.0.1/')).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects IPv6 loopback, ULA, and link-local literals', async () => {
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('http://[::1]/')).toBe(false);
    expect(await isPublicHttpUrl('http://[::]/')).toBe(false);
    expect(await isPublicHttpUrl('http://[fc00::1]/')).toBe(false);
    expect(await isPublicHttpUrl('http://[fd12:3456::1]/')).toBe(false);
    expect(await isPublicHttpUrl('http://[fe80::1]/')).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    'http://127.0.0.2/',
    'http://127.255.255.254/',
    'http://100.64.0.1/',
    'http://100.100.100.200/',
    'http://198.18.0.1/',
    'http://240.0.0.1/',
    'http://224.0.0.1/',
    'http://255.255.255.255/',
    'http://0.1.2.3/',
    'http://[::ffff:127.0.0.2]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://[64:ff9b:1::1]/',
    'http://[2002:7f00:1::]/',
    'http://[2002:a9fe:a9fe::]/',
    'http://[2001:0:4136:e378:8000:63bf:80ff:fffe]/',
    'http://[ff02::1]/',
  ])('rejects the special-purpose literal %s', async (url) => {
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl(url)).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(['127.0.0.2', '100.64.0.1', '198.18.0.1', '64:ff9b::7f00:1', '2002:7f00:1::'])(
    'rejects a hostname resolving to %s',
    async (address) => {
      lookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);
      const isPublicHttpUrl = await load();
      expect(await isPublicHttpUrl('https://rebind.example.com/')).toBe(false);
    },
  );

  it('accepts public addresses embedded in NAT64 / 6to4 forms', async () => {
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('http://[64:ff9b::5db8:d822]/')).toBe(true);
    expect(await isPublicHttpUrl('http://[2002:5db8:d822::1]/')).toBe(true);
  });

  it('rejects when DNS resolves to a private address (rebinding)', async () => {
    lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('https://evil.example.com/')).toBe(false);
  });

  it('rejects when any resolved address is private (mixed)', async () => {
    lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('https://mixed.example.com/')).toBe(false);
  });

  it('rejects when DNS resolves to IPv6 loopback', async () => {
    lookup.mockResolvedValue([{ address: '::1', family: 6 }]);
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('https://evil6.example.com/')).toBe(false);
  });

  it('rejects when DNS lookup throws', async () => {
    lookup.mockRejectedValue(new Error('ENOTFOUND'));
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('https://nonexistent.example.com/')).toBe(false);
  });

  it('rejects when DNS returns no records', async () => {
    lookup.mockResolvedValue([]);
    const isPublicHttpUrl = await load();
    expect(await isPublicHttpUrl('https://empty.example.com/')).toBe(false);
  });
});

describe('guardedLookup', () => {
  beforeEach(() => {
    lookup.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  type LookupResult = { err: NodeJS.ErrnoException | null; address?: unknown; family?: number };

  async function run(hostname: string, options: Record<string, unknown> = {}): Promise<LookupResult> {
    const { guardedLookup } = await import('@/lib/security/url-guard');
    return new Promise((resolve) => {
      guardedLookup(hostname, options, (err, address, family) => resolve({ err, address, family }));
    });
  }

  it('hands back a public address in net.connect callback form', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const result = await run('example.com', { family: 0 });
    expect(result.err).toBeNull();
    expect(result.address).toBe('93.184.216.34');
    expect(result.family).toBe(4);
  });

  it('honours options.all (happy-eyeballs path)', async () => {
    lookup.mockResolvedValue([
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ]);
    const result = await run('example.com', { all: true });
    expect(result.err).toBeNull();
    expect(result.address).toEqual([
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ]);
  });

  it('errors instead of returning a private address', async () => {
    lookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    const result = await run('internal.example.com');
    expect(result.err).toMatchObject({ code: 'EBLOCKED', address: '10.0.0.1' });
    expect(result.address).toBeUndefined();
  });

  it('errors when any address in the answer is private', async () => {
    lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    const result = await run('mixed.example.com', { all: true });
    expect(result.err).toMatchObject({ code: 'EBLOCKED', address: '169.254.169.254' });
  });

  it.each(['127.0.0.2', '100.64.0.1', '64:ff9b::7f00:1'])(
    'refuses a public name that resolves to %s',
    async (address) => {
      lookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);
      const result = await run('rebind.attacker.example', { all: true });
      expect(result.err).toMatchObject({ code: 'EBLOCKED', address });
    },
  );

  it('rebinding: a name that was public on the first answer is refused on the second', async () => {
    lookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const first = await run('rebind.example.com');
    expect(first.err).toBeNull();
    expect(first.address).toBe('93.184.216.34');
    const second = await run('rebind.example.com');
    expect(second.err).toMatchObject({ code: 'EBLOCKED', address: '127.0.0.1' });
  });

  it('refuses blocked hostnames and literal private IPs without a DNS query', async () => {
    for (const host of ['localhost', 'metadata.internal', '127.0.0.1', '::1', '[fe80::1]']) {
      const result = await run(host);
      expect(result.err, host).toMatchObject({ code: 'EBLOCKED' });
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('surfaces ENOTFOUND for empty answers', async () => {
    lookup.mockResolvedValue([]);
    const result = await run('nothing.example.com');
    expect(result.err).toMatchObject({ code: 'ENOTFOUND' });
  });

  it('propagates resolver errors', async () => {
    const boom = Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' });
    lookup.mockRejectedValue(boom);
    const result = await run('flaky.example.com');
    expect(result.err).toBe(boom);
  });
});

describe('fetchPublicUrl', () => {
  beforeEach(() => {
    lookup.mockReset();
    undiciFetch.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('rejects disallowed URLs up front without dispatching', async () => {
    const { fetchPublicUrl, DisallowedUrlError } = await import('@/lib/security/url-guard');
    for (const target of [
      'http://127.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://localhost/',
      'http://kube.internal/',
      'https://user:pw@example.com/',
      'file:///etc/passwd',
      'not a url',
    ]) {
      await expect(fetchPublicUrl(target), target).rejects.toBeInstanceOf(DisallowedUrlError);
    }
    expect(undiciFetch).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('dispatches allowed URLs through the guarded agent with redirects disabled', async () => {
    const { fetchPublicUrl, guardedLookup } = await import('@/lib/security/url-guard');
    const response = { status: 200 };
    undiciFetch.mockResolvedValue(response);

    const result = await fetchPublicUrl('https://example.com/feed.ics', {
      headers: { Accept: 'text/calendar' },
      // A caller cannot re-enable automatic redirects; each hop must come back
      // through the literal-IP / hostname checks.
      ...({ redirect: 'follow' } as object),
    });

    expect(result).toBe(response);
    expect(undiciFetch).toHaveBeenCalledTimes(1);
    const [url, init] = undiciFetch.mock.calls[0] as [
      string,
      { redirect: string; headers: unknown; dispatcher: { opts: { connect: { lookup: unknown } } } },
    ];
    expect(url).toBe('https://example.com/feed.ics');
    expect(init.redirect).toBe('manual');
    expect(init.headers).toEqual({ Accept: 'text/calendar' });
    expect(init.dispatcher.opts).toEqual({ connect: { lookup: guardedLookup } });
  });

  it('reuses one dispatcher across calls', async () => {
    const { fetchPublicUrl } = await import('@/lib/security/url-guard');
    undiciFetch.mockResolvedValue({ status: 200 });
    await fetchPublicUrl('https://a.example.com/');
    await fetchPublicUrl('https://b.example.com/');
    const [, first] = undiciFetch.mock.calls[0] as [string, { dispatcher: unknown }];
    const [, second] = undiciFetch.mock.calls[1] as [string, { dispatcher: unknown }];
    expect(first.dispatcher).toBe(second.dispatcher);
  });

  it("translates a connect-time block (wrapped in undici's 'fetch failed') into DisallowedUrlError", async () => {
    const { fetchPublicUrl, DisallowedUrlError, BlockedAddressError } = await import('@/lib/security/url-guard');
    const blocked = new BlockedAddressError('rebind.example.com', '127.0.0.1');
    undiciFetch.mockRejectedValue(new TypeError('fetch failed', { cause: blocked }));

    const err = await fetchPublicUrl('https://rebind.example.com/').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DisallowedUrlError);
    expect((err as Error).cause).toBe(blocked);
  });

  it('lets unrelated network errors through unchanged', async () => {
    const { fetchPublicUrl, DisallowedUrlError } = await import('@/lib/security/url-guard');
    const boom = new TypeError('fetch failed', {
      cause: Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    undiciFetch.mockRejectedValue(boom);

    const err = await fetchPublicUrl('https://down.example.com/').catch((e: unknown) => e);
    expect(err).toBe(boom);
    expect(err).not.toBeInstanceOf(DisallowedUrlError);
  });
});
