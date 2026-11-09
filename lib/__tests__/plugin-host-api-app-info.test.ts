import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';

// api.app.getInfo: what a plugin may know about the app it runs in (an AI
// assistant answering "what webmail is this?"), with no permission.

const config = { appName: 'Rath Mail', stalwartFeaturesEnabled: false, demoMode: false };
const fetchConfig = vi.fn(async () => config);
vi.mock('@/hooks/use-config', () => ({ fetchConfig: () => fetchConfig() }));

const { dispatchApiCall } = await import('../plugin-sandbox/host-api');

const plugin = (permissions: string[] = []) => ({
  id: 'p', name: 'P', version: '1.0.0', author: 'a', description: 'd', type: 'hook',
  permissions, managed: permissions.length > 0, entrypoint: 'index.js', enabled: true, status: 'running', settings: {}, httpPostAllowedOrigins: [],
} as unknown as InstalledPlugin);

afterEach(() => {
  vi.unstubAllEnvs();
  fetchConfig.mockClear();
});

describe('api.app.getInfo', () => {
  it('gives the product, the administrator\'s name for it, the version and the edition, without a permission', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '1.17.0');
    expect(await dispatchApiCall(plugin(), 'app.getInfo', [])).toEqual({
      product: 'Bulwark Mail',
      name: 'Rath Mail',
      version: '1.17.0',
      edition: 'full',
      stalwartFeatures: false,
      demoMode: false,
    });
  });

  it('still answers when the config can not be read', async () => {
    fetchConfig.mockRejectedValueOnce(new Error('offline'));
    const info = await dispatchApiCall(plugin(), 'app.getInfo', []) as { name: string; product: string };
    expect(info.product).toBe('Bulwark Mail');
    expect(info.name).toBe('Webmail');
  });
});

describe('api.app.searchSettings', () => {
  const setUp = async ({ locale = 'en', vacation = true } = {}) => {
    const { useLocaleStore } = await import('@/stores/locale-store');
    const { useAuthStore } = await import('@/stores/auth-store');
    useLocaleStore.setState({ locale } as never);
    useAuthStore.setState({ client: {
      supportsSieve: () => true, supportsVacationResponse: () => vacation, supportsCalendars: () => true, supportsFiles: () => false,
    } } as never);
  };

  it('finds a setting from an English query, named in the user\'s language', async () => {
    await setUp({ locale: 'de' });
    const results = await dispatchApiCall(plugin(), 'app.searchSettings', ['undo send', { limit: 3 }]) as { pageId: string; page: string; label: string }[];
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].pageId).toBe('composing');
    expect(results[0].page).toBe('Verfassen');
    const de = (await import('@/locales/de/common.json')).default as unknown as { compose_words: { undo_send: { label: string } } };
    expect(results.map((r) => r.label)).toContain(de.compose_words.undo_send.label);
  });

  it('leaves out pages the server does not offer', async () => {
    await setUp({ vacation: false });
    const results = await dispatchApiCall(plugin(), 'app.searchSettings', ['out of office automatic reply']) as { pageId: string }[];
    expect(results.some((r) => r.pageId === 'vacation')).toBe(false);
    await setUp({ vacation: true });
    const again = await dispatchApiCall(plugin(), 'app.searchSettings', ['out of office automatic reply']) as { pageId: string }[];
    expect(again.some((r) => r.pageId === 'vacation')).toBe(true);
  });

  it('returns texts with the configured name, never the raw placeholder (#1314)', async () => {
    await setUp();
    const results = await dispatchApiCall(plugin(), 'app.searchSettings', ['Rath Mail email links']) as { pageId: string; description?: string }[];
    expect(results.some((r) => r.pageId === 'general' && r.description?.includes('Rath Mail'))).toBe(true);
    expect(JSON.stringify(results)).not.toContain('{appName}');
  });

  it('says Bulwark when the config can not be read', async () => {
    await setUp();
    fetchConfig.mockRejectedValueOnce(new Error('offline'));
    const results = await dispatchApiCall(plugin(), 'app.searchSettings', ['bulwark email links']) as { pageId: string; description?: string }[];
    expect(fetchConfig).toHaveBeenCalledTimes(1);
    expect(results.some((r) => r.pageId === 'general' && r.description?.includes('Bulwark'))).toBe(true);
    expect(JSON.stringify(results)).not.toContain('{appName}');
  });

  it('wants a query', async () => {
    await expect(dispatchApiCall(plugin(), 'app.searchSettings', [''])).rejects.toThrow(/non-empty string/);
  });
});

describe('api.app.getSettings', () => {
  it('needs settings:read, and shares plain preferences but nothing about other people', async () => {
    const { useSettingsStore } = await import('@/stores/settings-store');
    useSettingsStore.setState({ sendDelaySeconds: 10, markAsReadDelay: 2000, mailLayout: 'focus', trustedSenders: ['boss@example.org'], pushRelayUrl: 'https://relay.example' } as never);
    await expect(dispatchApiCall(plugin(), 'app.getSettings', [])).rejects.toThrow();
    const settings = await dispatchApiCall(plugin(['settings:read']), 'app.getSettings', []) as Record<string, unknown>;
    expect(settings).toMatchObject({ sendDelaySeconds: 10, markAsReadDelay: 2000, mailLayout: 'focus' });
    expect(settings).not.toHaveProperty('trustedSenders');
    expect(settings).not.toHaveProperty('pushRelayUrl');
    expect(JSON.stringify(settings)).not.toContain('boss@example.org');
  });

  it('shares every setting a plugin may change, so it knows the value it would replace', async () => {
    const { SETTINGS_SCHEMA } = await import('@/lib/settings-schema');
    const { SHARED_SETTINGS } = await import('../plugin-sandbox/host-api-app');
    const { useSettingsStore } = await import('@/stores/settings-store');
    const { useCalendarStore } = await import('@/stores/calendar-store');
    const shared = new Set<string>(SHARED_SETTINGS);
    const missing = Object.values(SETTINGS_SCHEMA).filter((e) => e.store === 'settings' && !shared.has(e.key)).map((e) => e.key);
    expect(missing).toEqual([]);

    useSettingsStore.getState().resetToDefaults();
    useCalendarStore.setState({ viewMode: 'week' });
    const settings = await dispatchApiCall(plugin(['settings:read']), 'app.getSettings', []) as Record<string, unknown>;
    expect(settings.calendarView).toBe('week');
    // The reminder words come through whole (29 by default), or a proposal
    // built on them would drop the rest.
    expect(settings.attachmentReminderKeywords).toEqual(useSettingsStore.getState().attachmentReminderKeywords);
  });
});
