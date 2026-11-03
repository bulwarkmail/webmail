import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WindowControlsHost } from '@/components/layout/window-controls-host';
import { WindowMenuBar } from '@/components/layout/window-menu-bar';
import { CONTROLS_ATTRIBUTE, CONTROLS_LEFT_ATTRIBUTE, ROW_ATTRIBUTE, ROW_LEFT_ATTRIBUTE, ROW_RIGHT_ATTRIBUTE, TITLEBAR_RIGHT_VAR, TITLEBAR_ROW_VAR, markWindowRows, readTitlebarArea, watchWindowRows } from '@/lib/window-controls-overlay';

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
});

describe('the menu strip in the desktop app', () => {
  type BarEvent = { visible: boolean; open?: string };

  function withBar() {
    let send: (event: BarEvent) => void = () => {};
    const open = vi.fn();
    window.bulwarkDesktop = {
      version: 1,
      platform: 'win32',
      menu: {
        setState: () => {},
        bar: {
          entries: async () => [{ id: 'file', label: 'File', mnemonic: 'f' }, { id: 'edit', label: 'Edit', mnemonic: 'e' }],
          open,
          onEvent: (listener: (event: BarEvent) => void) => {
            send = listener;
            return () => {};
          },
        },
      },
    } as never;
    return { open, send: (event: BarEvent) => send(event) };
  }

  afterEach(() => {
    window.bulwarkDesktop = undefined;
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

  it('Alt shows the names with the focus on the first, and Escape gives it back', async () => {
    overlayOn();
    const bar = withBar();
    const before = document.createElement('button');
    document.body.appendChild(before);
    before.focus();
    render(<WindowMenuBar />);
    await act(async () => bar.send({ visible: true }));
    const file = await screen.findByRole('menuitem', { name: 'File' });
    await waitFor(() => expect(document.activeElement).toBe(file));
    fireEvent.keyDown(file, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Edit' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menubar')).toBeNull();
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it('a name opens that menu natively', async () => {
    overlayOn();
    const bar = withBar();
    render(<WindowMenuBar />);
    await act(async () => bar.send({ visible: true }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    expect(bar.open).toHaveBeenCalledWith('edit', expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
  });

  it('Alt and a letter opens that one right away', async () => {
    overlayOn();
    const bar = withBar();
    render(<WindowMenuBar />);
    await act(async () => bar.send({ visible: true, open: 'file' }));
    await waitFor(() => expect(bar.open).toHaveBeenCalledWith('file', expect.anything()));
  });

  it('the shell can take it away again', async () => {
    overlayOn();
    const bar = withBar();
    render(<WindowMenuBar />);
    await act(async () => bar.send({ visible: true }));
    await screen.findByRole('menubar');
    await act(async () => bar.send({ visible: false }));
    expect(screen.queryByRole('menubar')).toBeNull();
  });

  it('with no bridge there is none, and the title stays', async () => {
    overlayOn();
    render(<WindowMenuBar />);
    expect(screen.queryByRole('menubar')).toBeNull();
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
