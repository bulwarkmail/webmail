// The banners plugins draw in the reader (the S/MIME and OpenPGP verdicts above the body, and every
// other banner around the subject and sender) and the reader's toolbar are parts a plugin's list
// never covers. A list keeps off every marked part except one that holds its own frame: so
// plugin A's list never lies over plugin B's banner, nor over a banner slot it isn't in, but
// still opens next to A's own banner.
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
      slotOffers: [
        { name: 'email-banner', hasShouldShow: false, order: 100 },
        { name: 'reader-header', hasShouldShow: false, order: 100 },
      ],
    };
  },
}));
const offers = vi.hoisted(() => ({ list: [] as Array<{ pluginId: string; order: number; hasShouldShow: boolean }> }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => offers.list }));

type SlotOptions = { plugin: InstalledPlugin; slot: string; hostContainer: HTMLElement; onFloatingDropdown: (msg: Record<string, unknown>) => void; onResize: (h: number) => void };
type FakeInstance = { sendFloatingDropdownEvent: ReturnType<typeof vi.fn> };
const createSlotInstance = vi.fn((opts: SlotOptions) => {
  opts.hostContainer.appendChild(document.createElement('iframe'));
  return { destroy: vi.fn(), updateProps: vi.fn(), setTheme: vi.fn(), sendFloatingDropdownEvent: vi.fn(), initPromise: Promise.resolve() };
});
vi.mock('@/lib/plugin-sandbox/host-bridge', () => ({ createSlotInstance: (opts: SlotOptions) => createSlotInstance(opts) }));
vi.mock('@/lib/plugin-sandbox/host-theme', () => ({ snapshotHostTheme: () => ({}) }));

import { PluginSlot } from '@/components/plugins/plugin-slot';
import { PluginIframeSlot } from '@/components/plugins/plugin-iframe-slot';
import { usePluginStore } from '@/stores/plugin-store';

/** The one attribute that marks a part of the app as never covered. */
const AVOID = 'data-plugin-list-avoid';
type Box = { left: number; top: number; right: number; bottom: number };
const VIEW = { width: 1400, height: 900 };
const ZERO: Box = { left: 0, top: 0, right: 0, bottom: 0 };
let boxes = new Map<string, Box>();

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}
function plugin(id: string): InstalledPlugin {
  const p: InstalledPlugin = {
    id, name: `Plugin ${id}`, version: '1.0.0', author: '', description: '', type: 'ui-extension',
    permissions: ['ui:email-banner'], grantedPermissions: ['ui:email-banner'], entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
  plugins.set(id, p);
  return p;
}

beforeEach(() => {
  createSlotInstance.mockClear();
  plugins.clear();
  boxes = new Map();
  offers.list = [];
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEW.width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEW.height });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const host = this.tagName === 'IFRAME' ? this.parentElement : this;
    const key = (host as HTMLElement | null)?.dataset?.pluginIframeSlot ?? (host as HTMLElement | null)?.dataset?.box ?? (host as HTMLElement | null)?.dataset?.pluginSlot;
    const b = (key && boxes.get(key)) || ZERO;
    return { ...b, x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top, toJSON: () => b } as DOMRect;
  });
});
afterEach(() => vi.restoreAllMocks());

/** Each frame's options, by plugin, once the frames have started. */
async function framesOf(count: number) {
  await waitFor(() => expect(createSlotInstance).toHaveBeenCalledTimes(count));
  return new Map(createSlotInstance.mock.calls.map(([opts], i) => [opts.plugin.id, { opts, instance: createSlotInstance.mock.results[i].value as FakeInstance }]));
}

/** The user (or a script) is in plugin `id`'s frame of `slot`, and it asks for a list. */
function askFrom(frames: Awaited<ReturnType<typeof framesOf>>, id: string, slot: string, rect: Record<string, number>) {
  const iframe = document.querySelector<HTMLIFrameElement>(`[data-plugin-iframe-slot="${id}:${slot}"] iframe`)!;
  iframe.tabIndex = 0;
  const before = document.createElement('button');
  document.body.appendChild(before);
  act(() => { before.focus(); iframe.focus(); });
  before.remove();
  act(() => frames.get(id)!.opts.onFloatingDropdown({
    type: 'floating-dropdown-open', id: `${id}-list`, rect,
    options: [{ value: 'a', label: 'Signature valid' }, { value: 'b', label: 'Signed by your bank' }, { value: 'c', label: 'Encrypted' }],
    selectedValues: [], highlightedIndex: -1,
  }));
}

function listBox(): Box | null {
  const l = document.querySelector<HTMLElement>('[role="listbox"][id^="plugin-dropdown-"]');
  if (!l) return null;
  const s = l.style;
  const left = parseFloat(s.left);
  const maxHeight = parseFloat(s.maxHeight);
  const top = s.top ? parseFloat(s.top) : VIEW.height - parseFloat(s.bottom) - maxHeight;
  return { left, top, right: left + parseFloat(s.width), bottom: top + maxHeight };
}

describe('the banners plugins draw in the reader', () => {
  it('carry the mark, each banner and the slot as a whole', async () => {
    plugin('alpha'); plugin('beta');
    usePluginStore.setState({ plugins: [...plugins.values()] } as never);
    offers.list = [{ pluginId: 'alpha', order: 10, hasShouldShow: false }, { pluginId: 'beta', order: 20, hasShouldShow: false }];
    const { container } = render(<PluginSlot name="email-banner" />);
    await framesOf(2);
    expect(container.querySelector('[data-plugin-slot="email-banner"]')!.hasAttribute(AVOID)).toBe(true);
    expect(container.querySelector('[data-plugin-iframe-slot="alpha:email-banner"]')!.hasAttribute(AVOID)).toBe(true);
    expect(container.querySelector('[data-plugin-iframe-slot="beta:email-banner"]')!.hasAttribute(AVOID)).toBe(true);
  });

  it('keep plugin A\'s list off plugin B\'s banner', async () => {
    plugin('alpha'); plugin('beta');
    usePluginStore.setState({ plugins: [...plugins.values()] } as never);
    offers.list = [{ pluginId: 'alpha', order: 10, hasShouldShow: false }, { pluginId: 'beta', order: 20, hasShouldShow: false }];
    // The sender block (marked) above; alpha's banner, then beta's banner (the verdict) under it.
    boxes.set('sender', { left: 696, top: 200, right: 1400, bottom: 300 });
    boxes.set('alpha:email-banner', { left: 696, top: 300, right: 1400, bottom: 340 });
    boxes.set('beta:email-banner', { left: 696, top: 340, right: 1400, bottom: 400 });
    boxes.set('email-banner', { left: 696, top: 300, right: 1400, bottom: 400 });
    render(<><div data-box="sender" {...{ [AVOID]: '' }} /><PluginSlot name="email-banner" /></>);
    const frames = await framesOf(2);
    act(() => { frames.get('alpha')!.opts.onResize(40); frames.get('beta')!.opts.onResize(60); });
    askFrom(frames, 'alpha', 'email-banner', { left: 0, top: 38, bottom: 40, width: 704, height: 2 });
    const box = listBox();
    if (box) expect(overlaps(box, boxes.get('beta:email-banner')!)).toBe(false);
    // Neither below (beta's banner) nor above (the sender): no list, and the frame hears it.
    expect(box).toBeNull();
    expect(frames.get('alpha')!.instance.sendFloatingDropdownEvent).toHaveBeenCalledWith({ type: 'floating-dropdown-dismiss', id: 'alpha-list' });
  });

  it('still let plugin A\'s list open next to its own banner', async () => {
    plugin('alpha'); plugin('beta');
    usePluginStore.setState({ plugins: [...plugins.values()] } as never);
    offers.list = [{ pluginId: 'alpha', order: 10, hasShouldShow: false }, { pluginId: 'beta', order: 20, hasShouldShow: false }];
    // Alpha's banner is a tall form with its Combobox at the top; beta's banner below it.
    boxes.set('alpha:email-banner', { left: 696, top: 300, right: 1400, bottom: 620 });
    boxes.set('beta:email-banner', { left: 696, top: 620, right: 1400, bottom: 680 });
    boxes.set('email-banner', { left: 696, top: 300, right: 1400, bottom: 680 });
    render(<PluginSlot name="email-banner" />);
    const frames = await framesOf(2);
    act(() => { frames.get('alpha')!.opts.onResize(320); frames.get('beta')!.opts.onResize(60); });
    askFrom(frames, 'alpha', 'email-banner', { left: 16, top: 10, bottom: 40, width: 300, height: 30 });
    const box = listBox();
    expect(box).not.toBeNull();
    expect(overlaps(box!, boxes.get('beta:email-banner')!)).toBe(false);
  });

  it('keep a list anchored in another slot off the banner slot as a whole', async () => {
    plugin('alpha'); plugin('beta');
    usePluginStore.setState({ plugins: [...plugins.values()] } as never);
    offers.list = [{ pluginId: 'beta', order: 20, hasShouldShow: false }];
    // Alpha's frame in the reader header, beta's verdict banner slot right under it, the toolbar above.
    boxes.set('toolbar', { left: 696, top: 108, right: 1400, bottom: 165 });
    boxes.set('alpha:reader-header', { left: 696, top: 165, right: 1400, bottom: 199 });
    boxes.set('beta:email-banner', { left: 696, top: 199, right: 1400, bottom: 260 });
    boxes.set('email-banner', { left: 696, top: 199, right: 1400, bottom: 270 });
    render(
      <>
        <div data-box="toolbar" {...{ [AVOID]: '' }} />
        <PluginIframeSlot pluginId="alpha" slot="reader-header" extraProps={{}} />
        <PluginSlot name="email-banner" />
      </>,
    );
    const frames = await framesOf(2);
    act(() => { frames.get('alpha')!.opts.onResize(34); frames.get('beta')!.opts.onResize(60); });
    askFrom(frames, 'alpha', 'reader-header', { left: 0, top: 32, bottom: 34, width: 704, height: 2 });
    expect(listBox()).toBeNull();
  });
});

// The toolbar itself carries the mark in the real reader (reader-list-avoid-marks.test.tsx); here,
// with the parts as marked, a narrow list anchored in the reader-header frame finds no room:
// the subject below, the toolbar above.
describe('the reader toolbar', () => {
  it('keeps a list anchored in the reader-header frame off the toolbar above it', async () => {
    plugin('alpha');
    usePluginStore.setState({ plugins: [...plugins.values()] } as never);
    boxes.set('toolbar', { left: 696, top: 108, right: 1400, bottom: 165 });
    boxes.set('alpha:reader-header', { left: 696, top: 165, right: 1400, bottom: 199 });
    boxes.set('subject', { left: 696, top: 199, right: 1400, bottom: 280 });
    render(
      <>
        <div data-box="toolbar" {...{ [AVOID]: '' }} />
        <PluginIframeSlot pluginId="alpha" slot="reader-header" extraProps={{}} />
        <div data-box="subject" {...{ [AVOID]: '' }} />
      </>,
    );
    const frames = await framesOf(1);
    act(() => frames.get('alpha')!.opts.onResize(34));
    askFrom(frames, 'alpha', 'reader-header', { left: 0, top: 32, bottom: 34, width: 220, height: 2 });
    const box = listBox();
    if (box) expect(overlaps(box, boxes.get('toolbar')!)).toBe(false);
    expect(box).toBeNull();
  });
});
