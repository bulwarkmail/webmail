import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/read-file-env', () => ({
  readFileEnv: () => '',
}));

// Split-horizon DNS: every hostname resolves to an RFC-1918 address from the
// server, so the SSRF guard refuses all of them.
const isPublicHttpUrl = vi.fn(async (_url: string) => false);
vi.mock('@/lib/security/url-guard', () => ({
  isPublicHttpUrl: (url: string) => isPublicHttpUrl(url),
}));

const config = new Map<string, unknown>();
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    get: (key: string, def: unknown) => (config.has(key) ? config.get(key) : def),
    ensureLoaded: async () => {},
  },
}));

import { getDiscoveryValidator, getMetadata } from '@/lib/oauth/token-exchange';

const ISSUER = 'https://auth.example.com';

describe('OAuth discovery endpoint guard (#1028)', () => {
  beforeEach(() => {
    config.clear();
    isPublicHttpUrl.mockClear();
  });

  it('accepts endpoints on the configured issuer origin without the DNS check', async () => {
    const validate = getDiscoveryValidator(ISSUER)!;
    expect(await validate('https://auth.example.com/token')).toBe(true);
    expect(await validate('https://auth.example.com:443/revoke')).toBe(true);
    expect(isPublicHttpUrl).not.toHaveBeenCalled();
  });

  it('accepts other paths on a path-based issuer origin', async () => {
    const validate = getDiscoveryValidator('https://auth.example.com/realms/mail')!;
    expect(await validate('https://auth.example.com/realms/mail/protocol/openid-connect/token')).toBe(true);
  });

  it('still gates endpoints on any other origin', async () => {
    const validate = getDiscoveryValidator(ISSUER)!;
    for (const endpoint of [
      'https://keycloak.internal/token',
      'https://169.254.169.254/latest/meta-data',
      'https://auth.example.com.attacker.test/token',
      'https://auth.example.com:8443/token',
      'http://auth.example.com/token',
      'https://user:pass@auth.example.com/token',
    ]) {
      expect(await validate(endpoint), endpoint).toBe(false);
    }
    expect(isPublicHttpUrl).toHaveBeenCalledWith('https://keycloak.internal/token');
  });

  it('lets public endpoints on other origins through', async () => {
    isPublicHttpUrl.mockResolvedValueOnce(true);
    const validate = getDiscoveryValidator(ISSUER)!;
    expect(await validate('https://login.example.org/authorize')).toBe(true);
  });

  it('never exempts opaque origins', async () => {
    const validate = getDiscoveryValidator('file:///etc/issuer')!;
    expect(await validate('file:///etc/passwd')).toBe(false);
    expect(await validate('data:text/plain,x')).toBe(false);
  });

  it('drops the guard entirely when private endpoints are allowed', () => {
    config.set('oauthAllowPrivateEndpoints', true);
    expect(getDiscoveryValidator(ISSUER)).toBeUndefined();
  });
});

describe('OAuth metadata discovery behind split-horizon DNS (#1028)', () => {
  beforeEach(() => {
    config.clear();
    vi.stubEnv('OAUTH_CLIENT_ID', 'bulwark');
    vi.stubEnv('JMAP_SERVER_URL', 'https://mail.example.com');
    vi.stubEnv('OAUTH_ISSUER_URL', ISSUER);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function serveDocument(document: Record<string, string>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.endsWith('/openid-configuration')
        ? { ok: true, json: async () => document }
        : { ok: false, status: 404 },
    ));
  }

  it('discovers an issuer whose hostname resolves to a private address', async () => {
    serveDocument({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      revocation_endpoint: `${ISSUER}/revoke`,
      end_session_endpoint: `${ISSUER}/logout`,
    });

    const metadata = await getMetadata(null);
    expect(metadata?.token_endpoint).toBe(`${ISSUER}/token`);
  });

  it('refuses a document that points at another internal host and names it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    serveDocument({
      issuer: 'https://sso.example.com',
      authorization_endpoint: 'https://sso.example.com/authorize',
      token_endpoint: 'https://keycloak.cluster.local/token',
    });

    // A different issuer URL than the first test so the module-level
    // discovery cache does not answer.
    vi.stubEnv('OAUTH_ISSUER_URL', 'https://sso.example.com');
    expect(await getMetadata(null)).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('advertises https://keycloak.cluster.local/token'));
    expect(error).toHaveBeenCalledWith(expect.stringContaining('OAUTH_ALLOW_PRIVATE_ENDPOINTS'));
  });
});
