import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WindowTitleBar } from '@/components/layout/window-title-bar';
import { TITLEBAR_INSET_VAR, readTitlebarArea } from '@/lib/window-controls-overlay';

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

const inset = () => document.documentElement.style.getPropertyValue(TITLEBAR_INSET_VAR);
const strip = () => document.querySelector<HTMLElement>('[data-window-title-bar]');

afterEach(() => {
  cleanup();
  installOverlay(undefined);
  document.documentElement.style.removeProperty(TITLEBAR_INSET_VAR);
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
    render(<WindowTitleBar />);
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
    render(<WindowTitleBar />);
    await act(async () => bar.send({ visible: true }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    expect(bar.open).toHaveBeenCalledWith('edit', expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
  });

  it('Alt and a letter opens that one right away', async () => {
    overlayOn();
    const bar = withBar();
    render(<WindowTitleBar />);
    await act(async () => bar.send({ visible: true, open: 'file' }));
    await waitFor(() => expect(bar.open).toHaveBeenCalledWith('file', expect.anything()));
  });

  it('the shell can take it away again', async () => {
    overlayOn();
    const bar = withBar();
    render(<WindowTitleBar />);
    await act(async () => bar.send({ visible: true }));
    await screen.findByRole('menubar');
    await act(async () => bar.send({ visible: false }));
    expect(screen.queryByRole('menubar')).toBeNull();
  });

  it('with no bridge there is none, and the title stays', async () => {
    overlayOn();
    render(<WindowTitleBar />);
    expect(screen.queryByRole('menubar')).toBeNull();
  });
});

describe('the title bar', () => {
  it('shows nothing and touches nothing without the API', () => {
    installOverlay(undefined);
    expect(readTitlebarArea()).toBeNull();
    render(<WindowTitleBar />);
    expect(strip()).toBeNull();
    expect(inset()).toBe('');
  });

  it('shows nothing when the overlay is there but hidden', () => {
    const overlay = new FakeOverlay();
    overlay.visible = false;
    installOverlay(overlay);
    render(<WindowTitleBar />);
    expect(strip()).toBeNull();
    expect(inset()).toBe('');
  });

  it('draws the strip next to the controls and pushes the page down', () => {
    installOverlay(new FakeOverlay());
    document.title = 'Inbox - Mail';
    render(<WindowTitleBar />);
    const bar = strip()!;
    expect(bar.style.width).toBe('867px');
    expect(bar.style.height).toBe('40px');
    expect(bar.textContent).toBe('Inbox - Mail');
    expect(bar.classList.contains('window-title-bar')).toBe(true);
    expect(inset()).toBe('40px');
  });

  it('stays out of the accessibility tree and the tab order', () => {
    installOverlay(new FakeOverlay());
    render(<WindowTitleBar />);
    expect(strip()!.getAttribute('aria-hidden')).toBe('true');
    expect(strip()!.querySelector('a, button, input, [tabindex]')).toBeNull();
  });

  it('follows geometrychange, and takes everything back when the overlay goes', () => {
    const overlay = new FakeOverlay();
    installOverlay(overlay);
    render(<WindowTitleBar />);
    act(() => overlay.change({ rect: { x: 72, y: 0, width: 500, height: 32 } }));
    expect(strip()!.style.left).toBe('72px');
    expect(inset()).toBe('32px');
    act(() => overlay.change({ visible: false }));
    expect(strip()).toBeNull();
    expect(inset()).toBe('');
  });

  it('follows the window title as the surface changes it', async () => {
    installOverlay(new FakeOverlay());
    document.title = 'First';
    render(<WindowTitleBar />);
    await act(async () => {
      document.title = 'Second';
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(strip()!.textContent).toBe('Second');
  });
});

describe('the page roots and the stylesheet', () => {
  const root = process.cwd();
  const css = readFileSync(join(root, 'app/globals.css'), 'utf8');

  it('is 0 without an overlay, and exactly the old safe area then', () => {
    expect(css).toContain('--titlebar-inset: env(titlebar-area-height, 0px);');
    expect(css).toContain('--app-top-inset: max(env(safe-area-inset-top), var(--titlebar-inset));');
  });

  it('does not key on the display-mode media query, which is false in Electron', () => {
    expect(css).not.toMatch(/display-mode:\s*window-controls-overlay/);
  });

  it('makes the strip the part that drags the window', () => {
    expect(css).toMatch(/\.window-title-bar\s*\{[^}]*app-region:\s*drag/);
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
