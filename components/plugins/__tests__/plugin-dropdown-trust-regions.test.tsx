// A plugin frame can take the focus by script, and the app can't tell that from the user clicking
// into it. So whatever a frame asks for, the list the app draws for it never covers the parts of
// the app that tell the user whose mail this is and what the app vouches for: the reader's
// subject, sender line, recipients and details, the app's own security and trust banners and
// cards, the top bar and the account switcher. They carry `data-plugin-list-avoid`. The list
// opens the other way, is shortened or moves sideways; with no room for two options it isn't
// drawn, and the frame hears that it closed.
//
// jsdom has no layout: boxes are given per element, and the list's box is read from its fixed
// position (left, width, top or bottom, max-height), which is the most it can cover.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
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
      slotOffers: [{ name: 'reader-header', hasShouldShow: false, order: 100 }],
    };
  },
}));

type SlotOptions = { plugin: InstalledPlugin; slot: string; hostContainer: HTMLElement; onFloatingDropdown: (msg: Record<string, unknown>) => void; onResize: (h: number) => void };
type FakeInstance = { sendFloatingDropdownEvent: ReturnType<typeof vi.fn> };
const createSlotInstance = vi.fn((opts: SlotOptions) => {
  opts.hostContainer.appendChild(document.createElement('iframe'));
  return { destroy: vi.fn(), updateProps: vi.fn(), setTheme: vi.fn(), sendFloatingDropdownEvent: vi.fn(), initPromise: Promise.resolve() };
});
vi.mock('@/lib/plugin-sandbox/host-bridge', () => ({ createSlotInstance: (opts: SlotOptions) => createSlotInstance(opts) }));
vi.mock('@/lib/plugin-sandbox/host-theme', () => ({ snapshotHostTheme: () => ({}) }));

import { PluginIframeSlot, placeFloatingDropdown, minListHeight } from '@/components/plugins/plugin-iframe-slot';
import { usePluginStore } from '@/stores/plugin-store';

/** The one attribute that marks a part of the app as never covered. */
const AVOID = 'data-plugin-list-avoid';

type Box = { left: number; top: number; right: number; bottom: number };
const VIEW = { width: 1400, height: 900 };
function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}
function placedBox(p: { left: number; width: number; top?: number; bottom?: number; maxHeight: number }): Box {
  const top = p.top ?? VIEW.height - p.bottom! - p.maxHeight;
  return { left: p.left, top, right: p.left + p.width, bottom: top + p.maxHeight };
}

describe('placing a list clear of the parts it must not cover', () => {
  // A reader-header frame across the reader, from y 165 to 199, an anchor at its bottom as wide as it.
  const frame = { left: 696, top: 165, right: 1400, bottom: 199 };
  const anchor = { left: 0, top: 32, bottom: 34, width: 704, height: 2 };
  const subject: Box = { left: 696, top: 199, right: 1400, bottom: 260 };
  const sender: Box = { left: 696, top: 260, right: 1400, bottom: 330 };

  it('opens upward instead of over the subject and the sender line', () => {
    const place = placeFloatingDropdown(anchor, frame, frame, VIEW, { avoid: [subject, sender], minHeight: minListHeight(3) })!;
    expect(place).not.toBeNull();
    expect(place.top).toBeUndefined();
    for (const b of [subject, sender]) expect(overlaps(placedBox(place), b)).toBe(false);
  });

  it('is shortened to end above a trust part, and is not drawn when fewer than two options fit', () => {
    // A frame high on the page with a banner 130 px below the anchor: shortened to fit above it.
    const high = { left: 0, top: 0, right: 600, bottom: 40 };
    const a = { left: 0, top: 0, bottom: 30, width: 300, height: 30 };
    const banner: Box = { left: 0, top: 160, right: 600, bottom: 200 };
    const shorter = placeFloatingDropdown(a, high, high, VIEW, { avoid: [banner], minHeight: minListHeight(3) })!;
    expect(shorter.top! + shorter.maxHeight).toBeLessThanOrEqual(banner.top);
    expect(shorter.maxHeight).toBeGreaterThanOrEqual(minListHeight(3));
    // 80 px below the anchor: room for one option, not two, and nothing above: no list.
    const close: Box = { left: 0, top: 110, right: 600, bottom: 200 };
    expect(placeFloatingDropdown(a, high, high, VIEW, { avoid: [close], minHeight: minListHeight(3) })).toBeNull();
  });

  it('is not drawn when the parts above and below leave no room', () => {
    const topBar: Box = { left: 0, top: 0, right: 1400, bottom: 160 };
    expect(placeFloatingDropdown(anchor, frame, frame, VIEW, { avoid: [topBar, subject, sender], minHeight: minListHeight(3) })).toBeNull();
  });

  it('moves sideways past a trust part when its own column has no room', () => {
    // A frame 1000 px wide, a narrow list at its left, a card under the left half only.
    const wide = { left: 0, top: 0, right: 1000, bottom: 40 };
    const a = { left: 0, top: 0, bottom: 30, width: 300, height: 30 };
    const card: Box = { left: 0, top: 40, right: 500, bottom: 600 };
    const place = placeFloatingDropdown(a, wide, wide, VIEW, { avoid: [card], minHeight: minListHeight(3) })!;
    expect(place).not.toBeNull();
    expect(place.left).toBeGreaterThanOrEqual(card.right);
    expect(place.left + place.width).toBeLessThanOrEqual(wide.right);
    expect(overlaps(placedBox(place), card)).toBe(false);
  });

  it('needs room for two options, or one for a list of one', () => {
    expect(minListHeight(5)).toBe(minListHeight(2));
    expect(minListHeight(1)).toBeLessThan(minListHeight(2));
    expect(minListHeight(0)).toBe(minListHeight(1));
  });
});

describe('the list of a reader frame in the page', () => {
  const FRAME: Box = { left: 696, top: 165, right: 1400, bottom: 199 };
  let boxes = new Map<string, Box>();
  beforeEach(() => {
    createSlotInstance.mockClear();
    plugins.clear();
    boxes = new Map();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEW.width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEW.height });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const id = (this as HTMLElement).dataset?.box;
      const b = this.tagName === 'IFRAME' || this.matches('[data-plugin-iframe-slot]') ? FRAME : (id && boxes.get(id)) || { left: 0, top: 0, right: 0, bottom: 0 };
      return { ...b, x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top, toJSON: () => b } as DOMRect;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  /** The reader: the frame, then the subject and the sender line under it; the user is in the frame. */
  async function reader(parts: Record<string, Box>, marked = true) {
    for (const [id, b] of Object.entries(parts)) boxes.set(id, b);
    const p: InstalledPlugin = {
      id: 'helper', name: 'Helpful plugin', version: '1.0.0', author: '', description: '', type: 'ui-extension',
      permissions: ['ui:email-banner'], grantedPermissions: ['ui:email-banner'], entrypoint: 'index.js',
      enabled: true, status: 'running', settings: {},
    };
    plugins.set(p.id, p);
    usePluginStore.setState({ plugins: [p] } as never);
    const attr = marked ? { [AVOID]: '' } : {};
    const view = render(
      <>
        <button>elsewhere</button>
        <PluginIframeSlot pluginId="helper" slot="reader-header" extraProps={{}} />
        {Object.keys(parts).map((id) => <div key={id} data-box={id} data-testid={id} {...attr}>{id}</div>)}
      </>,
    );
    await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
    const opts = createSlotInstance.mock.calls[0][0];
    const instance = createSlotInstance.mock.results[0].value as FakeInstance;
    act(() => opts.onResize(34));
    const iframe = document.querySelector<HTMLIFrameElement>('iframe')!;
    iframe.tabIndex = 0;
    act(() => { view.getByRole('button', { name: 'elsewhere' }).focus(); iframe.focus(); });
    const open = (id: string) => act(() => opts.onFloatingDropdown({
      type: 'floating-dropdown-open', id, rect: { left: 0, top: 32, bottom: 34, width: 704, height: 2 },
      options: [{ value: 'a', label: 'From: Your bank <service@bank.example>' }, { value: 'b', label: 'Verified sender' }, { value: 'c', label: 'Signed and encrypted' }],
      selectedValues: [], highlightedIndex: -1,
    }));
    const list = () => document.querySelector<HTMLElement>('[role="listbox"][id^="plugin-dropdown-"]');
    const listBox = (): Box => {
      const s = list()!.style;
      return placedBox({ left: parseFloat(s.left), width: parseFloat(s.width), top: s.top ? parseFloat(s.top) : undefined, bottom: s.bottom ? parseFloat(s.bottom) : undefined, maxHeight: parseFloat(s.maxHeight) });
    };
    return { view, open, list, listBox, instance };
  }

  const subject: Box = { left: 696, top: 199, right: 1400, bottom: 260 };
  const sender: Box = { left: 696, top: 260, right: 1400, bottom: 330 };
  const toolbar: Box = { left: 696, top: 108, right: 1400, bottom: 165 };

  // Control: without the marks the list lies over the subject and the sender line.
  it('lies over unmarked parts', async () => {
    const { open, list, listBox } = await reader({ subject, sender }, false);
    open('l1');
    expect(list()).not.toBeNull();
    expect(overlaps(listBox(), subject)).toBe(true);
  });

  it('keeps clear of the marked subject and sender line, opening upward over what is not marked', async () => {
    const { open, list, listBox } = await reader({ subject, sender });
    open('l1');
    expect(list()).not.toBeNull();
    expect(overlaps(listBox(), subject)).toBe(false);
    expect(overlaps(listBox(), sender)).toBe(false);
  });

  it('draws no list when marked parts leave no room, and the frame hears it closed', async () => {
    const topBar: Box = { left: 0, top: 0, right: 1400, bottom: 120 };
    const { open, list, instance } = await reader({ topBar, toolbar, subject, sender });
    // The toolbar isn't a trust part; it is marked here to leave no room above.
    open('l1');
    expect(list()).toBeNull();
    expect(instance.sendFloatingDropdownEvent).toHaveBeenCalledWith({ type: 'floating-dropdown-dismiss', id: 'l1' });
  });

  it('ignores marked parts behind the backdrop of the plugin\'s own modal dialog, and keeps clear of them around a popover dialog', async () => {
    const parts = { subject, sender, topBand: { left: 0, top: 0, right: 1400, bottom: 160 } };
    for (const [id, b] of Object.entries(parts)) boxes.set(id, b);
    const p: InstalledPlugin = {
      id: 'helper', name: 'Helpful plugin', version: '1.0.0', author: '', description: '', type: 'ui-extension',
      permissions: ['ui:email-banner'], grantedPermissions: ['ui:email-banner'], entrypoint: 'index.js',
      enabled: true, status: 'running', settings: {},
    };
    plugins.set(p.id, p);
    usePluginStore.setState({ plugins: [p] } as never);
    const listFor = async (popover: boolean) => {
      createSlotInstance.mockClear();
      const view = render(
        <>
          <button>elsewhere</button>
          {Object.keys(parts).map((id) => <div key={id} data-box={id} {...{ [AVOID]: '' }}>{id}</div>)}
          <div data-plugin-dialog-layer="" {...(popover ? { 'data-plugin-dialog-popover': '' } : {})}>
            <PluginIframeSlot pluginId="helper" slot="reader-header" extraProps={{}} />
          </div>
        </>,
      );
      await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
      const opts = createSlotInstance.mock.calls[0][0];
      act(() => opts.onResize(34));
      const iframe = view.container.querySelector<HTMLIFrameElement>('iframe')!;
      iframe.tabIndex = 0;
      act(() => { view.getByRole('button', { name: 'elsewhere' }).focus(); iframe.focus(); });
      act(() => opts.onFloatingDropdown({
        type: 'floating-dropdown-open', id: 'd1', rect: { left: 0, top: 32, bottom: 34, width: 704, height: 2 },
        options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }], selectedValues: [], highlightedIndex: -1,
      }));
      const drawn = !!document.querySelector('[role="listbox"][id^="plugin-dropdown-"]');
      view.unmount();
      return drawn;
    };
    expect(await listFor(false)).toBe(true);
    expect(await listFor(true)).toBe(false);
  });

  it('moves an open list when a part gains the mark, or closes it when no room is left', async () => {
    const { view, open, list, listBox, instance } = await reader({ subject, sender }, false);
    open('l1');
    expect(overlaps(listBox(), subject)).toBe(true);
    // The subject is marked now: the list moves off it.
    act(() => { view.getByTestId('subject').setAttribute(AVOID, ''); });
    await waitFor(() => expect(overlaps(listBox(), subject)).toBe(false));
    // Then a marked part takes the room above too: no place is left, the list closes.
    boxes.set('band', { left: 0, top: 0, right: 1400, bottom: 160 });
    act(() => {
      const band = document.createElement('div');
      band.dataset.box = 'band';
      band.setAttribute(AVOID, '');
      document.body.appendChild(band);
    });
    await waitFor(() => expect(list()).toBeNull());
    expect(instance.sendFloatingDropdownEvent).toHaveBeenCalledWith({ type: 'floating-dropdown-dismiss', id: 'l1' });
    document.querySelector('[data-box="band"]')?.remove();
  });
});
