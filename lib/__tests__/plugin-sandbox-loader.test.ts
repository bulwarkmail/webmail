import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { InstalledPlugin } from '../plugin-types';

const mocks = vi.hoisted(() => ({
  getCode: vi.fn(),
  saveCode: vi.fn(),
  downloadManagedBundle: vi.fn(),
  createBackgroundInstance: vi.fn(),
  registerShortcuts: vi.fn((..._args: unknown[]) => () => {}),
  setLocale: vi.fn(),
}));

vi.mock('../plugin-storage', () => ({
  pluginStorage: {
    getCode: (...args: unknown[]) => mocks.getCode(...args),
    saveCode: (...args: unknown[]) => mocks.saveCode(...args),
    deleteCode: vi.fn(),
  },
}));
vi.mock('../plugin-sandbox/bundle-fetch', () => ({
  downloadManagedBundle: (...args: unknown[]) => mocks.downloadManagedBundle(...args),
}));
vi.mock('../plugin-sandbox/host-bridge', () => ({
  createBackgroundInstance: (...args: unknown[]) => mocks.createBackgroundInstance(...args),
  forEachInstance: (_id: string | null, fn: (i: { setLocale: (l: string, r?: unknown) => void }) => void) => fn({ setLocale: mocks.setLocale }),
  snapshotRegionalSettings: vi.fn((locale: string) => ({
    locale,
    dateLocale: locale,
    hour12: false,
    timeZone: 'UTC',
    firstDayOfWeek: 1,
  })),
  SandboxInstance: class {},
}));
vi.mock('../plugin-sandbox/host-api', () => ({
  cancelPluginDialogs: vi.fn(),
}));
vi.mock('../plugin-sandbox/shortcuts', () => ({
  registerShortcuts: (...args: unknown[]) => mocks.registerShortcuts(...args),
}));

import { loadSandboxedPlugin, unloadSandboxedPlugin, setSandboxStoreAccessor, setSandboxLocale } from '../plugin-sandbox/loader';
import { get as getActive, offersForSlot } from '../plugin-sandbox/registry';

const CODE = 'export default { activate() {} }';
const HASH = createHash('sha256').update(CODE, 'utf-8').digest('hex');

function plugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: 'managed-plugin',
    name: 'Managed plugin',
    version: '1.0.0',
    author: 'admin',
    description: '',
    type: 'hook',
    permissions: [],
    entrypoint: 'index.js',
    enabled: true,
    status: 'enabled',
    settings: {},
    managed: true,
    adminApproved: true,
    bundleHash: HASH,
    ...overrides,
  };
}

function fakeBackground() {
  const bg = {
    initPromise: Promise.resolve({ hooks: [], slots: [], shortcuts: [] }) as Promise<unknown>,
    invokeHook: vi.fn(),
    closed: false,
    destroy: vi.fn(() => { bg.closed = true; }),
  };
  return bg;
}

let statuses: Array<{ id: string; status: string; error?: string }>;

beforeEach(() => {
  statuses = [];
  setSandboxStoreAccessor({
    setPluginStatus: (id, status, error) => { statuses.push({ id, status, error }); },
  });
  mocks.getCode.mockReset().mockResolvedValue(null);
  mocks.saveCode.mockReset().mockResolvedValue(undefined);
  mocks.downloadManagedBundle.mockReset();
  mocks.createBackgroundInstance.mockReset().mockImplementation(() => fakeBackground());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  unloadSandboxedPlugin('managed-plugin');
  unloadSandboxedPlugin('user-plugin');
  vi.restoreAllMocks();
});

function lastStatus() {
  return statuses[statuses.length - 1];
}

describe('loadSandboxedPlugin in the no-third-party mode (#903)', () => {
  it('refuses a plugin that declares network access and runs one that does not', async () => {
    const { setNoThirdPartyTraffic } = await import('../third-party-mode');
    mocks.getCode.mockResolvedValue(CODE);
    setNoThirdPartyTraffic(true);
    try {
      await loadSandboxedPlugin(plugin({ permissions: ['http:fetch'], httpOrigins: ['https://api.vendor.example'] }));
      expect(lastStatus()).toMatchObject({ id: 'managed-plugin', status: 'error', error: 'third-party-off' });
      expect(mocks.createBackgroundInstance).not.toHaveBeenCalled();
      expect(getActive('managed-plugin')).toBeUndefined();

      await loadSandboxedPlugin(plugin({ permissions: ['email:read'] }));
      expect(lastStatus()).toMatchObject({ id: 'managed-plugin', status: 'running' });
    } finally {
      setNoThirdPartyTraffic(false);
    }
  });
});

describe('loadSandboxedPlugin when a frame is slow to boot', () => {
  const hung = () => ({ ...fakeBackground(), initPromise: new Promise(() => {}) });

  // The bundle check runs on real promises and crypto: wait for the frame
  // that is due before moving the clock past its timeout.
  const framesStarted = async (count: number) => {
    for (let i = 0; i < 2000 && mocks.createBackgroundInstance.mock.calls.length < count; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await new Promise((resolve) => setImmediate(resolve));
  };

  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('tries once more after the init timeout and runs when the second frame answers', async () => {
    mocks.getCode.mockResolvedValue(CODE);
    const first = hung();
    mocks.createBackgroundInstance.mockReturnValueOnce(first);

    const run = loadSandboxedPlugin(plugin());
    await framesStarted(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await framesStarted(2);
    await run;

    expect(first.destroy).toHaveBeenCalled();
    expect(mocks.createBackgroundInstance).toHaveBeenCalledTimes(2);
    expect(statuses.some((s) => s.status === 'error')).toBe(false);
    expect(lastStatus()).toMatchObject({ id: 'managed-plugin', status: 'running' });
  });

  it('reports the error when the second try times out too, and stops there', async () => {
    mocks.getCode.mockResolvedValue(CODE);
    mocks.createBackgroundInstance.mockImplementation(() => hung());

    const run = loadSandboxedPlugin(plugin());
    await framesStarted(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await framesStarted(2);
    await vi.advanceTimersByTimeAsync(30_000);
    await run;

    expect(mocks.createBackgroundInstance).toHaveBeenCalledTimes(2);
    expect(lastStatus()).toMatchObject({ id: 'managed-plugin', status: 'error' });
    expect(lastStatus().error).toMatch(/timed out/);
  });

  it('does not try again when the plugin was turned off while it started', async () => {
    mocks.getCode.mockResolvedValue(CODE);
    mocks.createBackgroundInstance.mockImplementation(() => hung());

    const run = loadSandboxedPlugin(plugin());
    await framesStarted(1);
    unloadSandboxedPlugin('managed-plugin');
    await vi.advanceTimersByTimeAsync(30_000);
    await run;

    expect(mocks.createBackgroundInstance).toHaveBeenCalledTimes(1);
  });

  it('does not retry a plugin that fails for another reason', async () => {
    mocks.getCode.mockResolvedValue(CODE);
    mocks.createBackgroundInstance.mockImplementationOnce(() => ({
      ...fakeBackground(),
      initPromise: Promise.reject(new Error('bundle threw')),
    }));

    await loadSandboxedPlugin(plugin());

    expect(mocks.createBackgroundInstance).toHaveBeenCalledTimes(1);
    expect(lastStatus()).toMatchObject({ status: 'error', error: 'bundle threw' });
  });
});

describe('loadSandboxedPlugin bundle sourcing', () => {
  it('runs a managed plugin from IndexedDB when the cached copy verifies', async () => {
    mocks.getCode.mockResolvedValue(CODE);
    await loadSandboxedPlugin(plugin());
    expect(lastStatus()).toMatchObject({ id: 'managed-plugin', status: 'running' });
    expect(mocks.downloadManagedBundle).not.toHaveBeenCalled();
    expect(mocks.createBackgroundInstance).toHaveBeenCalledWith(expect.objectContaining({ code: CODE }));
    expect(getActive('managed-plugin')).toBeDefined();
  });

  it('refills a missing managed bundle from the server (#636)', async () => {
    mocks.getCode.mockResolvedValue(null);
    mocks.downloadManagedBundle.mockResolvedValue(CODE);
    await loadSandboxedPlugin(plugin());
    expect(mocks.downloadManagedBundle).toHaveBeenCalledWith('managed-plugin', HASH, { requireSignature: false });
    expect(mocks.saveCode).toHaveBeenCalledWith('managed-plugin', CODE);
    expect(lastStatus()).toMatchObject({ status: 'running' });
    expect(getActive('managed-plugin')?.code).toBe(CODE);
  });

  it('replaces a cached managed bundle that fails the hash check', async () => {
    mocks.getCode.mockResolvedValue('stale or tampered copy');
    mocks.downloadManagedBundle.mockResolvedValue(CODE);
    await loadSandboxedPlugin(plugin());
    expect(mocks.downloadManagedBundle).toHaveBeenCalledTimes(1);
    expect(mocks.saveCode).toHaveBeenCalledWith('managed-plugin', CODE);
    expect(lastStatus()).toMatchObject({ status: 'running' });
  });

  it('fails when the server copy does not match the record hash either', async () => {
    mocks.getCode.mockResolvedValue(null);
    mocks.downloadManagedBundle.mockResolvedValue('something else entirely');
    await loadSandboxedPlugin(plugin());
    expect(lastStatus()).toMatchObject({ status: 'error', error: expect.stringMatching(/integrity mismatch/) });
    expect(mocks.saveCode).not.toHaveBeenCalled();
    expect(mocks.createBackgroundInstance).not.toHaveBeenCalled();
    expect(getActive('managed-plugin')).toBeUndefined();
  });

  it('surfaces the download failure on the plugin', async () => {
    mocks.downloadManagedBundle.mockRejectedValue(
      new Error('Could not download the bundle for plugin "managed-plugin" (HTTP 404)'),
    );
    await loadSandboxedPlugin(plugin());
    expect(lastStatus()).toMatchObject({ status: 'error', error: expect.stringMatching(/HTTP 404/) });
    expect(mocks.createBackgroundInstance).not.toHaveBeenCalled();
  });

  it('accepts a managed bundle without a recorded hash (older records)', async () => {
    mocks.downloadManagedBundle.mockResolvedValue(CODE);
    await loadSandboxedPlugin(plugin({ bundleHash: undefined }));
    expect(mocks.downloadManagedBundle).toHaveBeenCalledWith('managed-plugin', undefined, { requireSignature: false });
    expect(lastStatus()).toMatchObject({ status: 'running' });
  });

  it('still runs a managed plugin when the cache cannot be written', async () => {
    mocks.downloadManagedBundle.mockResolvedValue(CODE);
    mocks.saveCode.mockRejectedValue(new Error('QuotaExceededError'));
    await loadSandboxedPlugin(plugin());
    expect(lastStatus()).toMatchObject({ status: 'running' });
  });

  it('still runs a managed plugin when IndexedDB cannot be read', async () => {
    mocks.getCode.mockRejectedValue(new Error('InvalidStateError'));
    mocks.downloadManagedBundle.mockResolvedValue(CODE);
    await loadSandboxedPlugin(plugin());
    expect(lastStatus()).toMatchObject({ status: 'running' });
  });

  it('does not consult the server for a user-uploaded plugin', async () => {
    mocks.getCode.mockResolvedValue(null);
    await loadSandboxedPlugin(plugin({ id: 'user-plugin', managed: false }));
    expect(mocks.downloadManagedBundle).not.toHaveBeenCalled();
    expect(lastStatus()).toMatchObject({
      id: 'user-plugin',
      status: 'error',
      error: expect.stringMatching(/No bundle in storage.*Reinstall/),
    });
  });

  it('fails a user-uploaded plugin whose cached copy does not verify', async () => {
    mocks.getCode.mockResolvedValue('tampered');
    await loadSandboxedPlugin(plugin({ id: 'user-plugin', managed: false }));
    expect(mocks.downloadManagedBundle).not.toHaveBeenCalled();
    expect(lastStatus()).toMatchObject({ status: 'error', error: expect.stringMatching(/integrity mismatch/) });
  });
});

describe('plugin shortcuts', () => {
  const SHORTCUT = [{ id: 'new', keys: 'Alt+N', label: 'New' }];
  function withShortcuts() {
    return { ...fakeBackground(), initPromise: Promise.resolve({ hooks: [], slots: [], shortcuts: SHORTCUT }) };
  }

  it('does not install shortcuts for a plugin without ui:keyboard', async () => {
    mocks.getCode.mockResolvedValue(CODE);
    mocks.createBackgroundInstance.mockImplementation(withShortcuts);
    mocks.registerShortcuts.mockClear();

    await loadSandboxedPlugin(plugin());

    expect(mocks.registerShortcuts).not.toHaveBeenCalled();
  });

  it('installs them with ui:keyboard', async () => {
    mocks.getCode.mockResolvedValue(CODE);
    mocks.createBackgroundInstance.mockImplementation(withShortcuts);
    mocks.registerShortcuts.mockClear();

    await loadSandboxedPlugin(plugin({ permissions: ['ui:keyboard'] }));

    expect(mocks.registerShortcuts).toHaveBeenCalledWith(expect.anything(), SHORTCUT);
  });
});

describe('setSandboxLocale', () => {
  it('switches running plugins to the new language', () => {
    // Running plugins used to keep the old language until a reload.
    setSandboxLocale('en');
    mocks.setLocale.mockClear();

    setSandboxLocale('de');

    expect(mocks.setLocale).toHaveBeenCalledWith('de', expect.anything());
  });
});

describe('failing hooks', () => {
  it('turns a plugin off on its third failure, not its second', async () => {
    const { emailHooks, pluginErrorTracker } = await import('../plugin-hooks');
    const { setupSandboxAutoDisable } = await import('../plugin-sandbox/loader');
    const markAutoDisabled = vi.fn();
    setSandboxStoreAccessor({ setPluginStatus: () => {}, markAutoDisabled });
    setupSandboxAutoDisable();
    pluginErrorTracker.reset('managed-plugin');
    mocks.getCode.mockResolvedValue(CODE);
    mocks.createBackgroundInstance.mockImplementation(() => ({
      ...fakeBackground(),
      initPromise: Promise.resolve({ hooks: ['onEmailOpen'], slots: [], shortcuts: [] }),
      invokeHook: vi.fn(() => Promise.reject(new Error('boom'))),
    }));
    await loadSandboxedPlugin(plugin({ permissions: ['email:read'] }));

    await emailHooks.onEmailOpen.emit({});
    await emailHooks.onEmailOpen.emit({});
    expect(markAutoDisabled).not.toHaveBeenCalled();
    await emailHooks.onEmailOpen.emit({});
    expect(markAutoDisabled).toHaveBeenCalledWith('managed-plugin');
  });
});

describe('loading the same plugin twice', () => {
  it('starts one background instance, also when the loads overlap', async () => {
    mocks.getCode.mockResolvedValue(CODE);
    await Promise.all([loadSandboxedPlugin(plugin()), loadSandboxedPlugin(plugin())]);
    await loadSandboxedPlugin(plugin());

    expect(mocks.createBackgroundInstance).toHaveBeenCalledTimes(1);
  });
});

describe('slots remembered from the last start', () => {
  const OFFERS = [{ name: 'sidebar-section', hasShouldShow: false, order: 100 }];
  const perms = { permissions: ['ui:sidebar-widget'], grantedPermissions: ['ui:sidebar-widget'] } as Partial<InstalledPlugin>;

  function startingBackground() {
    let finish!: (info: unknown) => void;
    let fail!: (err: Error) => void;
    const bg = fakeBackground();
    bg.initPromise = new Promise((res, rej) => { finish = res; fail = rej; });
    mocks.createBackgroundInstance.mockImplementation(() => bg);
    return { finish, fail };
  }

  beforeEach(() => {
    localStorage.clear();
    mocks.getCode.mockResolvedValue(CODE);
  });

  it('offers them while the background frame is still booting, then the real list', async () => {
    // A slot frame used to start only after the plugin's own frame had booted.
    localStorage.setItem('plugin-slot-offers:managed-plugin', JSON.stringify({ hash: HASH, slots: OFFERS }));
    const { finish } = startingBackground();

    const load = loadSandboxedPlugin(plugin(perms));
    await vi.waitFor(() => expect(offersForSlot('sidebar-section').map((o) => o.pluginId)).toEqual(['managed-plugin']));
    expect(lastStatus()?.status).not.toBe('running');

    finish({ hooks: [], slots: [{ name: 'sidebar-section', hasShouldShow: true, order: 5 }], shortcuts: [] });
    await load;
    expect(offersForSlot('sidebar-section')).toEqual([{ pluginId: 'managed-plugin', order: 5, hasShouldShow: true }]);
    expect(lastStatus()).toMatchObject({ status: 'running' });
  });

  it('remembers the list for the bundle it came from only', async () => {
    mocks.createBackgroundInstance.mockImplementation(() => ({ ...fakeBackground(), initPromise: Promise.resolve({ hooks: [], slots: OFFERS, shortcuts: [] }) }));
    await loadSandboxedPlugin(plugin(perms));
    expect(JSON.parse(localStorage.getItem('plugin-slot-offers:managed-plugin')!)).toEqual({ hash: HASH, slots: OFFERS });
    unloadSandboxedPlugin('managed-plugin');

    // Another bundle: wait for its own list.
    localStorage.setItem('plugin-slot-offers:managed-plugin', JSON.stringify({ hash: 'f'.repeat(64), slots: OFFERS }));
    const { fail } = startingBackground();
    const load = loadSandboxedPlugin(plugin(perms));
    await new Promise((r) => setTimeout(r, 20));
    expect(offersForSlot('sidebar-section')).toEqual([]);
    fail(new Error('done'));
    await load;
  });

  it('does not offer a remembered slot the plugin may not use', async () => {
    localStorage.setItem('plugin-slot-offers:managed-plugin', JSON.stringify({ hash: HASH, slots: OFFERS }));
    const { fail } = startingBackground();
    const load = loadSandboxedPlugin(plugin());
    await new Promise((r) => setTimeout(r, 20));
    expect(offersForSlot('sidebar-section')).toEqual([]);
    fail(new Error('done'));
    await load;
  });

  it('takes them down when the plugin fails to start', async () => {
    localStorage.setItem('plugin-slot-offers:managed-plugin', JSON.stringify({ hash: HASH, slots: OFFERS }));
    const { fail } = startingBackground();
    const load = loadSandboxedPlugin(plugin(perms));
    await vi.waitFor(() => expect(offersForSlot('sidebar-section')).toHaveLength(1));

    fail(new Error('boom'));
    await load;
    expect(offersForSlot('sidebar-section')).toEqual([]);
    expect(getActive('managed-plugin')).toBeUndefined();
    expect(lastStatus()).toMatchObject({ status: 'error' });
  });

  it('is not marked failed when it was turned off while starting', async () => {
    localStorage.setItem('plugin-slot-offers:managed-plugin', JSON.stringify({ hash: HASH, slots: OFFERS }));
    const { fail } = startingBackground();
    const load = loadSandboxedPlugin(plugin(perms));
    await vi.waitFor(() => expect(getActive('managed-plugin')).toBeDefined());

    unloadSandboxedPlugin('managed-plugin');
    // What destroy() does to a starting frame.
    fail(new Error('sandbox destroyed'));
    await load;
    expect(lastStatus()).toMatchObject({ status: 'disabled' });
  });
});
