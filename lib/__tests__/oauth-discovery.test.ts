import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OAuthMetadata } from '../oauth/discovery';

const validateEndpoint = async (urlString: string) => {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (/^(127\.|169\.254\.|10\.|192\.168\.)/.test(host)) return false;
    if (host === '::1' || host === '0.0.0.0') return false;
    return true;
  } catch {
    return false;
  }
};

const VALID_METADATA: OAuthMetadata = {
  issuer: 'https://auth.example.com',
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
  revocation_endpoint: 'https://auth.example.com/revoke',
  end_session_endpoint: 'https://auth.example.com/logout',
};

describe('oauth/discovery', () => {
  let discoverOAuth: typeof import('../oauth/discovery').discoverOAuth;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
    const mod = await import('../oauth/discovery');
    discoverOAuth = mod.discoverOAuth;
  });

  it('discovers metadata from oauth-authorization-server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(VALID_METADATA),
    }));

    const result = await discoverOAuth('https://mail.example.com', { validateEndpoint });

    expect(result).toEqual(VALID_METADATA);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://mail.example.com/.well-known/oauth-authorization-server',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('falls back to openid-configuration when first returns 404', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(VALID_METADATA),
      }));

    const result = await discoverOAuth('https://fallback.example.com', { validateEndpoint });

    expect(result).toEqual(VALID_METADATA);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://fallback.example.com/.well-known/openid-configuration',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('returns null when both endpoints fail', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: false, status: 404 }));

    const result = await discoverOAuth('https://fail.example.com', { validateEndpoint });

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('parses optional fields (revocation_endpoint, end_session_endpoint)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(VALID_METADATA),
    }));

    const result = await discoverOAuth('https://optional.example.com', { validateEndpoint });

    expect(result?.revocation_endpoint).toBe('https://auth.example.com/revoke');
    expect(result?.end_session_endpoint).toBe('https://auth.example.com/logout');
  });

  it('returns null when required fields (authorization_endpoint, token_endpoint) are missing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ issuer: 'https://auth.example.com' }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404 }));

    const result = await discoverOAuth('https://incomplete.example.com', { validateEndpoint });

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('rejects metadata pointing at loopback / link-local hosts (SSRF guard)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          issuer: 'https://evil.example.com',
          authorization_endpoint: 'https://evil.example.com/authorize',
          token_endpoint: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404 }));

    const result = await discoverOAuth('https://evil.example.com', { validateEndpoint });

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('rejects metadata pointing at private RFC1918 hosts (SSRF guard)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          issuer: 'https://evil.example.com',
          authorization_endpoint: 'https://evil.example.com/authorize',
          token_endpoint: 'https://evil.example.com/token',
          revocation_endpoint: 'http://127.0.0.1:9200/_cluster/state',
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404 }));

    const result = await discoverOAuth('https://private-revoke.example.com', { validateEndpoint });

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('accepts private/loopback endpoints when validateEndpoint is omitted (admin opted in)', async () => {
    // Split-DNS deployments: mail.example.com resolves to an RFC-1918 address
    // locally. With the SSRF validator off, discovery must succeed.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        issuer: 'https://mail.example.com',
        authorization_endpoint: 'http://10.0.0.5/authorize',
        token_endpoint: 'http://10.0.0.5/token',
      }),
    }));

    const result = await discoverOAuth('https://mail.example.com');

    expect(result?.token_endpoint).toBe('http://10.0.0.5/token');
  });

  it('caches results - second call for same server URL does not re-fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(VALID_METADATA),
    }));

    const first = await discoverOAuth('https://cached.example.com', { validateEndpoint });
    const second = await discoverOAuth('https://cached.example.com', { validateEndpoint });

    expect(first).toEqual(VALID_METADATA);
    expect(second).toEqual(VALID_METADATA);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds each discovery fetch with an AbortSignal timeout (no hang on unresponsive IdP)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(
      Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await discoverOAuth('https://unresponsive.example.com', { validateEndpoint });

    expect(result).toBeNull();
    // Every discovery fetch must carry an AbortSignal so an unresponsive IdP is
    // aborted (DISCOVERY_TIMEOUT_MS) instead of hanging the request - and, with
    // it, the login page's SSO button.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    }
  });

  it('retries once when the first attempt fails, then succeeds', async () => {
    // Attempt 1: both well-known URLs fail. Attempt 2: first URL succeeds.
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(VALID_METADATA) }));

    const result = await discoverOAuth('https://flaky.example.com', { validateEndpoint });

    expect(result).toEqual(VALID_METADATA);
    // 2 failures (attempt 1) + 1 success (attempt 2 retry).
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('serves stale cached metadata when a refresh fails (keeps the SSO button up)', async () => {
    vi.useFakeTimers();
    try {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // First call succeeds and caches the metadata.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(VALID_METADATA),
      }));
      const first = await discoverOAuth('https://stale.example.com', { validateEndpoint });
      expect(first).toEqual(VALID_METADATA);

      // Expire the cache (positive TTL is 10 min).
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);

      // Refresh now fails on every URL/attempt: the stale-but-usable value must
      // be returned instead of null so the SSO button keeps rendering.
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
      const pending = discoverOAuth('https://stale.example.com', { validateEndpoint });
      await vi.advanceTimersByTimeAsync(1000); // fire the retry backoff timer
      const second = await pending;

      expect(second).toEqual(VALID_METADATA);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('negative-caches a total failure (no cached value) to avoid hammering the IdP', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const first = await discoverOAuth('https://down.example.com', { validateEndpoint });
    const callsAfterFirst = fetchMock.mock.calls.length;
    const second = await discoverOAuth('https://down.example.com', { validateEndpoint });

    expect(first).toBeNull();
    expect(second).toBeNull();
    // The immediate second call is short-circuited by the negative cache, so no
    // additional fetches are made.
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFirst);
  });
});
