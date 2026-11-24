/**
 * #1327: an admin's plugin turned on or off, and plugin settings, follow the
 * account to its other browsers through Settings Sync.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InstalledPlugin } from '@/lib/plugin-types';

vi.mock('@/lib/plugin-storage', () => ({
  pluginStorage: {
    saveCode: vi.fn().mockResolvedValue(undefined),
    getCode: vi.fn().mockResolvedValue(null),
    codeIds: vi.fn().mockResolvedValue([]),
    deleteCode: vi.fn().mockResolvedValue(undefined),
    savePreview: vi.fn().mockResolvedValue(undefined),
    getPreview: vi.fn().mockResolvedValue(null),
    deletePreview: vi.fn().mockResolvedValue(undefined),
  },
  fileStorage: { clearFiles: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/lib/plugin-loader', () => ({
  loadPlugin: vi.fn().mockResolvedValue(undefined),
  deactivatePlugin: vi.fn(),
  setPluginStoreAccessor: vi.fn(),
  setupAutoDisable: vi.fn(),
  setSandboxLocale: vi.fn(),
  forgetSlotOffers: vi.fn(),
}));
const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), downloadManagedBundle: vi.fn() }));
vi.mock('@/lib/browser-navigation', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('@/lib/plugin-sandbox/bundle-fetch', () => ({
  downloadManagedBundle: (...args: unknown[]) => mocks.downloadManagedBundle(...args),
}));

import { usePluginStore } from '@/stores/plugin-store';
import { useSettingsStore } from '@/stores/settings-store';
import { generateAccountId } from '@/lib/account-utils';

const USER = 'alice@example.com';
const SERVER = 'https://mail.example.com';
const ACCOUNT = generateAccountId(USER, SERVER);

function adminPlugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: 'paperless', name: 'Paperless', version: '1.0.0', author: 'x', description: '', type: 'hook',
    entrypoint: 'index.js', permissions: [], enabled: true, status: 'enabled', managed: true, forceEnabled: false,
    adminApproved: true, autoEnabled: true, settings: {},
    settingsSchema: { url: { type: 'string', label: 'Address', default: '' } },
    ...overrides,
  };
}

function pushed(): Record<string, { at: number; v?: unknown }> {
  return JSON.parse(useSettingsStore.getState().exportSettings({ forSync: true })).pluginSync;
}

function pull(pluginSync: unknown): void {
  useSettingsStore.getState().importSettings(JSON.stringify({ pluginSync }), { serverAccountId: ACCOUNT });
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  usePluginStore.setState({ plugins: [adminPlugin()], initialized: true });
  useSettingsStore.getState().enableSync(USER, SERVER);
});

describe('what goes up with the settings', () => {
  it("an admin's plugin the user turned off here", () => {
    usePluginStore.getState().disablePlugin('paperless');
    const entry = pushed()['paperless|on'];
    expect(entry.v).toBe(false);
    expect(entry.at).toBeGreaterThan(1);
  });

  it("a plugin's settings changed here", () => {
    usePluginStore.getState().updatePluginSettings('paperless', { url: 'https://docs.example.com' });
    expect(pushed()['paperless|settings'].v).toEqual({ url: 'https://docs.example.com' });
  });

  it('choices made before this browser synced them, as the oldest change', () => {
    usePluginStore.setState({ plugins: [adminPlugin({ enabled: false, chosen: true, settings: { url: 'https://a.example' } })] });
    const entries = pushed();
    expect(entries['paperless|on']).toEqual({ at: 1, v: false });
    expect(entries['paperless|settings']).toEqual({ at: 1, v: { url: 'https://a.example' } });
  });

  it('nothing for an admin plugin nobody chose', () => {
    expect(pushed()).toEqual({});
  });
});

describe("another browser's choices", () => {
  it('turn the plugin off here and bring its settings', () => {
    pull({ 'paperless|on': { at: 5, v: false }, 'paperless|settings': { at: 5, v: { url: 'https://docs.example.com' } } });
    const plugin = usePluginStore.getState().plugins[0];
    expect(plugin.enabled).toBe(false);
    expect(plugin.chosen).toBe(true);
    expect(plugin.settings).toEqual({ url: 'https://docs.example.com' });
  });

  it("don't replace a newer change made here", () => {
    usePluginStore.getState().updatePluginSettings('paperless', { url: 'https://mine.example' });
    pull({ 'paperless|settings': { at: 5, v: { url: 'https://older.example' } } });
    expect(usePluginStore.getState().plugins[0].settings).toEqual({ url: 'https://mine.example' });
  });

  it('wait for an admin plugin this browser has not fetched yet', async () => {
    usePluginStore.setState({ plugins: [], initialized: false });
    pull({ 'paperless|on': { at: 5, v: false }, 'paperless|settings': { at: 5, v: { url: 'https://docs.example.com' } } });
    mocks.downloadManagedBundle.mockResolvedValue('export default {}');
    mocks.apiFetch.mockImplementation(async () => new Response(JSON.stringify({
      plugins: [{
        id: 'paperless', name: 'Paperless', version: '1.0.0', author: 'x', description: '', type: 'hook',
        permissions: [], entrypoint: 'index.js', forceEnabled: false, defaultOn: true,
      }],
      themes: [],
    })));

    await usePluginStore.getState().initializePlugins();

    const plugin = usePluginStore.getState().plugins.find((p) => p.id === 'paperless');
    expect(plugin?.enabled).toBe(false);
    expect(plugin?.chosen).toBe(true);
    expect(plugin?.settings).toEqual({ url: 'https://docs.example.com' });
  });

  it("don't turn off a plugin the admin forces on", () => {
    usePluginStore.setState({ plugins: [adminPlugin({ forceEnabled: true })] });
    pull({ 'paperless|on': { at: 5, v: false } });
    expect(usePluginStore.getState().plugins[0].enabled).toBe(true);
  });

  it('are not pushed back as changes made here', () => {
    pull({ 'paperless|on': { at: 5, v: false } });
    expect(pushed()['paperless|on']).toEqual({ at: 5, v: false });
  });
});

describe('with Settings Sync off', () => {
  it('nothing is kept for the account', () => {
    useSettingsStore.getState().disableSync();
    usePluginStore.getState().disablePlugin('paperless');
    expect(Object.keys(localStorage).some((key) => key.startsWith('plugin-sync:'))).toBe(false);
  });
});
