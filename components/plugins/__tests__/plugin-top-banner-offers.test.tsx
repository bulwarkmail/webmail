// The top banner is at most 120 px tall, with the plugin's name beside it. What a plugin's frame
// reports at start (init-done: its slots, and for each whether its frame fills its panel) comes
// from the frame, where the plugin's own code runs: the host decides which slots may fill
// (slot-layout.ts FILLABLE_SLOTS) and how many frames one plugin gets in a slot, whatever the
// frame reports. Here the frame reports that its top banner fills, and lists it five times.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { createHash } from 'node:crypto';
import type { InstalledPlugin } from '@/lib/plugin-types';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
  useLocale: () => 'en',
}));

const CODE = 'module.exports = { slots: {} }';
const HASH = createHash('sha256').update(CODE, 'utf-8').digest('hex');

const mocks = vi.hoisted(() => ({
  slots: [] as Array<Record<string, unknown>>,
  createSlotInstance: null as unknown as import('vitest').Mock<(opts: { hostContainer: HTMLElement; onResize?: (h: number) => void }) => unknown>,
}));

vi.mock('@/lib/plugin-storage', () => ({
  pluginStorage: { getCode: async () => CODE, saveCode: async () => {}, deleteCode: () => {} },
}));
vi.mock('@/lib/plugin-sandbox/bundle-fetch', () => ({ downloadManagedBundle: () => {} }));
vi.mock('@/lib/plugin-sandbox/host-api', () => ({ cancelPluginDialogs: () => {} }));
vi.mock('@/lib/plugin-sandbox/shortcuts', () => ({ registerShortcuts: () => () => {} }));
vi.mock('@/lib/plugin-sandbox/host-theme', () => ({ snapshotHostTheme: () => ({}) }));
vi.mock('@/lib/plugin-sandbox/host-bridge', async () => {
  const { vi: v } = await import('vitest');
  mocks.createSlotInstance = v.fn((opts: { hostContainer: HTMLElement }) => {
    opts.hostContainer.appendChild(document.createElement('iframe'));
    return { destroy: v.fn(), updateProps: v.fn(), setTheme: v.fn(), sendFloatingDropdownEvent: v.fn(), initPromise: Promise.resolve() };
  });
  return {
    // What the frame said at start: its slots, as the plugin made them.
    createBackgroundInstance: () => ({
      initPromise: Promise.resolve({ hooks: [], slots: mocks.slots, shortcuts: [] }),
      invokeHook: v.fn(),
      destroy: v.fn(),
    }),
    createSlotInstance: (opts: { hostContainer: HTMLElement }) => mocks.createSlotInstance(opts),
    snapshotRegionalSettings: (locale: string) => ({ locale, dateLocale: locale, hour12: false, timeZone: 'UTC', firstDayOfWeek: 1 }),
    forEachInstance: () => {},
    SandboxInstance: class {},
  };
});

import { loadSandboxedPlugin, unloadSandboxedPlugin, setSandboxStoreAccessor } from '@/lib/plugin-sandbox/loader';
import { PluginSlot } from '@/components/plugins/plugin-slot';
import { usePluginStore } from '@/stores/plugin-store';

const ID = 'banner-plugin';

function plugin(): InstalledPlugin {
  return {
    id: ID, name: 'Banner plugin', version: '1.0.0', author: 'someone', description: '', type: 'ui-extension',
    permissions: ['ui:app-top-banner'], grantedPermissions: ['ui:app-top-banner'], entrypoint: 'index.js',
    enabled: true, status: 'enabled', settings: {}, managed: true, adminApproved: true, bundleHash: HASH,
  } as InstalledPlugin;
}

beforeEach(() => {
  setSandboxStoreAccessor({ setPluginStatus: () => {} });
  usePluginStore.setState({ plugins: [plugin()] } as never);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  unloadSandboxedPlugin(ID);
  vi.restoreAllMocks();
});

async function mountBanner() {
  await loadSandboxedPlugin(plugin());
  const view = render(<PluginSlot name="app-top-banner" />);
  await waitFor(() => expect(mocks.createSlotInstance).toHaveBeenCalled());
  for (const [opts] of mocks.createSlotInstance.mock.calls) {
    act(() => (opts as { onResize: (h: number) => void }).onResize(2000));
  }
  return view;
}

describe('a top banner whose frame claims more than the host gives', () => {
  it('stays at 120 px when the frame says it fills its panel', async () => {
    mocks.slots = [{ name: 'app-top-banner', hasShouldShow: false, order: 0, fill: true }];
    const { container } = await mountBanner();

    const wrappers = container.querySelectorAll<HTMLElement>(`[data-plugin-iframe-slot="${ID}:app-top-banner"]`);
    expect(wrappers).toHaveLength(1);
    const wrapper = wrappers[0];
    // Not a frame that takes its panel's height: the banner keeps the limit.
    expect(wrapper.hasAttribute('data-plugin-iframe-fill')).toBe(false);
    expect(wrapper.style.maxHeight).toBe('120px');
    // Nor does the slot around it take the page's height.
    const slot = container.querySelector<HTMLElement>('[data-plugin-slot="app-top-banner"]')!;
    expect(slot.className).not.toMatch(/\bh-full\b/);
    // And the host names the plugin beside it.
    expect(container.querySelector('[data-plugin-banner-source]')).not.toBeNull();
  });

  it('gets one banner frame however often the frame lists the slot', async () => {
    mocks.slots = Array.from({ length: 5 }, () => ({ name: 'app-top-banner', hasShouldShow: false, order: 0 }));
    const { container } = await mountBanner();
    expect(container.querySelectorAll(`[data-plugin-iframe-slot="${ID}:app-top-banner"]`)).toHaveLength(1);
  });

  // Control: an ordinary banner.
  it('shows an ordinary banner at the limit with the name beside it', async () => {
    mocks.slots = [{ name: 'app-top-banner', hasShouldShow: false, order: 0 }];
    const { container } = await mountBanner();
    const wrapper = container.querySelector<HTMLElement>(`[data-plugin-iframe-slot="${ID}:app-top-banner"]`)!;
    expect(wrapper.style.maxHeight).toBe('120px');
    expect(container.querySelector('[data-plugin-banner-source]')).not.toBeNull();
  });
});
