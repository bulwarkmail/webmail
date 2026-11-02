import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MailTransferHost } from '@/components/mail-transfer/mail-transfer-host';
import { useMailTransferStore, openMailExport } from '@/stores/mail-transfer-store';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import type { Mailbox } from '@/lib/jmap/types';

const startExport = vi.fn();
vi.mock('@/components/mail-transfer/start-export', () => ({ startExport: (...args: unknown[]) => startExport(...args) }));

const box = (id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox => ({
  id, name, sortOrder: 0, totalEmails: 3, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
  myRights: {} as Mailbox['myRights'], ...extra,
});

beforeEach(() => {
  startExport.mockReset();
  useMailTransferStore.setState({ request: null, visible: false, job: null });
  useEmailStore.setState({ mailboxes: [box('inbox', 'Inbox', { role: 'inbox' }), box('acc2:shared', 'Team', { originalId: 'shared', accountId: 'acc2', isShared: true })] } as never);
  useAuthStore.setState({ client: { getAccountId: () => 'acc1' } as never, username: 'alice@example.org' } as never);
});

afterEach(() => {
  delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
});

describe('MailExportDialog', () => {
  it('asks where to save first where the browser can, and exports a shared folder from its own account', async () => {
    const writable = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
    const picker = vi.fn(async () => ({ createWritable: async () => writable }));
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = picker;
    render(<MailTransferHost />);
    act(() => openMailExport({ mailboxId: 'acc2:shared' }));
    expect(screen.getByText('title_folder')).toBeTruthy();
    expect(screen.getByText('save_picker')).toBeTruthy();
    fireEvent.click(screen.getByTestId('mail-export-start'));
    await waitFor(() => expect(startExport).toHaveBeenCalled());
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'Team.mbox' }));
    expect(startExport).toHaveBeenCalledWith(expect.objectContaining({ format: 'mbox', accountId: 'acc2', mailboxId: 'shared' }));
    expect(startExport.mock.calls[0][0].sink.kind).toBe('picker');
  });

  it('does nothing when the save picker is closed', async () => {
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn(async () => { throw new DOMException('closed', 'AbortError'); });
    render(<MailTransferHost />);
    act(() => openMailExport({ mailboxId: 'inbox' }));
    fireEvent.click(screen.getByTestId('mail-export-start'));
    await waitFor(() => expect((screen.getByTestId('mail-export-start') as HTMLButtonElement).disabled).toBe(false));
    expect(startExport).not.toHaveBeenCalled();
  });

  it('exports the whole account as a ZIP of .eml files into memory where nothing else exists', async () => {
    render(<MailTransferHost />);
    act(() => openMailExport());
    expect(screen.getByText('title_account')).toBeTruthy();
    expect(screen.getByText('save_memory')).toBeTruthy();
    fireEvent.click(screen.getByTestId('mail-export-format-eml'));
    fireEvent.click(screen.getByTestId('mail-export-start'));
    await waitFor(() => expect(startExport).toHaveBeenCalled());
    const input = startExport.mock.calls[0][0];
    expect(input).toMatchObject({ format: 'eml', accountId: 'acc1', mailboxId: undefined });
    expect(input.sink.kind).toBe('memory');
  });

  it('offers the file again when done and frees it on Close', async () => {
    const discard = vi.fn(async () => {});
    const download = vi.fn();
    render(<MailTransferHost />);
    act(() => {
      openMailExport({ mailboxId: 'inbox' });
      useMailTransferStore.getState().startJob({
        kind: 'export', controller: new AbortController(),
        progress: { phase: 'done', exported: 3, failed: 0, failures: [], total: 3, fraction: 1, file: { name: 'Inbox.mbox', size: 1200, download, discard } },
      });
    });
    expect(screen.getByTestId('mail-export-status').getAttribute('aria-live')).toBe('polite');
    fireEvent.click(screen.getByTestId('mail-export-download'));
    expect(download).toHaveBeenCalled();
    const closes = screen.getAllByRole('button', { name: 'close' });
    fireEvent.click(closes[closes.length - 1]);
    expect(discard).toHaveBeenCalled();
    expect(useMailTransferStore.getState().request).toBeNull();
  });

  it('signing out stops a running export, or frees a finished one\'s file', async () => {
    const { runBeforeSignOut } = await import('@/lib/sign-out-cleanup');
    const controller = new AbortController();
    render(<MailTransferHost />);
    act(() => {
      openMailExport({ mailboxId: 'inbox' });
      useMailTransferStore.getState().startJob({ kind: 'export', controller, progress: { phase: 'running', exported: 1, failed: 0, failures: [], total: 4, fraction: 0.25 } });
    });
    await act(() => runBeforeSignOut('acc1'));
    expect(controller.signal.aborted).toBe(true);

    const discard = vi.fn(async () => {});
    act(() => {
      useMailTransferStore.setState({ request: null, visible: false, job: null });
      openMailExport({ mailboxId: 'inbox' });
      useMailTransferStore.getState().startJob({ kind: 'export', controller: new AbortController(), progress: { phase: 'done', exported: 3, failed: 0, failures: [], total: 3, fraction: 1, file: { name: 'a.mbox', size: 1, discard } } });
    });
    await act(() => runBeforeSignOut('acc1'));
    expect(discard).toHaveBeenCalled();
  });

  it('another account signing out leaves the job alone; its own sign-out stops it with the sign-out reason', async () => {
    const { runBeforeSignOut } = await import('@/lib/sign-out-cleanup');
    const controller = new AbortController();
    render(<MailTransferHost />);
    act(() => {
      openMailExport({ mailboxId: 'inbox' });
      useMailTransferStore.getState().startJob({ kind: 'export', controller, scope: 'bulwark-a', finished: Promise.resolve(), progress: { phase: 'running', exported: 1, failed: 0, failures: [], total: 4, fraction: 0.25 } });
    });
    await act(() => runBeforeSignOut('bulwark-b'));
    expect(controller.signal.aborted).toBe(false);
    await act(() => runBeforeSignOut('bulwark-a'));
    expect(controller.signal.reason).toBe('signout');
  });

  it('runs on in the background and the chip names the export', () => {
    const controller = new AbortController();
    render(<MailTransferHost />);
    act(() => {
      openMailExport({ mailboxId: 'inbox' });
      useMailTransferStore.getState().startJob({ kind: 'export', controller, progress: { phase: 'running', exported: 1, failed: 0, failures: [], total: 4, fraction: 0.25 } });
    });
    fireEvent.click(screen.getByRole('button', { name: 'background' }));
    expect(screen.getByTestId('mail-transfer-chip').textContent).toContain('chip');
    expect(controller.signal.aborted).toBe(false);
  });

  it('keeps the running count out of the live region', () => {
    render(<MailTransferHost />);
    act(() => {
      openMailExport({ mailboxId: 'inbox' });
      useMailTransferStore.getState().startJob({ kind: 'export', controller: new AbortController(), progress: { phase: 'running', exported: 1, failed: 0, failures: [], total: 4, fraction: 0.25 } });
    });
    expect(screen.getByTestId('mail-export-status').textContent).toBe('running_title');
    expect(screen.getByTestId('mail-export-count').textContent).toBe('status_exported');
  });

  it('says the export stays in memory where the private file system can\'t write files', () => {
    vi.stubGlobal('navigator', { ...navigator, storage: { getDirectory: async () => ({}) } });
    vi.stubGlobal('FileSystemFileHandle', class {});
    try {
      render(<MailTransferHost />);
      act(() => openMailExport());
      expect(screen.getByText('save_memory')).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
