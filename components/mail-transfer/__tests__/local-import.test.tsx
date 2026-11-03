import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BulwarkDesktopBridge, DesktopLocalImportBridge, DesktopLocalImportFile } from '@/lib/desktop/types';
import { LocalImportPanel } from '../local-import-panel';
import { MailTransferHost } from '../mail-transfer-host';
import {
  forgetLocalImportFor,
  forgetLocalImportJob,
  readLocalImportJob,
  resumeLocalImport,
  saveLocalImportJob,
  setImportTaskbarProgress,
  startLocalImport,
} from '../local-import-job';
import { startImport } from '../start-import';
import { useAuthStore } from '@/stores/auth-store';
import { useMailTransferStore } from '@/stores/mail-transfer-store';
import type { ImportProgress } from '@/lib/mail-import/engine';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  useLocale: () => 'en',
}));
vi.mock('../start-import', () => ({ startImport: vi.fn() }));

const candidate = (over: Partial<Parameters<typeof makeScan>[0]['candidates'][number]>) => ({
  handle: 'h', app: 'thunderbird' as const, kind: 'mbox' as const, group: 'default', account: 'Local Folders', folder: ['Inbox'], name: 'default/Local Folders/Inbox', size: 1000, lastModified: 1, ...over,
});

function makeScan(over: { candidates: Array<Record<string, unknown> & { handle: string }>; refused?: { name: string; reason: 'ost' | 'in-use' }[]; thunderbirdRunning?: boolean; calendars?: number; books?: { handle: string; group: string; name: string; contacts: number }[] }) {
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

const grantedFile: DesktopLocalImportFile = { url: 'bulwark-import://f/t', name: 'default/Local Folders/Inbox', kind: 'mbox', folder: ['Inbox'], size: 1000, lastModified: 1 };

beforeEach(async () => {
  await forgetLocalImportJob();
  vi.mocked(startImport).mockReset();
  useAuthStore.setState({ client: { supportsContacts: () => false } as never, activeAccountId: 'acct' });
  useMailTransferStore.setState({ request: null, visible: false, job: null });
});
afterEach(() => {
  delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
});

describe('the list of what was found', () => {
  it('is not there in a browser', () => {
    const { container } = render(<LocalImportPanel onPick={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('asks the shell, shows the list, and only asks to read after the user confirms it', async () => {
    const localImport = bridge({
      scan: vi.fn(async () => makeScan({ candidates: [candidate({ handle: 'a' }), candidate({ handle: 'b', folder: ['Archives', '2020'], name: 'x/Archives/2020', size: 2000 })] })) as never,
      grant: vi.fn(async () => ({ ok: true as const, jobId: 'job', files: [grantedFile], contacts: [], refused: [], thunderbirdRunning: false })),
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
  const job = { id: 'job', scope: 'acct', accountId: 'acc', targetMailboxId: null, keepFolders: true, dedupe: true };

  it('remembers what it needs when it starts, and forgets it and tells the shell when it ends', async () => {
    const localImport = bridge();
    await startLocalImport({ jobId: 'job', files: [], accountId: 'acc', targetMailboxId: null, keepFolders: true, resume: false, dedupe: true });
    expect(await readLocalImportJob()).toMatchObject({ id: 'job', scope: 'acct', dedupe: true });
    const input = vi.mocked(startImport).mock.calls[0][0];
    expect(input.dedupe).toBe(true);
    expect(localImport.release).not.toHaveBeenCalled();

    // Failed comes back at the next start; done does not.
    input.onEnd!({ phase: 'failed' } as ImportProgress);
    expect(await readLocalImportJob()).not.toBeNull();
    expect(localImport.release).not.toHaveBeenCalled();
    input.onEnd!({ phase: 'done' } as ImportProgress);
    await waitFor(async () => expect(await readLocalImportJob()).toBeNull());
    expect(localImport.release).toHaveBeenCalledWith('job');
  });

  it('a cancel is the user deciding: it does not come back', async () => {
    const localImport = bridge();
    await startLocalImport({ jobId: 'job', files: [], accountId: 'acc', targetMailboxId: null, keepFolders: true, resume: false, dedupe: true });
    vi.mocked(startImport).mock.calls[0][0].onEnd!({ phase: 'cancelled' } as ImportProgress);
    await waitFor(async () => expect(await readLocalImportJob()).toBeNull());
    expect(localImport.release).toHaveBeenCalledWith('job');
  });

  it('goes on with the checkpoints and the same target when the user says continue', async () => {
    await saveLocalImportJob(job);
    const localImport = bridge({ resume: vi.fn(async () => ({ ok: true as const, jobId: 'job', files: [grantedFile], contacts: [], refused: [], thunderbirdRunning: true })) });
    expect(await resumeLocalImport()).toBe('resumed-thunderbird-running');
    expect(localImport.resume).toHaveBeenCalledWith('job');
    const input = vi.mocked(startImport).mock.calls[0][0];
    expect(input).toMatchObject({ resume: true, dedupe: true, accountId: 'acc', targetMailboxId: null, keepFolders: true });
    expect(input.files[0]).toMatchObject({ format: 'mbox', folder: ['Inbox'] });
    // A dialog to come back to from the chip, hidden.
    expect(useMailTransferStore.getState().request).toEqual({ kind: 'import' });
    expect(useMailTransferStore.getState().visible).toBe(false);
    input.onEnd!({ phase: 'done' } as ImportProgress);
  });

  it('"not now" keeps the job, "stop" and missing files drop it, and another account leaves it alone', async () => {
    await saveLocalImportJob(job);
    const resume = vi.fn<DesktopLocalImportBridge['resume']>();
    bridge({ resume });

    resume.mockResolvedValueOnce({ ok: false, reason: 'later' });
    expect(await resumeLocalImport()).toBe('later');
    expect(await readLocalImportJob()).not.toBeNull();

    useAuthStore.setState({ activeAccountId: 'someone-else' });
    resume.mockClear();
    expect(await resumeLocalImport()).toBe('none');
    expect(resume).not.toHaveBeenCalled();
    useAuthStore.setState({ activeAccountId: 'acct' });

    resume.mockResolvedValueOnce({ ok: false, reason: 'invalid' });
    expect(await resumeLocalImport()).toBe('gone');
    expect(await readLocalImportJob()).toBeNull();

    await saveLocalImportJob(job);
    resume.mockResolvedValueOnce({ ok: false, reason: 'stopped' });
    expect(await resumeLocalImport()).toBe('none');
    expect(await readLocalImportJob()).toBeNull();
    expect(startImport).not.toHaveBeenCalled();
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
      const localImport = bridge({ resume: vi.fn(async () => ({ ok: true as const, jobId: 'job', files: [grantedFile], contacts: [], refused: [], thunderbirdRunning: false })) });
      let goAway: () => void = () => {};
      void request('bulwark-local-import-job', {}, () => new Promise<void>((resolve) => { goAway = resolve; }));
      const outcome = resumeLocalImport();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(localImport.resume).not.toHaveBeenCalled();
      goAway();
      expect(await outcome).toBe('resumed');
      expect(localImport.resume).toHaveBeenCalledWith('job');
      vi.mocked(startImport).mock.calls[0][0].onEnd!({ phase: 'done' } as ImportProgress);
    });

    it('does nothing once it has the lock if the job ended meanwhile', async () => {
      const request = fakeLocks();
      await saveLocalImportJob(job);
      const localImport = bridge();
      let finish: () => void = () => {};
      void request('bulwark-local-import-job', {}, () => new Promise<void>((resolve) => { finish = resolve; }));
      const outcome = resumeLocalImport();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await forgetLocalImportJob();
      finish();
      expect(await outcome).toBe('none');
      expect(localImport.resume).not.toHaveBeenCalled();
    });
  });

  it('leaves a device-only client alone, and goes on when the real one takes over', async () => {
    await saveLocalImportJob(job);
    const localImport = bridge({ resume: vi.fn(async () => ({ ok: true as const, jobId: 'job', files: [grantedFile], contacts: [], refused: [], thunderbirdRunning: false })) });
    useAuthStore.setState({ client: { isOfflineOnly: () => true, supportsContacts: () => false, getAccountId: () => 'acc' } as never });
    render(<MailTransferHost />);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(localImport.resume).not.toHaveBeenCalled();
    expect(await readLocalImportJob()).not.toBeNull();
    // A job on it would stay on it for good.
    expect(await resumeLocalImport()).toBe('none');

    act(() => useAuthStore.setState({ client: { isOfflineOnly: () => false, supportsContacts: () => false, getAccountId: () => 'acc' } as never }));
    await waitFor(() => expect(localImport.resume).toHaveBeenCalledWith('job'));
    await waitFor(() => expect(startImport).toHaveBeenCalled());
    vi.mocked(startImport).mock.calls[0][0].onEnd!({ phase: 'done' } as ImportProgress);
  });

  it('nothing happens in a browser, or with a job already running', async () => {
    await saveLocalImportJob(job);
    expect(await resumeLocalImport()).toBe('none');
    const localImport = bridge();
    useMailTransferStore.setState({ job: { kind: 'import', controller: new AbortController(), progress: { phase: 'running' } as ImportProgress } });
    expect(await resumeLocalImport()).toBe('none');
    expect(localImport.resume).not.toHaveBeenCalled();
  });

  it('a sign-out of that account takes the job along; another account leaves it', async () => {
    await saveLocalImportJob(job);
    const localImport = bridge();
    await forgetLocalImportFor('another');
    expect(await readLocalImportJob()).not.toBeNull();
    await forgetLocalImportFor('acct');
    expect(await readLocalImportJob()).toBeNull();
    expect(localImport.release).toHaveBeenCalledWith('job');

    await saveLocalImportJob(job);
    await forgetLocalImportFor('all');
    expect(await readLocalImportJob()).toBeNull();
    expect(localImport.releaseAll).toHaveBeenCalled();
  });
});

describe('the taskbar', () => {
  it('follows the import where the shell has the bar, and does nothing where it has not', () => {
    bridge();
    expect(() => setImportTaskbarProgress({ phase: 'running', fraction: 0.5 } as ImportProgress)).not.toThrow();
    const setProgress = vi.fn();
    (window as unknown as { bulwarkDesktop: { os: unknown } }).bulwarkDesktop.os = { setProgress };
    act(() => setImportTaskbarProgress({ phase: 'running', fraction: 0.5 } as ImportProgress));
    expect(setProgress).toHaveBeenLastCalledWith(0.5, 'normal');
    setImportTaskbarProgress({ phase: 'paused', fraction: 0.6 } as ImportProgress);
    expect(setProgress).toHaveBeenLastCalledWith(0.6, 'paused');
    setImportTaskbarProgress({ phase: 'done', fraction: 1 } as ImportProgress);
    expect(setProgress).toHaveBeenLastCalledWith(null);
    setImportTaskbarProgress(null);
    expect(setProgress).toHaveBeenLastCalledWith(null);
  });
});
