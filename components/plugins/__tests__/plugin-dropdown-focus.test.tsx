// A frame may ask the host to draw a dropdown list for it (the UI kit's Combobox). The rule these
// tests hold:
//
//   The host draws a frame's list only while the user is in that frame, and never while a menu,
//   popover or dialog of the app is open that the frame is not inside.
//
// The kit's Combobox opens its list on a click or a key in its field, so the frame has the focus
// then. A frame can also take the focus by script, so a stay in the frame counts only when the
// focus was seen coming into it from the app while the window had the focus and the frame showed,
// and a list the user closed with a click outside isn't drawn again until the focus has left the
// frame and come back.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
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
        { name: 'reader-header', hasShouldShow: false, order: 100 },
        { name: 'app-top-banner', hasShouldShow: false, order: 100 },
      ],
    };
  },
}));

type DropdownMsg = Record<string, unknown>;
type SlotOptions = { plugin: InstalledPlugin; slot: string; hostContainer: HTMLElement; onFloatingDropdown: (msg: DropdownMsg) => void; onResize: (h: number) => void };
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
const ZERO: Box = { left: 0, top: 0, right: 0, bottom: 0 };
let frameBox: Box;
// The menu beside a top banner (its chip and the menu under it, at the window's right edge).
const CHIP: Box = { left: 904, top: 4, right: 1020, bottom: 29 };
const MENU: Box = { left: 800, top: 33, right: 1020, bottom: 101 };
function rect(b: Box): DOMRect {
  return { ...b, x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top, toJSON: () => b } as DOMRect;
}
function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

beforeEach(() => {
  createSlotInstance.mockClear();
  plugins.clear();
  frameBox = { left: 0, top: 0, right: 900, bottom: 40 };
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.tagName === 'IFRAME' || this.matches('[data-plugin-iframe-slot]')) return rect(frameBox);
    if (this.closest('[data-plugin-banner-source]')) return rect(CHIP);
    if (this.closest('[role="menu"]')) return rect(MENU);
    return rect(ZERO);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('[data-test-layer]').forEach((el) => el.remove());
});

const OPTIONS = [
  { value: 'a', label: 'From: Your bank <service@bank.example>' },
  { value: 'b', label: 'Verified sender' },
];

async function mount(slot: 'reader-header' | 'app-top-banner' = 'reader-header', around?: (slotEl: ReactNode) => ReactNode) {
  const p: InstalledPlugin = {
    id: 'helper', name: 'Helpful plugin', version: '1.0.0', author: '', description: '', type: 'ui-extension',
    permissions: ['ui:email-banner', 'ui:app-top-banner'], grantedPermissions: ['ui:email-banner', 'ui:app-top-banner'],
    entrypoint: 'index.js', enabled: true, status: 'running', settings: {},
  };
  plugins.set(p.id, p);
  usePluginStore.setState({ plugins: [p], disablePlugin: vi.fn() } as never);
  const slotEl = <PluginIframeSlot pluginId="helper" slot={slot} extraProps={{}} />;
  render(<><button>elsewhere</button>{around ? around(slotEl) : slotEl}</>);
  await waitFor(() => expect(createSlotInstance).toHaveBeenCalled());
  const index = createSlotInstance.mock.calls.length - 1;
  const opts = createSlotInstance.mock.calls[index][0];
  const instance = createSlotInstance.mock.results[index].value as FakeInstance;
  act(() => opts.onResize(40));
  const iframe = document.querySelector<HTMLIFrameElement>('[data-plugin-iframe-slot] iframe')!;
  iframe.tabIndex = 0;
  const elsewhere = screen.getByRole('button', { name: 'elsewhere' });
  const open = (id = 'l1', more: DropdownMsg = {}) => act(() => opts.onFloatingDropdown({
    type: 'floating-dropdown-open', id, rect: { left: 0, top: 38, bottom: 40, width: 700, height: 2 },
    options: OPTIONS, selectedValues: [], highlightedIndex: -1, ...more,
  }));
  // The user is in the app, then goes into the frame (a click in its field, or Tab).
  const enter = () => act(() => { elsewhere.focus(); iframe.focus(); });
  const list = () => document.querySelector<HTMLElement>('[role="listbox"][id^="plugin-dropdown-"]');
  const dismissed = (id: string) => expect(instance.sendFloatingDropdownEvent).toHaveBeenCalledWith({ type: 'floating-dropdown-dismiss', id });
  return { opts, instance, iframe, elsewhere, open, enter, list, dismissed };
}

/** An element of the app's, added to the page for the test. */
function addToPage(html: string): HTMLElement {
  const holder = document.createElement('div');
  holder.setAttribute('data-test-layer', '');
  holder.innerHTML = html;
  act(() => { document.body.appendChild(holder); });
  return holder.firstElementChild as HTMLElement;
}

describe('a frame the user is not in', () => {
  it('draws no list for a frame the user is not in, and tells the frame', async () => {
    const { open, list, elsewhere, dismissed } = await mount();
    act(() => elsewhere.focus());
    open('l1');
    expect(list()).toBeNull();
    await waitFor(() => dismissed('l1'));
    expect(list()).toBeNull();
  });

  it('draws no list for a frame that asks before anyone has been in the app', async () => {
    const { open, list, dismissed } = await mount();
    open('l1');
    await waitFor(() => dismissed('l1'));
    expect(list()).toBeNull();
  });

  // Control: the user clicked the Combobox, so the frame has the focus.
  it('draws the list while the user is in the frame', async () => {
    const { open, list, enter, iframe } = await mount();
    enter();
    expect(document.activeElement).toBe(iframe);
    open('l1');
    expect(list()).not.toBeNull();
  });

  // The frame's message can come in before the app hears that the focus moved.
  it('draws a list asked for just before the focus is seen in the frame', async () => {
    const { open, list, enter } = await mount();
    open('l1');
    expect(list()).toBeNull();
    enter();
    await waitFor(() => expect(list()).not.toBeNull());
  });
});

describe('an open list closes when the focus leaves the frame', () => {
  it('closes on a click elsewhere in the app', async () => {
    const { open, list, enter, elsewhere, dismissed } = await mount();
    enter();
    open('l1');
    expect(list()).not.toBeNull();
    fireEvent.mouseDown(elsewhere);
    act(() => elsewhere.focus());
    expect(list()).toBeNull();
    dismissed('l1');
  });

  it('closes when Tab takes the focus out of the frame to the next control', async () => {
    const { open, list, enter, elsewhere } = await mount();
    enter();
    open('l1');
    expect(list()).not.toBeNull();
    // Tab from the frame's last field: the next control of the app gets the focus, no click.
    act(() => elsewhere.focus());
    expect(list()).toBeNull();
  });

  it('closes when the window loses the focus', async () => {
    const { open, list, enter } = await mount();
    enter();
    open('l1');
    expect(list()).not.toBeNull();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    act(() => { window.dispatchEvent(new Event('blur')); });
    expect(list()).toBeNull();
  });

  it('closes when the focus leaves with no event the app hears', async () => {
    const { open, list, enter } = await mount();
    enter();
    open('l1');
    expect(list()).not.toBeNull();
    // A browser that says nothing when the focus leaves the window from inside a frame.
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    await waitFor(() => expect(list()).toBeNull(), { timeout: 1000 });
  });

  it('closes when the frame is taken out of the page', async () => {
    const { open, list, enter, iframe } = await mount();
    enter();
    open('l1');
    expect(list()).not.toBeNull();
    act(() => iframe.remove());
    await waitFor(() => expect(list()).toBeNull(), { timeout: 1000 });
  });
});

describe('a list the frame would open with nobody in it', () => {
  it('draws none when the focus was in the frame as the window came back to the front', async () => {
    const { open, list, enter, elsewhere, iframe, dismissed } = await mount();
    act(() => elsewhere.focus());
    // The window goes to the background; the frame takes the focus meanwhile.
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    act(() => { window.dispatchEvent(new Event('blur')); });
    act(() => iframe.focus());
    // The window comes back with the focus in the frame; the app hears nothing.
    hasFocus.mockReturnValue(true);
    open('l1');
    expect(list()).toBeNull();
    dismissed('l1');

    // The user goes out of the frame and into it again: now it gets its list.
    enter();
    open('l2');
    expect(list()).not.toBeNull();
  });

  it('draws none for a frame that took the focus while it showed nothing', async () => {
    const { opts, open, list, enter, elsewhere, iframe } = await mount();
    act(() => elsewhere.focus());
    frameBox = { left: 0, top: 0, right: 900, bottom: 0 };
    act(() => opts.onResize(0));
    act(() => iframe.focus());
    // Then it grows and asks.
    act(() => opts.onResize(40));
    frameBox = { left: 0, top: 0, right: 900, bottom: 40 };
    open('l1');
    expect(list()).toBeNull();

    enter();
    open('l2');
    expect(list()).not.toBeNull();
  });

  it('draws no list again after the user closed it with a click outside, until they leave the frame and come back', async () => {
    const { open, list, enter, dismissed } = await mount();
    enter();
    open('l1');
    expect(list()).not.toBeNull();
    // A click outside that leaves the focus where it was (its mousedown keeps the focus).
    fireEvent.mouseDown(document.body);
    expect(list()).toBeNull();
    // The frame asks again at once.
    open('l2');
    expect(list()).toBeNull();
    dismissed('l2');

    enter();
    open('l3');
    expect(list()).not.toBeNull();
  });

  // Control: a list the frame closes itself (a pick, Escape in its field) opens again on the next click.
  it('opens again after the frame closed its own list', async () => {
    const { opts, open, list, enter } = await mount();
    enter();
    open('l1');
    act(() => opts.onFloatingDropdown({ type: 'floating-dropdown-close', id: 'l1' }));
    expect(list()).toBeNull();
    open('l1');
    expect(list()).not.toBeNull();
  });
});

describe('the app\'s menus and popovers', () => {
  it('keeps a list off the open menu beside the banner that turns the plugin off', async () => {
    const { open, iframe } = await mount('app-top-banner');
    fireEvent.click(screen.getByRole('button', { name: /^plugin_menu / }));
    expect(screen.getByRole('menuitem', { name: /turn_off Helpful plugin/ })).toBeTruthy();
    // The frame takes the focus by itself and asks for a list as wide as the banner.
    act(() => iframe.focus());
    open('l1', { rect: { left: 0, top: 38, bottom: 40, width: 900, height: 2 } });

    const lists = [...document.querySelectorAll<HTMLElement>('[role="listbox"][id^="plugin-dropdown-"]')];
    for (const l of lists) {
      const s = l.style;
      const left = parseFloat(s.left);
      const top = s.top ? parseFloat(s.top) : 768 - parseFloat(s.bottom) - parseFloat(s.maxHeight);
      expect(overlaps({ left, top, right: left + parseFloat(s.width), bottom: top + parseFloat(s.maxHeight) }, MENU), 'list over the turn-off menu').toBe(false);
    }
    expect(lists).toHaveLength(0);
  });

  it('closes an open list when a menu of the app opens, with the focus still in the frame', async () => {
    const { open, list, enter, iframe, dismissed } = await mount();
    enter();
    open('l1');
    expect(list()).not.toBeNull();
    addToPage('<div role="menu" aria-label="Message actions"><button role="menuitem">Delete</button></div>');
    expect(document.activeElement).toBe(iframe);
    await waitFor(() => expect(list()).toBeNull());
    dismissed('l1');
  });

  it('draws none for a stay that began while a menu of the app was open, after the menu closed', async () => {
    const { open, list, enter, elsewhere, iframe, dismissed } = await mount();
    act(() => elsewhere.focus());
    const menu = addToPage('<div role="menu" aria-label="Plugin menu"><button role="menuitem">Turn off</button></div>');
    // The frame takes the focus; Chromium tells the page with a blur of its window, and the
    // app's menus close on that blur.
    act(() => {
      iframe.focus();
      window.dispatchEvent(new Event('blur'));
    });
    act(() => menu.parentElement!.remove());
    open('l1');
    expect(list()).toBeNull();
    dismissed('l1');

    enter();
    open('l2');
    expect(list()).not.toBeNull();
  });

  it('draws no list while a menu of the app is open', async () => {
    const { open, list, enter } = await mount();
    addToPage('<div role="menu" aria-label="Message actions"><button role="menuitem">Delete</button></div>');
    enter();
    open('l1');
    expect(list()).toBeNull();
  });

  it('draws no list while a popover of the app is open', async () => {
    const { open, list, enter } = await mount();
    addToPage('<div role="dialog" aria-label="Event details"><p>Planning</p></div>');
    enter();
    open('l1');
    expect(list()).toBeNull();
  });

  it('draws no list while a picker of the app is open, whose list has no menu role', async () => {
    const { open, list, enter } = await mount();
    addToPage('<button aria-haspopup="listbox" aria-expanded="true">Sort by</button>');
    enter();
    open('l1');
    expect(list()).toBeNull();
  });

  // Controls.
  it('still draws the list beside a menu kept in the page while closed', async () => {
    const { open, list, enter } = await mount();
    addToPage('<div role="menu" inert aria-label="More"><button role="menuitem">Archive</button></div>');
    addToPage('<button aria-haspopup="menu" aria-expanded="false">More</button>');
    enter();
    open('l1');
    expect(list()).not.toBeNull();
  });

  it('still draws the list of a frame inside an open menu', async () => {
    const { open, list, enter } = await mount('reader-header', (slotEl) => (
      <>
        <button aria-haspopup="menu" aria-expanded="true">More actions</button>
        <div role="menu" aria-label="More actions">{slotEl}</div>
      </>
    ));
    enter();
    open('l1');
    expect(list()).not.toBeNull();
  });
});

describe('a pick with the mouse', () => {
  it('reaches the frame, and the list stays for the next pick', async () => {
    const { open, list, enter, instance } = await mount();
    enter();
    open('l1', { multiple: true });
    const row = screen.getByRole('option', { name: 'Verified sender' });
    fireEvent.pointerDown(row);
    fireEvent.mouseDown(row);
    fireEvent.click(row);
    expect(instance.sendFloatingDropdownEvent).toHaveBeenCalledWith({ type: 'floating-dropdown-select', id: 'l1', option: OPTIONS[1] });
    await new Promise((r) => setTimeout(r, 400));
    expect(list()).not.toBeNull();
    expect(instance.sendFloatingDropdownEvent).not.toHaveBeenCalledWith({ type: 'floating-dropdown-dismiss', id: 'l1' });
  });

  it('reaches the frame in a browser that moves the focus to the app on the press, and the frame takes it back', async () => {
    const { open, list, enter, instance, iframe, elsewhere } = await mount();
    enter();
    open('l1', { multiple: true });
    const row = screen.getByRole('option', { name: 'Verified sender' });
    fireEvent.pointerDown(row);
    fireEvent.mouseDown(row);
    act(() => elsewhere.focus());
    expect(list()).not.toBeNull();
    fireEvent.click(row);
    expect(instance.sendFloatingDropdownEvent).toHaveBeenCalledWith({ type: 'floating-dropdown-select', id: 'l1', option: OPTIONS[1] });
    // The kit puts the focus back into its field after a pick.
    act(() => iframe.focus());
    await new Promise((r) => setTimeout(r, 400));
    expect(list()).not.toBeNull();
  });
});
