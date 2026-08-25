import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The route consults admin-dashboard overrides (ADMIN_CONFIG_DIR, default
// data/admin) before env vars. Point it at an empty temp dir so local admin
// state on the developer's machine can't leak into these env-driven
// assertions. Set directly (not via vi.stubEnv) so unstubAllEnvs() between
// tests can't clear it - the config-manager singleton caches it on first load.
process.env.ADMIN_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'bw-config-route-'));

// Mock NextResponse before importing the route
vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown) => ({ json: async () => data }),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn() },
}));

// Env vars these tests drive. Stubbed to undefined before each test so the
// developer's / CI's real environment (and any other test file sharing this
// worker's process.env) can't leak in.
const MANAGED_ENV = [
  'APP_NAME', 'NEXT_PUBLIC_APP_NAME', 'JMAP_SERVER_URL', 'NEXT_PUBLIC_JMAP_SERVER_URL',
  'OAUTH_ENABLED', 'OAUTH_CLIENT_ID', 'OAUTH_ISSUER_URL', 'SESSION_SECRET',
  'SESSION_SECRET_FILE', 'SETTINGS_SYNC_ENABLED', 'STALWART_FEATURES', 'DEV_MOCK_JMAP',
  'FAVICON_URL', 'APP_LOGO_LIGHT_URL', 'APP_LOGO_DARK_URL', 'LOGIN_COMPANY_NAME',
  'LOGIN_IMPRINT_URL', 'LOGIN_PRIVACY_POLICY_URL', 'LOGIN_WEBSITE_URL', 'DOMAIN_BRANDING',
] as const;

describe('config API route', () => {
  // Unique per-test dirs so the SESSION_SECRET_FILE tests never share a path;
  // removed synchronously in afterEach (the old fire-and-forget async unlink of
  // a shared ./session-secret raced across tests under the full suite).
  const tempDirs: string[] = [];
  function secretFile(contents = 'test-secret'): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-secret-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'session-secret');
    writeFileSync(file, contents);
    return file;
  }

  beforeEach(() => {
    for (const key of MANAGED_ENV) vi.stubEnv(key, undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function mockRequest(headers: Record<string, string> = {}): unknown {
    const lc: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lc[k.toLowerCase()] = v;
    return {
      headers: {
        get(name: string) {
          return lc[name.toLowerCase()] ?? null;
        },
      },
    };
  }

  async function getConfig(headers?: Record<string, string>) {
    // Re-import to pick up env changes
    const { GET } = await import('@/app/api/config/route');
    const response = await GET(mockRequest(headers) as Parameters<typeof GET>[0]);
    return response.json();
  }

  it('should return defaults when no env vars are set', async () => {
    const config = await getConfig();

    expect(config.appName).toBe('Webmail');
    expect(config.jmapServerUrl).toBe('');
    expect(config.oauthEnabled).toBe(false);
    expect(config.oauthClientId).toBe('');
    expect(config.oauthIssuerUrl).toBe('');
    expect(config.rememberMeEnabled).toBe(false);
    expect(config.settingsSyncEnabled).toBe(false);
    expect(config.stalwartFeaturesEnabled).toBe(true);
    expect(config.devMode).toBe(false);
    expect(config.loginCompanyName).toBe('');
    expect(config.loginImprintUrl).toBe('');
    expect(config.loginPrivacyPolicyUrl).toBe('');
    expect(config.loginWebsiteUrl).toBe('');
    expect(config.faviconUrl).toBe('/branding/Bulwark_Favicon.svg');
    expect(config.appLogoLightUrl).toBe('');
    expect(config.appLogoDarkUrl).toBe('');
  });

  it('should use runtime env vars over defaults', async () => {
    vi.stubEnv('APP_NAME', 'My Mail');
    vi.stubEnv('JMAP_SERVER_URL', 'https://mail.example.com');

    const config = await getConfig();

    expect(config.appName).toBe('My Mail');
    expect(config.jmapServerUrl).toBe('https://mail.example.com');
  });

  it('should fall back to NEXT_PUBLIC_ vars when runtime vars are unset', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_NAME', 'Legacy Mail');
    vi.stubEnv('NEXT_PUBLIC_JMAP_SERVER_URL', 'https://legacy.example.com');

    const config = await getConfig();

    expect(config.appName).toBe('Legacy Mail');
    expect(config.jmapServerUrl).toBe('https://legacy.example.com');
  });

  it('should prefer runtime vars over NEXT_PUBLIC_ vars', async () => {
    vi.stubEnv('APP_NAME', 'Runtime');
    vi.stubEnv('NEXT_PUBLIC_APP_NAME', 'BuildTime');

    const config = await getConfig();

    expect(config.appName).toBe('Runtime');
  });

  it('should return login page customization values', async () => {
    vi.stubEnv('LOGIN_COMPANY_NAME', 'Acme Corp');
    vi.stubEnv('LOGIN_IMPRINT_URL', 'https://acme.com/imprint');
    vi.stubEnv('LOGIN_PRIVACY_POLICY_URL', 'https://acme.com/privacy');
    vi.stubEnv('LOGIN_WEBSITE_URL', 'https://acme.com');

    const config = await getConfig();

    expect(config.loginCompanyName).toBe('Acme Corp');
    expect(config.loginImprintUrl).toBe('https://acme.com/imprint');
    expect(config.loginPrivacyPolicyUrl).toBe('https://acme.com/privacy');
    expect(config.loginWebsiteUrl).toBe('https://acme.com');
  });

  it('should handle partial login customization', async () => {
    vi.stubEnv('LOGIN_COMPANY_NAME', 'Partial Corp');
    // Leave URLs unset

    const config = await getConfig();

    expect(config.loginCompanyName).toBe('Partial Corp');
    expect(config.loginImprintUrl).toBe('');
    expect(config.loginPrivacyPolicyUrl).toBe('');
    expect(config.loginWebsiteUrl).toBe('');
  });

  it('should enable rememberMe when SESSION_SECRET is set', async () => {
    vi.stubEnv('SESSION_SECRET', 'test-secret');

    const config = await getConfig();

    expect(config.rememberMeEnabled).toBe(true);
  });

  it('should enable rememberMe when SESSION_SECRET_FILE is set', async () => {
    vi.stubEnv('SESSION_SECRET_FILE', secretFile());

    const config = await getConfig();

    expect(config.rememberMeEnabled).toBe(true);
  });

  it('should enable settingsSync only when both SESSION_SECRET and SETTINGS_SYNC_ENABLED are set', async () => {
    vi.stubEnv('SETTINGS_SYNC_ENABLED', 'true');
    const config1 = await getConfig();
    expect(config1.settingsSyncEnabled).toBe(false);

    vi.stubEnv('SESSION_SECRET', 'test-secret');
    const config2 = await getConfig();
    expect(config2.settingsSyncEnabled).toBe(true);
  });

  it('should enable settingsSync only when both SESSION_SECRET_FILE and SETTINGS_SYNC_ENABLED are set', async () => {
    vi.stubEnv('SETTINGS_SYNC_ENABLED', 'true');
    const config1 = await getConfig();
    expect(config1.settingsSyncEnabled).toBe(false);

    vi.stubEnv('SESSION_SECRET_FILE', secretFile());
    const config2 = await getConfig();
    expect(config2.settingsSyncEnabled).toBe(true);
  });

  it('should disable stalwart features when explicitly set to false', async () => {
    vi.stubEnv('STALWART_FEATURES', 'false');

    const config = await getConfig();

    expect(config.stalwartFeaturesEnabled).toBe(false);
  });

  it('should return custom favicon and app logo URLs', async () => {
    vi.stubEnv('FAVICON_URL', '/branding/custom-favicon.svg');
    vi.stubEnv('APP_LOGO_LIGHT_URL', '/branding/my-logo.svg');
    vi.stubEnv('APP_LOGO_DARK_URL', '/branding/my-logo-white.svg');

    const config = await getConfig();

    expect(config.faviconUrl).toBe('/branding/custom-favicon.svg');
    expect(config.appLogoLightUrl).toBe('/branding/my-logo.svg');
    expect(config.appLogoDarkUrl).toBe('/branding/my-logo-white.svg');
  });

  describe('per-domain branding overrides', () => {
    it('applies overrides for the matching host', async () => {
      vi.stubEnv('LOGIN_COMPANY_NAME', 'Default Co');
      vi.stubEnv('LOGIN_WEBSITE_URL', 'https://default.example');
      vi.stubEnv('DOMAIN_BRANDING', JSON.stringify([
        {
          host: 'mail1.example.com',
          loginCompanyName: 'Brand One',
          loginWebsiteUrl: 'https://one.example',
        },
      ]));

      const config = await getConfig({ host: 'mail1.example.com' });

      expect(config.loginCompanyName).toBe('Brand One');
      expect(config.loginWebsiteUrl).toBe('https://one.example');
    });

    it('falls through to the global value when the host has no entry', async () => {
      vi.stubEnv('LOGIN_COMPANY_NAME', 'Default Co');
      vi.stubEnv('DOMAIN_BRANDING', JSON.stringify([
        { host: 'mail1.example.com', loginCompanyName: 'Brand One' },
      ]));

      const config = await getConfig({ host: 'unmapped.example.com' });

      expect(config.loginCompanyName).toBe('Default Co');
    });

    it('falls through field-by-field when the matching entry omits a field', async () => {
      vi.stubEnv('LOGIN_COMPANY_NAME', 'Default Co');
      vi.stubEnv('LOGIN_WEBSITE_URL', 'https://default.example');
      vi.stubEnv('DOMAIN_BRANDING', JSON.stringify([
        { host: 'mail1.example.com', loginCompanyName: 'Brand One' },
      ]));

      const config = await getConfig({ host: 'mail1.example.com' });

      expect(config.loginCompanyName).toBe('Brand One');
      expect(config.loginWebsiteUrl).toBe('https://default.example');
    });

    it('prefers X-Forwarded-Host over Host', async () => {
      vi.stubEnv('DOMAIN_BRANDING', JSON.stringify([
        { host: 'public.example.com', loginCompanyName: 'Public' },
      ]));

      const config = await getConfig({
        host: 'internal.example.com',
        'x-forwarded-host': 'public.example.com',
      });

      expect(config.loginCompanyName).toBe('Public');
    });

    it('strips the port from the host header before matching', async () => {
      vi.stubEnv('DOMAIN_BRANDING', JSON.stringify([
        { host: 'mail1.example.com', loginCompanyName: 'Brand One' },
      ]));

      const config = await getConfig({ host: 'mail1.example.com:8443' });

      expect(config.loginCompanyName).toBe('Brand One');
    });
  });
});
