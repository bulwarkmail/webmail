/**
 * The host of Files on this computer: claiming the bridge once, the accounts it runs for, what
 * it publishes, the controller, and what sign-out, a wipe and a refused login do.
 */
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilesControls } from '@/lib/desktop/types';
import { WindowControlsHost } from '@/components/layout/window-controls-host';
import { noteCredentialsRejected } from '@/lib/offline/credentials-rejected';
import { runWipeCleaners } from '@/lib/offline/wipe-registry';
import { runBeforeSignOut } from '@/lib/sign-out-cleanup';
import type { FilesSyncController, FilesSyncSnapshot } from '../types';
import { claimFilesControls, resetFilesControlsForTests } from '../controls';
import { FilesSyncHost, type HostAccount } from '../host';
import { registerFilesSyncLifecycle, resetFilesSyncLifecycleForTests, setRunningFilesSyncHost } from '../lifecycle';
import { FakeDisk } from './helpers/fake-disk';
import { FakeServer } from './helpers/fake-server';

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

function rig(options: { drive?: boolean; wanted?: string[] } = {}): Rig {
  const disk = new FakeDisk({ caseInsensitive: true, drive: options.drive });
  disk.driveWanted = options.wanted ?? [];
  const server = new FakeServer();
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

  it('a refused login the server is sure of does the same, an unsure one nothing', async () => {
    noteCredentialsRejected('a1', false, 'refused');
    noteCredentialsRejected('a1', true, 'session');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.disk.driveCalls.filter((call) => call.call === 'disable')).toEqual([]);
    noteCredentialsRejected('a1', true, 'refused');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.disk.driveCalls).toContainEqual({ call: 'disable', args: ['a1', 'refused'] });
    expect(r.disk.calls).toContain('removeRoot r1');
  });

  it('a sign-out takes the drive down and keeps the folders', async () => {
    await runBeforeSignOut('a1');
    expect(r.disk.driveCalls).toContainEqual({ call: 'disable', args: ['a1', 'signed-out'] });
    expect(r.disk.calls).toEqual([]);
  });
});
