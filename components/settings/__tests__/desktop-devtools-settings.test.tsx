import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BulwarkDesktopBridge, DesktopDevToolsState } from '@/lib/desktop/types';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
}));

const { DesktopDevToolsSettings } = await import('../desktop-devtools-settings');

function setBridge(state: DesktopDevToolsState | null, platform: 'win32' | 'darwin' = 'win32') {
  const listeners = new Set<(next: DesktopDevToolsState) => void>();
  const set = vi.fn(async (on: boolean) => ({ ...state!, on }));
  window.bulwarkDesktop = (state
    ? {
      version: 1,
      platform,
      devTools: {
        get: async () => state,
        set,
        onChange: (listener: (next: DesktopDevToolsState) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    }
    : { version: 1, platform }) as unknown as BulwarkDesktopBridge;
  return { set, emit: (next: DesktopDevToolsState) => listeners.forEach((listener) => listener(next)) };
}

afterEach(() => {
  window.bulwarkDesktop = undefined;
});

describe('the developer tools setting', () => {
  it('is not there in a browser or on a shell without it', () => {
    const { container } = render(<DesktopDevToolsSettings />);
    expect(container.innerHTML).toBe('');
    setBridge(null);
    const second = render(<DesktopDevToolsSettings />);
    expect(second.container.innerHTML).toBe('');
  });

  it('is off by default, names the shortcut, and asks main to turn it on', async () => {
    const { set } = setBridge({ on: false, forcedOff: false, locked: false });
    render(<DesktopDevToolsSettings />);
    const toggle = await screen.findByTestId('desktop-devtools-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('label:{"shortcut":"Ctrl+Shift+I"}')).toBeTruthy();
    fireEvent.click(toggle);
    expect(set).toHaveBeenCalledWith(true);
  });

  it('a Mac names its own keys', async () => {
    setBridge({ on: false, forcedOff: false, locked: false }, 'darwin');
    render(<DesktopDevToolsSettings />);
    expect(await screen.findByText('label:{"shortcut":"Cmd+Option+I"}')).toBeTruthy();
  });

  it('a policy locks it off, and the app lock stops changes', async () => {
    const { emit } = setBridge({ on: false, forcedOff: true, locked: false });
    render(<DesktopDevToolsSettings />);
    const toggle = await screen.findByTestId('desktop-devtools-toggle');
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('forced_off')).toBeTruthy();
    act(() => emit({ on: false, forcedOff: false, locked: true }));
    expect(screen.getByText('locked')).toBeTruthy();
    expect(screen.getByTestId('desktop-devtools-toggle').hasAttribute('disabled')).toBe(true);
  });
});
