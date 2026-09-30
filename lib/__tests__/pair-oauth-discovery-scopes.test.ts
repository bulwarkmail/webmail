import { afterEach, describe, expect, it, vi } from 'vitest';

// OAuth discovery now keeps `scopes_supported`, which the pairing re-auth
// reads to decide whether to ask for offline_access.

const METADATA = {
  issuer: 'https://idp.example.net',
  authorization_endpoint: 'https://idp.example.net/authorize',
  token_endpoint: 'https://idp.example.net/token',
};

async function discover(document: Record<string, unknown>) {
  // A fresh module each time: discovery caches per URL.
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(document) }));
  const { discoverOAuth } = await import('@/lib/oauth/discovery');
  return discoverOAuth('https://idp.example.net', { validateEndpoint: async () => true });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('discoverOAuth scopes_supported', () => {
  it('keeps the advertised scopes', async () => {
    const metadata = await discover({ ...METADATA, scopes_supported: ['openid', 'email', 'offline_access'] });
    expect(metadata?.scopes_supported).toEqual(['openid', 'email', 'offline_access']);
  });

  it('drops entries that are not strings', async () => {
    const metadata = await discover({ ...METADATA, scopes_supported: ['openid', 42, null, { x: 1 }, 'offline_access'] });
    expect(metadata?.scopes_supported).toEqual(['openid', 'offline_access']);
  });

  it('leaves the field out when the document has none or a malformed one', async () => {
    expect(await discover(METADATA)).not.toHaveProperty('scopes_supported');
    expect(await discover({ ...METADATA, scopes_supported: 'openid offline_access' })).not.toHaveProperty('scopes_supported');
  });
});
