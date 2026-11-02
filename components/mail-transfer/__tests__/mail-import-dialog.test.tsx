import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MailTransferHost } from '@/components/mail-transfer/mail-transfer-host';
import { useMailTransferStore, openMailImport } from '@/stores/mail-transfer-store';
import { useEmailStore } from '@/stores/email-store';
import { useAuthStore } from '@/stores/auth-store';
import type { Mailbox } from '@/lib/jmap/types';
import type { ImportProgress } from '@/lib/mail-import/engine';

const startImport = vi.fn();
vi.mock('@/components/mail-transfer/start-import', () => ({ startImport: (...args: unknown[]) => startImport(...args) }));

const box = (id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox => ({
  id, name, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
  myRights: { mayAddItems: true } as Mailbox['myRights'], ...extra,
});

const progress = (extra: Partial<ImportProgress> = {}): ImportProgress => ({
  phase: 'running', imported: 3, failed: 0, skipped: {}, failures: [], fraction: 0.4, foldersCreated: 0, ...extra,
});

beforeEach(() => {
  startImport.mockReset();
  useMailTransferStore.setState({ request: null, visible: false, job: null });
  useEmailStore.setState({
    mailboxes: [
      box('inbox', 'Inbox', { role: 'inbox' }),
      box('acc2:shared', 'Team', { originalId: 'shared', accountId: 'acc2', isShared: true, accountName: 'team@example.org' }),
      box('ro', 'Read only', { myRights: { mayAddItems: false } as Mailbox['myRights'] }),
    ],
  } as never);
  useAuthStore.setState({ client: { getAccountId: () => 'acc1' } as never, activeAccountId: 'bulwark-1' } as never);
});

function pick(files: File[]) {
  const input = screen.getByTestId('mail-import-file') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

describe('MailImportDialog', () => {
  it('imports into a shared folder in that folder\'s own account', async () => {
    render(<MailTransferHost />);
    act(() => openMailImport({ mailboxId: 'acc2:shared' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    // Folders the user can't add to aren't offered.
    expect(screen.queryByRole('option', { name: 'Read only' })).toBeNull();
    pick([new File(['From a Tue May  5 10:11:12 2020\nSubject: x\n\nb\n'], 'old.mbox')]);
    await screen.findByText('old.mbox');
    expect(screen.getByText(/format_mbox/)).toBeTruthy();
    // Import waits until it knows whether an earlier run can be continued.
    await waitFor(() => expect((screen.getByTestId('mail-import-start') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('mail-import-start'));
    expect(startImport).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'acc2', targetMailboxId: 'shared', keepFolders: false, resume: false,
      files: [expect.objectContaining({ format: 'mbox' })],
    }));
  });

  it('offers to keep a ZIP\'s folders and the top level as target', async () => {
    const { ZipWriter } = await import('@/lib/mail-export/zip-writer');
    const parts: Uint8Array[] = [];
    const z = new ZipWriter(async (c) => { parts.push(c.slice()); });
    await z.addFile('Archive/a.eml', new TextEncoder().encode('Subject: a\r\n\r\nA'));
    await z.finish();
    render(<MailTransferHost />);
    act(() => openMailImport());
    pick([new File(parts as BlobPart[], 'export.zip')]);
    const keep = await screen.findByRole('checkbox', { name: /keep_folders/ });
    expect((keep as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByTestId('mail-import-target'), { target: { value: '\u0000top' } });
    // Import waits until it knows whether an earlier run can be continued.
    await waitFor(() => expect((screen.getByTestId('mail-import-start') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('mail-import-start'));
    expect(startImport).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc1', targetMailboxId: null, keepFolders: true }));
  });

  it('loads the folders when opened from Settings before the mail view did, then picks the Inbox', async () => {
    const fetchMailboxes = vi.fn(async () => {});
    const loaded = useEmailStore.getState().mailboxes;
    useEmailStore.setState({ mailboxes: [], fetchMailboxes } as never);
    render(<MailTransferHost />);
    act(() => openMailImport());
    expect(fetchMailboxes).toHaveBeenCalled();
    act(() => useEmailStore.setState({ mailboxes: loaded } as never));
    await waitFor(() => expect((screen.getByTestId('mail-import-target') as HTMLSelectElement).value).toBe('inbox'));
  });

  it('cannot start without files', () => {
    render(<MailTransferHost />);
    act(() => openMailImport());
    expect((screen.getByTestId('mail-import-start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a pause in a live region, cancels on Cancel import, and hides on Escape without cancelling', async () => {
    const controller = new AbortController();
    render(<MailTransferHost />);
    act(() => {
      openMailImport();
      useMailTransferStore.getState().startJob({ kind: 'import', controller, progress: progress({ phase: 'paused', pausedUntil: Date.now() + 3600_000, quota: { files: 1000, bytes: 50_000_000 } }) });
    });
    const status = screen.getByTestId('mail-import-status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('paused');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40');

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(controller.signal.aborted).toBe(false);
    // The chip brings it back.
    fireEvent.click(screen.getByTestId('mail-transfer-chip'));
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'cancel_import' }));
    expect(controller.signal.aborted).toBe(true);
  });

  it('opening another import while one runs shows the running one', () => {
    const controller = new AbortController();
    render(<MailTransferHost />);
    act(() => {
      openMailImport();
      useMailTransferStore.getState().startJob({ kind: 'import', controller, progress: progress() });
      useMailTransferStore.getState().hide();
    });
    act(() => openMailImport({ mailboxId: 'inbox' }));
    expect(screen.getByRole('heading', { name: 'running_title' })).toBeTruthy();
  });

  it('says when a hidden import ends, with a way back to its summary', async () => {
    const { useToastStore } = await import('@/stores/toast-store');
    useToastStore.setState({ toasts: [] });
    render(<MailTransferHost />);
    act(() => {
      openMailImport();
      useMailTransferStore.getState().startJob({ kind: 'import', controller: new AbortController(), progress: progress() });
      useMailTransferStore.getState().hide();
    });
    act(() => useMailTransferStore.getState().updateProgress(progress({ phase: 'done', imported: 12, failed: 1 })));
    const toastShown = useToastStore.getState().toasts.find((x) => x.title === 'toast_done');
    expect(toastShown?.action?.label).toBe('toast_show');
    act(() => toastShown!.action!.onClick());
    expect(screen.getByRole('heading', { name: 'done_title' })).toBeTruthy();
  });

  it('keeps the focus in the dialog when Import turns into the progress view and then the summary', async () => {
    render(<MailTransferHost />);
    act(() => openMailImport());
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => useMailTransferStore.getState().startJob({ kind: 'import', controller: new AbortController(), progress: progress() }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe('background'));
    act(() => useMailTransferStore.getState().updateProgress(progress({ phase: 'done' })));
    await waitFor(() => expect(document.activeElement?.textContent).toBe('close'));
  });

  it('lists what was skipped and what failed when it ends', () => {
    render(<MailTransferHost />);
    act(() => {
      openMailImport();
      useMailTransferStore.getState().startJob({
        kind: 'import', controller: new AbortController(),
        progress: progress({ phase: 'done', imported: 10, failed: 1, failures: [{ label: 'Hello', reason: 'invalid' }], skipped: { deleted: 2, too_large: 1 } }),
      });
    });
    expect(screen.getByText('done_title')).toBeTruthy();
    expect(screen.getByText('skip_too_large')).toBeTruthy();
    expect(screen.getByText('skip_deleted')).toBeTruthy();
    expect(screen.getByText('Hello: failure_invalid')).toBeTruthy();
    // The footer's Close (the X in the corner is named the same).
    const closes = screen.getAllByRole('button', { name: 'close' });
    fireEvent.click(closes[closes.length - 1]);
    expect(useMailTransferStore.getState().job).toBeNull();
  });
});
