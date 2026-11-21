// A frame's list goes when the frame stops showing, also when that happens with no click, scroll
// or resize: a panel hidden by a style change, an attribute, or a layout that leaves the frame no
// room. The list is drawn for a frame that shows; it must not stay behind where the frame was.
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
      slotOffers: [{ name: 'app-top-banner', hasShouldShow: false, order: 100 }],
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

import { PluginIframeSlot } from '@/components/plugins/plugin-iframe-slot';
import { usePluginStore } from '@/stores/plugin-store';

type Box = { left: number; top: number; right: number; bottom: number };
let frameBox: Box;
function rect(b: Box): DOMRect {
  return { ...b, x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top, toJSON: () => b } as DOMRect;
}

beforeEach(() => {
  createSlotInstance.mockClear();
  plugins.clear();
  frameBox = { left: 0, top: 0, right: 900, bottom: 40 };
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return rect(this.tagName === 'IFRAME' || this.matches('[data-plugin-iframe-slot]') ? frameBox : { left: 0, top: 0, right: 0, bottom: 0 });
  });
});
afterEach(() => vi.restoreAllMocks());

/** A banner in a panel; the user is in its frame and its list is open. */
async function openList() {
  const p: InstalledPlugin = {
    id: 'helper', name: 'Helpful plugin', version: '1.0.0', author: '', description: '', type: 'ui-extension',
    permissions: ['ui:app-top-banner'], grantedPermissions: ['ui:app-top-banner'], entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
  plugins.set(p.id, p);
  usePluginStore.setState({ plugins: [p] } as never);
  const view = render(<><button>elsewhere</button><div data-testid="panel"><PluginIframeSlot pluginId="helper" slot="app-top-banner" extraProps={{}} /></div></>);
  await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
  const opts = createSlotInstance.mock.calls[0][0];
  const instance = createSlotInstance.mock.results[0].value as FakeInstance;
  act(() => opts.onResize(40));
  const iframe = document.querySelector<HTMLIFrameElement>('iframe')!;
  iframe.tabIndex = 0;
  act(() => { view.getByRole('button', { name: 'elsewhere' }).focus(); iframe.focus(); });
  act(() => opts.onFloatingDropdown({
    type: 'floating-dropdown-open', id: 'l1', rect: { left: 0, top: 0, bottom: 40, width: 400, height: 40 },
    options: [{ value: 'a', label: 'Alpha' }], selectedValues: [], highlightedIndex: -1,
  }));
  const list = () => document.querySelector('[role="listbox"][id^="plugin-dropdown-"]');
  expect(list()).not.toBeNull();
  return { panel: view.getByTestId('panel'), list, instance };
}

describe('a list whose frame stops showing, with no click, scroll or resize', () => {
  it('goes when the panel around the frame is hidden by a style change', async () => {
    const { panel, list, instance } = await openList();
    frameBox = { left: 0, top: 0, right: 0, bottom: 0 };
    act(() => { panel.style.display = 'none'; });
    await waitFor(() => expect(list()).toBeNull(), { timeout: 1000 });
    expect(instance.sendFloatingDropdownEvent).toHaveBeenCalledWith({ type: 'floating-dropdown-dismiss', id: 'l1' });
  });

  it('goes when the panel gets the hidden attribute', async () => {
    const { panel, list } = await openList();
    frameBox = { left: 0, top: 0, right: 0, bottom: 0 };
    act(() => { panel.hidden = true; });
    await waitFor(() => expect(list()).toBeNull(), { timeout: 1000 });
  });

  it('goes when the frame is made invisible', async () => {
    const { list } = await openList();
    act(() => { document.querySelector<HTMLIFrameElement>('iframe')!.style.visibility = 'hidden'; });
    await waitFor(() => expect(list()).toBeNull(), { timeout: 1000 });
  });

  it('goes when the frame is left with no room, with no change the app watches', async () => {
    const { list } = await openList();
    // Something else on the page takes the space: the frame's box collapses.
    frameBox = { left: 0, top: 0, right: 900, bottom: 0 };
    await waitFor(() => expect(list()).toBeNull(), { timeout: 1000 });
  });

  // Control.
  it('stays while the frame keeps showing and styles change elsewhere', async () => {
    const { panel, list } = await openList();
    act(() => { panel.style.color = 'red'; document.body.className = 'something-else'; });
    await new Promise((r) => setTimeout(r, 450));
    expect(list()).not.toBeNull();
  });
});
