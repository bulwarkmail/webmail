// Where the host may draw a frame's dropdown list. Anything the host draws for a plugin stays
// inside the plugin's own area and carries the plugin's name in a place the plugin's text cannot
// reach. A plugin's own dialog carries that name in its header ("From the plugin X" and the menu
// that turns it off); the list the host draws for the dialog's frame never lies over that header,
// so the dialog never looks like one of the app's own with nothing saying who asks. A frame that
// shows nothing (a top banner that reports 0 px, or a frame whose panel is hidden) gets no list.
//
// jsdom has no layout: the boxes are given per element, and the list's box is read from its fixed
// position (left, width, top or bottom, max-height), which is the most it can cover.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
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
      slotOffers: [
        { name: 'plugin-dialog', hasShouldShow: false, order: 100 },
        { name: 'app-top-banner', hasShouldShow: false, order: 100 },
      ],
    };
  },
}));

type DropdownMsg = Record<string, unknown>;
type SlotOptions = { plugin: InstalledPlugin; slot: string; hostContainer: HTMLElement; onFloatingDropdown: (msg: DropdownMsg) => void; onResize: (h: number) => void };
const createSlotInstance = vi.fn((opts: SlotOptions) => {
  opts.hostContainer.appendChild(document.createElement('iframe'));
  return { destroy: vi.fn(), updateProps: vi.fn(), setTheme: vi.fn(), sendFloatingDropdownEvent: vi.fn(), initPromise: Promise.resolve() };
});
vi.mock('@/lib/plugin-sandbox/host-bridge', () => ({
  createSlotInstance: (opts: SlotOptions) => createSlotInstance(opts),
}));
vi.mock('@/lib/plugin-sandbox/host-theme', () => ({ snapshotHostTheme: () => ({}) }));

import { PluginDialogHost } from '@/components/plugins/plugin-dialog-host';
import { PluginIframeSlot } from '@/components/plugins/plugin-iframe-slot';
import { usePluginStore } from '@/stores/plugin-store';
import { awaitCustomDialog, head, resetDialogLimits, resolveHead } from '@/lib/plugin-sandbox/host-dialog';

type Box = { left: number; top: number; right: number; bottom: number };
const VIEW = { width: 1024, height: 768 };

function plugin(id = 'helper', name = 'Helpful plugin'): InstalledPlugin {
  const p: InstalledPlugin = {
    id, name, version: '1.0.0', author: '', description: '', type: 'ui-extension',
    permissions: ['ui:app-top-banner'], grantedPermissions: ['ui:app-top-banner'], entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
  plugins.set(id, p);
  usePluginStore.setState({ plugins: [p] } as never);
  return p;
}

/** Boxes by element; everything else is 0 x 0 at the origin, as jsdom has it. */
let boxOf: (el: Element) => Box | null = () => null;
function rect(b: Box): DOMRect {
  return { ...b, x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top, toJSON: () => b } as DOMRect;
}

beforeEach(() => {
  while (head()) resolveHead(null);
  resetDialogLimits();
  createSlotInstance.mockClear();
  plugins.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEW.width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEW.height });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return rect(boxOf(this) ?? { left: 0, top: 0, right: 0, bottom: 0 });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  boxOf = () => null;
});

function lists(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="listbox"]')].filter((l) => l.textContent?.includes('Keep me signed in'));
}

/** The most of the window the list can cover, from its fixed position. */
function listBox(list: HTMLElement): Box {
  const s = list.style;
  const left = parseFloat(s.left);
  const width = parseFloat(s.width);
  const maxHeight = parseFloat(s.maxHeight);
  const top = s.top ? parseFloat(s.top) : VIEW.height - parseFloat(s.bottom) - maxHeight;
  return { left, top, right: left + width, bottom: top + maxHeight };
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

const OPTIONS = [{ value: 'a', label: 'Keep me signed in on this device' }];

describe('the list of a frame in the plugin\'s own dialog', () => {
  it('does not lie over the dialog\'s header, where the host names the plugin', async () => {
    plugin();
    render(<PluginDialogHost />);
    act(() => { void awaitCustomDialog({ pluginId: 'helper', title: 'Your session has expired', message: '', slot: 'plugin-dialog' }); });
    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());

    // A dialog 500 px wide: its header (title, "From the plugin", menu) at y 40-110, the frame
    // under it from y 140 down to near the bottom of the window.
    const source = document.querySelector('[data-plugin-dialog-source]')!;
    const menu = screen.getByRole('button', { name: /^plugin_menu / });
    const header: Box = { left: 262, top: 40, right: 762, bottom: 110 };
    const frame: Box = { left: 262, top: 140, right: 762, bottom: 740 };
    boxOf = (el) => {
      if (el.tagName === 'IFRAME' || el.matches('[data-plugin-iframe-slot]')) return frame;
      if (el === source) return { left: 286, top: 70, right: 600, bottom: 86 };
      if (el === menu) return { left: 700, top: 50, right: 732, bottom: 82 };
      if (el.matches('[data-plugin-dialog]')) return { left: 262, top: 40, right: 762, bottom: 760 };
      return null;
    };

    // The anchor covers the frame from its top to its bottom (the host keeps it inside the frame).
    const opts = createSlotInstance.mock.calls[0][0];
    act(() => opts.onFloatingDropdown({
      type: 'floating-dropdown-open', id: 'l1',
      rect: { left: 0, top: 0, bottom: 600, width: 500, height: 600 },
      options: OPTIONS, selectedValues: [], highlightedIndex: -1,
    }));

    for (const list of lists()) {
      const box = listBox(list);
      expect(overlaps(box, { left: 286, top: 70, right: 600, bottom: 86 }), 'list over "From the plugin"').toBe(false);
      expect(overlaps(box, { left: 700, top: 50, right: 732, bottom: 82 }), 'list over the plugin menu').toBe(false);
      expect(overlaps(box, header), 'list over the dialog header').toBe(false);
    }
  });
});

describe('a frame that shows nothing', () => {
  async function banner(height: number, box: Box) {
    plugin();
    render(<PluginIframeSlot pluginId="helper" slot="app-top-banner" extraProps={{}} />);
    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
    const opts = createSlotInstance.mock.calls[0][0];
    act(() => opts.onResize(height));
    boxOf = (el) => (el.tagName === 'IFRAME' || el.matches('[data-plugin-iframe-slot]') ? box : null);
    return opts;
  }

  it('gets no list when the top banner reports 0 px', async () => {
    const opts = await banner(0, { left: 0, top: 0, right: 1024, bottom: 0 });
    // Nothing of the banner's frame is on screen; the host still names the plugin beside it.
    expect(screen.getByRole('button', { name: /^plugin_menu / })).toBeTruthy();

    act(() => opts.onFloatingDropdown({
      type: 'floating-dropdown-open', id: 'l2',
      rect: { left: 0, top: 0, bottom: 0, width: 1024, height: 0 },
      options: OPTIONS, selectedValues: [], highlightedIndex: -1,
    }));

    expect(lists()).toHaveLength(0);
  });

  it('gets no list when its panel is hidden (a box of 0 x 0)', async () => {
    const opts = await banner(40, { left: 0, top: 0, right: 0, bottom: 0 });
    act(() => opts.onFloatingDropdown({
      type: 'floating-dropdown-open', id: 'l3',
      rect: { left: 0, top: 0, bottom: 20, width: 300, height: 20 },
      options: OPTIONS, selectedValues: [], highlightedIndex: -1,
    }));
    expect(lists()).toHaveLength(0);
  });

  // Control: a banner that shows still gets its list.
  it('still gets a list when the banner shows', async () => {
    const opts = await banner(40, { left: 0, top: 0, right: 900, bottom: 40 });
    act(() => opts.onFloatingDropdown({
      type: 'floating-dropdown-open', id: 'l4',
      rect: { left: 0, top: 0, bottom: 30, width: 300, height: 30 },
      options: OPTIONS, selectedValues: [], highlightedIndex: -1,
    }));
    expect(lists()).toHaveLength(1);
  });
});
