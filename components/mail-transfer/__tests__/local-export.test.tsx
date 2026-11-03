import 'fake-indexeddb/auto';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailTransferHost } from '@/components/mail-transfer/mail-transfer-host';
import { localExportAllowed, startLocalExport } from '@/components/mail-transfer/start-local-export';
import { OfflineSettings } from '@/components/offline/offline-settings';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { getStrictestDevices, devicesForAccount } from '@/lib/device-policy';
import { setDownloadGuard } from '@/lib/download-guard';
import type { ExportProgress } from '@/lib/mail-export/engine';
import type { ExportFile, ExportSink } from '@/lib/mail-export/sinks';
import { useOfflineStore } from '@/lib/offline/state';
import { runWipeCleaners } from '@/lib/offline/wipe-registry';
import { runBeforeSignOut } from '@/lib/sign-out-cleanup';
import { setStoreBackend, type StoreBackend } from '@/lib/store/client/api';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { isJobActive, openLocalExport, useMailTransferStore } from '@/stores/mail-transfer-store';
import { usePolicyStore } from '@/stores/policy-store';
import { toast } from '@/stores/toast-store';

const FOLDERS = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', sortOrder: 0 },
  { id: 'archive', name: 'Archive', sortOrder: 1 },
];
const RAW = new TextEncoder().encode('Subject: x\r\n\r\nbody\r\n');

/** A kept account where Inbox has 2 of 3 originals and Archive 1 of 1. */
function fakeStore(overrides: { rawBlob?: (blobId: string) => unknown; status?: { total: number; kept: number } } = {}) {
  const area = vi.fn(async (_account: string, name: string, params?: { mailboxId?: string; blobId?: string }): Promise<unknown> => {
    if (name === 'mail.session') return { primaryAccounts: { 'urn:ietf:params:jmap:mail': 'jmap-a' } };
    if (name === 'mail.rawStatus') return overrides.status ?? (params?.mailboxId === 'inbox' ? { total: 3, kept: 2 } : { total: 1, kept: 1 });
    if (name === 'mail.rawBlob') return overrides.rawBlob ? overrides.rawBlob(params!.blobId!) : { ok: true, blob: new Blob([RAW]) };
    if (name === 'mail.rawKept') return [];
    return null;
  });
  const answer = vi.fn(async (_account: string, calls: [string, Record<string, unknown>, string][]) => {
    const [name, args] = calls[0];
    if (name === 'Mailbox/get') return { methodResponses: [['Mailbox/get', { list: FOLDERS }, '0']] };
    if (name === 'Email/query') return { methodResponses: [['Email/query', { ids: (args.position as number) > 0 ? [] : ['m1'] }, '0']] };
    return { methodResponses: [['Email/get', { list: [{ id: 'm1', blobId: 'raw-m1', size: RAW.length, keywords: {}, receivedAt: '2026-10-01T00:00:00Z', subject: 'x' }] }, '0']] };
  });
  return { supported: () => true, setScope: vi.fn(async () => {}), area, answer };
}

function setDevices(devices: Partial<typeof DEFAULT_ORGANISATION_POLICY.devices>) {
  usePolicyStore.setState({
    loaded: true, source: 'server', partial: false, subject: { email: 'alice@example.org', groups: [] },
    policy: { ...usePolicyStore.getState().policy, organisation: { ...DEFAULT_ORGANISATION_POLICY, devices: { ...DEFAULT_ORGANISATION_POLICY.devices, ...devices } } },
  } as never);
}

function fakeSink(): ExportSink & { write: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  const file: ExportFile = { name: 'a.mbox', size: 1, discard: vi.fn(async () => {}) };
  return { kind: 'picker', write: vi.fn(async () => {}), close: vi.fn(async () => file), abort: vi.fn(async () => {}) };
}

/** The one lib/device-policy.ts installs, for tests that put their own in for a moment. */
const installedGuard: Parameters<typeof setDownloadGuard>[0] = (kind, subject) => {
  const devices = subject === undefined ? getStrictestDevices() : devicesForAccount(subject as string | null);
  return kind === 'export' ? !devices.noExport : !devices.noDownloads;
};

const realClient = { getServerUrl: () => 'https://mail.example.org', getAccountId: () => 'jmap-a', getMaxConcurrentRequests: () => 4 };

function setOnline(online: boolean) {
  useOfflineStore.setState({ browserOffline: !online, downServers: [] });
}

beforeEach(() => {
  useMailTransferStore.setState({ request: null, visible: false, job: null });
  useAuthStore.setState({
    client: realClient as never,
    activeAccountId: 'acc',
    getClientForAccount: ((id: string) => (id === 'acc' ? realClient : undefined)) as never,
    getAllConnectedClients: (() => new Map([['acc', realClient]])) as never,
  } as never);
  useAccountStore.setState({ accounts: [{ id: 'acc', email: 'alice@example.org', username: 'alice@example.org', serverUrl: 'https://mail.example.org' }] } as never);
  useOfflineStore.setState({
    enabled: ['acc', 'other'], outbox: [], pendingChanges: 0, conflicts: [], areaConflicts: [], syncing: [], lastSyncedAt: {}, choices: { acc: { on: true } }, health: {},
    storageFull: {}, progress: {}, persist: 'granted', browserOffline: false, downServers: [], startedOffline: false,
    usage: { acc: { bytes: 5000, parts: [] } },
  });
  setDevices({});
  setStoreBackend(fakeStore() as unknown as StoreBackend);
});

afterEach(() => {
  cleanup();
  setStoreBackend(null);
  delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  delete (window as { bulwarkDesktop?: unknown }).bulwarkDesktop;
  vi.unstubAllGlobals();
});

async function openDialog() {
  render(<MailTransferHost />);
  act(() => openLocalExport('acc'));
  await screen.findByTestId('local-export-summary');
}

/** Runs one export to its end through the job. */
async function finishedJob(sink = fakeSink()) {
  expect(startLocalExport({ account: 'acc', jmap: 'jmap-a', format: 'mbox', folders: [{ mailboxId: 'inbox', path: ['Inbox'] }], sink })).toBe(true);
  await act(async () => { await useMailTransferStore.getState().job!.finished; });
  return sink;
}

describe('before an export starts', () => {
  it('says how many originals are here and how many come from the server when online', async () => {
    await openDialog();
    expect(screen.getByTestId('local-export-kept').textContent).toBe('kept');
    expect(screen.getByTestId('local-export-missing').textContent).toBe('missing_online');
    expect(screen.queryByTestId('local-export-reason')).toBeNull();
  });

  it('says offline how many can\'t be exported, and why', async () => {
    setOnline(false);
    await openDialog();
    expect(screen.getByTestId('local-export-missing').textContent).toBe('missing_offline');
    expect(screen.getByTestId('local-export-reason').textContent).toBe('reason_not_kept');
  });

  it('gives attachments being off as the reason when they are', async () => {
    setOnline(false);
    useOfflineStore.setState({ choices: { acc: { on: true, attachments: false } } } as never);
    await openDialog();
    expect(screen.getByTestId('local-export-reason').textContent).toBe('reason_attachments_off');
  });

  it('counts only the folders chosen, and offers none of the rest', async () => {
    setOnline(false);
    await openDialog();
    const area = (await import('@/lib/store/client/api')).getStore().area as ReturnType<typeof vi.fn>;
    expect(area).toHaveBeenCalledWith('acc', 'mail.rawStatus', { jmap: 'jmap-a', mailboxId: 'inbox' });
    const boxes = screen.getAllByTestId('local-export-folder') as HTMLInputElement[];
    expect(boxes.map((box) => box.dataset.folder)).toEqual(['Inbox', 'Archive']);
    fireEvent.click(boxes[0]);
    // Only Archive now: all of its originals are here.
    expect(screen.queryByTestId('local-export-missing')).toBeNull();
    const all = screen.getByTestId('local-export-all') as HTMLInputElement;
    expect(all.indeterminate).toBe(true);
    fireEvent.click(all);
    expect(boxes.every((box) => box.checked)).toBe(true);
  });

  it('can\'t start offline with no original of anything, and can as soon as the server is back', async () => {
    setOnline(false);
    setStoreBackend(fakeStore({ status: { total: 4, kept: 0 } }) as unknown as StoreBackend);
    await openDialog();
    expect((screen.getByTestId('local-export-start') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('local-export-missing').textContent).toBe('missing_offline');
    act(() => setOnline(true));
    expect((screen.getByTestId('local-export-start') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('local-export-missing').textContent).toBe('missing_online');
  });

  it('puts the focus on the folders once they are read', async () => {
    await openDialog();
    expect(document.activeElement).toBe(screen.getByTestId('local-export-all'));
  });

  it('can\'t start with nothing chosen', async () => {
    await openDialog();
    fireEvent.click(screen.getByTestId('local-export-all'));
    expect((screen.getByTestId('local-export-start') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('local-export-nothing')).toBeTruthy();
  });

  it('opens the picker from the click, with a name for what was chosen', async () => {
    const writable = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    const picker = vi.fn(async () => ({ createWritable: async () => writable }));
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = picker;
    await openDialog();
    fireEvent.click(screen.getAllByTestId('local-export-folder')[1]);
    fireEvent.click(screen.getByTestId('local-export-start'));
    await waitFor(() => expect(picker).toHaveBeenCalled());
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'Inbox.mbox' }));
    await waitFor(() => expect(useMailTransferStore.getState().job?.progress.phase).toBe('done'));
    expect(writable.close).toHaveBeenCalled();
  });
});

describe('the device policy "No export"', () => {
  it('locks the action in settings, with the reason beside it', () => {
    setDevices({ noExport: true });
    render(<OfflineSettings />);
    expect((screen.getByTestId('local-export-open') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('settings_label').closest('[data-search-label]')!.querySelector('[data-org-locked]')).toBeTruthy();
  });

  it('leaves the action in settings open when it\'s off, and that opens the dialog', async () => {
    render(<OfflineSettings />);
    fireEvent.click(screen.getByTestId('local-export-open'));
    expect(useMailTransferStore.getState().request).toEqual({ kind: 'local-export', account: 'acc' });
  });

  it('keeps the dialog from opening', () => {
    setDevices({ noExport: true });
    act(() => openLocalExport('acc'));
    expect(useMailTransferStore.getState().request).toBeNull();
  });

  it('refuses to start, gives back the sink and reads nothing', () => {
    const store = fakeStore();
    setStoreBackend(store as unknown as StoreBackend);
    setDevices({ noExport: true });
    const sink = fakeSink();
    expect(startLocalExport({ account: 'acc', jmap: 'jmap-a', format: 'mbox', folders: [{ mailboxId: 'inbox', path: [] }], sink })).toBe(false);
    expect(sink.abort).toHaveBeenCalled();
    expect(store.answer).not.toHaveBeenCalled();
    expect(useMailTransferStore.getState().job).toBeNull();
  });

  it('counts as on while the organisation\'s word isn\'t known, as at a first start offline', () => {
    usePolicyStore.setState({ loaded: false, source: 'none' } as never);
    expect(localExportAllowed('acc')).toBe(false);
    usePolicyStore.setState({ loaded: true, source: 'fallback' } as never);
    expect(localExportAllowed('acc')).toBe(false);
    usePolicyStore.setState({ loaded: true, source: 'server', partial: true } as never);
    expect(localExportAllowed('acc')).toBe(false);
    usePolicyStore.setState({ loaded: true, source: 'cache', partial: false } as never);
    expect(localExportAllowed('acc')).toBe(true);
  });

  it('stops a running export the moment it\'s switched on, and its file goes', async () => {
    let release: () => void = () => {};
    const store = fakeStore();
    store.answer.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ methodResponses: [['Email/query', { ids: [] }, '0']] }); }));
    setStoreBackend(store as unknown as StoreBackend);
    const sink = fakeSink();
    startLocalExport({ account: 'acc', jmap: 'jmap-a', format: 'mbox', folders: [{ mailboxId: 'inbox', path: [] }], sink });
    const job = useMailTransferStore.getState().job!;
    expect(isJobActive(job)).toBe(true);
    await waitFor(() => expect(store.answer).toHaveBeenCalled());
    act(() => setDevices({ noExport: true }));
    expect(job.controller.signal.aborted).toBe(true);
    release();
    await act(async () => { await job.finished; });
    expect(useMailTransferStore.getState().job?.progress.phase).toBe('cancelled');
    expect(sink.abort).toHaveBeenCalled();
    expect(sink.close).not.toHaveBeenCalled();
  });

  it('asks about the account the export is for, not the active one', async () => {
    useAuthStore.setState({ getClientForAccount: (() => realClient) as never } as never);
    const asked: unknown[] = [];
    setDownloadGuard((_kind, subject) => { asked.push(subject); return true; });
    try {
      const sink = fakeSink();
      expect(startLocalExport({ account: 'other', jmap: 'jmap-a', format: 'mbox', folders: [{ mailboxId: 'inbox', path: [] }], sink })).toBe(true);
      expect(useMailTransferStore.getState().job?.scope).toBe('other');
      await act(async () => { await useMailTransferStore.getState().job!.finished; });
      expect(sink.close).toHaveBeenCalled();
      expect(asked.length).toBeGreaterThan(1);
      expect(new Set(asked)).toEqual(new Set(['other']));
    } finally {
      setDownloadGuard(installedGuard);
    }
  });

  it('stops at the file when it came on without the store noticing, as the save picker has no other gate', async () => {
    const sink = fakeSink();
    let allowed = true;
    setDownloadGuard(() => allowed);
    try {
      sink.write.mockImplementation(async () => { allowed = false; });
      await finishedJob(sink);
      expect(useMailTransferStore.getState().job?.progress.phase).toBe('failed');
      expect(sink.close).not.toHaveBeenCalled();
      expect(sink.abort).toHaveBeenCalled();
    } finally {
      setDownloadGuard(installedGuard);
    }
  });

  it('shows the organisation as the reason when that stopped it', async () => {
    const sink = fakeSink();
    render(<MailTransferHost />);
    act(() => openLocalExport('acc'));
    let allowed = true;
    setDownloadGuard(() => allowed);
    try {
      sink.write.mockImplementation(async () => { allowed = false; });
      await finishedJob(sink);
      expect(screen.getByText('export_blocked')).toBeTruthy();
    } finally {
      setDownloadGuard(installedGuard);
    }
  });
});

describe('what an export couldn\'t write', () => {
  const notKept = () => setStoreBackend(fakeStore({ rawBlob: () => ({ ok: false, reason: 'not_kept' }) }) as unknown as StoreBackend);

  it('counts it offline with the reason and no way to retry until online', async () => {
    setOnline(false);
    notKept();
    render(<MailTransferHost />);
    act(() => openLocalExport('acc'));
    await finishedJob();
    expect((useMailTransferStore.getState().job?.progress as ExportProgress).notKept).toEqual({ not_kept: 1 });
    expect(screen.getByTestId('local-export-not-kept-missing').textContent).toBe('not_kept_not_kept');
    // Nothing was written: no file, and nothing to download again.
    expect(screen.queryByTestId('mail-export-file')).toBeNull();
    expect(screen.queryByTestId('mail-export-download')).toBeNull();
    expect(screen.queryByTestId('local-export-not-kept-attachments')).toBeNull();
    expect(screen.getByTestId('local-export-retry-hint').textContent).toBe('retry_offline');
    expect((screen.getByTestId('local-export-retry') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers the retry once the connection is back, which goes back to the question with fresh counts', async () => {
    setOnline(false);
    notKept();
    render(<MailTransferHost />);
    act(() => openLocalExport('acc'));
    await finishedJob();
    act(() => setOnline(true));
    expect(screen.getByTestId('local-export-retry-hint').textContent).toBe('retry_online');
    const area = (await import('@/lib/store/client/api')).getStore().area as ReturnType<typeof vi.fn>;
    area.mockClear();
    fireEvent.click(screen.getByTestId('local-export-retry'));
    await screen.findByTestId('local-export-summary');
    expect(useMailTransferStore.getState().job).toBeNull();
    expect(area).toHaveBeenCalledWith('acc', 'mail.rawStatus', expect.anything());
    expect(screen.getByTestId('local-export-missing').textContent).toBe('missing_online');
  });

  it('says the export stopped, not that a file is ready, when it ends hidden with nothing written', async () => {
    setOnline(false);
    notKept();
    const warning = vi.spyOn(toast, 'warning');
    const success = vi.spyOn(toast, 'success');
    render(<MailTransferHost />);
    await finishedJob();
    expect(warning).toHaveBeenCalledWith('toast_stopped', expect.anything());
    expect(success).not.toHaveBeenCalled();
    warning.mockRestore();
    success.mockRestore();
  });

  it('offers no retry when everything was written', async () => {
    render(<MailTransferHost />);
    act(() => openLocalExport('acc'));
    await finishedJob();
    expect(useMailTransferStore.getState().job?.progress.phase).toBe('done');
    expect(screen.queryByTestId('local-export-retry')).toBeNull();
  });
});

describe('while it runs', () => {
  it('shows the progress, and Cancel stops it and gives up its file', async () => {
    const sink = fakeSink();
    let finish: () => void = () => {};
    const store = fakeStore();
    store.answer.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ methodResponses: [['Email/query', { ids: [] }, '0']] }); }));
    setStoreBackend(store as unknown as StoreBackend);
    render(<MailTransferHost />);
    act(() => openLocalExport('acc'));
    act(() => { startLocalExport({ account: 'acc', jmap: 'jmap-a', format: 'mbox', folders: [{ mailboxId: 'inbox', path: [] }], sink }); });
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(screen.getByTestId('mail-export-status').getAttribute('role')).toBe('status');
    await waitFor(() => expect(store.answer).toHaveBeenCalled());
    const job = useMailTransferStore.getState().job!;
    fireEvent.click(screen.getByTestId('local-export-cancel'));
    expect(job.controller.signal.aborted).toBe(true);
    finish();
    await act(async () => { await job.finished; });
    expect(useMailTransferStore.getState().job?.progress.phase).toBe('cancelled');
    expect(sink.abort).toHaveBeenCalled();
    expect(sink.close).not.toHaveBeenCalled();
    expect(screen.getByText('cancelled_title')).toBeTruthy();
  });
});

describe('an export is cleaned up', () => {
  /** A job that doesn't end until it's aborted. */
  function runningJob(account = 'acc') {
    const sink = fakeSink();
    const store = fakeStore();
    // Like a store read: under way until the job is stopped.
    store.answer.mockImplementation(() => new Promise((_resolve, reject) => {
      const signal = useMailTransferStore.getState().job!.controller.signal;
      const stop = () => reject(new DOMException('stopped', 'AbortError'));
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop);
    }));
    setStoreBackend(store as unknown as StoreBackend);
    expect(startLocalExport({ account, jmap: 'jmap-a', format: 'mbox', folders: [{ mailboxId: 'inbox', path: [] }], sink })).toBe(true);
    return { sink, job: useMailTransferStore.getState().job! };
  }

  function stubSweep() {
    const removed: string[] = [];
    const dir = {
      keys: async function* () { yield 'old-spool'; },
      removeEntry: async (name: string) => { removed.push(name); },
    };
    const root = {
      getDirectoryHandle: async () => dir,
      removeEntry: vi.fn(async () => {}),
    };
    vi.stubGlobal('navigator', { ...navigator, storage: { getDirectory: async () => root }, locks: { request: async (name: string, _o: unknown, cb: (lock: unknown) => unknown) => cb({ name }) } });
    return { removed, root };
  }

  it('on a wipe of its account: stops the job and forgets it', async () => {
    render(<MailTransferHost />);
    const { job } = runningJob();
    await act(async () => { await runWipeCleaners('acc'); });
    expect(job.controller.signal.aborted).toBe(true);
    expect(useMailTransferStore.getState().job).toBeNull();
  });

  it('a wipe of another account leaves the job alone', async () => {
    render(<MailTransferHost />);
    const { job } = runningJob();
    await act(async () => { await runWipeCleaners('someone-else'); });
    expect(job.controller.signal.aborted).toBe(false);
    expect(useMailTransferStore.getState().job).toBe(job);
  });

  it('on a wipe of everything: also every spool, whoever holds it', async () => {
    render(<MailTransferHost />);
    const { job } = runningJob();
    const { root } = stubSweep();
    await act(async () => { await runWipeCleaners(null); });
    expect(job.controller.signal.aborted).toBe(true);
    expect(root.removeEntry).toHaveBeenCalledWith('bulwark-exports', { recursive: true });
  });

  it('on a wipe of one account: the spools nobody holds go too', async () => {
    render(<MailTransferHost />);
    const { removed, root } = stubSweep();
    await act(async () => { await runWipeCleaners('acc'); });
    expect(removed).toEqual(['old-spool']);
    expect(root.removeEntry).not.toHaveBeenCalled();
  });

  it('on sign-out of its account: stops the job and forgets it', async () => {
    render(<MailTransferHost />);
    const { job } = runningJob();
    await act(async () => { await runBeforeSignOut('acc'); });
    expect(job.controller.signal.aborted).toBe(true);
    expect(useMailTransferStore.getState().job).toBeNull();
  });

  it('frees a finished export\'s file at once on a wipe', async () => {
    render(<MailTransferHost />);
    const sink = fakeSink();
    await finishedJob(sink);
    const file = (useMailTransferStore.getState().job!.progress as ExportProgress).file!;
    await act(async () => { await runWipeCleaners('acc'); });
    expect(file.discard).toHaveBeenCalledWith(true);
  });

  it('when the account stops keeping mail here: stops the job', () => {
    const { job } = runningJob();
    act(() => useOfflineStore.setState({ enabled: ['other'] }));
    expect(job.controller.signal.aborted).toBe(true);
  });

  it('at start-up: sweeps what a crash left', async () => {
    const { removed } = stubSweep();
    render(<MailTransferHost />);
    await waitFor(() => expect(removed).toEqual(['old-spool']));
  });
});

describe('the taskbar in the desktop app', () => {
  it('shows a running export and takes it away at the end', async () => {
    const setProgress = vi.fn();
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, platform: 'win32', os: { setProgress } };
    render(<MailTransferHost />);
    await finishedJob();
    const calls = setProgress.mock.calls;
    expect(calls[0]).toEqual([0, 'normal']);
    expect(calls[calls.length - 1][0]).toBeNull();
  });

  it('says when it\'s paused', async () => {
    const setProgress = vi.fn();
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, platform: 'win32', os: { setProgress } };
    render(<MailTransferHost />);
    const store = useMailTransferStore.getState();
    act(() => store.startJob({ kind: 'export', controller: new AbortController(), progress: { phase: 'paused', exported: 1, failed: 0, failures: [], total: 4, fraction: 0.25 } }));
    expect(setProgress).toHaveBeenLastCalledWith(0.25, 'paused');
  });

  it('asks nothing of a shell without it, or of a browser', async () => {
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, platform: 'win32' };
    render(<MailTransferHost />);
    await finishedJob();
    expect(useMailTransferStore.getState().job?.progress.phase).toBe('done');
  });
});
