import { unlink, writeFileSync } from "fs";
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock NextResponse before importing the route
vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown) => ({ json: async () => data }),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn() },
}));

describe('config API route', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all relevant env vars before each test
    delete process.env.APP_NAME;
    delete process.env.NEXT_PUBLIC_APP_NAME;
    delete process.env.JMAP_SERVER_URL;
    delete process.env.NEXT_PUBLIC_JMAP_SERVER_URL;
    delete process.env.OAUTH_ENABLED;
    delete process.env.OAUTH_CLIENT_ID;
    delete process.env.OAUTH_ISSUER_URL;
    delete process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET_FILE;
    delete process.env.SETTINGS_SYNC_ENABLED;
    delete process.env.STALWART_FEATURES;
    delete process.env.DEV_MOCK_JMAP;
    delete process.env.FAVICON_URL;
    delete process.env.APP_LOGO_LIGHT_URL;
    delete process.env.APP_LOGO_DARK_URL;
    delete process.env.LOGIN_COMPANY_NAME;
    delete process.env.LOGIN_IMPRINT_URL;
    delete process.env.LOGIN_PRIVACY_POLICY_URL;
    delete process.env.LOGIN_WEBSITE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function getConfig() {
    // Re-import to pick up env changes
    const { GET } = await import('@/app/api/config/route');
    const response = await GET();
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
    process.env.APP_NAME = 'My Mail';
    process.env.JMAP_SERVER_URL = 'https://mail.example.com';

    const config = await getConfig();

    expect(config.appName).toBe('My Mail');
    expect(config.jmapServerUrl).toBe('https://mail.example.com');
  });

  it('should fall back to NEXT_PUBLIC_ vars when runtime vars are unset', async () => {
    process.env.NEXT_PUBLIC_APP_NAME = 'Legacy Mail';
    process.env.NEXT_PUBLIC_JMAP_SERVER_URL = 'https://legacy.example.com';

    const config = await getConfig();

    expect(config.appName).toBe('Legacy Mail');
    expect(config.jmapServerUrl).toBe('https://legacy.example.com');
  });

  it('should prefer runtime vars over NEXT_PUBLIC_ vars', async () => {
    process.env.APP_NAME = 'Runtime';
    process.env.NEXT_PUBLIC_APP_NAME = 'BuildTime';

    const config = await getConfig();

    expect(config.appName).toBe('Runtime');
  });

  it('should return login page customization values', async () => {
    process.env.LOGIN_COMPANY_NAME = 'Acme Corp';
    process.env.LOGIN_IMPRINT_URL = 'https://acme.com/imprint';
    process.env.LOGIN_PRIVACY_POLICY_URL = 'https://acme.com/privacy';
    process.env.LOGIN_WEBSITE_URL = 'https://acme.com';

    const config = await getConfig();

    expect(config.loginCompanyName).toBe('Acme Corp');
    expect(config.loginImprintUrl).toBe('https://acme.com/imprint');
    expect(config.loginPrivacyPolicyUrl).toBe('https://acme.com/privacy');
    expect(config.loginWebsiteUrl).toBe('https://acme.com');
  });

  it('should handle partial login customization', async () => {
    process.env.LOGIN_COMPANY_NAME = 'Partial Corp';
    // Leave URLs unset

    const config = await getConfig();

    expect(config.loginCompanyName).toBe('Partial Corp');
    expect(config.loginImprintUrl).toBe('');
    expect(config.loginPrivacyPolicyUrl).toBe('');
    expect(config.loginWebsiteUrl).toBe('');
  });

  it('should enable rememberMe when SESSION_SECRET is set', async () => {
    process.env.SESSION_SECRET = 'test-secret';

    const config = await getConfig();

    expect(config.rememberMeEnabled).toBe(true);
	});

  it('should enable rememberMe when SESSION_SECRET_FILE is set', async () => {
    writeFileSync('./session-secret', 'test-secret');
    process.env.SESSION_SECRET_FILE = './session-secret';

    const config = await getConfig();

    unlink('./session-secret', (err) => {
      if (err) throw err;
    });

    expect(config.rememberMeEnabled).toBe(true);
  });

  it('should enable settingsSync only when both SESSION_SECRET and SETTINGS_SYNC_ENABLED are set', async () => {
    process.env.SETTINGS_SYNC_ENABLED = 'true';
    const config1 = await getConfig();
    expect(config1.settingsSyncEnabled).toBe(false);

    process.env.SESSION_SECRET = 'test-secret';
    const config2 = await getConfig();
    expect(config2.settingsSyncEnabled).toBe(true);
	});

  it('should enable settingsSync only when both SESSION_SECRET_FILE and SETTINGS_SYNC_ENABLED are set', async () => {
    process.env.SETTINGS_SYNC_ENABLED = 'true';
    const config1 = await getConfig();
    expect(config1.settingsSyncEnabled).toBe(false);

    writeFileSync('./session-secret', 'test-secret');
    process.env.SESSION_SECRET_FILE = './session-secret';

    const config2 = await getConfig();

    unlink('./session-secret', (err) => {
      if (err) throw err;
    });

    expect(config2.settingsSyncEnabled).toBe(true);
  });

  it('should disable stalwart features when explicitly set to false', async () => {
    process.env.STALWART_FEATURES = 'false';

    const config = await getConfig();

    expect(config.stalwartFeaturesEnabled).toBe(false);
  });

  it('should return custom favicon and app logo URLs', async () => {
    process.env.FAVICON_URL = '/branding/custom-favicon.svg';
    process.env.APP_LOGO_LIGHT_URL = '/branding/my-logo.svg';
    process.env.APP_LOGO_DARK_URL = '/branding/my-logo-white.svg';

    const config = await getConfig();

    expect(config.faviconUrl).toBe('/branding/custom-favicon.svg');
    expect(config.appLogoLightUrl).toBe('/branding/my-logo.svg');
    expect(config.appLogoDarkUrl).toBe('/branding/my-logo-white.svg');
  });
});
