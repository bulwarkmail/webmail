import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/locales/en/common.json';
import type { FilesRoot } from '@/lib/desktop/types';
import type { FilesSyncController } from '@/lib/files-sync/types';

// The mass-delete question asked wherever the user is (FilesSyncPrompts, mounted
// with the app-wide hosts), and kept away while the settings page asks it itself.

vi.unmock('next-intl');

const { useFilesSyncStore } = await import('@/stores/files-sync-store');
const { FilesSyncPrompts, useInlineMassDeleteQuestions } = await import('../files-sync-prompts');

const ROOT: FilesRoot = {
  id: 'r1', kind: 'folder', account: 'acc', path: 'C:\\Users\\ann\\Projects', remoteId: 'n1', remoteLabel: 'Work / Projects', paused: false, createdAt: 1,
};

function setup(count = 80, deletedOn: 'this-computer' | 'files' = 'this-computer') {
  const controller = { confirmMassDelete: vi.fn(async () => {}) } as unknown as FilesSyncController & { confirmMassDelete: ReturnType<typeof vi.fn> };
  useFilesSyncStore.setState({
    available: true,
    account: 'acc',
    controller,
    roots: [ROOT],
    status: { r1: { rootId: 'r1', state: 'confirm-delete', pending: 0, done: 0, lastSyncedAt: null, massDelete: { count, deletedOn } } },
  });
  return controller;
}

const wrap = (node: React.ReactNode) => <NextIntlClientProvider locale="en" messages={en}>{node}</NextIntlClientProvider>;

afterEach(() => useFilesSyncStore.getState().reset());

describe('the tray line (files-p3-5)', () => {
  it('says the state in a few words, with how many wait', async () => {
    const { trayLineText } = await import('../files-sync-text');
    const t = (key: string, values?: Record<string, string | number>) => {
      const ns = (en as unknown as { files_sync_extra: Record<string, Record<string, string>> }).files_sync_extra;
      const [group, name] = key.split('.');
      return ns[group][name].replace('{count}', String(values?.count ?? ''));
    };
    const status = (state: string, pending = 0) => ({ rootId: 'r', state, pending, done: 0, lastSyncedAt: null }) as never;
    expect(trayLineText(t, status('idle'), 'idle')).toBe('Bulwark Files: Up to date');
    expect(trayLineText(t, status('syncing', 4), 'syncing')).toBe('Bulwark Files: Syncing. To go: 4');
    expect(trayLineText(t, status('offline', 3), 'offline')).toBe('Bulwark Files: Offline. Waiting: 3');
    expect(trayLineText(t, status('paused'), 'paused')).toBe('Bulwark Files: Paused');
    expect(trayLineText(t, status('confirm-delete'), 'confirm-delete')).toBe('Bulwark Files: Needs your answer');
    expect(trayLineText(t, status('error'), 'error')).toBe('Bulwark Files: Error');
  });
});

describe('mass-delete prompt, app-wide', () => {
  it('asks with the count and the side, and deletes on yes', () => {
    const controller = setup(80, 'this-computer');
    render(wrap(<FilesSyncPrompts />));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete 80 items?' });
    expect(dialog).toHaveTextContent('80 items were deleted from Projects on this computer. Delete them in Files too?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete them' }));
    expect(controller.confirmMassDelete).toHaveBeenCalledWith('r1', true);
  });

  it('brings them back on no, naming the Files folder when they went there', () => {
    const controller = setup(51, 'files');
    render(wrap(<FilesSyncPrompts />));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('51 items were deleted from Work / Projects in Files. Delete them on this computer too?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Bring them back' }));
    expect(controller.confirmMassDelete).toHaveBeenCalledWith('r1', false);
  });

  it('goes away on "Decide later" without answering, and comes back for a new question', () => {
    const controller = setup(80);
    render(wrap(<FilesSyncPrompts />));
    fireEvent.click(screen.getByRole('button', { name: 'Decide later' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(controller.confirmMassDelete).not.toHaveBeenCalled();
    act(() => useFilesSyncStore.setState({
      status: { r1: { rootId: 'r1', state: 'confirm-delete', pending: 0, done: 0, lastSyncedAt: null, massDelete: { count: 95, deletedOn: 'this-computer' } } },
    }));
    expect(screen.getByRole('alertdialog', { name: 'Delete 95 items?' })).toBeInTheDocument();
  });

  it('asks nothing when no folder waits for an answer, or outside the app', () => {
    setup();
    act(() => useFilesSyncStore.setState({ status: { r1: { rootId: 'r1', state: 'paused', pending: 0, done: 0, lastSyncedAt: null } } }));
    const { unmount } = render(wrap(<FilesSyncPrompts />));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    unmount();
    setup();
    act(() => useFilesSyncStore.setState({ available: false }));
    render(wrap(<FilesSyncPrompts />));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('stays away while the settings page asks in its rows', () => {
    setup();
    function Page() {
      useInlineMassDeleteQuestions();
      return null;
    }
    const { rerender } = render(wrap(<><FilesSyncPrompts /><Page /></>));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    rerender(wrap(<FilesSyncPrompts />));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});
