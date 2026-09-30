import { describe, expect, it } from 'vitest';
import { applyLiteConfig, applyLitePolicy, liteStalwartDefaults, LITE_FORCED_FLAGS } from '@/lib/lite-config';
import { DEFAULT_POLICY } from '@/lib/admin/types';

describe('applyLiteConfig (config.json for the static build)', () => {
  it('fills every field with the defaults useConfig assumes when the file is empty', () => {
    const config = applyLiteConfig({});
    expect(config.appName).toBe('Webmail');
    expect(config.jmapServerUrl).toBe('');
    expect(config.rememberMeEnabled).toBe(true);
    expect(config.loginShowTotp).toBe(true);
    expect(config.faviconUrl).toBe('/branding/Bulwark_Favicon.svg');
    expect(config.loginLogoLightUrl).toBe('/branding/Bulwark_Logo_Color.svg');
    expect(config.jmapServers).toEqual([]);
    expect(config.demoMode).toBe(false);
  });

  it('allows a custom endpoint by default only when no server is configured', () => {
    expect(applyLiteConfig({}).allowCustomJmapEndpoint).toBe(true);
    expect(applyLiteConfig({ jmapServerUrl: 'https://mail.example.com' }).allowCustomJmapEndpoint).toBe(false);
    expect(applyLiteConfig({ jmapServers: [{ id: 'eu', url: 'https://eu.example.com' }] }).allowCustomJmapEndpoint).toBe(false);
    // An explicit value always wins.
    expect(applyLiteConfig({ jmapServerUrl: 'https://mail.example.com', allowCustomJmapEndpoint: true }).allowCustomJmapEndpoint).toBe(true);
  });

  it('trims trailing slashes from server URLs', () => {
    const config = applyLiteConfig({
      jmapServerUrl: 'https://mail.example.com///',
      jmapServers: [{ id: 'eu', label: 'EU', url: 'https://eu.example.com/', domains: ['example.com', 42] }],
    });
    expect(config.jmapServerUrl).toBe('https://mail.example.com');
    expect(config.jmapServers).toEqual([{ id: 'eu', label: 'EU', url: 'https://eu.example.com', domains: ['example.com'] }]);
  });

  it('drops malformed server entries and labels unnamed ones by id', () => {
    const config = applyLiteConfig({ jmapServers: [{ id: 'a', url: 'https://a.example' }, { url: 'nope' }, 'junk', null] });
    expect(config.jmapServers).toEqual([{ id: 'a', label: 'a', url: 'https://a.example', domains: [] }]);
  });

  it('pins every server-backed flag off no matter what the file says', () => {
    const config = applyLiteConfig({
      oauthEnabled: true,
      oauthOnly: true,
      autoSsoEnabled: true,
      settingsSyncEnabled: true,
      stalwartFeaturesEnabled: true,
      stalwartJmapPassthroughEnabled: true,
      devMode: true,
    });
    for (const [key, value] of Object.entries(LITE_FORCED_FLAGS)) {
      expect(config[key as keyof typeof LITE_FORCED_FLAGS]).toBe(value);
    }
    expect(config.oauthClientId).toBe('');
  });

  it('ignores values of the wrong type instead of crashing', () => {
    const config = applyLiteConfig({ appName: 12, rememberMeEnabled: 'yes', loginShowVersion: 0, jmapServers: 'x' });
    expect(config.appName).toBe('Webmail');
    expect(config.rememberMeEnabled).toBe(true);
    expect(config.loginShowVersion).toBe(true);
    expect(config.jmapServers).toEqual([]);
    expect(applyLiteConfig(null).appName).toBe('Webmail');
    expect(applyLiteConfig('garbage').appName).toBe('Webmail');
  });

  it('keeps deployer-facing branding and login toggles', () => {
    const config = applyLiteConfig({
      appName: 'Acme Mail',
      loginCompanyName: 'Acme',
      loginImprintUrl: 'https://acme.example/imprint',
      loginShowHeading: false,
      demoMode: true,
      embeddedMode: true,
      parentOrigin: 'https://intranet.acme.example',
    });
    expect(config.appName).toBe('Acme Mail');
    expect(config.loginCompanyName).toBe('Acme');
    expect(config.loginImprintUrl).toBe('https://acme.example/imprint');
    expect(config.loginShowHeading).toBe(false);
    expect(config.demoMode).toBe(true);
    expect(config.embeddedMode).toBe(true);
    expect(config.parentOrigin).toBe('https://intranet.acme.example');
  });
});

describe('applyLitePolicy (policy.json for the static build)', () => {
  it('returns the defaults with plugins and sidebar apps pinned off for an empty file', () => {
    const policy = applyLitePolicy({});
    expect(policy.features.pluginsEnabled).toBe(false);
    expect(policy.features.sidebarAppsEnabled).toBe(false);
    expect(policy.features.pluginsUploadEnabled).toBe(false);
    expect(policy.features.calendarEnabled).toBe(DEFAULT_POLICY.features.calendarEnabled);
    expect(policy.restrictions).toEqual({});
    expect(policy.pushRelays).toEqual([]);
  });

  it('honours deployer gates and restrictions but never re-enables plugins', () => {
    const policy = applyLitePolicy({
      features: { pluginsEnabled: true, sidebarAppsEnabled: true, calendarEnabled: false },
      restrictions: { theme: { locked: true, value: 'dark' } },
      forceEnabledPlugins: ['evil'],
      defaultSidebarApps: [{ id: 'x' }],
    });
    expect(policy.features.pluginsEnabled).toBe(false);
    expect(policy.features.sidebarAppsEnabled).toBe(false);
    expect(policy.features.calendarEnabled).toBe(false);
    expect(policy.restrictions.theme).toEqual({ locked: true, value: 'dark' });
    expect(policy.forceEnabledPlugins).toEqual([]);
    expect(policy.defaultSidebarApps).toEqual([]);
  });

  it('tolerates junk input', () => {
    expect(applyLitePolicy(null).features.themesEnabled).toBe(true);
    expect(applyLitePolicy('nope').features.pluginsEnabled).toBe(false);
  });
});

describe('applyLiteConfig for the Stalwart bundle (same-origin defaults)', () => {
  it('uses the page origin when config.json names no server, and hides the server field', () => {
    const defaults = liteStalwartDefaults();
    expect(defaults.jmapServerUrl).toBe(window.location.origin);
    const config = applyLiteConfig({}, defaults);
    expect(config.jmapServerUrl).toBe(window.location.origin);
    expect(config.allowCustomJmapEndpoint).toBe(false);
    expect(config.rememberMeEnabled).toBe(true);
    expect(config.demoMode).toBe(false);
    expect(applyLiteConfig({ jmapServerUrl: '' }, { jmapServerUrl: 'https://mail.example.com/' }).jmapServerUrl).toBe('https://mail.example.com');
  });

  it('still lets a custom build point elsewhere or show the field explicitly', () => {
    const defaults = { jmapServerUrl: 'https://mail.example.com' };
    expect(applyLiteConfig({ jmapServerUrl: 'https://other.example.com' }, defaults).jmapServerUrl).toBe('https://other.example.com');
    expect(applyLiteConfig({ allowCustomJmapEndpoint: true }, defaults).allowCustomJmapEndpoint).toBe(true);
  });
});
