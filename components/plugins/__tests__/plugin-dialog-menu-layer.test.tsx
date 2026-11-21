// The menu in a plugin dialog's header ("Turn off <plugin>") is the way out of a plugin that keeps
// opening dialogs. It must stand above the dialog it belongs to, and above everything the plugin
// can put in the plugin layer: the dialog's frame, a list the host draws for that frame, and a
// second dialog of the same plugin on top.
//
// jsdom has no layout and can't say which element is at a point. The menu, the plugin dialog
// layers and the lists are all position: fixed with a z-index in the page's root stacking context,
// so the one with the higher z-index is painted on top and takes the click where they overlap.
// The tests read the z-index each one is painted at (the inline value, else the app's z-* class
// on it or on its outermost ancestor that sets one) and compare those.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { InstalledPlugin } from '@/lib/plugin-types';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
  useLocale: () => 'en',
}));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Webmail' }) }));

const plugins = new Map<string, InstalledPlugin>();
vi.mock('@/lib/plugin-sandbox/registry', () => ({
  get: (id: string) => {
    const plugin = plugins.get(id);
    return plugin && {
      plugin, code: '', tier: 'untrusted',
      background: { evaluateShouldShow: async () => true },
      slotOffers: [{ name: 'plugin-dialog', hasShouldShow: false, order: 100 }],
    };
  },
}));

type SlotOptions = { plugin: InstalledPlugin; slot: string; hostContainer: HTMLElement; onFloatingDropdown: (msg: Record<string, unknown>) => void; onResize: (h: number) => void };
const createSlotInstance = vi.fn((opts: SlotOptions) => {
  opts.hostContainer.appendChild(document.createElement('iframe'));
  return { destroy: vi.fn(), updateProps: vi.fn(), setTheme: vi.fn(), sendFloatingDropdownEvent: vi.fn(), initPromise: Promise.resolve() };
});
vi.mock('@/lib/plugin-sandbox/host-bridge', () => ({ createSlotInstance: (opts: SlotOptions) => createSlotInstance(opts) }));
vi.mock('@/lib/plugin-sandbox/host-theme', () => ({ snapshotHostTheme: () => ({}) }));

import { PluginDialogHost } from '@/components/plugins/plugin-dialog-host';
import { usePluginStore } from '@/stores/plugin-store';
import { awaitCustomDialog, awaitPrompt, head, resetDialogLimits, resolveHead } from '@/lib/plugin-sandbox/host-dialog';

/** The z-index an element itself sets: inline, else the app's z-50 / z-[100000] class. */
function ownZ(el: Element): number | null {
  const inline = (el as HTMLElement).style?.zIndex;
  if (inline) return Number(inline);
  for (const c of el.classList) {
    const m = /^z-(?:\[(\d+)\]|(\d+))$/.exec(c);
    if (m) return Number(m[1] ?? m[2]);
  }
  return null;
}

/** The z-index the element is painted at in the page's root stacking context. */
function paintedZ(el: Element): number {
  let z = 0;
  for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
    const own = ownZ(n);
    if (own !== null) z = own;
  }
  return z;
}

const disablePlugin = vi.fn();

beforeEach(() => {
  while (head()) resolveHead(null);
  resetDialogLimits();
  createSlotInstance.mockClear();
  disablePlugin.mockClear();
  plugins.clear();
  const p: InstalledPlugin = {
    id: 'helper', name: 'Helpful plugin', version: '1.0.0', author: '', description: '', type: 'ui-extension',
    permissions: [], grantedPermissions: [], entrypoint: 'index.js', enabled: true, status: 'running', settings: {},
  };
  plugins.set(p.id, p);
  usePluginStore.setState({ plugins: [p], disablePlugin } as never);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
  // The dialog's frame shows (so a list may be drawn for it); everything else is 0 x 0, as in jsdom.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const b = this.tagName === 'IFRAME' || this.matches('[data-plugin-iframe-slot]') ? { left: 262, top: 140, right: 762, bottom: 400 } : { left: 0, top: 0, right: 0, bottom: 0 };
    return { ...b, x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top, toJSON: () => b } as DOMRect;
  });
});
afterEach(() => vi.restoreAllMocks());

async function openPluginDialog() {
  render(<PluginDialogHost />);
  act(() => { void awaitCustomDialog({ pluginId: 'helper', title: 'Pick a folder', message: '', slot: 'plugin-dialog' }); });
  await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
  return document.querySelector('[data-plugin-dialog-layer]')!;
}

function openMenu(): HTMLElement {
  const buttons = screen.getAllByRole('button', { name: /^plugin_menu Helpful plugin/ });
  fireEvent.click(buttons[buttons.length - 1]);
  return screen.getByRole('menuitem', { name: /turn_off Helpful plugin/ });
}

describe('the menu in a plugin dialog\'s header', () => {
  it('stands above the dialog, and its "Turn off" turns the plugin off', async () => {
    const layer = await openPluginDialog();
    const frame = layer.querySelector('iframe')!;
    const item = openMenu();

    expect(paintedZ(item)).toBeGreaterThan(paintedZ(layer));
    expect(paintedZ(item)).toBeGreaterThan(paintedZ(frame));

    fireEvent.click(item);
    expect(disablePlugin).toHaveBeenCalledWith('helper');
  });

  it('stays above a second dialog the plugin opens on top while the menu is open', async () => {
    await openPluginDialog();
    const item = openMenu();
    act(() => {
      void awaitPrompt({ pluginId: 'helper', kind: 'prompt', title: 'Your session has expired', message: '', fields: [{ name: 'code', label: 'Code' }] });
    });
    await waitFor(() => expect(document.querySelectorAll('[data-plugin-dialog-layer]')).toHaveLength(2));

    expect(item.isConnected).toBe(true);
    for (const layer of document.querySelectorAll('[data-plugin-dialog-layer]')) {
      expect(paintedZ(item)).toBeGreaterThan(paintedZ(layer));
    }
  });

  it('stands above the menu of the dialog on top as well', async () => {
    await openPluginDialog();
    act(() => {
      void awaitPrompt({ pluginId: 'helper', kind: 'prompt', title: 'Your session has expired', message: '', fields: [{ name: 'code', label: 'Code' }] });
    });
    await waitFor(() => expect(document.querySelectorAll('[data-plugin-dialog-layer]')).toHaveLength(2));
    const item = openMenu();
    for (const layer of document.querySelectorAll('[data-plugin-dialog-layer]')) {
      expect(paintedZ(item)).toBeGreaterThan(paintedZ(layer));
    }
  });

  it('closes a list drawn for the dialog\'s frame and stands above the layer it was in', async () => {
    const layer = await openPluginDialog();
    const frame = layer.querySelector<HTMLIFrameElement>('iframe')!;
    const opts = createSlotInstance.mock.calls[0][0];
    // The user is in the frame's Combobox.
    const before = document.createElement('button');
    document.body.appendChild(before);
    act(() => { before.focus(); frame.tabIndex = 0; frame.focus(); });
    before.remove();
    act(() => opts.onFloatingDropdown({
      type: 'floating-dropdown-open', id: 'l1', rect: { left: 0, top: 0, bottom: 30, width: 300, height: 30 },
      options: [{ value: 'a', label: 'Keep it on' }], selectedValues: [], highlightedIndex: -1,
    }));
    const list = document.querySelector('[role="listbox"][id^="plugin-dropdown-"]')!;
    expect(list).not.toBeNull();
    const listZ = paintedZ(list);

    const item = openMenu();
    await waitFor(() => expect(document.querySelector('[role="listbox"][id^="plugin-dropdown-"]')).toBeNull());
    expect(paintedZ(item)).toBeGreaterThan(listZ);
  });
});
