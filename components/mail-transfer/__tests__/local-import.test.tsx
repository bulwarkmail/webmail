import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BulwarkDesktopBridge, DesktopLocalImportBridge, DesktopLocalImportFile } from '@/lib/desktop/types';
import { LocalImportPanel } from '../local-import-panel';
import { MailTransferHost } from '../mail-transfer-host';
import { forgetLocalImportFor, resumeLocalImport, startLocalImport, stopTryingRefused } from '../local-import-job';
import { forgetLocalImportJob, readLocalImportJob, saveLocalImportJob, type LocalImportJobRecord } from '@/lib/desktop/local-import';
import { startImport } from '../start-import';
import { runBeforeSignOut } from '@/lib/sign-out-cleanup';
import { runWipeCleaners } from '@/lib/offline/wipe-registry';
import { useAuthStore } from '@/stores/auth-store';
import { useMailTransferStore } from '@/stores/mail-transfer-store';
import { toast } from '@/stores/toast-store';
import type { ImportProgress } from '@/lib/mail-import/engine';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  useLocale: () => 'en',
}));
vi.mock('../start-import', () => ({ startImport: vi.fn() }));

const candidate = (over: Record<string, unknown>) => ({
  handle: 'h', app: 'thunderbird' as const, kind: 'mbox' as const, group: 'default', account: 'Local Folders', folder: ['Inbox'], name: 'default/Local Folders/Inbox', size: 1000, lastModified: 1, ...over,
});

function makeScan(over: { candidates: Array<Record<string, unknown>>; refused?: { name: string; reason: 'ost' | 'in-use' }[]; thunderbirdRunning?: boolean; calendars?: number; incomplete?: boolean; books?: { handle: string; group: string; name: string; contacts: number }[] }) {
  return { ok: true as const, books: [], refused: [], calendars: 0, thunderbirdRunning: false, ...over };
}

function bridge(over: Partial<DesktopLocalImportBridge> = {}): DesktopLocalImportBridge {
  const localImport: DesktopLocalImportBridge = {
    scan: vi.fn(),
    grant: vi.fn(),
    resume: vi.fn(),
    release: vi.fn(async () => {}),
    releaseAll: vi.fn(async () => {}),
    ...over,
  };
  (window as unknown as { bulwarkDesktop: BulwarkDesktopBridge }).bulwarkDesktop = { version: 1, platform: 'win32', localImport };
  return localImport;
}

const SCOPE = 'acct';
const grantedFile: DesktopLocalImportFile = { url: 'bulwark-import://f/t', name: 'default/Local Folders/Inbox', kind: 'mbox', folder: ['Inbox'], size: 1000, lastModified: 1 };
const job: LocalImportJobRecord = { id: 'job', scope: SCOPE, accountId: 'acc', targetMailboxId: null, keepFolders: true, dedupe: true };
const granted = (over: Record<string, unknown> = {}) => ({ ok: true as const, jobId: 'job', files: [grantedFile], contacts: [], refused: [] as string[], thunderbirdRunning: false, ...over });

beforeEach(async () => {
  await forgetLocalImportJob(SCOPE);
  await forgetLocalImportJob('someone-else');
  vi.mocked(startImport).mockReset();
  useAuthStore.setState({ client: { supportsContacts: () => false, getAccountId: () => 'acc' } as never, activeAccountId: SCOPE });
  useMailTransferStore.setState({ request: null, visible: false, job: null });
});
afterEach(() => {
  delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
  vi.restoreAllMocks();
});

const ended = (phase: ImportProgress['phase'], call = 0) => vi.mocked(startImport).mock.calls[call][0].onEnd!({ phase } as ImportProgress);

describe('the list of what was found', () => {
  it('is not there in a browser', () => {
    const { container } = render(<LocalImportPanel onPick={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('asks the shell, shows the list, and only asks to read after the user confirms it', async () => {
    const localImport = bridge({
      scan: vi.fn(async () => makeScan({ candidates: [candidate({ handle: 'a' }), candidate({ handle: 'b', folder: ['Archives', '2020'], name: 'x/Archives/2020', size: 2000 })] })) as never,
      grant: vi.fn(async () => granted()),
    });
    const onPick = vi.fn();
    render(<LocalImportPanel onPick={onPick} />);
    expect(localImport.scan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('local-import-find'));
    await screen.findByTestId('local-import-list');
    expect(screen.getByText('Archives / 2020')).toBeTruthy();
    expect(localImport.grant).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    // Unticking one leaves it out of what's asked for.
    fireEvent.click(screen.getAllByTestId('local-import-item')[1]);
    fireEvent.click(screen.getByTestId('local-import-confirm'));
    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(localImport.grant).toHaveBeenCalledWith(['a']);
    expect(onPick.mock.calls[0][0]).toMatchObject({ jobId: 'job', files: [grantedFile] });
  });

  it('says so when the user declined at either question, and reads nothing', async () => {
    const localImport = bridge({ scan: vi.fn(async () => ({ ok: false as const, reason: 'declined' as const })) });
    const onPick = vi.fn();
    render(<LocalImportPanel onPick={onPick} />);
    fireEvent.click(screen.getByTestId('local-import-find'));
    expect((await screen.findByTestId('local-import-note')).textContent).toBe('scan_declined');
    expect(localImport.grant).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('says so when the search failed, and when it was stopped part way', async () => {
    const scan = vi.fn<DesktopLocalImportBridge['scan']>();
    bridge({ scan });
    render(<LocalImportPanel onPick={() => {}} />);
    scan.mockResolvedValueOnce({ ok: false, reason: 'failed' });
    fireEvent.click(screen.getByTestId('local-import-find'));
    expect((await screen.findByTestId('local-import-note')).textContent).toBe('scan_failed');
    scan.mockResolvedValueOnce(makeScan({ candidates: [candidate({ handle: 'a' })], incomplete: true }) as never);
    fireEvent.click(screen.getByTestId('local-import-find'));
    expect((await screen.findByTestId('local-import-incomplete')).textContent).toBe('scan_incomplete');
    expect(screen.getAllByTestId('local-import-item')).toHaveLength(1);
  });

  it('names an .ost as not offered, with the reason, and it has no checkbox', async () => {
    bridge({ scan: vi.fn(async () => makeScan({ candidates: [], refused: [{ name: 'me.ost', reason: 'ost' }] })) as never });
    render(<LocalImportPanel onPick={() => {}} />);
    fireEvent.click(screen.getByTestId('local-import-find'));
    expect((await screen.findByTestId('local-import-ost')).textContent).toContain('ost_refused');
    expect(screen.getByTestId('local-import-ost').textContent).toContain('me.ost');
    expect(screen.queryAllByTestId('local-import-item')).toHaveLength(0);
    expect(screen.getByTestId('local-import-nothing')).toBeTruthy();
    expect(screen.queryByTestId('local-import-confirm')).toBeNull();
  });

  it('says a PST held by Outlook needs Outlook closed, apart from the .ost note', async () => {
    bridge({ scan: vi.fn(async () => makeScan({ candidates: [], refused: [{ name: 'Open.pst', reason: 'in-use' }] })) as never });
    render(<LocalImportPanel onPick={() => {}} />);
    fireEvent.click(screen.getByTestId('local-import-find'));
    expect((await screen.findByTestId('local-import-in-use')).textContent).toContain('pst_in_use');
    expect(screen.getByTestId('local-import-in-use').textContent).toContain('Open.pst');
    expect(screen.queryByTestId('local-import-ost')).toBeNull();
  });

  it('warns when Thunderbird is running, and says calendars stay out', async () => {
    bridge({ scan: vi.fn(async () => makeScan({ candidates: [candidate({ handle: 'a' })], thunderbirdRunning: true, calendars: 1 })) as never });
    render(<LocalImportPanel onPick={() => {}} />);
    fireEvent.click(screen.getByTestId('local-import-find'));
    expect((await screen.findByTestId('local-import-running')).textContent).toContain('thunderbird_running');
    expect(screen.getByTestId('local-import-calendars')).toBeTruthy();
  });

  it('says nothing about hours when a selection is well under the limit', async () => {
    bridge({ scan: vi.fn(async () => makeScan({ candidates: [candidate({ handle: 'a', size: 1_000_000 })] })) as never });
    render(<LocalImportPanel onPick={() => {}} />);
    fireEvent.click(screen.getByTestId('local-import-find'));
    await screen.findByTestId('local-import-list');
    expect(screen.queryByTestId('local-import-estimate')).toBeNull();
  });

  it('gives an honest estimate of the selection, and Trash and Junk start unticked', async () => {
    bridge({
      scan: vi.fn(async () => makeScan({
        candidates: [
          candidate({ handle: 'a', size: 5_000_000_000 }),
          candidate({ handle: 'trash', folder: ['Trash'], name: 'x/Trash', size: 9_000_000_000 }),
          candidate({ handle: 'junk', folder: ['Junk'], name: 'x/Junk', size: 9_000_000_000 }),
        ],
      })) as never,
    });
    render(<LocalImportPanel onPick={() => {}} />);
    fireEvent.click(screen.getByTestId('local-import-find'));
    const estimate = await screen.findByTestId('local-import-estimate');
    // 5 GB at 50 MB an hour is 100 hours: 5 days, and only the ticked one counts.
    expect(estimate.textContent).toContain('duration_days');
    expect(estimate.textContent).toContain('{\\"count\\":5}');
    const boxes = screen.getAllByTestId('local-import-item') as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, false, false]);
  });
});

describe('an import that goes on after a restart', () => {
  const start = (over: Partial<Parameters<typeof startLocalImport>[0]> = {}) =>
    startLocalImport({ jobId: 'job', files: [], handPicked: [], accountId: 'acc', targetMailboxId: null, keepFolders: true, resume: false, dedupe: true, ...over });

  it('remembers what it needs when it starts, and forgets it and tells the shell when it ends', async () => {
    const localImport = bridge();
    expect(await start()).toBe(true);
    expect(await readLocalImportJob(SCOPE)).toMatchObject({ id: 'job', scope: SCOPE, dedupe: true });
    const input = vi.mocked(startImport).mock.calls[0][0];
    expect(input.dedupe).toBe(true);
    expect(localImport.release).not.toHaveBeenCalled();

    // Failed comes back at the next start; done does not.
    input.onEnd!({ phase: 'failed' } as ImportProgress);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await readLocalImportJob(SCOPE)).not.toBeNull();
    expect(localImport.release).not.toHaveBeenCalled();
    input.onEnd!({ phase: 'done' } as ImportProgress);
    await waitFor(async () => expect(await readLocalImportJob(SCOPE)).toBeNull());
    await waitFor(() => expect(localImport.release).toHaveBeenCalledWith('job'));
  });

  it('a cancel is the user deciding: it does not come back', async () => {
    const localImport = bridge();
    await start();
    ended('cancelled');
    await waitFor(async () => expect(await readLocalImportJob(SCOPE)).toBeNull());
    await waitFor(() => expect(localImport.release).toHaveBeenCalledWith('job'));
  });

  it('one account starting an import leaves another account\'s job alone', async () => {
    bridge();
    await saveLocalImportJob({ ...job, id: 'theirs', scope: 'someone-else' });
    await start();
    expect(await readLocalImportJob('someone-else')).toMatchObject({ id: 'theirs' });
    expect(await readLocalImportJob(SCOPE)).toMatchObject({ id: 'job' });
    ended('done');
  });

  it('goes on with the checkpoints and the same target when the user says continue', async () => {
    await saveLocalImportJob(job);
    const localImport = bridge({ resume: vi.fn(async () => granted({ thunderbirdRunning: true })) });
    expect(await resumeLocalImport()).toMatchObject({ outcome: 'resumed', thunderbirdRunning: true });
    expect(localImport.resume).toHaveBeenCalledWith('job');
    const input = vi.mocked(startImport).mock.calls[0][0];
    expect(input).toMatchObject({ resume: true, dedupe: true, accountId: 'acc', targetMailboxId: null, keepFolders: true });
    expect(input.files[0]).toMatchObject({ format: 'mbox', folder: ['Inbox'] });
    // A dialog to come back to from the chip, hidden.
    expect(useMailTransferStore.getState().request).toEqual({ kind: 'import' });
    expect(useMailTransferStore.getState().visible).toBe(false);
    ended('done');
  });

  it('"not now" keeps the job, "stop" and missing files drop it, and another account leaves it alone', async () => {
    await saveLocalImportJob(job);
    const resume = vi.fn<DesktopLocalImportBridge['resume']>();
    bridge({ resume });

    resume.mockResolvedValueOnce({ ok: false, reason: 'later' });
    expect((await resumeLocalImport()).outcome).toBe('later');
    expect(await readLocalImportJob(SCOPE)).not.toBeNull();

    useAuthStore.setState({ activeAccountId: 'someone-else' });
    resume.mockClear();
    expect((await resumeLocalImport()).outcome).toBe('none');
    expect(resume).not.toHaveBeenCalled();
    useAuthStore.setState({ activeAccountId: SCOPE });

    resume.mockResolvedValueOnce({ ok: false, reason: 'invalid', refused: ['p/Inbox'] });
    expect(await resumeLocalImport()).toEqual({ outcome: 'gone', refused: ['p/Inbox'] });
    expect(await readLocalImportJob(SCOPE)).toBeNull();

    await saveLocalImportJob(job);
    resume.mockResolvedValueOnce({ ok: false, reason: 'stopped' });
    expect((await resumeLocalImport()).outcome).toBe('none');
    expect(await readLocalImportJob(SCOPE)).toBeNull();
    expect(startImport).not.toHaveBeenCalled();
  });

  it('files that are held right now keep the job, and are named', async () => {
    await saveLocalImportJob(job);
    bridge({ resume: vi.fn(async () => ({ ok: false as const, reason: 'in-use' as const, refused: ['p/Inbox'] })) });
    expect(await resumeLocalImport()).toEqual({ outcome: 'later', refused: ['p/Inbox'] });
    expect(await readLocalImportJob(SCOPE)).not.toBeNull();
  });

  describe('when a resume can only read some of the folders', () => {
    const other: DesktopLocalImportFile = { ...grantedFile, name: 'p/Other', url: 'bulwark-import://f/o' };

    it('goes on with the rest, keeps the job open for them, and at the next start asks for only those', async () => {
      await saveLocalImportJob(job);
      const resume = vi.fn<DesktopLocalImportBridge['resume']>().mockResolvedValueOnce(granted({ refused: ['p/Other'] }));
      const localImport = bridge({ resume });
      expect(await resumeLocalImport()).toMatchObject({ outcome: 'resumed', refused: ['p/Other'] });
      expect(vi.mocked(startImport).mock.calls[0][0].files).toHaveLength(1);

      // The rest finished, and the job is still open: the shell keeps the paths.
      ended('done');
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await readLocalImportJob(SCOPE)).toMatchObject({ retryOnly: ['p/Other'] });
      expect(localImport.release).not.toHaveBeenCalled();

      // Next start: the folder is back. What finished before is not read again.
      useMailTransferStore.setState({ request: null, visible: false, job: null });
      resume.mockResolvedValueOnce(granted({ files: [grantedFile, other] }));
      expect((await resumeLocalImport()).outcome).toBe('resumed');
      expect(vi.mocked(startImport).mock.calls[1][0].files.map((f) => f.file.name)).toEqual(['p/Other']);
      ended('done', 1);
      await waitFor(async () => expect(await readLocalImportJob(SCOPE)).toBeNull());
      await waitFor(() => expect(localImport.release).toHaveBeenCalledWith('job'));
    });

    it('names them in a toast with the choice to stop trying, which ends the job when it is done', async () => {
      await saveLocalImportJob(job);
      const localImport = bridge({ resume: vi.fn(async () => granted({ refused: ['p/Other'] })) });
      const warn = vi.spyOn(toast, 'warning');
      render(<MailTransferHost />);
      await waitFor(() => expect(warn).toHaveBeenCalled());
      const [text, options] = warn.mock.calls.find(([message]) => String(message).startsWith('resume_refused'))!;
      expect(text).toContain('p/Other');
      const action = (options as { action: { label: string; onClick: () => void } }).action;
      expect(action.label).toBe('resume_stop_trying');

      // The rest is still importing: that goes on, and the job ends with it.
      act(() => useMailTransferStore.setState({ job: { kind: 'import', controller: new AbortController(), progress: { phase: 'running', fraction: 0.1 } as ImportProgress } }));
      await act(async () => {
        action.onClick();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(await readLocalImportJob(SCOPE)).toMatchObject({ retryOnly: [] });
      expect(localImport.release).not.toHaveBeenCalled();
      ended('done');
      await waitFor(async () => expect(await readLocalImportJob(SCOPE)).toBeNull());
      await waitFor(() => expect(localImport.release).toHaveBeenCalledWith('job'));
    });

    it('with no job running, stop trying lets it go at once', async () => {
      await saveLocalImportJob({ ...job, retryOnly: ['p/Other'] });
      const localImport = bridge();
      await stopTryingRefused(SCOPE);
      expect(await readLocalImportJob(SCOPE)).toBeNull();
      expect(localImport.release).toHaveBeenCalledWith('job');
    });

    it('with nothing readable among what is left, the job waits and says so', async () => {
      await saveLocalImportJob({ ...job, retryOnly: ['p/Other'] });
      bridge({ resume: vi.fn(async () => granted({ refused: ['p/Other'] })) });
      expect(await resumeLocalImport()).toMatchObject({ outcome: 'later', refused: ['p/Other'] });
      expect(startImport).not.toHaveBeenCalled();
      expect(await readLocalImportJob(SCOPE)).toMatchObject({ retryOnly: ['p/Other'] });
    });
  });

  it('names files chosen by hand once, since they can not come back by themselves', async () => {
    bridge();
    await start({ handPicked: ['old.mbox'] });
    expect(await readLocalImportJob(SCOPE)).toMatchObject({ handPicked: ['old.mbox'] });
    ended('failed');
    await new Promise((resolve) => setTimeout(resolve, 10));

    useMailTransferStore.setState({ request: null, visible: false, job: null });
    bridge({ resume: vi.fn(async () => granted()) });
    const warn = vi.spyOn(toast, 'warning');
    render(<MailTransferHost />);
    await waitFor(() => expect(warn.mock.calls.some(([message]) => String(message).includes('resume_hand_picked') && String(message).includes('old.mbox'))).toBe(true));
    expect((await readLocalImportJob(SCOPE))?.handPicked).toEqual([]);
    ended('done', 1);
  });

  it('refuses to start while another window holds this account\'s job', async () => {
    const release = vi.fn();
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), {
      locks: { request: (_name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => unknown) => (options.ifAvailable ? Promise.resolve(callback(null)) : new Promise(release)) },
    }));
    bridge();
    expect(await start()).toBe(false);
    expect(startImport).not.toHaveBeenCalled();
    expect(await readLocalImportJob(SCOPE)).toBeNull();
    vi.unstubAllGlobals();
  });

  describe('with another window holding the job', () => {
    /** Web Locks as the browser does them, for what a window holds and what another waits for. */
    function fakeLocks() {
      const held = new Map<string, Array<() => void>>();
      const request = (name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => unknown) => {
        const queue = held.get(name) ?? [];
        held.set(name, queue);
        const run = () => Promise.resolve(callback({ name })).finally(() => {
          queue.shift();
          queue[0]?.();
        });
        if (queue.length && options.ifAvailable) return Promise.resolve(callback(null));
        return new Promise((resolve, reject) => {
          queue.push(() => { run().then(resolve, reject); });
          if (queue.length === 1) queue[0]();
        });
      };
      vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { locks: { request } }));
      return request;
    }
    afterEach(() => vi.unstubAllGlobals());

    it('waits, and takes over when that window goes away', async () => {
      const request = fakeLocks();
      await saveLocalImportJob(job);
      const localImport = bridge({ resume: vi.fn(async () => granted()) });
      let goAway: () => void = () => {};
      void request(`bulwark-local-import-job:${SCOPE}`, {}, () => new Promise<void>((resolve) => { goAway = resolve; }));
      const outcome = resumeLocalImport();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(localImport.resume).not.toHaveBeenCalled();
      goAway();
      expect((await outcome).outcome).toBe('resumed');
      expect(localImport.resume).toHaveBeenCalledWith('job');
      ended('done');
    });

    it('does nothing once it has the lock if the job ended meanwhile', async () => {
      const request = fakeLocks();
      await saveLocalImportJob(job);
      const localImport = bridge();
      let finish: () => void = () => {};
      void request(`bulwark-local-import-job:${SCOPE}`, {}, () => new Promise<void>((resolve) => { finish = resolve; }));
      const outcome = resumeLocalImport();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await forgetLocalImportJob(SCOPE);
      finish();
      expect((await outcome).outcome).toBe('none');
      expect(localImport.resume).not.toHaveBeenCalled();
    });
  });

  it('leaves a device-only client alone, and goes on when the real one takes over', async () => {
    await saveLocalImportJob(job);
    const localImport = bridge({ resume: vi.fn(async () => granted()) });
    useAuthStore.setState({ client: { isOfflineOnly: () => true, supportsContacts: () => false, getAccountId: () => 'acc' } as never });
    render(<MailTransferHost />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(localImport.resume).not.toHaveBeenCalled();
    expect(await readLocalImportJob(SCOPE)).not.toBeNull();
    // A job on it would stay on it for good.
    expect((await resumeLocalImport()).outcome).toBe('none');

    act(() => useAuthStore.setState({ client: { isOfflineOnly: () => false, supportsContacts: () => false, getAccountId: () => 'acc' } as never }));
    await waitFor(() => expect(localImport.resume).toHaveBeenCalledWith('job'));
    await waitFor(() => expect(startImport).toHaveBeenCalled());
    ended('done');
  });

  it('nothing happens in a browser, or with a job already running', async () => {
    await saveLocalImportJob(job);
    expect((await resumeLocalImport()).outcome).toBe('none');
    const localImport = bridge();
    useMailTransferStore.setState({ job: { kind: 'import', controller: new AbortController(), progress: { phase: 'running' } as ImportProgress } });
    expect((await resumeLocalImport()).outcome).toBe('none');
    expect(localImport.resume).not.toHaveBeenCalled();
  });

  it('forgetting by account takes that one, and everyone takes them all', async () => {
    await saveLocalImportJob(job);
    await saveLocalImportJob({ ...job, id: 'theirs', scope: 'someone-else' });
    const localImport = bridge();
    await forgetLocalImportFor('another');
    expect(await readLocalImportJob(SCOPE)).not.toBeNull();
    await forgetLocalImportFor(SCOPE);
    expect(await readLocalImportJob(SCOPE)).toBeNull();
    expect(await readLocalImportJob('someone-else')).not.toBeNull();
    expect(localImport.release).toHaveBeenCalledWith('job');

    await forgetLocalImportFor('all');
    expect(await readLocalImportJob('someone-else')).toBeNull();
    expect(localImport.releaseAll).toHaveBeenCalled();
  });
});

describe('what the mounted host is wired to', () => {
  it('a sign-out of the account releases its job in the shell, through the real registry', async () => {
    await saveLocalImportJob(job);
    await saveLocalImportJob({ ...job, id: 'theirs', scope: 'someone-else' });
    const localImport = bridge({ resume: vi.fn(async () => ({ ok: false as const, reason: 'later' as const })) });
    const { unmount } = render(<MailTransferHost />);
    await runBeforeSignOut(SCOPE);
    expect(await readLocalImportJob(SCOPE)).toBeNull();
    expect(localImport.release).toHaveBeenCalledWith('job');
    expect(await readLocalImportJob('someone-else')).not.toBeNull();
    expect(localImport.release).not.toHaveBeenCalledWith('theirs');

    await runBeforeSignOut('all');
    expect(await readLocalImportJob('someone-else')).toBeNull();
    expect(localImport.releaseAll).toHaveBeenCalled();
    unmount();
    // Unmounted, it's no longer signed up.
    await saveLocalImportJob(job);
    await runBeforeSignOut(SCOPE);
    expect(await readLocalImportJob(SCOPE)).not.toBeNull();
  });

  it('a wipe does the same through the wipe registry', async () => {
    await saveLocalImportJob(job);
    const localImport = bridge({ resume: vi.fn(async () => ({ ok: false as const, reason: 'later' as const })) });
    render(<MailTransferHost />);
    await runWipeCleaners(SCOPE);
    expect(await readLocalImportJob(SCOPE)).toBeNull();
    expect(localImport.release).toHaveBeenCalledWith('job');
    await runWipeCleaners(null);
    expect(localImport.releaseAll).toHaveBeenCalled();
  });

  it('the taskbar follows an import through the one helper, and does nothing where the shell has no bar', async () => {
    bridge({ resume: vi.fn(async () => ({ ok: false as const, reason: 'later' as const })) });
    const setProgress = vi.fn();
    render(<MailTransferHost />);
    const running = (progress: Partial<ImportProgress>) =>
      act(() => useMailTransferStore.setState({ job: { kind: 'import', controller: new AbortController(), progress: progress as ImportProgress } }));
    // No bar here: nothing breaks.
    running({ phase: 'running', fraction: 0.2 });
    (window as unknown as { bulwarkDesktop: { os: unknown } }).bulwarkDesktop.os = { setProgress };
    running({ phase: 'running', fraction: 0.5 });
    expect(setProgress).toHaveBeenLastCalledWith(0.5, 'normal');
    running({ phase: 'paused', fraction: 0.6 });
    expect(setProgress).toHaveBeenLastCalledWith(0.6, 'paused');
    running({ phase: 'done', fraction: 1 });
    expect(setProgress.mock.lastCall?.[0]).toBeNull();
  });
});
