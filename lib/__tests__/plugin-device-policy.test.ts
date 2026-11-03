import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '@/lib/plugin-types';
import { EMPTY_POLICY_LAYERS, resolvePolicies, type PolicyLayer } from '@/lib/desktop/policy-schema';

/**
 * PluginsMode on the client: the only gate there is on an instance. And the trap: a
 * plugin missing from /api/plugins counts as removed by the admin, which deletes its
 * bundle, data and connected accounts. Tightening a policy must not do that.
 */

vi.mock('@/lib/plugin-storage', () => ({
  pluginStorage: {
    saveCode: vi.fn().mockResolvedValue(undefined),
    getCode: vi.fn().mockResolvedValue('code'),
    codeIds: vi.fn().mockResolvedValue(['kept', 'refused-one']),
    deleteCode: vi.fn().mockResolvedValue(undefined),
    saveThemeCSS: vi.fn().mockResolvedValue(undefined),
    getThemeCSS: vi.fn().mockResolvedValue(null),
    deleteThemeCSS: vi.fn().mockResolvedValue(undefined),
    savePreview: vi.fn().mockResolvedValue(undefined),
    getPreview: vi.fn().mockResolvedValue(null),
    deletePreview: vi.fn().mockResolvedValue(undefined),
  },
  fileStorage: { clearFiles: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/lib/plugin-validator', () => ({ extractPlugin: vi.fn() }));
vi.mock('@/lib/plugin-loader', () => ({
  loadPlugin: vi.fn().mockResolvedValue(undefined),
  deactivatePlugin: vi.fn(),
  setPluginStoreAccessor: vi.fn(),
  setupAutoDisable: vi.fn(),
  setSandboxLocale: vi.fn(),
  forgetSlotOffers: vi.fn(),
}));
vi.mock('@/lib/plugin-hooks', () => ({ removeAllPluginHooks: vi.fn() }));

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), downloadManagedBundle: vi.fn() }));

// In the app the bridge is there before any page code runs, and the store subscribes
// when it's first imported. So it's here before the imports below.
const harness = vi.hoisted(() => {
  const state = {
    current: null as unknown,
    listeners: [] as ((snapshot: unknown) => void)[],
  };
  (window as unknown as { bulwarkDesktop: unknown }).bulwarkDesktop = {
    version: 1,
    platform: 'win32',
    policy: {
      get: () => state.current,
      onChange: (listener: (snapshot: unknown) => void) => {
        state.listeners.push(listener);
        return () => {};
      },
      onWipeOfflineData: () => () => {},
    },
  };
  return state;
});
vi.mock('@/lib/browser-navigation', () => ({ apiFetch: (...args: unknown[]) => mocks.apiFetch(...args) }));
vi.mock('@/lib/plugin-sandbox/host-bridge', () => ({
  forEachInstance: () => {},
  snapshotRegionalSettings: vi.fn((locale: string) => ({ locale, dateLocale: locale, hour12: false, timeZone: 'UTC', firstDayOfWeek: 1 })),
}));
vi.mock('@/lib/plugin-sandbox/bundle-fetch', () => ({ downloadManagedBundle: (...args: unknown[]) => mocks.downloadManagedBundle(...args) }));

import { register as registerActive, deregister as deregisterActive } from '@/lib/plugin-sandbox/registry';
import { usePluginStore } from '@/stores/plugin-store';
import { pluginStorage } from '@/lib/plugin-storage';
import { deactivatePlugin, forgetSlotOffers, loadPlugin } from '@/lib/plugin-loader';
import { extractPlugin } from '@/lib/plugin-validator';

function snapshotOf(forcedMachine: PolicyLayer) {
  return resolvePolicies({ ...EMPTY_POLICY_LAYERS, forcedMachine });
}

function setPolicy(forced: PolicyLayer) {
  harness.current = snapshotOf(forced);
  for (const listener of harness.listeners) listener(harness.current);
}

function plugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: 'refused-one', name: 'R', version: '1.0.0', author: 'A', description: '', type: 'hook', entrypoint: 'index.js',
    permissions: [], enabled: true, status: 'running', managed: true, settings: { mine: 'kept' }, ...overrides,
  };
}

const listed = (id: string, extra: object = {}) => ({
  id, name: id, version: '1.0.0', author: 'A', description: '', type: 'hook', entrypoint: 'index.js', permissions: [], forceEnabled: false, bundleHash: 'hash', ...extra,
});

function serve(plugins: unknown[]) {
  mocks.apiFetch.mockImplementation(async () => new Response(JSON.stringify({ plugins, themes: [] })));
}

beforeEach(() => {
  vi.clearAllMocks();
  usePluginStore.setState({ plugins: [], initialized: false });
  setPolicy({});
  localStorage.clear();
  usePluginStore.setState({ plugins: [], initialized: false });
});

describe('tightening the policy destroys nothing', () => {
  function expectNothingDeleted(id: string) {
    expect(usePluginStore.getState().plugins.find((p) => p.id === id)).toMatchObject({ id, settings: { mine: 'kept' } });
    expect(localStorage.getItem(`plugin:${id}:@acct:notes`)).toBe('"secret"');
    expect(pluginStorage.deleteCode).not.toHaveBeenCalledWith(id);
    expect(pluginStorage.deletePreview).not.toHaveBeenCalledWith(id);
    expect(forgetSlotOffers).not.toHaveBeenCalledWith(id);
  }

  beforeEach(() => {
    localStorage.setItem('server-managed-plugin-ids', JSON.stringify(['refused-one']));
    localStorage.setItem('plugin:refused-one:@acct:notes', '"secret"');
    usePluginStore.setState({ plugins: [plugin()] });
  });

  it('the embedded server flags it: record, data and bundle stay, and nothing is downloaded', async () => {
    setPolicy({ PluginsMode: 'allowlist', PluginAllowlist: ['kept'] });
    serve([listed('refused-one', { refused: true, version: '2.0.0', bundleHash: 'changed' })]);
    await usePluginStore.getState().initializePlugins();
    expectNothingDeleted('refused-one');
    expect(usePluginStore.getState().plugins[0].version).toBe('1.0.0');
    expect(mocks.downloadManagedBundle).not.toHaveBeenCalled();
  });

  it('an instance knows nothing of the policy and lists it plainly: the client refuses by itself', async () => {
    setPolicy({ PluginsMode: 'off' });
    serve([listed('refused-one', { version: '2.0.0', bundleHash: 'changed' })]);
    await usePluginStore.getState().initializePlugins();
    expectNothingDeleted('refused-one');
    expect(mocks.downloadManagedBundle).not.toHaveBeenCalled();
  });

  it('a plugin the admin really removed still goes, with the policy on', async () => {
    setPolicy({ PluginsMode: 'allowlist', PluginAllowlist: ['kept'] });
    serve([]);
    await usePluginStore.getState().initializePlugins();
    expect(usePluginStore.getState().plugins.some((p) => p.id === 'refused-one')).toBe(false);
    expect(localStorage.getItem('plugin:refused-one:@acct:notes')).toBeNull();
  });

  it('a change while running stops it and keeps everything, and lifting it starts it again', async () => {
    registerActive({ plugin: plugin(), code: 'code', tier: 'untrusted', background: { destroy: vi.fn() }, slotOffers: [], hookDisposables: [] } as never);
    setPolicy({ PluginsMode: 'off' });
    expect(deactivatePlugin).toHaveBeenCalledWith('refused-one');
    expect(usePluginStore.getState().plugins[0]).toMatchObject({ enabled: true, status: 'error', error: 'device-policy' });
    expectNothingDeleted('refused-one');
    deregisterActive('refused-one');

    setPolicy({});
    expect(loadPlugin).toHaveBeenCalledWith(expect.objectContaining({ id: 'refused-one' }));
    expect(usePluginStore.getState().plugins[0].error).toBeUndefined();
  });
});

describe('the client gates', () => {
  it('a new plugin the policy refuses isn\'t added or downloaded', async () => {
    setPolicy({ PluginsMode: 'allowlist', PluginAllowlist: ['kept'] });
    serve([listed('refused-one')]);
    mocks.downloadManagedBundle.mockResolvedValue('code');
    await usePluginStore.getState().initializePlugins();
    expect(usePluginStore.getState().plugins).toEqual([]);
    expect(mocks.downloadManagedBundle).not.toHaveBeenCalled();
  });

  it('an allowed one is', async () => {
    setPolicy({ PluginsMode: 'allowlist', PluginAllowlist: ['kept'] });
    serve([listed('kept')]);
    mocks.downloadManagedBundle.mockResolvedValue('code');
    await usePluginStore.getState().initializePlugins();
    expect(usePluginStore.getState().plugins.map((p) => p.id)).toEqual(['kept']);
  });

  it('installing a package is refused by the id in its manifest', async () => {
    setPolicy({ PluginsMode: 'allowlist', PluginAllowlist: ['kept'] });
    vi.mocked(extractPlugin).mockResolvedValue({ valid: true, errors: [], warnings: [], manifest: { id: 'refused-one' }, code: 'x' } as never);
    const result = await usePluginStore.getState().installPlugin(new File(['x'], 'p.zip'));
    expect(result).toMatchObject({ success: false, reason: 'device-policy' });
    expect(usePluginStore.getState().plugins).toEqual([]);
    expect(pluginStorage.saveCode).not.toHaveBeenCalled();
  });

  it('turning one on is refused, and says why', async () => {
    setPolicy({ PluginsMode: 'off' });
    usePluginStore.setState({ plugins: [plugin({ enabled: false, status: 'installed' })] });
    await usePluginStore.getState().enablePlugin('refused-one');
    expect(usePluginStore.getState().plugins[0]).toMatchObject({ enabled: false, status: 'error', error: 'device-policy' });
    expect(loadPlugin).not.toHaveBeenCalled();
  });
});
