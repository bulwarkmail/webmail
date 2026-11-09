import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/oauth/discovery', () => ({
  discoverOAuth: vi.fn(),
}));

vi.mock('@/lib/security/url-guard', () => ({
  isPublicHttpUrl: vi.fn(),
}));

vi.mock('@/lib/read-file-env', () => ({
  readFileEnv: () => '',
}));

// Only the resource indicator comes from the admin config here; every other
// lookup falls through to its default so the stubbed env vars apply.
const adminConfig: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    get: (key: string, def: unknown) => (key in adminConfig ? adminConfig[key] : def),
    ensureLoaded: async () => {},
  },
}));

import { buildOAuthParams } from '@/lib/oauth/token-exchange';

describe('resource indicator on token requests (RFC 8707 section 2.2)', () => {
  beforeEach(() => {
    vi.stubEnv('JMAP_SERVER_URL', 'https://mail.example.com');
    vi.stubEnv('OAUTH_CLIENT_ID', 'webmail');
    vi.stubEnv('OAUTH_ISSUER_URL', 'https://idp.example.com/oidc');
    vi.stubEnv('OAUTH_CLIENT_SECRET', '');
    adminConfig.oauthResource = 'https://mail.example.com';
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete adminConfig.oauthResource;
  });

  it('sends the resource with the authorization code exchange', () => {
    const params = buildOAuthParams({ grant_type: 'authorization_code', code: 'c', redirect_uri: 'https://wm/cb', code_verifier: 'v' });
    expect(params.get('resource')).toBe('https://mail.example.com');
  });

  it('sends the resource with a refresh', () => {
    const params = buildOAuthParams({ grant_type: 'refresh_token', refresh_token: 'r' });
    expect(params.get('resource')).toBe('https://mail.example.com');
  });

  it('does not send it with a revocation request', () => {
    const params = buildOAuthParams({ token: 'r', token_type_hint: 'refresh_token' });
    expect(params.has('resource')).toBe(false);
  });

  it('sends nothing when no resource is configured', () => {
    delete adminConfig.oauthResource;
    const params = buildOAuthParams({ grant_type: 'authorization_code', code: 'c', redirect_uri: 'https://wm/cb', code_verifier: 'v' });
    expect(params.has('resource')).toBe(false);
  });

  it('never sends the global resource to a custom upstream', () => {
    const params = buildOAuthParams(
      { grant_type: 'refresh_token', refresh_token: 'r' },
      null,
      { upstream: { clientId: 'other', serverUrl: 'https://other.example.com' } } as never,
    );
    expect(params.has('resource')).toBe(false);
  });
});
