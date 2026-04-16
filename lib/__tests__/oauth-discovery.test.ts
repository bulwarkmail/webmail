import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OAuthMetadata } from '../oauth/discovery';

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

    const result = await discoverOAuth('https://mail.example.com');

    expect(result).toEqual(VALID_METADATA);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://mail.example.com/.well-known/oauth-authorization-server'
    );
  });

  it('falls back to openid-configuration when first returns 404', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(VALID_METADATA),
      }));

    const result = await discoverOAuth('https://fallback.example.com');

    expect(result).toEqual(VALID_METADATA);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://fallback.example.com/.well-known/openid-configuration'
    );
  });

  it('returns null when both endpoints fail', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: false, status: 404 }));

    const result = await discoverOAuth('https://fail.example.com');

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('parses optional fields (revocation_endpoint, end_session_endpoint)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(VALID_METADATA),
    }));

    const result = await discoverOAuth('https://optional.example.com');

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

    const result = await discoverOAuth('https://incomplete.example.com');

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('caches results - second call for same server URL does not re-fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(VALID_METADATA),
    }));

    const first = await discoverOAuth('https://cached.example.com');
    const second = await discoverOAuth('https://cached.example.com');

    expect(first).toEqual(VALID_METADATA);
    expect(second).toEqual(VALID_METADATA);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
