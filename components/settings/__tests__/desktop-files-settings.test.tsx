import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/locales/en/common.json';
import type { FilesDriveState, FilesRoot } from '@/lib/desktop/types';
import type { FilesSyncActivity, FilesSyncController, FilesSyncRootStatus } from '@/lib/files-sync/types';

// Files on this computer, the settings page: the drive, synced folders, the
// activity list and the mass-delete question, against the store and a fake
// controller (the engine is built elsewhere).

vi.unmock('next-intl');
vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));

const { useFilesSyncStore } = await import('@/stores/files-sync-store');
const { useAuthStore } = await import('@/stores/auth-store');
const { DesktopFilesSettings } = await import('../desktop-files-settings');
const { FilesFlushDialog } = await import('@/components/files-sync/files-sync-flush');

type Fake = { [K in keyof FilesSyncController]: ReturnType<typeof vi.fn> };

function fakeController(): Fake {
  return {
    addFolder: vi.fn(async () => ({ ok: true as const, value: folderRoot() })),
    removeRoot: vi.fn(async () => {}),
    setPaused: vi.fn(async () => {}),
    confirmMassDelete: vi.fn(async () => {}),
    setDriveEnabled: vi.fn(async () => ({ ok: true as const, value: null })),
    setDriveLetter: vi.fn(async () => ({ ok: true as const, value: { letter: 'Z', chosen: 'Z', locked: false, available: [] } })),
    coverage: vi.fn(() => null),
    showInFolder: vi.fn(async () => true),
    clearActivity: vi.fn(),
    // Nothing waits here unless a test says otherwise.
    pendingHere: vi.fn(async () => []),
    flushRoot: vi.fn(async (_rootId: string, options?: { onProgress?: (waiting: string[], total: number) => void }) => {
      options?.onProgress?.([], 0);
      return 'done';
    }),
    openRescue: vi.fn(async () => true),
    openRoot: vi.fn(async () => true),
    dismissRescue: vi.fn(),
  } as never;
}

function folderRoot(patch: Partial<FilesRoot> = {}): FilesRoot {
  return {
    id: 'r1', kind: 'folder', account: 'acc', path: 'C:\\Users\\ann\\Documents\\Projects', remoteId: 'n-proj',
    remoteLabel: 'Projects', paused: false, createdAt: 1, ...patch,
  };
}

function drive(patch: Partial<FilesDriveState> = {}): FilesDriveState {
  return {
    supported: true, forcedOff: false, wanted: [],
    letter: { letter: null, chosen: null, locked: false, available: ['X', 'Z'] },
    ...patch,
  };
}

let controller: ReturnType<typeof fakeController>;

function setup(patch: Record<string, unknown> = {}) {
  controller = fakeController();
  useFilesSyncStore.setState({ available: true, account: 'acc', controller: controller as unknown as FilesSyncController, ...patch });
}

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <DesktopFilesSettings />
      <FilesFlushDialog />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  useFilesSyncStore.getState().reset();
});
afterEach(() => {
  useFilesSyncStore.getState().reset();
});

describe('Files on this computer settings page', () => {
  it('draws nothing outside the desktop app or on an older shell', () => {
    useFilesSyncStore.setState({ available: false, roots: [folderRoot()], drive: drive() });
    const { container } = renderPage();
    expect(container).toBeEmptyDOMElement();
  });

  it('has no drive section off Windows', () => {
    setup({ drive: null });
    renderPage();
    expect(screen.queryByRole('switch', { name: 'Show Files as a drive' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Synced folders' })).toBeInTheDocument();
  });

  it('turns the drive on for the account from the click itself', () => {
    setup({ drive: drive() });
    renderPage();
    const toggle = screen.getByRole('switch', { name: 'Show Files as a drive' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    // No drive, no letter.
    expect(screen.queryByText('Drive letter')).toBeNull();
    fireEvent.click(toggle);
    // Synchronously: the shell needs the click it came from.
    expect(controller.setDriveEnabled).toHaveBeenCalledWith(true);
  });

  it('shows the drive on, and turns it off', async () => {
    setup({ drive: drive({ wanted: ['acc'] }) });
    renderPage();
    const toggle = screen.getByRole('switch', { name: 'Show Files as a drive' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    await waitFor(() => expect(controller.setDriveEnabled).toHaveBeenCalledWith(false));
  });

  it('uploads what waits before turning the drive off, and keeps it on when the user says so (files-p3-2)', async () => {
    setup({ drive: drive({ wanted: ['acc'] }), roots: [folderRoot({ id: 'd1', kind: 'drive', remoteId: null, remoteLabel: 'acc' })] });
    let finish: (outcome: string) => void = () => {};
    controller.flushRoot.mockImplementation((_rootId: string, options?: { onProgress?: (waiting: string[], total: number) => void }) => {
      options?.onProgress?.(['Notes/notes.txt', 'unsynced new.txt'], 3);
      return new Promise((resolve) => { finish = resolve; });
    });
    renderPage();
    expect(screen.getByTestId('files-sync-drive-off-note')).toHaveTextContent('Your files stay in Files.');
    fireEvent.click(screen.getByRole('switch', { name: 'Show Files as a drive' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Uploading changes before the drive turns off' });
    expect(controller.flushRoot).toHaveBeenCalledWith('d1', expect.anything());
    expect(dialog).toHaveTextContent('Still to upload: notes.txt, unsynced new.txt');
    expect(within(dialog).getByRole('progressbar', { name: '1 of 3 uploaded' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent('Documents\\Bulwark – not uploaded');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep the drive on' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    finish('cancelled');
    expect(controller.setDriveEnabled).not.toHaveBeenCalled();
  });

  it('turns the drive off once everything is uploaded, or right away when the server is away and the user goes on', async () => {
    setup({ drive: drive({ wanted: ['acc'] }), roots: [folderRoot({ id: 'd1', kind: 'drive', remoteId: null, remoteLabel: 'acc' })] });
    controller.flushRoot.mockImplementation(async (_rootId: string, options?: { onProgress?: (waiting: string[], total: number) => void }) => {
      options?.onProgress?.(['a.txt'], 1);
      return 'offline';
    });
    renderPage();
    fireEvent.click(screen.getByRole('switch', { name: 'Show Files as a drive' }));
    const dialog = await screen.findByRole('alertdialog', { name: "Some changes can't be uploaded now" });
    expect(dialog).toHaveTextContent("The server can't be reached. Not uploaded yet: a.txt");
    expect(controller.setDriveEnabled).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off now' }));
    await waitFor(() => expect(controller.setDriveEnabled).toHaveBeenCalledWith(false));
  });

  it("says where the files that weren't uploaded went, and opens that folder", () => {
    const folder = 'C:\\Users\\ann\\Documents\\Bulwark – not uploaded\\2026-11-04';
    setup({ drive: drive(), rescued: { folder, count: 2, failed: 0 } });
    renderPage();
    const notice = screen.getByTestId('files-sync-rescued');
    expect(notice).toHaveTextContent(`Files that weren't uploaded (2) are in ${folder} now.`);
    fireEvent.click(within(notice).getByRole('button', { name: 'Open folder' }));
    expect(controller.openRescue).toHaveBeenCalled();
    fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss' }));
    expect(controller.dismissRescue).toHaveBeenCalled();
  });

  it('says the organisation turned the drive off and keeps the switch off', () => {
    setup({ drive: drive({ forcedOff: true, wanted: ['acc'] }) });
    renderPage();
    const toggle = screen.getByRole('switch', { name: 'Show Files as a drive' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toBeDisabled();
    expect(screen.getByText(en.settings.org_locked)).toBeInTheDocument();
  });

  it('offers no letter by default and the free letters, and sets the chosen one', () => {
    setup({ drive: drive({ wanted: ['acc'] }) });
    renderPage();
    const select = screen.getByRole('combobox', { name: 'Drive letter' }) as HTMLSelectElement;
    expect(select.value).toBe('none');
    expect([...select.options].map((o) => o.textContent)).toEqual(['No letter', 'X:', 'Z:']);
    fireEvent.change(select, { target: { value: 'Z' } });
    expect(controller.setDriveLetter).toHaveBeenCalledWith('Z');
    fireEvent.change(select, { target: { value: 'none' } });
    expect(controller.setDriveLetter).toHaveBeenLastCalledWith(null);
  });

  it('shows a letter forced by policy, locked', () => {
    setup({ drive: drive({ wanted: ['acc'], letter: { letter: 'Q', chosen: 'X', locked: true, available: ['X'] } }) });
    renderPage();
    const select = screen.getByRole('combobox', { name: 'Drive letter' }) as HTMLSelectElement;
    expect(select.value).toBe('Q');
    expect(select).toBeDisabled();
    const row = select.closest('[data-search-label]') as HTMLElement;
    expect(within(row).getByText(en.settings.org_locked)).toBeInTheDocument();
  });

  it('lists a synced folder with its Files folder and pauses and resumes it', () => {
    setup({ roots: [folderRoot()], status: { r1: { rootId: 'r1', state: 'idle', pending: 0, done: 0, lastSyncedAt: null } } });
    const { rerender } = renderPage();
    expect(screen.getByText('C:\\Users\\ann\\Documents\\Projects')).toBeInTheDocument();
    expect(screen.getByText('With Projects in Files')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(controller.setPaused).toHaveBeenCalledWith('r1', true);

    act(() => useFilesSyncStore.setState({ roots: [folderRoot({ paused: true })], status: { r1: { rootId: 'r1', state: 'paused', pending: 0, done: 0, lastSyncedAt: null } } }));
    rerender(
      <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
        <DesktopFilesSettings />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(controller.setPaused).toHaveBeenLastCalledWith('r1', false);
  });

  it('asks before removing a folder, saying its files stay', async () => {
    setup({ roots: [folderRoot()] });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Stop syncing…' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('The files on this computer stay where they are');
    expect(controller.removeRoot).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop syncing' }));
    await waitFor(() => expect(controller.removeRoot).toHaveBeenCalledWith('r1'));
    expect(controller.flushRoot).toHaveBeenCalledWith('r1', expect.anything());
  });

  it("uploads a folder's changes before it stops; what can't go stays in the folder", async () => {
    setup({ roots: [folderRoot()] });
    controller.flushRoot.mockImplementation(async (_rootId: string, options?: { onProgress?: (waiting: string[], total: number) => void }) => {
      options?.onProgress?.(['big.iso'], 1);
      return 'stuck';
    });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Stop syncing…' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Stop syncing' }));
    const dialog = await screen.findByRole('alertdialog', { name: "Some changes can't be uploaded now" });
    expect(dialog).toHaveTextContent('stays in the folder on this computer');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep syncing' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(controller.removeRoot).not.toHaveBeenCalled();
  });

  it('says how each folder is doing', () => {
    const at = Date.UTC(2026, 10, 4, 14, 5);
    vi.useFakeTimers({ now: at + 60_000, toFake: ['Date'] });
    const states: [string, Partial<FilesSyncRootStatus>][] = [
      ['idle', { lastSyncedAt: at }],
      ['syncing', { done: 3, pending: 7 }],
      ['paused', {}],
      ['offline', { pending: 2 }],
      ['error', { errorKey: 'files_sync.errors.quota' }],
      ['blocked', {}],
      ['starting', {}],
    ];
    const roots = states.map(([state]) => folderRoot({ id: state, path: `/home/ann/${state}` }));
    const status = Object.fromEntries(states.map(([state, extra]) => [state, { rootId: state, state, pending: 0, done: 0, lastSyncedAt: null, ...extra }]));
    setup({ roots, status });
    renderPage();
    const line = (id: string) => document.querySelector(`[data-files-sync-root="${id}"] [data-files-sync-state]`)!.textContent;
    // The app's 24-hour setting (the default), not the language's 12-hour clock (settings-p3-12).
    expect(line('idle')).toBe('Up to date. Last synced 14:05');
    expect(line('syncing')).toBe('Syncing: 3 done, 7 to go');
    expect(line('paused')).toBe('Paused');
    expect(line('offline')).toBe('Offline. 2 changes wait for the server');
    expect(line('error')).toBe('Stopped: Your storage in Files is full');
    expect(line('blocked')).toBe('Turned off by your organisation');
    expect(line('starting')).toBe('Starting…');
    // A blocked folder can't be resumed, only removed.
    expect(within(document.querySelector('[data-files-sync-root="blocked"]') as HTMLElement).queryByRole('button', { name: 'Resume' })).toBeNull();
    vi.useRealTimers();
  });

  it('shows an unknown error key as a plain failure, never the key', () => {
    setup({ roots: [folderRoot()], status: { r1: { rootId: 'r1', state: 'error', pending: 0, done: 0, lastSyncedAt: null, errorKey: 'something_new' } } });
    renderPage();
    expect(screen.getByText('Stopped: Something went wrong')).toBeInTheDocument();
  });

  it('adds a folder: picks the Files folder, then calls the controller from that click', async () => {
    const listAllFileNodes = vi.fn(async () => [
      { id: 'n-proj', name: 'Projects', parentId: null, blobId: null },
      { id: 'n-2026', name: '2026', parentId: 'n-proj', blobId: null },
      { id: 'n-file', name: 'a.txt', parentId: 'n-proj', blobId: 'b1' },
    ]);
    useAuthStore.setState({ client: { listAllFileNodes } as never });
    setup({ roots: [] });
    renderPage();
    expect(screen.getByText('No folders are synced yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Which folder in Files?' });
    // Only folders are offered.
    expect(within(dialog).queryByText('a.txt')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Expand Projects' }));
    await waitFor(() => expect(within(dialog).getByText('2026')).toBeInTheDocument());
    fireEvent.click(within(dialog).getByText('2026'));
    expect(controller.addFolder).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose folder on this computer…' }));
    // In the same task as the click: nothing slow is awaited first.
    expect(controller.addFolder).toHaveBeenCalledWith('n-2026', 'Projects / 2026');
    useAuthStore.setState({ client: null });
  });

  it('says why a folder could not be added, and nothing when the picker was closed', async () => {
    useAuthStore.setState({ client: { listAllFileNodes: vi.fn(async () => [{ id: 'n-proj', name: 'Projects', parentId: null, blobId: null }]) } as never });
    setup({ roots: [] });
    controller.addFolder.mockResolvedValueOnce({ ok: false, error: 'overlap' });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('Projects'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose folder on this computer…' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(en.files_sync.folders.add_failed.overlap);

    controller.addFolder.mockResolvedValueOnce({ ok: false, error: 'cancelled' });
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('Projects'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose folder on this computer…' }));
    await waitFor(() => expect(controller.addFolder).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    useAuthStore.setState({ client: null });
  });

  it('hides adding folders when the organisation turned folder sync off', () => {
    setup({ folderSyncForcedOff: true, roots: [folderRoot()], status: { r1: { rootId: 'r1', state: 'blocked', pending: 0, done: 0, lastSyncedAt: null } } });
    renderPage();
    expect(screen.queryByRole('button', { name: 'Add folder…' })).toBeNull();
    expect(screen.getByTestId('files-sync-folders-locked')).toHaveTextContent(en.settings.org_locked);
    // The folder can still be removed; its files stay.
    expect(screen.getByRole('button', { name: 'Stop syncing…' })).toBeInTheDocument();
  });

  it('lists recent activity newest first, marks conflicts and errors, and clears it', () => {
    const activity: FilesSyncActivity[] = [
      { id: 'a1', at: 1000, rootId: 'r1', kind: 'uploaded', direction: 'up', path: 'notes.txt' },
      { id: 'a3', at: 3000, rootId: 'r1', kind: 'error', direction: 'up', path: 'big.iso', messageKey: 'files_sync.errors.quota' },
      { id: 'a2', at: 2000, rootId: 'r1', kind: 'conflict', direction: null, path: 'plan.docx', detail: 'plan (conflict, PC, 2026-11-04).docx' },
      { id: 'a4', at: 500, rootId: 'r1', kind: 'too-large', direction: null, path: 'video.mp4', detail: '1048576' },
    ];
    setup({ roots: [folderRoot()], activity });
    renderPage();
    const rows = within(screen.getByTestId('files-sync-activity')).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-activity-kind'))).toEqual(['error', 'conflict', 'uploaded', 'too-large']);
    expect(rows[0]).toHaveTextContent('big.iso couldn\'t be synced: Your storage in Files is full');
    expect(within(rows[0]).getByRole('img', { name: 'Error' })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('plan.docx was changed in both places. The other version is kept as plan (conflict, PC, 2026-11-04).docx');
    expect(within(rows[1]).getByRole('img', { name: 'Conflict' })).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent('Projects');
    expect(rows[2]).toHaveTextContent('Uploaded notes.txt');
    expect(within(rows[2]).getByRole('img', { name: 'To Files' })).toBeInTheDocument();
    expect(rows[3]).toHaveTextContent('video.mp4 is bigger than Files allows (1 MB)');
    expect(within(rows[3]).getByRole('img', { name: 'Error' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(controller.clearActivity).toHaveBeenCalled();
  });

  it('has a line for every kind of activity', () => {
    const kinds = ['uploaded', 'downloaded', 'folder-created', 'renamed', 'moved', 'deleted', 'trashed', 'conflict', 'renamed-for-disk', 'too-large', 'waiting', 'mass-delete', 'error'] as const;
    setup({ roots: [folderRoot()], activity: kinds.map((kind, i) => ({ id: kind, at: 10_000 - i, rootId: 'r1', kind, direction: null, path: 'x.txt', detail: 'y.txt' })) });
    renderPage();
    const rows = within(screen.getByTestId('files-sync-activity')).getAllByRole('listitem');
    expect(rows).toHaveLength(kinds.length);
    for (const row of rows) expect(row.textContent).not.toMatch(/files_sync\.|\{/);
  });

  it('says when nothing happened yet, with no Clear to press', () => {
    setup({ roots: [folderRoot()] });
    renderPage();
    expect(screen.getByText('Nothing has happened yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });

  it("follows the app's 12-hour setting for times (settings-p3-12)", async () => {
    const { useSettingsStore } = await import('@/stores/settings-store');
    const before = useSettingsStore.getState().timeFormat;
    useSettingsStore.setState({ timeFormat: '12h' });
    const at = Date.UTC(2026, 10, 4, 14, 5);
    vi.useFakeTimers({ now: at + 60_000, toFake: ['Date'] });
    try {
      setup({
        roots: [folderRoot()],
        status: { r1: { rootId: 'r1', state: 'idle', pending: 0, done: 0, lastSyncedAt: at } },
        activity: [{ id: 'x', at, rootId: 'r1', account: 'acc', kind: 'uploaded', direction: 'up', path: 'a.txt' }],
      });
      renderPage();
      expect(document.querySelector('[data-files-sync-root="r1"] [data-files-sync-state]')!.textContent).toBe('Up to date. Last synced 2:05 PM');
      expect(screen.getByTestId('files-sync-activity').querySelector('time')!.textContent).toBe('2:05 PM');
    } finally {
      vi.useRealTimers();
      useSettingsStore.setState({ timeFormat: before });
    }
  });

  it('says how many changes wait while offline, names a file Files has under another name here and why, and groups many such lines', () => {
    const line = (id: string, extra: Partial<FilesSyncActivity>): FilesSyncActivity => ({ id, at: 1, rootId: 'r1', account: 'acc', kind: 'uploaded', direction: null, path: '', ...extra });
    setup({
      roots: [folderRoot()],
      activity: [
        line('w', { kind: 'waiting', detail: '3', messageKey: 'errors.offline', at: 10 }),
        line('n', { kind: 'renamed-for-disk', path: 'Seed/back\\slash.txt', detail: 'back＼slash.txt', messageKey: 'disk_name', at: 9 }),
        line('u', { kind: 'uploaded', path: 'x.txt', at: 8 }),
        ...[1, 2, 3, 4].map((n) => line(`g${n}`, { kind: 'renamed-for-disk', path: `Seed/Report${n}.txt`, detail: `report${n} (2).txt`, messageKey: 'disk_case', at: 5 - n })),
      ],
    });
    renderPage();
    const list = screen.getByTestId('files-sync-activity');
    expect(list).toHaveTextContent("Changes waiting for the server: 3: The server can't be reached");
    expect(list).toHaveTextContent("Seed/back\\slash.txt in Files is called back＼slash.txt on this computer, because some of its characters aren't allowed here");
    const group = list.querySelector('[data-activity-kind="renamed-for-disk-group"]') as HTMLElement;
    expect(group).toHaveTextContent("Names in Files that this computer doesn't allow: 4.");
    expect(group).not.toHaveTextContent('Seed/Report1.txt');
    fireEvent.click(within(group).getByRole('button', { name: 'Show' }));
    expect(group).toHaveTextContent('Seed/Report1.txt in Files is called report1 (2).txt on this computer, because a name that differs only in upper and lower case is already here');
  });

  it("keeps files that can't sync on top until they're gone (files-p3-13)", () => {
    setup({
      roots: [folderRoot()],
      status: { r1: { rootId: 'r1', state: 'idle', pending: 0, done: 0, lastSyncedAt: null, cantSync: [{ path: 'huge.iso', limit: 50 * 1048576 }] } },
    });
    renderPage();
    expect(screen.getByTestId('files-sync-cant-sync')).toHaveTextContent("Can't sync");
    expect(screen.getByTestId('files-sync-cant-sync')).toHaveTextContent('huge.iso is bigger than Files allows (50 MB). It stays on this computer only');
  });

  it('asks about a mass delete in the folder row, with both answers', () => {
    setup({
      roots: [folderRoot(), folderRoot({ id: 'r2', path: '/home/ann/Photos', remoteLabel: 'Photos' })],
      status: {
        r1: { rootId: 'r1', state: 'confirm-delete', pending: 0, done: 0, lastSyncedAt: null, massDelete: { count: 120, deletedOn: 'this-computer' } },
        r2: { rootId: 'r2', state: 'confirm-delete', pending: 0, done: 0, lastSyncedAt: null, massDelete: { count: 64, deletedOn: 'files' } },
      },
    });
    renderPage();
    const first = document.querySelector('[data-files-sync-root="r1"]') as HTMLElement;
    expect(first).toHaveTextContent('120 items were deleted from Projects on this computer. Delete them in Files too?');
    const second = document.querySelector('[data-files-sync-root="r2"]') as HTMLElement;
    expect(second).toHaveTextContent('64 items were deleted from Photos in Files. Delete them on this computer too?');
    fireEvent.click(within(first).getByRole('button', { name: 'Delete them' }));
    expect(controller.confirmMassDelete).toHaveBeenCalledWith('r1', true);
    fireEvent.click(within(second).getByRole('button', { name: 'Bring them back' }));
    expect(controller.confirmMassDelete).toHaveBeenLastCalledWith('r2', false);
  });
});

describe('opening, pausing and the letter (files-p3-7, p3-10, p3-14 to p3-19, settings-p3-3)', () => {
  const driveRoot = () => folderRoot({ id: 'd1', kind: 'drive', remoteId: null, remoteLabel: 'acc', path: 'C:\\Users\\ann\\Bulwark Files\\ann@example.org' });

  it('says where the drive is, with its letter, and opens it', () => {
    setup({ drive: drive({ wanted: ['acc'], letter: { letter: 'Z', chosen: 'Z', locked: false, available: ['X'] } }), roots: [driveRoot()] });
    renderPage();
    const where = screen.getByTestId('files-sync-drive-where');
    expect(where).toHaveTextContent('In File Explorer as Bulwark Files (Z:)');
    expect(where).toHaveTextContent('C:\\Users\\ann\\Bulwark Files\\ann@example.org');
    fireEvent.click(within(where).getByRole('button', { name: 'Open' }));
    expect(controller.openRoot).toHaveBeenCalledWith('d1');
    // The letter option says what Explorer shows through it.
    expect(screen.getByText(/Through the letter, File Explorer shows no sync status/)).toBeInTheDocument();
  });

  it('pauses and resumes the drive', () => {
    setup({ drive: drive({ wanted: ['acc'] }), roots: [driveRoot()] });
    renderPage();
    fireEvent.click(within(screen.getByTestId('files-sync-drive-where')).getByRole('button', { name: 'Pause' }));
    expect(controller.setPaused).toHaveBeenCalledWith('d1', true);
  });

  it('says Starting… while the drive is wanted and not there yet', () => {
    setup({ drive: drive({ wanted: ['acc'] }), roots: [] });
    renderPage();
    expect(screen.getByText('Starting…')).toBeInTheDocument();
  });

  it('opens a synced folder from its path and its Open button', () => {
    setup({ roots: [folderRoot()] });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'C:\\Users\\ann\\Documents\\Projects' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(controller.openRoot).toHaveBeenCalledTimes(2);
    expect(controller.openRoot).toHaveBeenCalledWith('r1');
  });

  it('hides Pause while a folder waits for the mass-delete answer', () => {
    setup({ roots: [folderRoot()], status: { r1: { rootId: 'r1', state: 'confirm-delete', pending: 0, done: 0, lastSyncedAt: null, massDelete: { count: 70, deletedOn: 'files' } } } });
    renderPage();
    const row = document.querySelector('[data-files-sync-root="r1"]') as HTMLElement;
    expect(within(row).queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(within(row).getByRole('button', { name: 'Bring them back' })).toBeInTheDocument();
  });

  it('shows no letter row while the organisation keeps the drive off, even with a forced letter', () => {
    setup({ drive: drive({ forcedOff: true, wanted: ['acc'], letter: { letter: null, chosen: null, locked: true, available: [] } }) });
    renderPage();
    expect(screen.queryByRole('combobox', { name: 'Drive letter' })).toBeNull();
  });

  it("says a letter that couldn't be set in its own words, and nothing when no key press came with it", async () => {
    setup({ drive: drive({ wanted: ['acc'] }), roots: [driveRoot()] });
    controller.setDriveLetter.mockResolvedValueOnce({ ok: false, error: 'gesture' });
    renderPage();
    const select = screen.getByRole('combobox', { name: 'Drive letter' });
    fireEvent.change(select, { target: { value: 'X' } });
    await act(async () => {});
    expect(screen.queryByRole('alert')).toBeNull();
    controller.setDriveLetter.mockResolvedValueOnce({ ok: false, error: 'exists' });
    fireEvent.change(select, { target: { value: 'Z' } });
    expect(await screen.findByRole('alert')).toHaveTextContent("The drive letter couldn't be set. Try again.");
    expect(screen.queryByText("The folder couldn't be added. Try again.")).toBeNull();
  });
});

describe('the drive and starting with Windows (files-p3-4)', () => {
  function osBridge(startAtLogin: boolean) {
    let settings = { closeToTray: true, startAtLogin, startMinimized: false, attentionOnNewMail: true, quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '07:00', showShortcut: null };
    const listeners = new Set<(status: unknown) => void>();
    const status = () => ({ settings, pausedUntil: null, shortcutActive: false });
    const os = {
      getStatus: vi.fn(async () => status()),
      onStatusChange: vi.fn((listener: (status: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      setSettings: vi.fn(async (patch: Record<string, unknown>) => {
        settings = { ...settings, ...patch };
        const next = status();
        for (const listener of listeners) listener(next);
        return next;
      }),
    };
    (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, platform: 'win32', os };
    return os;
  }
  afterEach(() => {
    delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
  });

  it('turning the drive on also starts Bulwark with Windows, from the same click', async () => {
    const os = osBridge(false);
    setup({ drive: drive() });
    renderPage();
    await waitFor(() => expect(os.getStatus).toHaveBeenCalled());
    await act(async () => {});
    fireEvent.click(screen.getByRole('switch', { name: 'Show Files as a drive' }));
    expect(os.setSettings).toHaveBeenCalledWith({ startAtLogin: true });
    expect(controller.setDriveEnabled).toHaveBeenCalledWith(true);
  });

  it('shows the option checked under the drive, says why, and warns once the user unticks it', async () => {
    const os = osBridge(true);
    setup({ drive: drive({ wanted: ['acc'] }) });
    renderPage();
    const box = await screen.findByRole('checkbox', { name: /Start Bulwark when you sign in to Windows/ });
    expect(box).toBeChecked();
    expect(screen.getByText('The drive needs Bulwark running, as OneDrive does.')).toBeInTheDocument();
    expect(screen.queryByTestId('files-sync-closed-warning')).toBeNull();
    fireEvent.click(box);
    expect(os.setSettings).toHaveBeenCalledWith({ startAtLogin: false });
    expect(await screen.findByTestId('files-sync-closed-warning')).toHaveTextContent("Files in the drive can't open while Bulwark is closed.");
  });
});

describe('storage on the Files on this computer page', () => {
  it("shows the server's limit with a bar, and says when it is full", () => {
    setup({ quota: { used: 95 * 1048576, total: 100 * 1048576, source: 'server' } });
    renderPage();
    const section = screen.getByTestId('files-sync-storage');
    expect(section).toHaveTextContent('95 MB of 100 MB used');
    expect(within(section).getByRole('progressbar', { name: 'Storage in Files' })).toHaveAttribute('aria-valuenow', '95');
    expect(section).toHaveTextContent('Your storage in Files is full');
    expect(section).toHaveAttribute('data-quota-level', 'full');
  });

  it('without a limit on the server: what the files take, and no bar', () => {
    setup({ quota: { used: 7 * 1048576, total: null, source: 'files' } });
    renderPage();
    const section = screen.getByTestId('files-sync-storage');
    expect(section).toHaveTextContent('7 MB used');
    expect(section).toHaveTextContent('Your server sets no limit. This is what your files take.');
    expect(within(section).queryByRole('progressbar')).toBeNull();
  });

  // The section is there before the numbers, so a settings search for storage lands on it.
  it('shows the storage section as loading, with no numbers, before they are known', () => {
    setup({ quota: null });
    renderPage();
    const section = screen.getByTestId('files-sync-storage');
    expect(section).toHaveAttribute('aria-busy', 'true');
    expect(section.textContent).toBe('');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});
