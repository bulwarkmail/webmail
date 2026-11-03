import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulwarkDesktopBridge } from '@/lib/desktop/types';
import { registerDesktopSurface, resetDesktopCommands } from '@/lib/desktop/commands';
import { resetDesktopPrefsCache, setDesktopPref } from '@/lib/desktop/preferences';
import { useAuthStore } from '@/stores/auth-store';
import { useLocaleStore } from '@/stores/locale-store';
import { useOfflineStore } from '@/lib/offline/state';

const push = vi.fn();
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push }) }));

const canPrint = vi.fn(() => true);
const canDownload = vi.fn(() => true);
vi.mock('@/lib/device-policy', () => ({ canPrintAnywhere: () => canPrint(), canDownloadAnywhere: () => canDownload() }));

const { DesktopHost } = await import('../desktop-host');

function fakeBridge() {
  let command: ((id: string) => void) | null = null;
  let flush: (() => Promise<unknown>) | null = null;
  const parts = {
    setState: vi.fn(),
    setLanguages: vi.fn(),
    sessionReady: vi.fn(),
    setRestoreEnabled: vi.fn(),
    setTheme: vi.fn(),
  };
  const bridge = {
    version: 1,
    platform: 'win32',
    menu: { setState: parts.setState, onCommand: (listener: (id: string) => void) => { command = listener; return () => {}; } },
    shell: { openExternal: () => {}, setLanguages: parts.setLanguages },
    windows: { sessionReady: parts.sessionReady, setRestoreEnabled: parts.setRestoreEnabled },
    theme: { set: parts.setTheme, system: async () => ({ dark: false, highContrast: false }) },
    lifecycle: { onFlushRequest: (handler: () => Promise<unknown>) => { flush = handler; return () => {}; } },
  };
  window.bulwarkDesktop = bridge as unknown as BulwarkDesktopBridge;
  return { ...parts, run: (id: string) => act(() => command!(id)), flush: () => flush!() };
}

const original = useAuthStore.getState();

beforeEach(() => {
  push.mockClear();
  canPrint.mockReturnValue(true);
  canDownload.mockReturnValue(true);
  localStorage.clear();
  resetDesktopPrefsCache();
  useAuthStore.setState({ isAuthenticated: true, getAllConnectedClients: () => new Map() } as never);
});

afterEach(() => {
  cleanup();
  window.bulwarkDesktop = undefined;
  resetDesktopCommands();
  useAuthStore.setState(original);
  window.history.replaceState(null, '', '/');
});

describe('DesktopHost', () => {
  it('does nothing in a browser', () => {
    expect(() => render(<DesktopHost />)).not.toThrow();
  });

  it('runs a command from what\'s on the page first', () => {
    const shell = fakeBridge();
    render(<DesktopHost />);
    const onPage = vi.fn();
    registerDesktopSurface({ handlers: { 'go.inbox': onPage }, state: {} });
    shell.run('go.inbox');
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it('with nothing there, the commands that work anywhere still do', () => {
    const shell = fakeBridge();
    render(<DesktopHost />);
    shell.run('go.calendar');
    expect(push).toHaveBeenLastCalledWith('/calendar');
    shell.run('go.contacts');
    expect(push).toHaveBeenLastCalledWith('/contacts');
  });

  it('a link to a folder goes through the router, encoded', () => {
    const shell = fakeBridge();
    render(<DesktopHost />);
    shell.run('link.folder:sent');
    expect(push).toHaveBeenLastCalledWith('/mail/folder/sent');
  });

  it('an unknown command does nothing', () => {
    const shell = fakeBridge();
    render(<DesktopHost />);
    expect(() => shell.run('nonsense')).not.toThrow();
    expect(push).not.toHaveBeenCalled();
  });

  it('tells the shell what the organisation allows', async () => {
    canPrint.mockReturnValue(false);
    canDownload.mockReturnValue(false);
    const shell = fakeBridge();
    render(<DesktopHost />);
    await waitFor(() => expect(shell.setState).toHaveBeenCalled());
    expect(shell.setState.mock.lastCall![0]).toMatchObject({ 'file.print': false, 'file.savePdf': false, 'policy.download': false });
  });

  it('signed in: it says so once, for windows from last time and waiting links', async () => {
    const shell = fakeBridge();
    render(<DesktopHost />);
    await waitFor(() => expect(shell.sessionReady).toHaveBeenCalledTimes(1));
  });

  it('not signed in, or in a pop-out with a borrowed session: it doesn\'t', async () => {
    const shell = fakeBridge();
    useAuthStore.setState({ isAuthenticated: false } as never);
    const first = render(<DesktopHost />);
    await act(async () => {});
    expect(shell.sessionReady).not.toHaveBeenCalled();
    first.unmount();
    useAuthStore.setState({ isAuthenticated: true } as never);
    window.history.replaceState(null, '', '/popout/compose');
    render(<DesktopHost />);
    await act(async () => {});
    expect(shell.sessionReady).not.toHaveBeenCalled();
  });

  it('passes the restore setting on', async () => {
    const shell = fakeBridge();
    render(<DesktopHost />);
    await waitFor(() => expect(shell.setRestoreEnabled).toHaveBeenLastCalledWith(true));
    act(() => setDesktopPref('restoreWindows', false));
    await waitFor(() => expect(shell.setRestoreEnabled).toHaveBeenLastCalledWith(false));
  });

  it('says which languages are in use', async () => {
    const shell = fakeBridge();
    act(() => useLocaleStore.setState({ locale: 'de' }));
    render(<DesktopHost />);
    await waitFor(() => expect(shell.setLanguages).toHaveBeenCalled());
    expect(shell.setLanguages.mock.lastCall![0]).toMatchObject({ ui: 'de' });
  });

  it('a quit is told how much mail is waiting', async () => {
    const shell = fakeBridge();
    render(<DesktopHost />);
    act(() => useOfflineStore.setState({ outbox: [{ id: 1 }, { id: 2 }] } as never));
    await expect(shell.flush()).resolves.toEqual({ unsent: 2 });
    act(() => useOfflineStore.setState({ outbox: [] } as never));
  });
});
