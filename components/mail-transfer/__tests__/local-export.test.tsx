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
import { memorySink, type ExportFile, type ExportSink } from '@/lib/mail-export/sinks';
import { useOfflineStore } from '@/lib/offline/state';
import { runWipeCleaners } from '@/lib/offline/wipe-registry';
import { useAccountSubjects } from '@/lib/org/account-subjects';
import { runBeforeSignOut } from '@/lib/sign-out-cleanup';
import { setStoreBackend, type StoreBackend } from '@/lib/store/client/api';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { isJobActive, openLocalExport, useMailTransferStore } from '@/stores/mail-transfer-store';
import { usePolicyStore } from '@/stores/policy-store';
import { toast } from '@/stores/toast-store';

const FOLDERS: { id: string; name: string; role?: string; sortOrder: number }[] = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', sortOrder: 0 },
  { id: 'archive', name: 'Archive', sortOrder: 1 },
];
const RAW = new TextEncoder().encode('Subject: x\r\n\r\nbody\r\n');

/** A kept account where Inbox has 2 of 3 originals and Archive 1 of 1. */
function fakeStore(overrides: { rawBlob?: (blobId: string) => unknown; status?: { total: number; kept: number }; size?: { bytes: number; keptBytes: number } } = {}) {
  const area = vi.fn(async (_account: string, name: string, params?: { mailboxId?: string; blobId?: string }): Promise<unknown> => {
    if (name === 'mail.session') return { primaryAccounts: { 'urn:ietf:params:jmap:mail': 'jmap-a' } };
    if (name === 'mail.rawStatus') return overrides.status ?? (params?.mailboxId === 'inbox' ? { total: 3, kept: 2 } : { total: 1, kept: 1 });
    if (name === 'mail.rawBlob') return overrides.rawBlob ? overrides.rawBlob(params!.blobId!) : { ok: true, blob: new Blob([RAW]) };
    if (name === 'mail.rawSize') return overrides.size ?? { bytes: 10, keptBytes: 10 };
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
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('local-export-all')));
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
    useAccountSubjects.setState({ settled: { other: true } } as never);
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

  it('shows the organisation as the reason when a real change of policy stopped it', async () => {
    const sink = fakeSink();
    render(<MailTransferHost />);
    act(() => openLocalExport('acc'));
    // Through the policy store, the way a fetched policy arrives.
    sink.write.mockImplementation(async () => { act(() => setDevices({ noExport: true })); });
    await finishedJob(sink);
    expect(useMailTransferStore.getState().job?.progress.phase).toBe('cancelled');
    expect(screen.getByTestId('local-export-stop-reason').textContent).toBe('export_blocked');
    expect(sink.close).not.toHaveBeenCalled();
  });

  it('says why when the account stopped keeping mail here during the run', async () => {
    const sink = fakeSink();
    render(<MailTransferHost />);
    act(() => openLocalExport('acc'));
    sink.write.mockImplementation(async () => { act(() => useOfflineStore.setState({ enabled: ['other'] })); });
    await finishedJob(sink);
    expect(screen.getByTestId('local-export-stop-reason').textContent).toBe('stopped_offline_off');
  });

  it('gives no reason beyond the title when the person cancelled it', async () => {
    const sink = fakeSink();
    render(<MailTransferHost />);
    act(() => openLocalExport('acc'));
    sink.write.mockImplementation(async () => { act(() => useMailTransferStore.getState().cancelJob()); });
    await finishedJob(sink);
    expect(screen.queryByTestId('local-export-stop-reason')).toBeNull();
  });

  describe('with a scope the subject decides', () => {
    /** Everyone may export; one domain or group may not. */
    function scoped(match: Record<string, string[]>) {
      const base = usePolicyStore.getState().rawPolicy;
      usePolicyStore.setState({
        rawPolicy: { ...base, scopes: [{ id: 'locked', label: 'Locked', match, policy: { organisation: { devices: { noExport: true } } } }] },
        loaded: true, source: 'server', partial: false, subject: null, subjectPending: false,
      } as never);
    }

    afterEach(() => {
      usePolicyStore.setState({ rawPolicy: { ...usePolicyStore.getState().rawPolicy, scopes: [] }, subjectPending: false } as never);
      usePolicyStore.getState().setPolicySubject(null);
    });

    it.each([['domain', { domains: ['example.org'] }], ['group', { groups: ['team@example.org'] }]])('%s: says no until the subject is known, whatever Everyone may do', (_kind, match) => {
      scoped(match as Record<string, string[]>);
      // What the policy alone would say: nobody has been matched yet.
      expect(devicesForAccount('acc').noExport).toBe(false);
      expect(localExportAllowed('acc')).toBe(false);
      usePolicyStore.setState({ subjectPending: true } as never);
      expect(localExportAllowed('acc')).toBe(false);
      usePolicyStore.setState({ subjectPending: false } as never);
      usePolicyStore.getState().setPolicySubject({ email: 'alice@example.org', groups: ['team@example.org'] });
      expect(devicesForAccount('acc').noExport).toBe(true);
      expect(localExportAllowed('acc')).toBe(false);
    });

    it('opens once the subject is known and the scope isn\'t for it', () => {
      scoped({ domains: ['elsewhere.example'] });
      expect(localExportAllowed('acc')).toBe(false);
      usePolicyStore.getState().setPolicySubject({ email: 'alice@example.org', groups: [] });
      expect(localExportAllowed('acc')).toBe(true);
    });

    it('waits for another account\'s own subject too', () => {
      usePolicyStore.getState().setPolicySubject({ email: 'alice@example.org', groups: [] });
      useAuthStore.setState({ getClientForAccount: (() => realClient) as never } as never);
      useAccountSubjects.setState({ settled: {} } as never);
      expect(localExportAllowed('other')).toBe(false);
      useAccountSubjects.setState({ settled: { other: true } } as never);
      expect(localExportAllowed('other')).toBe(true);
    });
  });

  describe('at the click on Export', () => {
    function withPicker() {
      const picker = vi.fn(async () => ({ createWritable: async () => ({ write: async () => {}, close: async () => {}, abort: async () => {} }) }));
      (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = picker;
      return picker;
    }

    it('opens the picker in the same tick as the click, so the gesture counts', async () => {
      const picker = withPicker();
      await openDialog();
      fireEvent.click(screen.getByTestId('local-export-start'));
      expect(picker).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(useMailTransferStore.getState().job?.progress.phase).toBe('done'));
    });

    it('opens no picker under the policy, and says why', async () => {
      const picker = withPicker();
      await openDialog();
      setDevices({ noExport: true });
      fireEvent.click(screen.getByTestId('local-export-start'));
      expect(picker).not.toHaveBeenCalled();
      expect((await screen.findByTestId('local-export-refused')).textContent).toBe('export_blocked');
      expect(useMailTransferStore.getState().job).toBeNull();
    });

    it('opens no picker while the policy isn\'t known, and says that', async () => {
      const picker = withPicker();
      await openDialog();
      usePolicyStore.setState({ subjectPending: true } as never);
      fireEvent.click(screen.getByTestId('local-export-start'));
      expect(picker).not.toHaveBeenCalled();
      expect((await screen.findByTestId('local-export-refused')).textContent).toBe('policy_unknown');
      usePolicyStore.setState({ subjectPending: false } as never);
    });
  });
});

describe('what the browser can hold', () => {
  const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
  const MB = 1024 * 1024;

  /** A browser with no save picker but a private file system: the spool path. */
  function spoolBrowser(agent: string, free: number) {
    vi.stubGlobal('navigator', {
      ...navigator, userAgent: agent,
      storage: { getDirectory: async () => ({}), estimate: async () => ({ quota: free + 100, usage: 100 }) },
      locks: { request: async (name: string, _o: unknown, cb: (lock: unknown) => unknown) => cb({ name }) },
    });
    vi.stubGlobal('FileSystemFileHandle', class { createWritable() {} });
  }

  it('on WebKit stops it before it starts when the choice is over the cap, and says what to do', async () => {
    spoolBrowser(SAFARI, 100 * 1024 * MB);
    setStoreBackend(fakeStore({ status: { total: 2, kept: 2 }, size: { bytes: 600 * MB, keptBytes: 600 * MB } }) as unknown as StoreBackend);
    await openDialog();
    expect(screen.getByTestId('local-export-over-limit').textContent).toBe('over_limit');
    expect((screen.getByTestId('local-export-start') as HTMLButtonElement).disabled).toBe(true);
    // Fewer folders fit.
    fireEvent.click(screen.getAllByTestId('local-export-folder')[0]);
    expect(screen.queryByTestId('local-export-over-limit')).toBeNull();
    expect((screen.getByTestId('local-export-start') as HTMLButtonElement).disabled).toBe(false);
  });

  it('puts no such cap on Firefox', async () => {
    spoolBrowser('Mozilla/5.0 (Windows NT 10.0; rv:148.0) Gecko/20100101 Firefox/148.0', 100 * 1024 * MB);
    setStoreBackend(fakeStore({ status: { total: 2, kept: 2 }, size: { bytes: 600 * MB, keptBytes: 600 * MB } }) as unknown as StoreBackend);
    await openDialog();
    expect(screen.queryByTestId('local-export-over-limit')).toBeNull();
    expect((screen.getByTestId('local-export-start') as HTMLButtonElement).disabled).toBe(false);
  });

  it('says so when the browser has no room for the spool', async () => {
    spoolBrowser('Mozilla/5.0 (Windows NT 10.0; rv:148.0) Gecko/20100101 Firefox/148.0', 5 * MB);
    setStoreBackend(fakeStore({ status: { total: 2, kept: 2 }, size: { bytes: 3 * MB, keptBytes: 3 * MB } }) as unknown as StoreBackend);
    await openDialog();
    expect(screen.getByTestId('local-export-no-room').textContent).toBe('no_room');
    expect((screen.getByTestId('local-export-start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('counts only what will be written: offline, what is kept', async () => {
    spoolBrowser('Mozilla/5.0 (Windows NT 10.0; rv:148.0) Gecko/20100101 Firefox/148.0', 5 * MB);
    setOnline(false);
    setStoreBackend(fakeStore({ status: { total: 2, kept: 1 }, size: { bytes: 300 * MB, keptBytes: 1 * MB } }) as unknown as StoreBackend);
    await openDialog();
    expect(screen.queryByTestId('local-export-no-room')).toBeNull();
    act(() => setOnline(true));
    expect(screen.getByTestId('local-export-no-room')).toBeTruthy();
  });

  it('doesn\'t ask about room when the save picker writes elsewhere', async () => {
    spoolBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36', 5 * MB);
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn();
    setStoreBackend(fakeStore({ status: { total: 2, kept: 2 }, size: { bytes: 300 * MB, keptBytes: 300 * MB } }) as unknown as StoreBackend);
    await openDialog();
    expect(screen.queryByTestId('local-export-no-room')).toBeNull();
    expect(screen.queryByTestId('local-export-over-limit')).toBeNull();
  });

  it.each([
    ['ExportTooLargeError', 'stopped_limit'],
    ['QuotaExceededError', 'stopped_no_room'],
    ['TypeError', 'failed_generic'],
  ])('says %s in the user\'s language, never the browser\'s text', async (name, key) => {
    const sink = fakeSink();
    sink.write.mockImplementation(async () => { throw Object.assign(new Error('Some English from a browser'), { name, limit: 1024 }); });
    render(<MailTransferHost />);
    act(() => openLocalExport('acc'));
    await finishedJob(sink);
    expect(useMailTransferStore.getState().job?.progress.phase).toBe('failed');
    expect(screen.getByText(key)).toBeTruthy();
    expect(screen.queryByText(/Some English/)).toBeNull();
  });

  it('says a message failed in the user\'s language too', async () => {
    setStoreBackend(fakeStore({ rawBlob: () => { throw new Error('Some English from a server'); } }) as unknown as StoreBackend);
    render(<MailTransferHost />);
    act(() => openLocalExport('acc'));
    await finishedJob();
    expect(screen.getByText(/message_failed/)).toBeTruthy();
    expect(screen.queryByText(/Some English/)).toBeNull();
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

  it('says when the picked file couldn\'t be removed after a run that wrote nothing', async () => {
    setOnline(false);
    notKept();
    const sink = fakeSink();
    sink.abort.mockImplementation(async () => ({ leftover: 'a.mbox' }));
    render(<MailTransferHost />);
    act(() => openLocalExport('acc'));
    await finishedJob(sink);
    expect(sink.close).not.toHaveBeenCalled();
    expect(screen.getByTestId('local-export-leftover').textContent).toBe('leftover_file');
  });

  it('says nothing about a file that was removed', async () => {
    setOnline(false);
    notKept();
    const sink = fakeSink();
    sink.abort.mockImplementation(async () => ({}));
    render(<MailTransferHost />);
    act(() => openLocalExport('acc'));
    await finishedJob(sink);
    expect(sink.abort).toHaveBeenCalled();
    expect(screen.queryByTestId('local-export-leftover')).toBeNull();
  });

  it('keeps to the chosen folders on the retry, also when a new folder has turned up', async () => {
    setOnline(false);
    notKept();
    render(<MailTransferHost />);
    act(() => openLocalExport('acc'));
    await screen.findByTestId('local-export-summary');
    fireEvent.click(screen.getAllByTestId('local-export-folder')[1]);
    await finishedJob();
    act(() => setOnline(true));
    FOLDERS.push({ id: 'new', name: 'New', sortOrder: 2 });
    try {
      fireEvent.click(screen.getByTestId('local-export-retry'));
      await waitFor(() => expect(screen.getAllByTestId('local-export-folder')).toHaveLength(3));
      const boxes = screen.getAllByTestId('local-export-folder') as HTMLInputElement[];
      expect(boxes.map((box) => [box.dataset.folder, box.checked])).toEqual([['Inbox', true], ['Archive', false], ['New', false]]);
    } finally {
      FOLDERS.pop();
    }
  });

  it('takes a new folder in when all were chosen', async () => {
    setOnline(false);
    notKept();
    render(<MailTransferHost />);
    act(() => openLocalExport('acc'));
    await screen.findByTestId('local-export-summary');
    await finishedJob();
    act(() => setOnline(true));
    FOLDERS.push({ id: 'new', name: 'New', sortOrder: 2 });
    try {
      fireEvent.click(screen.getByTestId('local-export-retry'));
      await waitFor(() => expect(screen.getAllByTestId('local-export-folder')).toHaveLength(3));
      expect((screen.getAllByTestId('local-export-folder') as HTMLInputElement[]).every((box) => box.checked)).toBe(true);
    } finally {
      FOLDERS.pop();
    }
  });

  it('makes no empty file when the folders turned out empty by the time it ran, and says so', async () => {
    const store = fakeStore();
    store.answer.mockImplementation(async (_account: string, calls: [string, Record<string, unknown>, string][]) => (
      calls[0][0] === 'Mailbox/get'
        ? { methodResponses: [['Mailbox/get', { list: FOLDERS }, '0']] }
        : { methodResponses: [['Email/query', { ids: [] }, '0']] }
    ) as never);
    setStoreBackend(store as unknown as StoreBackend);
    const sink = fakeSink();
    render(<MailTransferHost />);
    act(() => openLocalExport('acc'));
    await finishedJob(sink);
    expect(sink.close).not.toHaveBeenCalled();
    expect(sink.abort).toHaveBeenCalled();
    expect(screen.getByTestId('local-export-wrote-nothing').textContent).toBe('nothing_kept');
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

describe('stopped while the file is being finished', () => {
  /** A sink whose close doesn't end until told, the way opening a large spool takes a while. */
  function slowClose() {
    const sink = fakeSink();
    const file: ExportFile = { name: 'a.mbox', size: 1, discard: vi.fn(async () => {}) };
    let finish: () => void = () => {};
    let signal: AbortSignal | undefined;
    sink.close.mockImplementation((given?: AbortSignal) => new Promise((resolve) => {
      signal = given;
      finish = () => resolve(file);
    }));
    return { sink, file, finish: () => finish(), signal: () => signal };
  }

  async function closing(sink: ExportSink) {
    expect(startLocalExport({ account: 'acc', jmap: 'jmap-a', format: 'mbox', folders: [{ mailboxId: 'inbox', path: [] }], sink })).toBe(true);
    await waitFor(() => expect((sink.close as ReturnType<typeof vi.fn>)).toHaveBeenCalled());
    return useMailTransferStore.getState().job!;
  }

  it('passes the job\'s signal to the sink', async () => {
    const slow = slowClose();
    const job = await closing(slow.sink);
    expect(slow.signal()).toBe(job.controller.signal);
    slow.finish();
    await act(async () => { await job.finished; });
  });

  it('a cancel: the file goes and the run counts as cancelled, also if the sink finished anyway', async () => {
    const slow = slowClose();
    const job = await closing(slow.sink);
    act(() => useMailTransferStore.getState().cancelJob());
    slow.finish();
    await act(async () => { await job.finished; });
    const progress = useMailTransferStore.getState().job?.progress as ExportProgress;
    expect(progress.phase).toBe('cancelled');
    expect(progress.file).toBeUndefined();
    expect(slow.file.discard).toHaveBeenCalledWith(true);
  });

  it('a wipe that outlasts its wait: the job and its file still go when it ends', async () => {
    render(<MailTransferHost />);
    const slow = slowClose();
    const job = await closing(slow.sink);
    await act(async () => { await runWipeCleaners('acc'); });
    expect(job.controller.signal.aborted).toBe(true);
    // Still running after the 1.5 s the wipe gives it.
    expect(useMailTransferStore.getState().job).not.toBeNull();
    slow.finish();
    await act(async () => { await job.finished; });
    await waitFor(() => expect(useMailTransferStore.getState().job).toBeNull());
    expect(slow.file.discard).toHaveBeenCalledWith(true);
  });

  it('a sign-out that outlasts its wait: the same', async () => {
    render(<MailTransferHost />);
    const slow = slowClose();
    const job = await closing(slow.sink);
    await act(async () => { await runBeforeSignOut('acc'); });
    slow.finish();
    await act(async () => { await job.finished; });
    await waitFor(() => expect(useMailTransferStore.getState().job).toBeNull());
    expect(slow.file.discard).toHaveBeenCalledWith(true);
  });

  it('a wipe after the dialog closed drops the finished file at once', async () => {
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: revoke }));
    render(<MailTransferHost />);
    await finishedJob(memorySink('a.mbox', 'application/mbox') as ReturnType<typeof fakeSink>);
    act(() => useMailTransferStore.getState().close());
    expect(useMailTransferStore.getState().job).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    await act(async () => { await runWipeCleaners('acc'); });
    expect(revoke).toHaveBeenCalledWith('blob:x');
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
