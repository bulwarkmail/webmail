import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WindowControlsHost } from '@/components/layout/window-controls-host';
import { WindowMenuBar } from '@/components/layout/window-menu-bar';
import { menuKeyText } from '@/lib/desktop/menu-bar';
import { desktopBootScript } from '@/lib/desktop/boot';
import { CONTROLS_ATTRIBUTE, CONTROLS_LEFT_ATTRIBUTE, DRAWER_LEFT_ATTRIBUTE, DRAWER_RIGHT_ATTRIBUTE, ROW_ATTRIBUTE, ROW_LEFT_ATTRIBUTE, ROW_RIGHT_ATTRIBUTE, TITLEBAR_RIGHT_VAR, TITLEBAR_ROW_VAR, markWindowRows, readTitlebarArea, watchWindowRows } from '@/lib/window-controls-overlay';

class FakeOverlay extends EventTarget {
  visible = true;
  rect = { x: 0, y: 0, width: 867, height: 40 };
  getTitlebarAreaRect() {
    return this.rect;
  }
  change(next: Partial<FakeOverlay>) {
    Object.assign(this, next);
    this.dispatchEvent(new Event('geometrychange'));
  }
}

function installOverlay(overlay: FakeOverlay | undefined) {
  Object.defineProperty(navigator, 'windowControlsOverlay', { value: overlay, configurable: true });
}

const root = document.documentElement;
const rightInset = () => root.style.getPropertyValue(TITLEBAR_RIGHT_VAR);

afterEach(() => {
  cleanup();
  installOverlay(undefined);
  root.style.removeProperty(TITLEBAR_RIGHT_VAR);
  root.style.removeProperty(TITLEBAR_ROW_VAR);
  root.removeAttribute(CONTROLS_ATTRIBUTE);
  root.removeAttribute(CONTROLS_LEFT_ATTRIBUTE);
  root.removeAttribute(DRAWER_LEFT_ATTRIBUTE);
  root.removeAttribute(DRAWER_RIGHT_ATTRIBUTE);
});

describe('the menu bar in the desktop app', () => {
  type BarEvent = { visible: boolean; open?: string; pinned?: boolean };
  type Line = { key: string; id?: string; label: string; type: string; enabled: boolean; checked?: boolean; accelerator?: string; mnemonic?: number; items?: Line[] };

  const line = (key: string, label: string, extra: Partial<Line> = {}): Line => ({ key, label, type: 'normal', enabled: true, mnemonic: 0, ...extra });
  const MENUS = [
    { id: 'file', label: 'File', mnemonic: 'f', items: [
      line('0/0', 'New message', { accelerator: 'CmdOrCtrl+N', id: 'file.newMessage' }),
      line('0/1', 'Print…', { enabled: false, mnemonic: 0 }),
      { key: '0/2', label: '', type: 'separator', enabled: false },
      line('0/3', 'Exit', { mnemonic: 1, accelerator: 'Ctrl+Q' }),
    ] },
    { id: 'view', label: 'View', mnemonic: 'v', items: [
      line('1/0', 'Reading pane', { type: 'submenu', items: [line('1/0/0', 'On the right', { type: 'radio', checked: true }), line('1/0/1', 'Off', { type: 'radio', mnemonic: 1 })] }),
      line('1/1', 'Always show the menu bar', { type: 'checkbox', checked: false }),
      line('1/2', 'Zoom in', { mnemonic: 0, accelerator: 'CmdOrCtrl+Plus' }),
    ] },
    { id: 'help', label: 'Help', mnemonic: 'h', items: [line('2/0', 'Keyboard shortcuts', { mnemonic: 0, accelerator: '?' })] },
  ];

  function withBar(options: { legacy?: boolean; platform?: string } = {}) {
    let send: (event: BarEvent) => void = () => {};
    const open = vi.fn();
    const run = vi.fn();
    const report = vi.fn();
    const setPinned = vi.fn();
    window.bulwarkDesktop = {
      version: 1,
      platform: options.platform ?? 'win32',
      menu: {
        setState: () => {},
        bar: {
          entries: async () => MENUS.map(({ id, label, mnemonic }) => ({ id, label, mnemonic })),
          open,
          onEvent: (listener: (event: BarEvent) => void) => {
            send = listener;
            return () => {};
          },
          ...(options.legacy ? {} : { menus: async () => MENUS, run, report, setPinned }),
        },
      },
    } as never;
    return { open, run, report, setPinned, send: (event: BarEvent) => act(async () => send(event)) };
  }

  afterEach(() => {
    window.bulwarkDesktop = undefined;
    document.documentElement.removeAttribute('data-menu-bar');
    document.documentElement.removeAttribute('data-desktop');
    localStorage.removeItem('bulwark-menu-bar');
  });

  const overlayOn = () => {
    Object.defineProperty(navigator, 'windowControlsOverlay', {
      configurable: true,
      value: Object.assign(new EventTarget(), { visible: true, getTitlebarAreaRect: () => ({ x: 0, y: 0, width: 800, height: 36 }) }),
    });
  };

  afterEach(() => {
    delete (navigator as unknown as { windowControlsOverlay?: unknown }).windowControlsOverlay;
  });

  const typed = () => {
    const before = document.createElement('input');
    document.body.appendChild(before);
    before.focus();
    return before;
  };

  it('Alt shows a row that moves the app down, with the keys on the first name, and Escape gives them back', async () => {
    overlayOn();
    const bar = withBar();
    const before = typed();
    render(<WindowMenuBar />);
    await bar.send({ visible: true });
    const file = await screen.findByRole('menuitem', { name: 'File' });
    await waitFor(() => expect(document.activeElement).toBe(file));
    expect(document.documentElement.hasAttribute('data-menu-bar')).toBe(true);
    expect(screen.getByRole('menubar').hasAttribute('data-window-top-row')).toBe(true);
    expect(bar.report).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }));
    // The letter that opens it is underlined while the keys are on the bar.
    expect(file.querySelector('.underline')?.textContent).toBe('F');
    fireEvent.keyDown(file, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'View' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menubar')).toBeNull();
    expect(document.documentElement.hasAttribute('data-menu-bar')).toBe(false);
    expect(bar.report).toHaveBeenLastCalledWith({ height: 0, active: false });
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it('draws the menu with its keys apart from the names, skips what is off, and runs a line where the keys were', async () => {
    overlayOn();
    const bar = withBar();
    const before = typed();
    render(<WindowMenuBar />);
    await bar.send({ visible: true });
    const file = await screen.findByRole('menuitem', { name: 'File' });
    await waitFor(() => expect(document.activeElement).toBe(file));
    fireEvent.keyDown(file, { key: 'ArrowDown' });
    const menu = await screen.findByRole('menu', { name: 'File' });
    const newMessage = within(menu).getByRole('menuitem', { name: /New message/ });
    await waitFor(() => expect(document.activeElement).toBe(newMessage));
    expect(newMessage.querySelector('[data-menu-label]')?.textContent).toBe('New message');
    expect(newMessage.querySelector('[data-menu-keys]')?.textContent).toBe('Ctrl+N');
    // Drawn as every menu's rows: its icon (by the shell's id) and the key as a keycap.
    expect(newMessage.querySelector('svg')).not.toBeNull();
    expect(newMessage.querySelector('[data-menu-keys]')?.hasAttribute('data-menu-shortcut')).toBe(true);
    expect(within(menu).getByRole('menuitem', { name: /Print/ }).getAttribute('aria-disabled')).toBe('true');
    // Down skips the line that's off.
    fireEvent.keyDown(newMessage, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('Exit');
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(bar.run).toHaveBeenCalledWith('0/3', 'Exit');
    expect(screen.queryByRole('menubar')).toBeNull();
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it('the arrows go across to the next menu and into a submenu', async () => {
    overlayOn();
    const bar = withBar();
    render(<WindowMenuBar />);
    await bar.send({ visible: true, open: 'file' });
    const menu = await screen.findByRole('menu', { name: 'File' });
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    const view = await screen.findByRole('menu', { name: 'View' });
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Reading pane'));
    expect(screen.queryByRole('menu', { name: 'File' })).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    const sub = await screen.findByRole('menu', { name: 'Reading pane' });
    await waitFor(() => expect(sub.contains(document.activeElement)).toBe(true));
    expect(within(sub).getByRole('menuitemradio', { name: /On the right/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(screen.queryByRole('menu', { name: 'Reading pane' })).toBeNull();
    expect(document.activeElement?.textContent).toContain('Reading pane');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    await screen.findByRole('menu', { name: 'File' });
    expect(view.isConnected).toBe(false);
    // Escape closes the menu and leaves the keys on its name.
    await waitFor(() => expect(screen.getByRole('menu', { name: 'File' }).contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'File' }));
  });

  it('Alt and a letter opens that menu, and a line\'s letter runs it', async () => {
    overlayOn();
    const bar = withBar();
    render(<WindowMenuBar />);
    await bar.send({ visible: true, open: 'view' });
    const view = await screen.findByRole('menu', { name: 'View' });
    await waitFor(() => expect(view.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement!, { key: 'z' });
    expect(bar.run).toHaveBeenCalledWith('1/2', 'Zoom in');
  });

  it('a click elsewhere puts it away', async () => {
    overlayOn();
    const bar = withBar();
    render(<WindowMenuBar />);
    await bar.send({ visible: true });
    fireEvent.pointerDown(await screen.findByRole('menuitem', { name: 'Help' }), { button: 0 });
    await screen.findByRole('menu', { name: 'Help' });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menubar')).toBeNull();
  });

  it('always shown, it is there without Alt and takes no keys, and a click on a name opens that menu', async () => {
    overlayOn();
    const bar = withBar();
    const before = typed();
    render(<WindowMenuBar />);
    await bar.send({ visible: false, pinned: true });
    const help = await screen.findByRole('menuitem', { name: 'Help' });
    expect(document.activeElement).toBe(before);
    expect(help.querySelector('.underline')).toBeNull();
    expect(document.documentElement.hasAttribute('data-menu-bar')).toBe(true);
    expect(localStorage.getItem('bulwark-menu-bar')).toBe('pinned');
    fireEvent.pointerDown(help, { button: 0 });
    const menu = await screen.findByRole('menu', { name: 'Help' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Keyboard shortcuts/ }));
    expect(bar.run).toHaveBeenCalledWith('2/0', 'Keyboard shortcuts');
    // Still there: it's always shown.
    expect(screen.getByRole('menubar')).toBeTruthy();
    expect(document.activeElement).toBe(before);
    await bar.send({ visible: false, pinned: false });
    expect(screen.queryByRole('menubar')).toBeNull();
    expect(localStorage.getItem('bulwark-menu-bar')).toBeNull();
    before.remove();
  });

  it('an older shell opens the menu natively', async () => {
    overlayOn();
    const bar = withBar({ legacy: true });
    render(<WindowMenuBar />);
    await bar.send({ visible: true });
    fireEvent.pointerDown(await screen.findByRole('menuitem', { name: 'View' }), { button: 0 });
    expect(bar.open).toHaveBeenCalledWith('view', expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
  });

  it('the shell can take it away again', async () => {
    overlayOn();
    const bar = withBar();
    render(<WindowMenuBar />);
    await bar.send({ visible: true });
    await screen.findByRole('menubar');
    await bar.send({ visible: false });
    expect(screen.queryByRole('menubar')).toBeNull();
  });

  it('with no bridge there is none, and none on a Mac, which has the system bar', async () => {
    overlayOn();
    const { unmount } = render(<WindowMenuBar />);
    expect(screen.queryByRole('menubar')).toBeNull();
    unmount();
    const bar = withBar({ platform: 'darwin' });
    render(<WindowMenuBar />);
    await bar.send({ visible: true });
    expect(screen.queryByRole('menubar')).toBeNull();
  });

  it('an always-shown bar has its row from the first frame, before any script of the app', () => {
    overlayOn();
    localStorage.setItem('bulwark-menu-bar', 'pinned');
    window.bulwarkDesktop = { version: 1, platform: 'darwin' } as never;
    new Function(desktopBootScript())();
    expect(document.documentElement.hasAttribute('data-menu-bar'), 'a Mac has the system bar').toBe(false);
    window.bulwarkDesktop = { version: 1, platform: 'win32' } as never;
    new Function(desktopBootScript())();
    expect(document.documentElement.hasAttribute('data-menu-bar')).toBe(true);
  });

  it('menu keys read the way Windows writes them', () => {
    expect(menuKeyText('CmdOrCtrl+N', 'win32')).toBe('Ctrl+N');
    expect(menuKeyText('CmdOrCtrl+Plus', 'win32')).toBe('Ctrl++');
    expect(menuKeyText('Alt+Left', 'win32')).toBe('Alt+←');
    expect(menuKeyText('Shift+R', 'linux')).toBe('Shift+R');
    expect(menuKeyText('Delete', 'win32')).toBe('Del');
    expect(menuKeyText('?', 'win32')).toBe('?');
    expect(menuKeyText('CommandOrControl+Shift+Z', 'win32')).toBe('Ctrl+Shift+Z');
  });

  it('and in the app\'s language, as German Windows writes them', () => {
    expect(menuKeyText('CmdOrCtrl+Shift+R', 'win32', 'de')).toBe('Strg+Umschalt+R');
    expect(menuKeyText('Delete', 'win32', 'de')).toBe('Entf');
    expect(menuKeyText('CmdOrCtrl+Enter', 'linux', 'de')).toBe('Strg+Eingabe');
    expect(menuKeyText('Alt+Left', 'win32', 'de')).toBe('Alt+←');
    expect(menuKeyText('Delete', 'win32', 'fr')).toBe('Suppr');
  });
});

describe('the window controls over the app', () => {
  const overlayAt = (x: number, width: number, height = 56) => {
    const fake = Object.assign(new EventTarget(), { visible: true, getTitlebarAreaRect: () => ({ x, y: 0, width, height }) });
    installOverlay(fake as never);
    return fake;
  };

  it('the root layout has no messages: the host there reads none, and the bar sits below', () => {
    const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
    expect(read('components/layout/window-controls-host.tsx')).not.toContain('next-intl');
    expect(read('app/(main)/layout.tsx')).toContain('<WindowControlsHost />');
    expect(read('app/(main)/layout.tsx')).not.toContain('<WindowMenuBar');
    for (const layout of ['app/(main)/[locale]/layout.tsx', 'app/(main)/admin/layout.tsx']) expect(read(layout)).toContain('<WindowMenuBar />');
  });

  it('does nothing without the API', () => {
    installOverlay(undefined);
    render(<WindowControlsHost />);
    expect(root.hasAttribute(CONTROLS_ATTRIBUTE)).toBe(false);
    expect(rightInset()).toBe('');
    expect(readTitlebarArea()).toBeNull();
  });

  it('does nothing when the overlay is there but hidden', () => {
    installOverlay(Object.assign(new EventTarget(), { visible: false, getTitlebarAreaRect: () => ({ x: 0, y: 0, width: 800, height: 56 }) }) as never);
    render(<WindowControlsHost />);
    expect(root.hasAttribute(CONTROLS_ATTRIBUTE)).toBe(false);
  });

  it('draws no row of its own: no title, no strip, nothing on the page at all', () => {
    overlayAt(0, window.innerWidth - 138);
    document.title = 'A subject - Bulwark';
    const { container } = render(<WindowControlsHost />);
    expect(container.innerHTML).toBe('');
    expect(document.body.textContent).not.toContain('A subject');
  });

  it('says how much room the controls take, on the right', () => {
    overlayAt(0, window.innerWidth - 138);
    render(<WindowControlsHost />);
    expect(root.hasAttribute(CONTROLS_ATTRIBUTE)).toBe(true);
    expect(rightInset()).toBe('138px');
    expect(root.style.getPropertyValue(TITLEBAR_ROW_VAR)).toBe('56px');
    expect(root.hasAttribute(CONTROLS_LEFT_ATTRIBUTE)).toBe(false);
  });

  it('and on the left, on macOS', () => {
    overlayAt(78, window.innerWidth - 78);
    render(<WindowControlsHost />);
    expect(rightInset()).toBe('0px');
    expect(root.hasAttribute(CONTROLS_LEFT_ATTRIBUTE)).toBe(true);
  });

  // mail-p2-16: the desktop app sends geometrychange while the page still has
  // its old width; the controls' share came out of that and stayed wrong.
  it('measures again with the new width once the window has resized', () => {
    const before = window.innerWidth;
    const fake = overlayAt(0, before - 137);
    render(<WindowControlsHost />);
    expect(rightInset()).toBe('137px');
    act(() => {
      (fake as unknown as { getTitlebarAreaRect: () => object }).getTitlebarAreaRect = () => ({ x: 0, y: 0, width: 800 - 137, height: 56 });
      fake.dispatchEvent(new Event('geometrychange'));
    });
    act(() => {
      Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true, writable: true });
      window.dispatchEvent(new Event('resize'));
    });
    try {
      expect(rightInset()).toBe('137px');
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: before, configurable: true, writable: true });
    }
  });

  it('follows geometrychange, and takes everything back when the overlay goes', () => {
    const fake = overlayAt(0, window.innerWidth - 138);
    render(<WindowControlsHost />);
    act(() => {
      (fake as unknown as { getTitlebarAreaRect: () => object }).getTitlebarAreaRect = () => ({ x: 0, y: 0, width: window.innerWidth - 100, height: 56 });
      fake.dispatchEvent(new Event('geometrychange'));
    });
    expect(rightInset()).toBe('100px');
    act(() => {
      (fake as unknown as { visible: boolean }).visible = false;
      fake.dispatchEvent(new Event('geometrychange'));
    });
    expect(root.hasAttribute(CONTROLS_ATTRIBUTE)).toBe(false);
    expect(rightInset()).toBe('');
  });

  describe('when the window changes size in one step', () => {
    const startWidth = window.innerWidth;
    const setWidth = (width: number) => Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
    afterEach(() => setWidth(startWidth));

    // As Chromium does it: geometrychange with the new rect while the page still has
    // its old width, then the page takes the new width and fires resize.
    const resizeTo = (fake: EventTarget, width: number) => act(() => {
      (fake as unknown as { getTitlebarAreaRect: () => object }).getTitlebarAreaRect = () => ({ x: 0, y: 0, width: width - 137, height: 56 });
      fake.dispatchEvent(new Event('geometrychange'));
      setWidth(width);
      window.dispatchEvent(new Event('resize'));
    });

    it('keeps the room for the controls after a maximise, a restore, a snap and a shrink', () => {
      setWidth(1366);
      const fake = overlayAt(0, 1366 - 137);
      render(<WindowControlsHost />);
      expect(rightInset()).toBe('137px');
      for (const width of [2048, 1366, 1024, 640, 1920]) {
        resizeTo(fake, width);
        expect(rightInset(), `at ${width} px`).toBe('137px');
      }
    });
  });

  // A drawer from the window's edge started under the controls' row on both sides,
  // so the rail's top icon showed above it, dimmed (usability test 2026-11-04).
  describe("a drawer from the window's edge", () => {
    const startWidth = window.innerWidth;
    const setWidth = (width: number) => Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
    afterEach(() => setWidth(startWidth));

    it('Windows and Linux: from the left it runs from the top, from the right it starts below the controls', () => {
      overlayAt(0, window.innerWidth - 138);
      render(<WindowControlsHost />);
      expect(root.hasAttribute(DRAWER_LEFT_ATTRIBUTE)).toBe(false);
      expect(root.getAttribute(DRAWER_RIGHT_ATTRIBUTE)).toBe('below');
    });

    it('macOS: from the left it runs from the top with its content below the traffic lights, from the right it runs from the top', () => {
      overlayAt(78, window.innerWidth - 78);
      render(<WindowControlsHost />);
      expect(root.getAttribute(DRAWER_LEFT_ATTRIBUTE)).toBe('inset');
      expect(root.hasAttribute(DRAWER_RIGHT_ATTRIBUTE)).toBe(false);
    });

    it('follows the window: too narrow for the drawer and the controls side by side, the left one goes below too, and back', () => {
      setWidth(1000);
      const fake = overlayAt(0, 1000 - 138);
      render(<WindowControlsHost />);
      expect(root.hasAttribute(DRAWER_LEFT_ATTRIBUTE)).toBe(false);
      const resizeTo = (width: number) => act(() => {
        (fake as unknown as { getTitlebarAreaRect: () => object }).getTitlebarAreaRect = () => ({ x: 0, y: 0, width: width - 138, height: 56 });
        fake.dispatchEvent(new Event('geometrychange'));
        setWidth(width);
        window.dispatchEvent(new Event('resize'));
      });
      // 85 % of 400 is 340, wider than 288; 400 - 138 = 262 leaves less than that.
      resizeTo(400);
      expect(root.getAttribute(DRAWER_LEFT_ATTRIBUTE)).toBe('below');
      resizeTo(1000);
      expect(root.hasAttribute(DRAWER_LEFT_ATTRIBUTE)).toBe(false);
    });

    it('the overlay going takes the marks with it', () => {
      const fake = overlayAt(0, window.innerWidth - 138);
      render(<WindowControlsHost />);
      act(() => {
        (fake as unknown as { visible: boolean }).visible = false;
        fake.dispatchEvent(new Event('geometrychange'));
      });
      expect(root.hasAttribute(DRAWER_RIGHT_ATTRIBUTE)).toBe(false);
    });

    it('the stylesheet: from the top with a band to drag by, below where marked, and the content inset under the traffic lights', () => {
      const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');
      const rule = (selector: string) => {
        const at = css.indexOf(`${selector} {`);
        expect(at, selector).toBeGreaterThan(-1);
        return css.slice(at, css.indexOf('}', at));
      };
      expect(rule('html[data-window-controls]:not([data-menu-bar])')).toMatch(/--drawer-top:\s*var\(--app-top-inset\);\s*--drawer-band:\s*var\(--titlebar-row-height\)/);
      const below = rule('html[data-window-controls]:not([data-menu-bar])[dir="rtl"][data-right-drawer="below"]');
      expect(css).toContain('html[data-window-controls]:not([data-menu-bar]):not([dir="rtl"])[data-left-drawer="below"],');
      expect(below).toMatch(/--drawer-top:\s*max\(var\(--app-top-inset\), var\(--titlebar-row-height\)\);\s*--drawer-band:\s*0px/);
      expect(css).toContain('html[data-window-controls]:not([data-menu-bar]):not([dir="rtl"])[data-left-drawer="inset"],');
      expect(rule('html[data-window-controls]:not([data-menu-bar])[dir="rtl"][data-right-drawer="inset"]')).toMatch(/--drawer-inset:\s*var\(--titlebar-row-height\)/);
      expect(rule('html[data-window-controls] [data-window-drawer]')).toMatch(/padding-top:\s*var\(--drawer-inset, 0px\)/);
      const band = rule('html[data-window-controls] [data-window-drawer]::before');
      expect(band).toMatch(/height:\s*var\(--drawer-band, 0px\)/);
      expect(band).toMatch(/pointer-events:\s*none/);
      expect(band).toMatch(/-webkit-app-region:\s*drag/);
    });
  });
});

describe('which rows hold the controls', () => {
  const W = window.innerWidth;
  const AREA = { x: 0, y: 0, width: W - 138, height: 56 };
  const row = (className: string, rect: { left: number; right: number; top?: number; height?: number }, parent: HTMLElement = document.body, attrs: Record<string, string> = {}) => {
    const el = document.createElement('div');
    el.className = className;
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    const top = rect.top ?? 0;
    const height = rect.height ?? 56;
    el.getBoundingClientRect = () => ({ left: rect.left, right: rect.right, top, bottom: top + height, width: rect.right - rect.left, height, x: rect.left, y: top, toJSON: () => ({}) });
    parent.appendChild(el);
    return el;
  };

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('three panes: all are rows to drag by, and only the reader\'s toolbar makes room', () => {
    const sidebar = row('h-14', { left: 56, right: 300 });
    const list = row('h-14', { left: 300, right: 700 });
    const reader = row('h-14', { left: 700, right: W });
    markWindowRows(AREA);
    for (const el of [sidebar, list, reader]) expect(el.hasAttribute(ROW_ATTRIBUTE)).toBe(true);
    expect(sidebar.hasAttribute(ROW_RIGHT_ATTRIBUTE)).toBe(false);
    expect(list.hasAttribute(ROW_RIGHT_ATTRIBUTE)).toBe(false);
    expect(reader.hasAttribute(ROW_RIGHT_ATTRIBUTE)).toBe(true);
  });

  it('with no reader, the list\'s header is the one', () => {
    const list = row('h-14', { left: 300, right: W });
    markWindowRows(AREA);
    expect(list.hasAttribute(ROW_RIGHT_ATTRIBUTE)).toBe(true);
  });

  it('a row further down is no row of the window\'s', () => {
    const lower = row('h-14', { left: 0, right: W, top: 100 });
    markWindowRows(AREA);
    expect(lower.hasAttribute(ROW_ATTRIBUTE)).toBe(false);
    expect(lower.hasAttribute(ROW_RIGHT_ATTRIBUTE)).toBe(false);
  });

  it('a tall box at the top is a pane, unless it says otherwise', () => {
    const pane = row('h-14', { left: 0, right: W, height: 600 });
    const header = row('', { left: 0, right: W, height: 72 }, document.body, { 'data-window-top-row': '' });
    markWindowRows(AREA);
    expect(pane.hasAttribute(ROW_ATTRIBUTE)).toBe(false);
    expect(header.hasAttribute(ROW_RIGHT_ATTRIBUTE)).toBe(true);
  });

  it('the outermost box of a row takes it, not one inside it too', () => {
    const outer = row('h-14', { left: 0, right: W });
    const inner = row('h-14', { left: 0, right: W }, outer);
    markWindowRows(AREA);
    expect(outer.hasAttribute(ROW_RIGHT_ATTRIBUTE)).toBe(true);
    expect(inner.hasAttribute(ROW_RIGHT_ATTRIBUTE)).toBe(false);
  });

  it('macOS: the row under the traffic lights makes room on the left', () => {
    const sidebar = row('h-14', { left: 56, right: 300 });
    const list = row('h-14', { left: 300, right: W });
    markWindowRows({ x: 78, y: 0, width: W - 78, height: 56 });
    expect(sidebar.hasAttribute(ROW_LEFT_ATTRIBUTE)).toBe(true);
    expect(list.hasAttribute(ROW_LEFT_ATTRIBUTE)).toBe(false);
    expect(list.hasAttribute(ROW_RIGHT_ATTRIBUTE)).toBe(false);
  });

  it('a mark goes when the row no longer lies there', () => {
    const reader = row('h-14', { left: 700, right: W });
    markWindowRows(AREA);
    expect(reader.hasAttribute(ROW_RIGHT_ATTRIBUTE)).toBe(true);
    reader.getBoundingClientRect = () => ({ left: 500, right: 800, top: 0, bottom: 56, width: 300, height: 56, x: 700, y: 0, toJSON: () => ({}) });
    markWindowRows(AREA);
    expect(reader.hasAttribute(ROW_RIGHT_ATTRIBUTE)).toBe(false);
  });

  it('a pane that finishes changing width, with nothing else changing, is noticed', async () => {
    const list = row('h-14', { left: 300, right: 700 });
    const stop = watchWindowRows(AREA);
    expect(list.hasAttribute(ROW_RIGHT_ATTRIBUTE)).toBe(false);
    list.getBoundingClientRect = () => ({ left: 300, right: W, top: 0, bottom: 56, width: W - 300, height: 56, x: 300, y: 0, toJSON: () => ({}) });
    document.body.dispatchEvent(new Event('transitionend', { bubbles: true }));
    await Promise.resolve();
    expect(list.hasAttribute(ROW_RIGHT_ATTRIBUTE)).toBe(true);
    stop();
  });

  it('a row that appears is marked before the next paint', async () => {
    const stop = watchWindowRows(AREA);
    const dialogRow = row('h-12', { left: 0, right: W });
    // A mutation callback, then a microtask: both ahead of any paint.
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dialogRow.hasAttribute(ROW_RIGHT_ATTRIBUTE)).toBe(true);
    stop();
  });
});

describe('the page roots and the stylesheet', () => {
  const root = process.cwd();
  const css = readFileSync(join(root, 'app/globals.css'), 'utf8');

  it('keeps no row: the inset is 0, and the page roots are on the safe area alone', () => {
    expect(css).toMatch(/--titlebar-inset:\s*0px/);
    expect(css).toMatch(/--app-top-inset:\s*env\(safe-area-inset-top, 0px\)/);
    expect(css).not.toMatch(/--titlebar-inset:\s*env/);
  });

  it('takes the room from env(), so it holds from the first paint', () => {
    expect(css).toContain('--titlebar-right-inset: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))');
    expect(css).toContain('--titlebar-left-inset: env(titlebar-area-x, 0px)');
  });

  it('does not key on the display-mode media query, which is false in Electron', () => {
    expect(css).not.toMatch(/display-mode:\s*window-controls-overlay/);
  });

  it('drags by the app\'s own rows, and leaves what\'s clickable alone', () => {
    expect(css).toMatch(/:is\(\[data-window-row\], \[data-window-rail\]\) \{\s*app-region: drag;/);
    expect(css).toMatch(/\[contenteditable="true"\][\s\S]*?app-region: no-drag;/);
    expect(css).not.toContain('.window-title-bar');
  });

  function tsxFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === '__tests__' || name === 'node_modules') return [];
      return statSync(path).isDirectory() ? tsxFiles(path) : name.endsWith('.tsx') ? [path] : [];
    });
  }

  it('leaves no page root or top bar on the bare safe area, skeletons included', () => {
    const left = [...tsxFiles(join(root, 'components')), ...tsxFiles(join(root, 'app'))]
      .filter((path) => /pt-\[(?:calc\([^\]]*)?env\(safe-area-inset-top/.test(readFileSync(path, 'utf8')));
    expect(left).toEqual([]);
  });

  it('gives each skeleton the same top inset as the page it stands in for', () => {
    for (const file of ['components/boot-skeleton/shell.tsx', 'components/boot-skeleton/pro-skeleton.tsx', 'components/boot-skeleton/admin-skeleton.tsx', 'components/mail/mail-app.tsx']) {
      expect(readFileSync(join(root, file), 'utf8'), file).toContain('pt-[var(--app-top-inset)]');
    }
  });
});
