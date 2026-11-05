import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

// The page-wide hosts the first screen doesn't need come as chunks of their
// own: the desktop app's only in the desktop app, the others once the page
// has drawn and gone idle. Each mock below counts the loads of its module.
const loaded = vi.hoisted(() => [] as string[]);
vi.mock('@/components/desktop/desktop-host', () => { loaded.push('desktop'); return { DesktopHost: () => <p>desktop host</p> }; });
vi.mock('@/components/mail-transfer/mail-transfer-host', () => { loaded.push('transfer'); return { MailTransferHost: () => <p>transfer host</p> }; });
vi.mock('@/components/offline/offline-host', () => { loaded.push('offline'); return { OfflineHost: () => <p>offline host</p> }; });
// A host that fails once it runs, as the files sync host did with the demo's client.
vi.mock('@/components/popout/popout-host', async () => {
  const { useEffect } = await import('react');
  return { PopoutHost: () => { useEffect(() => { throw new TypeError('t.getSessionSnapshot is not a function'); }, []); return <p>popout host</p>; } };
});
vi.mock('@/components/desktop/desktop-os-host', () => ({ DesktopOsHost: () => { throw new Error('broken while drawing'); } }));

const idle: (() => void)[] = [];
vi.stubGlobal('requestIdleCallback', (callback: () => void) => { idle.push(callback); return idle.length; });

const { DeferredDesktopHost, DeferredDesktopOsHost, DeferredMailTransferHost, DeferredOfflineHost, DeferredPopoutHost } = await import('../deferred-hosts');
const { useOfflineStore } = await import('@/lib/offline/state');

afterEach(() => {
  delete (window as { bulwarkDesktop?: unknown }).bulwarkDesktop;
});

describe('deferred hosts', () => {
  it('never loads a desktop host in a browser', async () => {
    const { container } = render(<DeferredDesktopHost />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.textContent).toBe('');
    expect(loaded).not.toContain('desktop');
  });

  it('loads it in the desktop app', async () => {
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1 };
    render(<DeferredDesktopHost />);
    expect(await screen.findByText('desktop host')).toBeTruthy();
    expect(loaded).toContain('desktop');
  });

  it('loads a background host once the page is idle, not before', async () => {
    render(<DeferredMailTransferHost />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(loaded).not.toContain('transfer');
    expect(screen.queryByText('transfer host')).toBeNull();
    act(() => { for (const callback of idle.splice(0)) callback(); });
    expect(await screen.findByText('transfer host')).toBeTruthy();
  });

  it('loads offline mode only once it is in use here', async () => {
    vi.stubGlobal('indexedDB', { databases: async () => [] });
    useOfflineStore.setState({ enabled: [], choices: {}, health: {} });
    render(<DeferredOfflineHost />);
    act(() => { for (const callback of idle.splice(0)) callback(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(loaded).not.toContain('offline');
    // Turned on for an account, in this tab or another.
    act(() => { useOfflineStore.setState({ enabled: ['acc'] }); });
    expect(await screen.findByText('offline host')).toBeTruthy();
    expect(loaded).toContain('offline');
  });

  it('keeps the app on screen when a background host fails in an effect', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<main><p>Inbox</p><DeferredPopoutHost /></main>);
    act(() => { for (const callback of idle.splice(0)) callback(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(screen.getByText('Inbox')).toBeTruthy();
    // The host is gone, and the log says which one.
    expect(screen.queryByText('popout host')).toBeNull();
    expect(errors.mock.calls.some((call) => call.some((arg) => typeof arg === 'string' && arg.includes('[PopoutHost]')))).toBe(true);
    errors.mockRestore();
  });

  it('keeps the app on screen when a desktop host fails while drawing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1 };
    render(<main><p>Inbox</p><DeferredDesktopOsHost /></main>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(screen.getByText('Inbox')).toBeTruthy();
    errors.mockRestore();
  });
});
