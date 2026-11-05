import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

// The page-wide hosts the first screen doesn't need come as chunks of their
// own: the desktop app's only in the desktop app, the others once the page
// has drawn and gone idle. Each mock below counts the loads of its module.
const loaded = vi.hoisted(() => [] as string[]);
vi.mock('@/components/desktop/desktop-host', () => { loaded.push('desktop'); return { DesktopHost: () => <p>desktop host</p> }; });
vi.mock('@/components/mail-transfer/mail-transfer-host', () => { loaded.push('transfer'); return { MailTransferHost: () => <p>transfer host</p> }; });

const idle: (() => void)[] = [];
vi.stubGlobal('requestIdleCallback', (callback: () => void) => { idle.push(callback); return idle.length; });

const { DeferredDesktopHost, DeferredMailTransferHost } = await import('../deferred-hosts');

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
});
