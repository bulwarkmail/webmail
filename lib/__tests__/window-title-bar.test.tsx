import { act, cleanup, render } from '@testing-library/react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
