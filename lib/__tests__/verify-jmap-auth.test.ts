import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.fn();

vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>();
  return {
    ...actual,
    default: { ...actual, lookup: (...args: unknown[]) => lookup(...args) },
    lookup: (...args: unknown[]) => lookup(...args),
  };
});

describe('verifyJmapAuth SSRF protection', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    lookup.mockReset();
    vi.resetModules();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  async function load() {
    const mod = await import('@/lib/auth/verify-jmap-auth');
    return mod;
  }

  it('rejects loopback literal without issuing fetch', async () => {
    const { verifyJmapAuth, JmapAuthVerificationError } = await load();
    await expect(verifyJmapAuth('http://127.0.0.1', 'Bearer x')).rejects.toBeInstanceOf(
      JmapAuthVerificationError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects AWS IMDS endpoint without issuing fetch', async () => {
    const { verifyJmapAuth } = await load();
    await expect(
      verifyJmapAuth('http://169.254.169.254', 'Bearer x'),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects RFC-1918 literals without issuing fetch', async () => {
    const { verifyJmapAuth } = await load();
    for (const target of ['http://10.0.0.5', 'http://172.16.0.1', 'http://192.168.1.1']) {
      await expect(verifyJmapAuth(target, 'Bearer x')).rejects.toMatchObject({ status: 400 });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects localhost hostname without issuing fetch', async () => {
    const { verifyJmapAuth } = await load();
    await expect(verifyJmapAuth('http://localhost', 'Bearer x')).rejects.toMatchObject({
      status: 400,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects IPv6 loopback literal without issuing fetch', async () => {
    const { verifyJmapAuth } = await load();
    await expect(verifyJmapAuth('http://[::1]', 'Bearer x')).rejects.toMatchObject({
      status: 400,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects hostnames whose DNS resolves to a private IP without issuing fetch', async () => {
    lookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    const { verifyJmapAuth } = await load();
    await expect(verifyJmapAuth('https://internal.example.com', 'Bearer x')).rejects.toMatchObject({
      status: 400,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects file:// URLs', async () => {
    const { verifyJmapAuth } = await load();
    await expect(verifyJmapAuth('file:///etc/passwd', 'Bearer x')).rejects.toMatchObject({
      status: 400,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses to follow a redirect to a private address', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    fetchSpy.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/.well-known/jmap' } }),
    );
    const { verifyJmapAuth } = await load();
    await expect(verifyJmapAuth('https://example.com', 'Bearer x')).rejects.toMatchObject({
      status: 400,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses to follow a redirect to AWS IMDS', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    );
    const { verifyJmapAuth } = await load();
    await expect(verifyJmapAuth('https://example.com', 'Bearer x')).rejects.toMatchObject({
      status: 400,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('accepts a public host that returns a valid JMAP session', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ apiUrl: 'https://example.com/api', accounts: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { verifyJmapAuth } = await load();
    await expect(verifyJmapAuth('https://example.com', 'Bearer x')).resolves.toBe(
      'https://example.com',
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://example.com/.well-known/jmap',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('rejects an invalid Authorization header before any fetch', async () => {
    const { verifyJmapAuth } = await load();
    await expect(verifyJmapAuth('https://example.com', 'NotAuth')).rejects.toMatchObject({
      status: 400,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('with trusted=true, accepts a hostname resolving to a private IP', async () => {
    lookup.mockResolvedValue([{ address: '10.0.20.5', family: 4 }]);
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ apiUrl: 'https://mail.internal/api', accounts: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { verifyJmapAuth } = await load();
    await expect(
      verifyJmapAuth('https://mail.internal', 'Bearer x', { trusted: true }),
    ).resolves.toBe('https://mail.internal');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://mail.internal/.well-known/jmap',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('with trusted=true, still rejects unsupported protocols', async () => {
    const { verifyJmapAuth } = await load();
    await expect(
      verifyJmapAuth('file:///etc/passwd', 'Bearer x', { trusted: true }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('with trusted=true, still rejects an invalid Authorization header', async () => {
    const { verifyJmapAuth } = await load();
    await expect(
      verifyJmapAuth('https://mail.internal', 'NotAuth', { trusted: true }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
