/**
 * The host of Files on this computer: claiming the bridge once, the accounts it runs for, what
 * it publishes, the controller, and what sign-out, a wipe and a refused login do.
 */
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopOsNotification, FilesControls } from '@/lib/desktop/types';
import { WindowControlsHost } from '@/components/layout/window-controls-host';
import { noteCredentialsRejected } from '@/lib/offline/credentials-rejected';
import { runWipeCleaners } from '@/lib/offline/wipe-registry';
import { runBeforeSignOut } from '@/lib/sign-out-cleanup';
import type { FilesSyncController, FilesSyncSnapshot } from '../types';
import { claimFilesControls, resetFilesControlsForTests } from '../controls';
import type { DriveStatusText } from '../drive-status';
import { FilesSyncHost, type HostAccount, type QuotaTiming } from '../host';
import { answerFlush, currentFlushRequest, subscribeFlushRequests, type FilesFlushRequest } from '../flush-requests';
import { registerFilesSyncLifecycle, resetFilesSyncLifecycleForTests, setRunningFilesSyncHost } from '../lifecycle';
import { FakeDisk } from './helpers/fake-disk';
import { FakeServer } from './helpers/fake-server';

const TEXT: DriveStatusText = {
  state: (state) => `state:${state}`,
  detail: (_status, state) => `detail:${state}`,
  quota: (used, total) => (total === null ? `${used} used` : `${used} of ${total}`),
  notice: (level) => `notice:${level}`,
};

/** What Quota/get answered for dso-quota@example.org on Stalwart 1.0 (0.16 the same, but `used`), 2026-11-04. */
const STALWART_QUOTA = { id: 'a', resourceType: 'octets', used: 1048816, warnLimit: null, softLimit: null, hardLimit: 104857600, scope: 'account', name: 'dso-quota@example.org', types: ['Email', 'SieveScript', 'FileNode', 'CalendarEvent', 'ContactCard'] };

const FAST = { localDelayMs: 0, remoteDelayMs: 0, pollMs: 1e9, rescanMs: 1e9, retryMs: [1e9], soonMs: 5, fetchWaitMs: 1000 };

function fakeBridge(controls: FilesControls) {
  const claim = vi.fn<() => FilesControls | null>();
  let taken = false;
  claim.mockImplementation(() => {
    if (taken) return null;
    taken = true;
    return controls;
  });
  return { version: 1, platform: 'win32' as const, files: { claim } };
}

describe('claiming the bridge', () => {
  afterEach(() => {
    delete (window as { bulwarkDesktop?: unknown }).bulwarkDesktop;
    resetFilesControlsForTests();
  });

  it('takes the controls in the first render, once, so a frame coming later gets nothing', () => {
    const controls = new FakeDisk();
    const bridge = fakeBridge(controls);
    (window as { bulwarkDesktop?: unknown }).bulwarkDesktop = bridge;
    const { rerender } = render(createElement(WindowControlsHost));
    rerender(createElement(WindowControlsHost));
    expect(bridge.files.claim).toHaveBeenCalledTimes(1);
    expect(claimFilesControls()).toBe(controls);
    // A same-origin frame reaching the bridge through parent.
    expect(bridge.files.claim()).toBeNull();
  });

  it('takes nothing in a browser', () => {
    render(createElement(WindowControlsHost));
    expect(claimFilesControls()).toBeNull();
  });
});

interface Rig {
  host: FilesSyncHost;
  disk: FakeDisk;
  server: FakeServer;
  snapshot: () => Partial<FilesSyncSnapshot>;
  controller: () => FilesSyncController | null;
  folderOff: { value: boolean };
  account: HostAccount;
}

function rig(options: { drive?: boolean; wanted?: string[]; quota?: Record<string, unknown>[]; quotaTiming?: Partial<QuotaTiming> } = {}): Rig {
  const disk = new FakeDisk({ caseInsensitive: true, drive: options.drive });
  disk.driveWanted = options.wanted ?? [];
  const server = new FakeServer(options.quota ? { quota: options.quota } : {});
  let published: Partial<FilesSyncSnapshot> = {};
  let controller: FilesSyncController | null = null;
  const folderOff = { value: false };
  const host = new FilesSyncHost({
    controls: disk,
    platform: 'win32',
    publish: (patch) => {
      published = { ...published, ...patch };
    },
    setController: (next) => {
      controller = next;
    },
    folderSyncForcedOff: () => folderOff.value,
    downloadsForbidden: () => false,
    remoteFor: () => server.remote(),
    readUrl: disk.readUrl,
    timing: FAST,
    driveStatusText: () => TEXT,
    quotaTiming: options.quotaTiming,
  });
  const account: HostAccount = { id: 'a1', label: 'a@example.org', client: { getSessionSnapshot: () => server.session, getAuthHeader: () => 'Basic x' } };
  return { host, disk, server, snapshot: () => published, controller: () => controller, folderOff, account };
}

async function settle(host: FilesSyncHost): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await host.engine.settled();
  await new Promise((resolve) => setTimeout(resolve, 60));
}

describe('the host', () => {
  it('runs the roots of signed-in accounts, publishes the current one, and registers the controller', async () => {
    const r = rig();
    r.disk.addRoot({ id: 'r1', account: 'a1', remoteId: null });
    r.disk.addRoot({ id: 'r2', account: 'other', remoteId: null });
    r.disk.write('r1', 'a.txt', 'a');
    r.host.start();
    r.host.setAccounts([r.account], 'a1');
    await settle(r.host);
    expect(r.server.listing()).toEqual(['a.txt']);
    expect(r.snapshot()).toMatchObject({ available: true, account: 'a1', folderSyncForcedOff: false });
    expect(r.snapshot().roots?.map((root) => root.id)).toEqual(['r1']);
    expect(r.snapshot().status?.r1).toMatchObject({ state: 'idle' });
    expect(r.snapshot().activity?.[0]).toMatchObject({ kind: 'uploaded', path: 'a.txt' });
    expect(Object.values(r.snapshot().items ?? {})).toEqual(['synced']);
    expect(r.controller()).not.toBeNull();
    r.host.stop();
    expect(r.controller()).toBeNull();
  });

  it('keeps folders out of sync while the policy forbids them', async () => {
    const r = rig();
    r.folderOff.value = true;
    r.disk.addRoot({ id: 'r1', account: 'a1', remoteId: null });
    r.disk.write('r1', 'a.txt', 'a');
    r.host.start();
    r.host.setAccounts([r.account], 'a1');
    await settle(r.host);
    expect(r.server.listing()).toEqual([]);
    expect(r.snapshot().status?.r1).toMatchObject({ state: 'blocked', errorKey: 'errors.policy' });
    expect(r.snapshot().folderSyncForcedOff).toBe(true);
    r.host.stop();
  });

  it('turns the drive back on at sign-in without a click, and off at sign-out keeping the wish', async () => {
    const r = rig({ drive: true, wanted: ['a1'] });
    r.server.file('a.txt', null, 'a');
    r.host.start();
    r.host.setAccounts([r.account], 'a1');
    await settle(r.host);
    await settle(r.host);
    expect(r.disk.driveCalls[0]).toEqual({ call: 'enable', args: ['a1', 'a@example.org'] });
    expect(r.disk.listing('drive-a1')).toEqual(['a.txt']);
    expect(r.disk.states.get('drive-a1')).toContain('a.txt');
    await r.host.signedOut('a1');
    expect(r.disk.driveCalls.at(-1)).toEqual({ call: 'disable', args: ['a1', 'signed-out'] });
    expect(r.disk.driveWanted).toEqual(['a1']);
    // The record went before the folder did: the next sign-in starts from an empty one.
    expect(r.disk.states.get('drive-a1')).not.toContain('a.txt');
    r.host.stop();
  });

  it('a sign-out nobody chose only disconnects the drive: folder, edits and record stay, and the next sign-in uploads the edit', async () => {
    const r = rig({ drive: true, wanted: ['a1'] });
    r.server.file('a.txt', null, 'a');
    r.host.start();
    r.host.setAccounts([r.account], 'a1');
    await settle(r.host);
    await settle(r.host);
    r.server.offline = true;
    r.disk.write('drive-a1', 'edit.txt', 'made while the server was away');
    await r.host.signedOut('a1', false);
    expect(r.disk.driveCalls.at(-1)).toEqual({ call: 'disable', args: ['a1', 'suspended'] });
    expect(r.disk.states.get('drive-a1')).toContain('a.txt');
    r.server.offline = false;
    r.host.setAccounts([r.account], 'a1');
    await settle(r.host);
    await settle(r.host);
    expect(r.server.content(r.server.find('edit.txt')!.id)).toBe('made while the server was away');
    r.host.stop();
  });

  it('turning the drive off says where the files that weren\'t uploaded went, and opens that folder', async () => {
    const r = rig({ drive: true, wanted: ['a1'] });
    r.disk.rescueAnswer = { folder: 'C:\\Users\\ann\\Documents\\Bulwark – not uploaded\\2026-11-04', count: 2, failed: 0 };
    r.host.start();
    r.host.setAccounts([r.account], 'a1');
    await settle(r.host);
    const controller = r.controller()!;
    await controller.setDriveEnabled(false);
    await settle(r.host);
    expect(r.snapshot().rescued).toEqual(r.disk.rescueAnswer);
    expect(await controller.openRescue()).toBe(true);
    controller.dismissRescue();
    await settle(r.host);
    expect(r.snapshot().rescued).toBeNull();
    r.host.stop();
  });

  it('the sign-out gate asks the drive to upload first, and keeps the user signed in if they say so', async () => {
    const r = rig({ drive: true, wanted: ['a1'] });
    r.host.start();
    r.host.setAccounts([r.account], 'a1');
    await settle(r.host);
    await settle(r.host);
    const asked: FilesFlushRequest[] = [];
    const stop = subscribeFlushRequests(() => {
      const request = currentFlushRequest();
      if (request) asked.push(request);
    });
    const kept = r.host.signOutGate('a1');
    await expect.poll(() => asked.length).toBe(1);
    expect(asked[0]).toMatchObject({ rootId: 'drive-a1', kind: 'drive', purpose: 'sign-out' });
    answerFlush(asked[0].id, false);
    expect(await kept).toBe(false);
    const gone = r.host.signOutGate('all');
    await expect.poll(() => asked.length).toBe(2);
    answerFlush(asked[1].id, true);
    expect(await gone).toBe(true);
    // Another account's drive isn't asked about.
    expect(await r.host.signOutGate('a2')).toBe(true);
    expect(asked).toHaveLength(2);
    stop();
    r.host.stop();
  });

  it('uploads what waits when main asks before the policy removes the drive, then answers', async () => {
    const r = rig({ drive: true, wanted: ['a1'] });
    r.host.start();
    r.host.setAccounts([r.account], 'a1');
    await settle(r.host);
    await settle(r.host);
    r.disk.write('drive-a1', 'last minute.txt', 'up it goes');
    for (const listener of r.disk.flushListeners) listener({ requestId: 'q1', accounts: ['a1'] });
    await expect.poll(() => r.disk.flushed).toEqual(['q1']);
    expect(r.server.content(r.server.find('last minute.txt')!.id)).toBe('up it goes');
    r.host.stop();
  });

  it('removes the drive and forgets the folders of a wiped account, and keeps their files', async () => {
    const r = rig({ drive: true, wanted: ['a1', 'a2'] });
    r.disk.addRoot({ id: 'r1', account: 'a1', remoteId: null });
    r.disk.addRoot({ id: 'r2', account: 'a2', remoteId: null });
    r.disk.write('r1', 'mine.txt', 'mine');
    r.host.start();
    await r.host.removeAccountData('a1', 'wipe');
    expect(r.disk.driveCalls).toContainEqual({ call: 'disable', args: ['a1', 'wipe'] });
    expect(r.disk.driveCalls.some((call) => call.args[0] === 'a2')).toBe(false);
    expect(r.disk.calls).toEqual(['removeRoot r1']);
    expect(r.disk.read('r1', 'mine.txt')).toBe('mine');
    r.host.stop();
  });

  it('answers the controller: shared folders refused, the drive switch, show in folder', async () => {
    const r = rig({ drive: true });
    r.disk.addRoot({ id: 'r1', account: 'a1', remoteId: null });
    r.disk.write('r1', 'Docs/a.txt', 'a');
    r.host.start();
    r.host.setAccounts([r.account], 'a1');
    await settle(r.host);
    const controller = r.controller()!;
    expect(await controller.addFolder('shared1:n5', 'Team')).toEqual({ ok: false, error: 'unsupported' });
    expect(r.disk.calls).toEqual([]);
    const id = r.server.find('Docs/a.txt')!.id;
    expect(controller.coverage(id)).toEqual({ rootId: 'r1', kind: 'folder', path: 'Docs/a.txt' });
    expect(await controller.showInFolder(id)).toBe(true);
    expect(r.disk.shown).toEqual([{ rootId: 'r1', path: 'Docs/a.txt' }]);
    expect(await controller.showInFolder('unknown')).toBe(false);
    expect((await controller.setDriveEnabled(true)).ok).toBe(true);
    expect(r.disk.driveCalls.at(-1)).toEqual({ call: 'enable', args: ['a1', 'a@example.org'] });
    expect(await controller.setDriveEnabled(false)).toEqual({ ok: true, value: null });
    expect(r.disk.driveCalls.at(-1)).toEqual({ call: 'disable', args: ['a1', 'user'] });
    r.host.stop();
  });
});

describe('sign-out, wipe and refused logins', () => {
  let r: Rig;
  beforeEach(async () => {
    resetFilesSyncLifecycleForTests();
    registerFilesSyncLifecycle();
    r = rig({ drive: true, wanted: ['a1'] });
    r.disk.addRoot({ id: 'r1', account: 'a1', remoteId: null });
    r.host.start();
    setRunningFilesSyncHost(r.host);
  });
  afterEach(() => {
    r.host.stop();
    resetFilesSyncLifecycleForTests();
  });

  it('a wipe removes the drive and forgets the folders', async () => {
    await runWipeCleaners('a1');
    expect(r.disk.driveCalls).toContainEqual({ call: 'disable', args: ['a1', 'wipe'] });
    expect(r.disk.calls).toContain('removeRoot r1');
  });

  it('a refused login, sure or not, and a session limit only disconnect the drive and forget nothing', async () => {
    noteCredentialsRejected('a1', false, 'refused');
    noteCredentialsRejected('a1', true, 'session');
    noteCredentialsRejected('a1', true, 'refused');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const disables = r.disk.driveCalls.filter((call) => call.call === 'disable');
    expect(disables.length).toBeGreaterThan(0);
    for (const call of disables) expect(call.args).toEqual(['a1', 'suspended']);
    expect(r.disk.calls).toEqual([]);
  });

  it('a sign-out the user chose takes the drive down and keeps the folders; one the app made only disconnects it', async () => {
    await runBeforeSignOut('a1', { userInitiated: true });
    expect(r.disk.driveCalls).toContainEqual({ call: 'disable', args: ['a1', 'signed-out'] });
    expect(r.disk.calls).toEqual([]);
    r.disk.driveCalls.length = 0;
    await runBeforeSignOut('a1');
    expect(r.disk.driveCalls.filter((call) => call.call === 'disable')).toEqual([{ call: 'disable', args: ['a1', 'suspended'] }]);
  });
});

describe('OS notifications and the tray line (files-p3-5)', () => {
  const NOTIFY_TEXT = {
    massDelete: (_root: unknown, massDelete: { count: number; deletedOn: string }) => ({ title: `delete ${massDelete.count}?`, body: `deleted on ${massDelete.deletedOn}`, allow: 'Delete them', restore: 'Bring them back' }),
    conflict: (_root: unknown, entry: { path: string; detail?: string }) => ({ title: 'conflict', body: `${entry.path} kept as ${entry.detail}` }),
    problem: (_root: unknown, entry: { path: string; kind: string }) => ({ title: 'problem', body: `${entry.kind} ${entry.path}` }),
  };

  function notifyingRig(server?: Record<string, unknown>) {
    const disk = new FakeDisk({ caseInsensitive: true });
    const remote = new FakeServer(server ?? {});
    const shown: DesktopOsNotification[] = [];
    const host = new FilesSyncHost({
      controls: disk,
      platform: 'win32',
      publish: () => {},
      setController: () => {},
      folderSyncForcedOff: () => false,
      downloadsForbidden: () => false,
      remoteFor: () => remote.remote(),
      readUrl: disk.readUrl,
      timing: FAST,
      notify: (notification) => shown.push(notification),
      notifyText: () => NOTIFY_TEXT as never,
    });
    const account: HostAccount = { id: 'a1', label: 'a@example.org', client: { getSessionSnapshot: () => remote.session, getAuthHeader: () => 'Basic x' } };
    return { disk, server: remote, host, shown, account };
  }

  it('asks about a mass delete with both answers as buttons, and names conflicts and files that stay here', async () => {
    const r = notifyingRig({ maxSizeUpload: 10 });
    const folder = r.server.folder('Sync');
    r.disk.addRoot({ id: 'r1', account: 'a1', remoteId: folder.id });
    for (let i = 0; i < 60; i += 1) r.disk.write('r1', `bulk/f${i}.txt`, `file ${i}`);
    r.host.start();
    r.host.setAccounts([r.account], 'a1');
    await settle(r.host);
    // Ordinary work says nothing.
    expect(r.shown).toEqual([]);

    r.disk.deleteUser('r1', 'bulk');
    r.host.engine.syncNow();
    await settle(r.host);
    expect(r.shown).toEqual([expect.objectContaining({
      title: 'delete 61?',
      body: 'deleted on this-computer',
      context: JSON.stringify({ filesSync: 'r1' }),
      actions: [{ id: 'files-restore', label: 'Bring them back' }, { id: 'files-delete', label: 'Delete them' }],
    })]);
    r.host.engine.confirmMassDelete('r1', false);
    await settle(r.host);

    r.disk.write('r1', 'huge.bin', 'x'.repeat(20));
    r.host.engine.syncNow();
    await settle(r.host);
    expect(r.shown.at(-1)).toMatchObject({ title: 'problem', body: 'too-large huge.bin', context: JSON.stringify({ filesSync: 'r1' }) });
    r.host.stop();
  });

  it('says a conflict', async () => {
    const r = notifyingRig();
    const folder = r.server.folder('Sync');
    r.disk.addRoot({ id: 'r1', account: 'a1', remoteId: folder.id });
    r.disk.write('r1', 'doc.txt', 'v1');
    r.host.start();
    r.host.setAccounts([r.account], 'a1');
    await settle(r.host);
    r.disk.write('r1', 'doc.txt', 'here, longer');
    r.server.edit(r.server.find('Sync/doc.txt')!.id, 'there');
    r.host.engine.syncNow();
    await settle(r.host);
    expect(r.shown).toEqual([expect.objectContaining({ title: 'conflict', body: expect.stringMatching(/^doc\.txt kept as doc \(conflict, Windows, /) })]);
    r.host.stop();
  });

  it("gives main the tray's line for the drive", async () => {
    const r = rig({ drive: true, wanted: ['a1'] });
    const text = { ...TEXT, tray: (status: { state?: string } | undefined, state: string) => `Bulwark Files: ${state}` };
    (r.host as unknown as { deps: { driveStatusText: () => unknown } }).deps.driveStatusText = () => text;
    r.host.start();
    r.host.setAccounts([r.account], 'a1');
    await settle(r.host);
    await settle(r.host);
    expect(r.disk.driveStatuses.at(-1)?.status.tray).toBe('Bulwark Files: idle');
    r.host.stop();
  });
});

describe('storage and the drive in Explorer', () => {
  it("reads the server's quota, publishes it for the UI, and tells main what Explorer shows for the drive", async () => {
    const r = rig({ drive: true, wanted: ['a1'], quota: [STALWART_QUOTA] });
    r.server.file('a.txt', null, 'abc');
    r.host.start();
    r.host.setAccounts([r.account], 'a1');
    await settle(r.host);
    await settle(r.host);
    expect(r.server.quotaCalls).toBe(1);
    expect(r.snapshot().quota).toEqual({ used: 1048816, total: 104857600, source: 'server' });
    expect(r.disk.driveStatuses.at(-1)).toEqual({
      account: 'a1',
      status: { state: 'synced', label: 'state:synced', detail: 'detail:idle', quota: { used: 1048816, total: 104857600, label: '1048816 of 104857600' }, notice: null },
    });
    // Unchanged: main doesn't hear it again.
    const sent = r.disk.driveStatuses.length;
    r.host.publishNow();
    expect(r.disk.driveStatuses).toHaveLength(sent);
    r.host.stop();
  });

  it('no limit on the server: what the files take, and no total', async () => {
    const r = rig({ drive: true, wanted: ['a1'], quota: [] });
    r.server.file('a.txt', null, 'abc');
    r.server.file('b.txt', null, 'defgh');
    r.host.start();
    r.host.setAccounts([r.account], 'a1');
    await settle(r.host);
    await settle(r.host);
    expect(r.snapshot().quota).toEqual({ used: 8, total: null, source: 'files' });
    expect(r.disk.driveStatuses.at(-1)?.status.quota).toEqual({ used: 8, total: null, label: '8 used' });
    r.host.stop();
  });

  it('asks again after Files changes, at most once per gap, the last of a burst at its end', async () => {
    const r = rig({ quota: [STALWART_QUOTA], quotaTiming: { minGapMs: 300, everyMs: 1e9 } });
    r.host.start();
    r.host.setAccounts([r.account], 'a1');
    await settle(r.host);
    expect(r.server.quotaCalls).toBe(1);
    r.server.quotaList = [{ ...STALWART_QUOTA, used: 2_000_000 }];
    r.host.remoteChanged('a1');
    r.host.remoteChanged('a1');
    r.host.remoteChanged('a1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(r.server.quotaCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(r.server.quotaCalls).toBe(2);
    expect(r.snapshot().quota).toMatchObject({ used: 2_000_000 });
    r.host.stop();
  });

  it('a drive turned on again hears its status again; signed out, the storage goes', async () => {
    const r = rig({ drive: true, wanted: ['a1'], quota: [STALWART_QUOTA] });
    r.host.start();
    r.host.setAccounts([r.account], 'a1');
    await settle(r.host);
    await settle(r.host);
    const before = r.disk.driveStatuses.length;
    expect(before).toBeGreaterThan(0);
    await r.host.signedOut('a1');
    await settle(r.host);
    expect(r.snapshot().quota).toBeNull();
    r.host.setAccounts([r.account], 'a1');
    await settle(r.host);
    await settle(r.host);
    expect(r.disk.driveStatuses.length).toBeGreaterThan(before);
    expect(r.disk.driveStatuses.at(-1)).toMatchObject({ account: 'a1', status: { state: 'synced', quota: { used: 1048816 } } });
    r.host.stop();
  });
});
