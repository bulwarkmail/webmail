import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RecurrenceScopeDialog } from '@/components/calendar/recurrence-scope-dialog';
import { SessionTimeoutDialog } from '@/components/session/session-timeout-dialog';
import { FilePickerDialog } from '@/components/files/file-picker-dialog';
import type { BulwarkDesktopBridge } from '@/lib/desktop/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Modals that draw their own overlay instead of using Dialog go into a window of their
// own in the desktop app too (ModalWindow): the overlay keeps its markup, its backdrop
// turns transparent there, and its focus trap, keys and handlers keep working.

interface FakeWindow {
  name: string;
  document: Document;
  devicePixelRatio: number;
  close: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, listener: () => void) => void;
  fire: (type: string) => void;
}

let opened: FakeWindow[] = [];

function fakeWindow(name: string): FakeWindow {
  const frame = document.createElement('iframe');
  frame.setAttribute('data-fake-window', '');
  document.body.appendChild(frame);
  const listeners: Record<string, (() => void)[]> = {};
  return {
    name,
    document: frame.contentDocument!,
    devicePixelRatio: 1,
    close: vi.fn(),
    open: vi.fn(),
    addEventListener: (type, listener) => {
      (listeners[type] ??= []).push(listener);
    },
    fire: (type) => listeners[type]?.forEach((listener) => listener()),
  };
}

function desktop() {
  opened = [];
  window.bulwarkDesktop = { version: 1, platform: 'win32', dialogs: { confirm: vi.fn(), showWindow: vi.fn(async () => true) } } as unknown as BulwarkDesktopBridge;
  vi.spyOn(window, 'open').mockImplementation(((_url: string, name: string) => {
    const win = fakeWindow(name);
    opened.push(win);
    return win as unknown as Window;
  }) as typeof window.open);
}

afterEach(() => {
  window.bulwarkDesktop = undefined;
  vi.restoreAllMocks();
  document.querySelectorAll('[data-fake-window]').forEach((node) => node.remove());
});

describe('modals with their own overlay, in the desktop app', () => {
  it('the recurrence question opens in a window, holds the focus there and answers from there', async () => {
    desktop();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<RecurrenceScopeDialog isOpen actionType="delete" eventTitle="Yoga" onSelect={onSelect} onClose={onClose} />);
    expect(opened).toHaveLength(1);
    const doc = opened[0].document;
    expect(screen.queryByRole('dialog')).toBeNull();
    const dialog = doc.querySelector('[role="dialog"]')!;
    expect(dialog).toBeTruthy();
    // The backdrop is marked, so the window shows it transparent.
    expect(doc.querySelector('[data-modal-backdrop]')?.contains(dialog)).toBe(true);
    // The focus trap started in the window's document once the dialog was there.
    await waitFor(() => expect(dialog.contains(doc.activeElement)).toBe(true));

    fireEvent.keyDown(doc.activeElement!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    const deleteButton = [...doc.querySelectorAll('button')].find((b) => /delete/.test(b.textContent ?? ''))!;
    fireEvent.click(deleteButton);
    expect(onSelect).toHaveBeenCalledWith('this');
  });

  it('a modal that can\'t be closed just now comes back over the page when its window is closed', async () => {
    desktop();
    const noop = () => {};
    render(<SessionTimeoutDialog mode="ending" deadline={Date.now() + 30_000} onStay={noop} onDismiss={noop} onSignOut={noop} />);
    expect(opened).toHaveLength(1);
    expect(opened[0].document.querySelector('[data-testid="session-timeout-dialog"]')).toBeTruthy();
    expect(screen.queryByTestId('session-timeout-dialog')).toBeNull();
    act(() => opened[0].fire('pagehide'));
    expect(await screen.findByTestId('session-timeout-dialog')).toBeTruthy();
  });

  it('the Files picker opens in a window and closes with Escape there', async () => {
    desktop();
    const onClose = vi.fn();
    const client = { listAllFileNodesAcrossAccounts: vi.fn(() => new Promise(() => {})) } as unknown as IJMAPClient;
    render(<FilePickerDialog client={client} onClose={onClose} onPick={vi.fn()} />);
    const doc = opened[0].document;
    const dialog = doc.querySelector('[role="dialog"]')!;
    expect(dialog).toBeTruthy();
    await waitFor(() => expect(dialog.contains(doc.activeElement) || doc.activeElement === dialog).toBe(true));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('stays over the page without the shell\'s windows', () => {
    render(<RecurrenceScopeDialog isOpen actionType="edit" onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
