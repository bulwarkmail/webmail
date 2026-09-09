import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    get: (_key: string, def: unknown) => def,
    ensureLoaded: async () => {},
  },
}));

import { getRequiredConfig } from '@/lib/oauth/token-exchange';

// OAuth discovery metadata lives at the origin root (RFC 8414), but JMAP_SERVER_URL
// is often the session URL. Discovery must normalize to the root, or
// discoverOAuth fetches `<session-url>/.well-known/oauth-authorization-server` (404)
// and refresh fails with "OAuth token endpoint not found". (#971)
describe('OAuth discovery base normalization (#971)', () => {
  beforeEach(() => {
    vi.stubEnv('OAUTH_CLIENT_ID', 'client');
    vi.stubEnv('OAUTH_ISSUER_URL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const discoveryFor = (serverUrl: string) => {
    vi.stubEnv('JMAP_SERVER_URL', serverUrl);
    return getRequiredConfig().discoveryUrl;
  };

  it('strips a trailing /jmap/session so discovery hits the server root', () => {
    expect(discoveryFor('https://mail.example.com/jmap/session')).toBe('https://mail.example.com');
  });

  it('strips a trailing /.well-known/jmap', () => {
    expect(discoveryFor('https://mail.example.com/.well-known/jmap')).toBe('https://mail.example.com');
  });

  it('strips a session path that has a trailing slash', () => {
    expect(discoveryFor('https://mail.example.com/jmap/session/')).toBe('https://mail.example.com');
  });

  it('drops query and fragment', () => {
    expect(discoveryFor('https://mail.example.com/jmap/session?slot=0#x')).toBe('https://mail.example.com');
  });

  it('leaves a plain server root unchanged', () => {
    expect(discoveryFor('https://mail.example.com')).toBe('https://mail.example.com');
  });

  it('only strips the session suffix, keeping any base path prefix', () => {
    expect(discoveryFor('https://mail.example.com/api/jmap/session')).toBe('https://mail.example.com/api');
    expect(discoveryFor('https://mail.example.com/mail')).toBe('https://mail.example.com/mail');
  });

  it('does not strip a path-based OAuth issuer (would break e.g. a Keycloak realm)', () => {
    // Discovery also runs against OAUTH_ISSUER_URL, which takes precedence. A
    // path-based issuer must keep its path, so this is not normalized to the origin.
    vi.stubEnv('JMAP_SERVER_URL', 'https://mail.example.com/jmap/session');
    vi.stubEnv('OAUTH_ISSUER_URL', 'https://kc.example.com/realms/mail');
    expect(getRequiredConfig().discoveryUrl).toBe('https://kc.example.com/realms/mail');
  });
});
