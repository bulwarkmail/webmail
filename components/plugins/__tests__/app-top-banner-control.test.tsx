// The top banner sits above every page and a plugin draws anything in it. The host names the
// plugin beside the banner, in a part the banner's frame can't reach, with a menu that turns the
// plugin off; a plugin the administrator turned on for everyone gets the name only. The frame's
// wrapper is never taller than the slot's limit.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InstalledPlugin } from '@/lib/plugin-types';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
  useLocale: () => 'en',
}));

const plugins = new Map<string, InstalledPlugin>();
vi.mock('@/lib/plugin-sandbox/registry', () => ({
  get: (id: string) => {
    const plugin = plugins.get(id);
    return plugin && {
      plugin, code: '', tier: 'untrusted',
      background: { evaluateShouldShow: async () => true },
      slotOffers: [
        { name: 'app-top-banner', hasShouldShow: false, order: 100 },
        { name: 'email-banner', hasShouldShow: false, order: 100 },
      ],
    };
  },
}));

type SlotOptions = { slot: string; hostContainer: HTMLElement; onResize: (h: number) => void };
const createSlotInstance = vi.fn((opts: SlotOptions) => {
  opts.hostContainer.appendChild(document.createElement('iframe'));
  return { destroy: vi.fn(), updateProps: vi.fn(), setTheme: vi.fn(), sendFloatingDropdownEvent: vi.fn(), initPromise: Promise.resolve() };
});
vi.mock('@/lib/plugin-sandbox/host-bridge', () => ({
  createSlotInstance: (opts: SlotOptions) => createSlotInstance(opts),
}));
vi.mock('@/lib/plugin-sandbox/host-theme', () => ({ snapshotHostTheme: () => ({}) }));

import { PluginIframeSlot } from '@/components/plugins/plugin-iframe-slot';
import { usePluginStore } from '@/stores/plugin-store';

const disablePlugin = vi.fn();

function install(extra: Partial<InstalledPlugin> = {}): InstalledPlugin {
  const p: InstalledPlugin = {
    id: 'agenda', name: 'Calendar agenda', version: '1.0.0', author: '', description: '', type: 'ui-extension',
    permissions: ['ui:app-top-banner', 'ui:email-banner'], grantedPermissions: ['ui:app-top-banner', 'ui:email-banner'],
    entrypoint: 'index.js', enabled: true, status: 'running', settings: {}, ...extra,
  };
  plugins.set(p.id, p);
  usePluginStore.setState({ plugins: [p], disablePlugin } as never);
  return p;
}

/** Mounts the plugin's frame in `slot` and has it report `height`. */
async function mount(slot: 'app-top-banner' | 'email-banner', height: number) {
  const view = render(<PluginIframeSlot pluginId="agenda" slot={slot} extraProps={{}} />);
  await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
  act(() => createSlotInstance.mock.calls[0][0].onResize(height));
  return view;
}

beforeEach(() => {
  plugins.clear();
  createSlotInstance.mockClear();
  disablePlugin.mockClear();
});

describe('the host\'s control beside a plugin\'s top banner', () => {
  it('names the plugin and turns it off from its menu', async () => {
    install();
    await mount('app-top-banner', 40);

    const button = screen.getByRole('button', { name: 'plugin_menu Calendar agenda' });
    expect(button.closest('[data-plugin-iframe-slot]')).toBeNull();
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('menuitem', { name: /turn_off Calendar agenda/ }));

    expect(disablePlugin).toHaveBeenCalledWith('agenda');
  });

  it('gives a plugin the administrator turned on for everyone the name only', async () => {
    install({ forceEnabled: true });
    await mount('app-top-banner', 40);

    expect(screen.getByLabelText('from_plugin Calendar agenda')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /plugin_menu/ })).toBeNull();
  });

  it('shows nothing beside a banner that has nothing to show', async () => {
    install();
    await mount('app-top-banner', 0);
    expect(screen.queryByRole('button', { name: /plugin_menu/ })).toBeNull();
  });

  it('adds no control to the reader\'s banners', async () => {
    install();
    await mount('email-banner', 40);
    expect(screen.queryByRole('button', { name: /plugin_menu/ })).toBeNull();
  });

  it('keeps the frame\'s wrapper to the slot\'s limit, whatever height it is given', async () => {
    install();
    const { container } = await mount('app-top-banner', 2000);
    const wrapper = container.querySelector<HTMLElement>('[data-plugin-iframe-slot="agenda:app-top-banner"]')!;
    expect(wrapper.style.maxHeight).toBe('120px');
    expect(wrapper.style.overflow).toBe('hidden');
  });
});
