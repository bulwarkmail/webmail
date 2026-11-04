// @vitest-environment node
/**
 * The sync engine against an in-memory disk (main's answers) and a fake FileNode server
 * (Stalwart's). Each test changes one side or both and checks both sides afterwards.
 */
import { describe, expect, it } from 'vitest';
import type { FilesRoot } from '@/lib/desktop/types';
import { FilesSyncEngine, type EngineTiming } from '../engine';
import { namingFor } from '../names';
import { parseRecord } from '../state';
import { FakeDisk, str, text } from './helpers/fake-disk';
import { FakeServer, type FakeServerOptions } from './helpers/fake-server';

const FAST: Partial<EngineTiming> = { localDelayMs: 0, remoteDelayMs: 0, pollMs: 1e9, rescanMs: 1e9, retryMs: [1e9], soonMs: 5, fetchWaitMs: 2000 };

interface Setup {
  server: FakeServer;
  disk: FakeDisk;
  engine: FilesSyncEngine;
  root: FilesRoot;
  sync: () => Promise<void>;
  kinds: () => string[];
}

async function setup(options: { server?: FakeServerOptions; drive?: boolean; remoteFolder?: string | null; platform?: string; seed?: (server: FakeServer, disk: FakeDisk, rootId: string) => void } = {}): Promise<Setup> {
  const server = new FakeServer(options.server);
  const platform = options.platform ?? 'win32';
  const disk = new FakeDisk({ caseInsensitive: platform !== 'linux', drive: options.drive });
  let remoteId: string | null = null;
  if (options.remoteFolder !== null && !options.drive) remoteId = server.folder(options.remoteFolder ?? 'Sync').id;
  const root = disk.addRoot({ id: 'r1', account: 'a1', kind: options.drive ? 'drive' : 'folder', remoteId });
  options.seed?.(server, disk, root.id);
  const engine = new FilesSyncEngine({ controls: disk, naming: namingFor(platform), device: 'Laptop', readUrl: disk.readUrl, timing: FAST, now: () => disk.clock });
  engine.start();
  engine.setAccount('a1', server.remote());
  const sync = async () => {
    await engine.refreshRoots();
    engine.syncNow();
    await engine.settled();
  };
  await sync();
  return { server, disk, engine, root, sync, kinds: () => engine.activity.map((entry) => `${entry.kind} ${entry.path}${entry.detail ? ` (${entry.detail})` : ''}`).reverse() };
}

/** What's under the root's Files folder, as paths relative to it. */
function remoteUnder(server: FakeServer, folder = 'Sync'): string[] {
  return server.listing().filter((path) => path.startsWith(`${folder}/`)).map((path) => path.slice(folder.length + 1)).filter(Boolean);
}

describe('first sync', () => {
  it('puts both sides together without deleting anything', async () => {
    const { server, disk } = await setup({
      seed: (s, d, rootId) => {
        const sync = s.find('Sync')!;
        const docs = s.folder('Docs', sync.id);
        s.file('a.txt', docs.id, 'remote a');
        s.file('top.txt', sync.id, 'top');
        d.write(rootId, 'notes.txt', 'local notes');
        d.write(rootId, 'Pics/p.png', 'png');
      },
    });
    expect(disk.listing('r1')).toEqual(['Docs/', 'Docs/a.txt', 'Pics/', 'Pics/p.png', 'notes.txt', 'top.txt']);
    expect(remoteUnder(server)).toEqual(['Docs/', 'Docs/a.txt', 'Pics/', 'Pics/p.png', 'notes.txt', 'top.txt']);
    expect(disk.read('r1', 'Docs/a.txt')).toBe('remote a');
    expect(server.content(server.find('Sync/notes.txt')!.id)).toBe('local notes');
    expect(disk.trashed).toEqual([]);
    const record = parseRecord(disk.states.get('r1') ?? null, server.find('Sync')!.id);
    expect(record.items.map((item) => item.path).sort()).toEqual(['Docs', 'Docs/a.txt', 'Pics', 'Pics/p.png', 'notes.txt', 'top.txt']);
  });

  it('takes the same file on both sides as one, and keeps both when they differ', async () => {
    const { server, disk, kinds } = await setup({
      seed: (s, d, rootId) => {
        const sync = s.find('Sync')!;
        s.file('same.txt', sync.id, 'identical');
        s.file('differ.txt', sync.id, 'from files');
        d.write(rootId, 'same.txt', 'identical');
        d.write(rootId, 'differ.txt', 'from here');
      },
    });
    expect(server.uploads).toEqual([9]);
    expect(disk.read('r1', 'differ.txt')).toBe('from files');
    const copy = disk.listing('r1').find((path) => path.startsWith('differ (conflict, Laptop, '));
    expect(copy).toBeDefined();
    expect(disk.read('r1', copy!)).toBe('from here');
    expect(server.content(server.find(`Sync/${copy}`)!.id)).toBe('from here');
    expect(kinds()).toContain(`conflict differ.txt (${copy})`);
  });

  it('syncs the top of Files, without the trash, when the pair names no folder', async () => {
    const s = await setup({
      remoteFolder: null,
      seed: (server) => {
        server.file('root.txt', null, 'at the top');
        server.file('old.txt', server.folder('.Trash').id, 'deleted');
      },
    });
    expect(s.disk.listing('r1')).toEqual(['root.txt']);
    s.disk.write('r1', 'up.txt', 'new');
    await s.sync();
    expect(s.server.listing()).toEqual(['root.txt', 'up.txt']);
  });
});

describe('files the computer makes for itself', () => {
  it('never uploads them', async () => {
    const s = await setup({ seed: (server, disk, rootId) => { disk.write(rootId, 'desktop.ini', 'x'); disk.write(rootId, 'Docs/~$report.docx', 'lock'); disk.write(rootId, 'Docs/report.docx', 'r'); } });
    expect(remoteUnder(s.server)).toEqual(['Docs/', 'Docs/report.docx']);
  });
});

describe('renames and moves', () => {
  it('sends a rename and a move made here, without uploading again', async () => {
    const s = await setup({ seed: (server, disk, rootId) => { disk.write(rootId, 'a.txt', 'aaa'); disk.mkdirUser(rootId, 'Folder'); } });
    const id = s.server.find('Sync/a.txt')!.id;
    const uploads = s.server.uploads.length;
    s.disk.moveUser('r1', 'a.txt', 'Folder/b.txt');
    await s.sync();
    expect(remoteUnder(s.server)).toEqual(['Folder/', 'Folder/b.txt']);
    expect(s.server.find('Sync/Folder/b.txt')!.id).toBe(id);
    expect(s.server.uploads.length).toBe(uploads);
    expect(s.kinds()).toContain('moved Folder/b.txt (a.txt)');
  });

  it('moves a file here when it moved in Files, keeping the same file', async () => {
    const s = await setup({ seed: (server) => { const sync = server.find('Sync')!; server.folder('Other', sync.id); server.file('x.txt', sync.id, 'xx'); } });
    const fileId = s.disk.node('r1', 'x.txt').fileId;
    const downloads = s.server.downloads.length;
    s.server.rename(s.server.find('Sync/x.txt')!.id, 'y.txt', s.server.find('Sync/Other')!.id);
    await s.sync();
    expect(s.disk.listing('r1')).toEqual(['Other/', 'Other/y.txt']);
    expect(s.disk.node('r1', 'Other/y.txt').fileId).toBe(fileId);
    expect(s.server.downloads.length).toBe(downloads);
  });

  it('moves a whole folder either way with what is in it', async () => {
    const s = await setup({ seed: (server, disk, rootId) => { disk.write(rootId, 'A/one.txt', '1'); disk.write(rootId, 'A/B/two.txt', '2'); } });
    s.disk.moveUser('r1', 'A', 'Renamed');
    await s.sync();
    expect(remoteUnder(s.server)).toEqual(['Renamed/', 'Renamed/B/', 'Renamed/B/two.txt', 'Renamed/one.txt']);
    s.server.rename(s.server.find('Sync/Renamed')!.id, 'Back');
    await s.sync();
    expect(s.disk.listing('r1')).toEqual(['Back/', 'Back/B/', 'Back/B/two.txt', 'Back/one.txt']);
    expect(s.disk.trashed).toEqual([]);
  });

  it('lets the place in Files win when both sides renamed the same file', async () => {
    const s = await setup({ seed: (server, disk, rootId) => disk.write(rootId, 'doc.txt', 'd') });
    s.disk.moveUser('r1', 'doc.txt', 'mine.txt');
    s.server.rename(s.server.find('Sync/doc.txt')!.id, 'theirs.txt');
    await s.sync();
    expect(s.disk.listing('r1')).toEqual(['theirs.txt']);
    expect(remoteUnder(s.server)).toEqual(['theirs.txt']);
  });

  it('does case-only renames both ways', async () => {
    const s = await setup({ seed: (server, disk, rootId) => disk.write(rootId, 'readme.txt', 'r') });
    s.disk.moveUser('r1', 'readme.txt', 'README.txt');
    await s.sync();
    expect(remoteUnder(s.server)).toEqual(['README.txt']);
    s.server.rename(s.server.find('Sync/README.txt')!.id, 'ReadMe.txt');
    await s.sync();
    expect(s.disk.listing('r1')).toEqual(['ReadMe.txt']);
    expect(s.server.uploads.length).toBe(1);
  });
});

describe('conflicts', () => {
  it('keeps both versions when both sides changed a file', async () => {
    const s = await setup({ seed: (server, disk, rootId) => disk.write(rootId, 'report.txt', 'v1') });
    const id = s.server.find('Sync/report.txt')!.id;
    s.disk.write('r1', 'report.txt', 'mine, longer');
    s.server.edit(id, 'theirs');
    await s.sync();
    expect(s.disk.read('r1', 'report.txt')).toBe('theirs');
    expect(s.server.content(id)).toBe('theirs');
    const copy = s.disk.listing('r1').find((path) => path.startsWith('report (conflict, Laptop, '))!;
    expect(copy).toMatch(/^report \(conflict, Laptop, \d{4}-\d\d-\d\d \d\d\.\d\d\)\.txt$/);
    expect(s.disk.read('r1', copy)).toBe('mine, longer');
    expect(s.server.content(s.server.find(`Sync/${copy}`)!.id)).toBe('mine, longer');
    expect(s.engine.activity.some((entry) => entry.kind === 'conflict' && entry.detail === copy)).toBe(true);
  });

  it('brings back a file deleted here that was changed in Files', async () => {
    const s = await setup({ seed: (server, disk, rootId) => disk.write(rootId, 'keep.txt', 'v1') });
    const id = s.server.find('Sync/keep.txt')!.id;
    s.disk.deleteUser('r1', 'keep.txt');
    s.server.edit(id, 'edited elsewhere');
    await s.sync();
    expect(s.disk.read('r1', 'keep.txt')).toBe('edited elsewhere');
    expect(s.server.find('Sync/keep.txt')!.id).toBe(id);
  });

  it('uploads again a file changed here that was deleted in Files', async () => {
    const s = await setup({ seed: (server, disk, rootId) => disk.write(rootId, 'mine.txt', 'v1') });
    s.server.destroyTree(s.server.find('Sync/mine.txt')!.id);
    s.disk.write('r1', 'mine.txt', 'v2 here');
    await s.sync();
    expect(s.server.content(s.server.find('Sync/mine.txt')!.id)).toBe('v2 here');
    expect(s.disk.read('r1', 'mine.txt')).toBe('v2 here');
  });

  it('keeps a folder deleted in Files when something new was put in it here', async () => {
    const s = await setup({ seed: (server, disk, rootId) => disk.write(rootId, 'F/old.txt', 'old') });
    s.server.destroyTree(s.server.find('Sync/F')!.id);
    s.disk.write('r1', 'F/new.txt', 'new');
    await s.sync();
    expect(remoteUnder(s.server)).toEqual(['F/', 'F/new.txt', 'F/old.txt']);
    expect(s.disk.trashed).toEqual([]);
  });
});

describe('deletes', () => {
  it('puts a file deleted here into the Files trash', async () => {
    const s = await setup({ seed: (server, disk, rootId) => { disk.write(rootId, 'gone.txt', 'g'); disk.write(rootId, 'stay.txt', 's'); } });
    const id = s.server.find('Sync/gone.txt')!.id;
    s.disk.deleteUser('r1', 'gone.txt');
    await s.sync();
    expect(remoteUnder(s.server)).toEqual(['stay.txt']);
    const trashed = s.server.listing(true).find((path) => path.endsWith('/gone.txt'))!;
    expect(trashed).toMatch(new RegExp(`^\\.Trash/\\d+~${s.server.find('Sync')!.id}/gone\\.txt$`));
    expect(s.server.nodes.has(id)).toBe(true);
    expect(s.kinds()).toContain('trashed gone.txt');
  });

  it('puts a file deleted in Files into the computer trash', async () => {
    const s = await setup({ seed: (server, disk, rootId) => { disk.write(rootId, 'x.txt', 'x'); disk.write(rootId, 'y.txt', 'y'); } });
    s.server.destroyTree(s.server.find('Sync/x.txt')!.id);
    await s.sync();
    expect(s.disk.listing('r1')).toEqual(['y.txt']);
    expect(s.disk.trashed).toEqual(['x.txt']);
  });

  function many(server: FakeServer, disk: FakeDisk, rootId: string): void {
    void server;
    for (let i = 0; i < 60; i += 1) disk.write(rootId, `bulk/f${i}.txt`, `file ${i}`);
    disk.write(rootId, 'other.txt', 'o');
  }

  it('asks before many deletes made here, and brings them back on no', async () => {
    const s = await setup({ seed: many });
    s.disk.deleteUser('r1', 'bulk');
    await s.sync();
    expect(s.engine.status().r1).toMatchObject({ state: 'confirm-delete', massDelete: { count: 61, side: 'remote' } });
    expect(remoteUnder(s.server)).toContain('bulk/f0.txt');
    expect(s.kinds()).toContain('mass-delete  (61)');
    s.engine.confirmMassDelete('r1', false);
    await s.engine.settled();
    expect(s.disk.listing('r1').filter((path) => path.startsWith('bulk/')).length).toBe(61);
    expect(s.engine.status().r1.state).toBe('idle');
  });

  it('deletes them on yes', async () => {
    const s = await setup({ seed: many });
    s.disk.deleteUser('r1', 'bulk');
    await s.sync();
    s.engine.confirmMassDelete('r1', true);
    await s.engine.settled();
    expect(remoteUnder(s.server)).toEqual(['other.txt']);
    expect(s.server.listing(true).filter((path) => path.startsWith('.Trash/')).length).toBe(63);
  });

  it('asks before many deletes from Files, and uploads them again on no', async () => {
    const s = await setup({ seed: many });
    s.server.destroyTree(s.server.find('Sync/bulk')!.id);
    await s.sync();
    expect(s.engine.status().r1).toMatchObject({ state: 'confirm-delete', massDelete: { count: 61, side: 'local' } });
    expect(s.disk.trashed).toEqual([]);
    s.engine.confirmMassDelete('r1', false);
    await s.engine.settled();
    expect(remoteUnder(s.server).filter((path) => path.startsWith('bulk/')).length).toBe(61);
  });

  it('removes them here on yes', async () => {
    const s = await setup({ seed: many });
    s.server.destroyTree(s.server.find('Sync/bulk')!.id);
    await s.sync();
    s.engine.confirmMassDelete('r1', true);
    await s.engine.settled();
    expect(s.disk.listing('r1')).toEqual(['other.txt']);
    expect(s.disk.trashed).toEqual(['bulk']);
  });

  it('asks when more than half of a root goes at once', async () => {
    const s = await setup({ seed: (server, disk, rootId) => { for (let i = 0; i < 12; i += 1) disk.write(rootId, `f${i}.txt`, `${i}`); } });
    for (let i = 0; i < 7; i += 1) s.disk.deleteUser('r1', `f${i}.txt`);
    await s.sync();
    expect(s.engine.status().r1.state).toBe('confirm-delete');
  });
});

describe('names the disk cannot hold', () => {
  it('shows them under another name here and never renames them in Files', async () => {
    const s = await setup({
      seed: (server) => {
        const sync = server.find('Sync')!;
        server.file('a:b?.txt', sync.id, 'colon');
        server.file('CON.txt', sync.id, 'device');
        server.file('trail.', sync.id, 'dot');
        server.file('Report.txt', sync.id, 'upper');
        server.file('report.txt', sync.id, 'lower');
      },
    });
    expect(s.disk.listing('r1')).toEqual(['CON_.txt', 'Report.txt', 'a：b？.txt', 'report (2).txt', 'trail._']);
    expect(s.kinds()).toEqual(expect.arrayContaining(['renamed-for-disk a：b？.txt (a：b？.txt)', 'renamed-for-disk report (2).txt (report (2).txt)']));
    const id = s.server.find('Sync/a:b?.txt')!.id;
    // An edit here goes to the same node, under the name it has in Files.
    s.disk.write('r1', 'a：b？.txt', 'edited');
    s.disk.write('r1', 'report (2).txt', 'lower edited');
    await s.sync();
    expect(s.server.content(id)).toBe('edited');
    expect(s.server.content(s.server.find('Sync/report.txt')!.id)).toBe('lower edited');
    expect(remoteUnder(s.server)).toEqual(['CON.txt', 'Report.txt', 'a:b?.txt', 'report.txt', 'trail.']);
    // Another pass changes nothing on either side.
    const sets = s.server.sets.length;
    await s.sync();
    expect(s.server.sets.length).toBe(sets);
  });

  it('keeps the name in Files when the disk name is renamed back and forth', async () => {
    const s = await setup({ seed: (server) => server.file('q?.txt', server.find('Sync')!.id, 'q') });
    s.server.rename(s.server.find('Sync/q?.txt')!.id, 'r?.txt');
    await s.sync();
    expect(s.disk.listing('r1')).toEqual(['r？.txt']);
    expect(remoteUnder(s.server)).toEqual(['r?.txt']);
  });

  it('leaves names alone on a disk that takes them', async () => {
    const s = await setup({ platform: 'linux', seed: (server) => { server.file('a:b.txt', server.find('Sync')!.id, '1'); server.file('A:b.txt', server.find('Sync')!.id, '2'); } });
    expect(s.disk.listing('r1')).toEqual(['A:b.txt', 'a:b.txt']);
  });
});

describe('reading and uploading', () => {
  it('carries on when a file is renamed while it uploads', async () => {
    const s = await setup();
    s.disk.write('r1', 'big.txt', 'content');
    s.server.beforeRequest = () => {
      if (s.server.uploads.length === 1 && s.disk.has('r1', 'big.txt')) s.disk.moveUser('r1', 'big.txt', 'renamed.txt');
    };
    await s.sync();
    s.server.beforeRequest = null;
    await s.sync();
    expect(remoteUnder(s.server)).toEqual(['renamed.txt']);
    expect(s.server.uploads.length).toBe(1);
    expect(s.disk.listing('r1')).toEqual(['renamed.txt']);
  });

  it('does not upload a file that changed while it was read, and uploads it once it holds still', async () => {
    const s = await setup();
    s.disk.write('r1', 'live.log', 'first');
    let writes = 0;
    s.disk.onRead = (rootId, path) => {
      if (writes < 1) {
        writes += 1;
        s.disk.write(rootId, path, 'first and more');
      }
    };
    await s.sync();
    expect(s.server.uploads).toEqual([14]);
    expect(s.server.content(s.server.find('Sync/live.log')!.id)).toBe('first and more');
  });

  it('keeps a file over the upload limit here, says so once, and uploads it once it fits', async () => {
    const s = await setup({ server: { maxSizeUpload: 10 } });
    s.disk.write('r1', 'huge.bin', 'x'.repeat(20));
    await s.sync();
    await s.sync();
    expect(s.server.uploads).toEqual([]);
    expect(s.engine.activity.filter((entry) => entry.kind === 'too-large')).toEqual([expect.objectContaining({ path: 'huge.bin', detail: '10', messageKey: 'errors.too_large' })]);
    s.disk.write('r1', 'huge.bin', 'small');
    await s.sync();
    expect(s.server.content(s.server.find('Sync/huge.bin')!.id)).toBe('small');
  });

  it('writes a downloaded file in pieces and leaves nothing half written', async () => {
    const big = new Uint8Array(2_600_000).map((_, i) => i % 251);
    const s = await setup({ seed: (server) => server.file('big.bin', server.find('Sync')!.id, big) });
    const node = s.disk.node('r1', 'big.bin');
    expect(node.data?.length).toBe(big.length);
    expect(node.data?.[2_599_999]).toBe(2_599_999 % 251);
    expect(s.disk.openWrites).toBe(0);
  });
});

describe('offline', () => {
  it('keeps the changes while the server is away and sends them when it is back', async () => {
    const s = await setup({ seed: (server, disk, rootId) => disk.write(rootId, 'a.txt', 'v1') });
    s.server.offline = true;
    s.disk.write('r1', 'a.txt', 'v2');
    s.disk.write('r1', 'b.txt', 'new');
    await s.sync();
    expect(s.engine.status().r1.state).toBe('offline');
    expect(s.engine.activity[0]).toMatchObject({ kind: 'waiting', messageKey: 'errors.offline' });
    await s.sync();
    expect(s.engine.activity.filter((entry) => entry.kind === 'waiting')).toHaveLength(1);
    s.server.offline = false;
    s.engine.retryNow();
    await s.engine.settled();
    expect(s.engine.status().r1.state).toBe('idle');
    expect(s.server.content(s.server.find('Sync/a.txt')!.id)).toBe('v2');
    expect(s.server.content(s.server.find('Sync/b.txt')!.id)).toBe('new');
  });

  it('keeps the record when an upload breaks off, and finishes it later', async () => {
    const s = await setup();
    s.disk.write('r1', 'u.txt', 'up');
    s.server.failUploads = 1;
    await s.sync();
    expect(s.engine.status().r1.state).toBe('offline');
    s.engine.retryNow();
    await s.engine.settled();
    expect(remoteUnder(s.server)).toEqual(['u.txt']);
  });
});

describe('changes in Files', () => {
  it('reads FileNode/changes, and lists everything again only when the server cannot say', async () => {
    const s = await setup({ seed: (server, disk, rootId) => disk.write(rootId, 'a.txt', 'a') });
    const fullListings = () => s.server.calls.filter(([name, args]) => name === 'FileNode/get' && (args as { ids: unknown }).ids === null).length;
    const before = fullListings();
    s.server.file('b.txt', s.server.find('Sync')!.id, 'b');
    s.engine.remoteChanged('a1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await s.engine.settled();
    expect(s.disk.read('r1', 'b.txt')).toBe('b');
    expect(fullListings()).toBe(before);
    s.server.file('c.txt', s.server.find('Sync')!.id, 'c');
    s.server.account().coll.truncatedBelow = s.server.account().coll.log.length;
    s.engine.remoteChanged('a1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await s.engine.settled();
    expect(s.disk.read('r1', 'c.txt')).toBe('c');
    expect(fullListings()).toBe(before + 1);
  });

  it('ignores changes outside the pair', async () => {
    const s = await setup();
    const passes = s.server.calls.length;
    s.server.file('elsewhere.txt', null, 'x');
    s.engine.remoteChanged('a1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await s.engine.settled();
    // One /changes and one get of the new node, and no pass of the root.
    expect(s.server.calls.length - passes).toBe(2);
  });

  it('says so when the paired folder is gone from Files, and deletes nothing', async () => {
    const s = await setup({ seed: (server, disk, rootId) => disk.write(rootId, 'a.txt', 'a') });
    s.server.destroyTree(s.server.find('Sync')!.id);
    await s.sync();
    expect(s.engine.status().r1).toMatchObject({ state: 'error', errorKey: 'errors.not_found' });
    expect(s.disk.listing('r1')).toEqual(['a.txt']);
  });
});

describe('pause', () => {
  it('does nothing while paused and catches up on resume', async () => {
    const s = await setup();
    await s.engine.setPaused('r1', true);
    s.disk.write('r1', 'while-paused.txt', 'p');
    await s.sync();
    expect(s.engine.status().r1.state).toBe('paused');
    expect(remoteUnder(s.server)).toEqual([]);
    await s.engine.setPaused('r1', false);
    await s.engine.settled();
    expect(remoteUnder(s.server)).toEqual(['while-paused.txt']);
  });

  it('runs nothing while the app is locked, and loses no record', async () => {
    const s = await setup({ seed: (server, disk, rootId) => disk.write(rootId, 'a.txt', 'a') });
    const record = s.disk.states.get('r1');
    s.disk.locked = true;
    await s.sync();
    expect(s.disk.states.get('r1')).toBe(record);
    s.disk.locked = false;
    s.disk.emit('r1', null);
    await s.engine.settled();
    s.disk.write('r1', 'b.txt', 'b');
    await s.sync();
    expect(remoteUnder(s.server)).toEqual(['a.txt', 'b.txt']);
  });
});

describe('the drive', () => {
  async function drive(seed?: (server: FakeServer) => void) {
    return setup({ drive: true, seed: (server) => seed?.(server) });
  }

  it('places every node of the account but the trash, and downloads nothing', async () => {
    const s = await drive((server) => {
      const docs = server.folder('Docs');
      server.file('a.txt', docs.id, 'aaa');
      server.file('top.txt', null, 'top');
      const trash = server.folder('.Trash');
      server.file('old.txt', trash.id, 'old');
    });
    expect(s.disk.listing('r1')).toEqual(['Docs/', 'Docs/a.txt', 'top.txt']);
    expect(s.disk.node('r1', 'Docs/a.txt').placeholder).toMatchObject({ identity: s.server.find('Docs/a.txt')!.id, hydrated: false, inSync: true });
    expect(s.server.downloads).toEqual([]);
    expect(s.engine.items('a1')[s.server.find('Docs/a.txt')!.id]).toBe('online-only');
  });

  it('streams a file opened in Explorer from where Windows asked, to the end', async () => {
    const content = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 199);
    const s = await drive((server) => server.file('big.bin', null, content));
    const request = s.disk.requestFetch('r1', 'big.bin', 10_000);
    expect(request.offset).toBe(8192);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const got = s.disk.suppliedBytes(request.fetchId);
    expect(got.length).toBe(content.length - 8192);
    expect(got[0]).toBe(content[8192]);
    expect(got.at(-1)).toBe(content.at(-1));
    expect(s.disk.fetchFailed.size).toBe(0);
  });

  it('stops streaming when the fetch is cancelled, and fails one it cannot answer', async () => {
    const content = new Uint8Array(4 * 1024 * 1024);
    const s = await drive((server) => { server.file('big.bin', null, content); server.file('gone.txt', null, 'g'); });
    s.server.partBytes = 64 * 1024;
    s.disk.refuseSupplyAfter = 1024 * 1024;
    const request = s.disk.requestFetch('r1', 'big.bin');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(s.disk.suppliedBytes(request.fetchId).length).toBe(1024 * 1024);
    // Cancelled while the download runs: the rest isn't fetched, and nothing is failed.
    s.disk.refuseSupplyAfter = null;
    let second = '';
    let parts = 0;
    s.server.onPart = () => {
      parts += 1;
      if (parts === 2) s.disk.cancelFetch(second);
    };
    second = s.disk.requestFetch('r1', 'big.bin').fetchId;
    await new Promise((resolve) => setTimeout(resolve, 50));
    s.server.onPart = null;
    expect(parts).toBeLessThan(5);
    expect(s.disk.suppliedBytes(second).length).toBeLessThan(content.length);
    expect(s.disk.fetchFailed.has(second)).toBe(false);
    // Deleted in Files meanwhile.
    s.server.destroyTree(s.server.find('gone.txt')!.id);
    const third = s.disk.requestFetch('r1', 'gone.txt');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.disk.fetchFailed.get(third.fetchId)).toBe('missing');
    s.server.offline = true;
    s.disk.supplied.clear();
  });

  it('updates a placeholder when the file changed in Files', async () => {
    const s = await drive((server) => server.file('a.txt', null, 'v1'));
    s.server.edit(s.server.find('a.txt')!.id, 'version two');
    await s.sync();
    expect(s.disk.driveCalls.filter((call) => call.call === 'update')).toEqual([{ call: 'update', args: ['r1', 'a.txt', true] }]);
    expect(s.disk.node('r1', 'a.txt')).toMatchObject({ size: 11, placeholder: { hydrated: false, inSync: true } });
  });

  it('uploads a file made in Explorer and marks it in sync', async () => {
    const s = await drive();
    s.disk.write('r1', 'new.txt', 'from explorer');
    await s.sync();
    const node = s.server.find('new.txt')!;
    expect(s.server.content(node.id)).toBe('from explorer');
    expect(s.disk.node('r1', 'new.txt').placeholder).toMatchObject({ identity: node.id, inSync: true });
  });

  it('uploads a file made in Explorer inside a placed folder, next to a file opened there', async () => {
    const s = await drive((server) => { const docs = server.folder('Docs'); server.file('seen.txt', docs.id, 'seen'); });
    const request = s.disk.requestFetch('r1', 'Docs/seen.txt');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.disk.fetchFailed.has(request.fetchId)).toBe(false);
    s.disk.write('r1', 'Docs/new.txt', 'from explorer');
    await s.sync();
    const node = s.server.find('Docs/new.txt');
    expect(node && s.server.content(node.id)).toBe('from explorer');
  });

  it('takes a save over a placeholder as an edit here', async () => {
    const s = await drive((server) => server.file('doc.txt', null, 'v1'));
    const id = s.server.find('doc.txt')!.id;
    s.disk.write('r1', 'doc.txt', 'saved over');
    await s.sync();
    expect(s.server.content(id)).toBe('saved over');
    expect(s.disk.node('r1', 'doc.txt').placeholder).toMatchObject({ identity: id, inSync: true });
  });

  it('keeps both when a file edited here also changed in Files', async () => {
    const s = await drive((server) => server.file('doc.txt', null, 'v1'));
    const id = s.server.find('doc.txt')!.id;
    s.disk.write('r1', 'doc.txt', 'here');
    s.server.edit(id, 'there');
    await s.sync();
    const copy = s.disk.listing('r1').find((path) => path.includes('(conflict, Laptop,'))!;
    expect(s.server.content(id)).toBe('there');
    expect(s.disk.node('r1', 'doc.txt').placeholder).toMatchObject({ identity: id, hydrated: false });
    expect(s.server.content(s.server.find(copy)!.id)).toBe('here');
  });

  it('finds a placeholder moved in Explorer by its identity', async () => {
    const s = await drive((server) => { server.folder('A'); server.file('f.txt', null, 'f'); });
    const id = s.server.find('f.txt')!.id;
    s.disk.moveUser('r1', 'f.txt', 'A/g.txt');
    await s.sync();
    expect(s.server.find('A/g.txt')!.id).toBe(id);
    expect(s.server.uploads).toEqual([]);
  });

  it('starts afresh when its folder came back empty', async () => {
    const s = await drive((server) => server.file('a.txt', null, 'a'));
    s.disk.trees.set('r1', new Map());
    await s.sync();
    expect(s.disk.listing('r1')).toEqual(['a.txt']);
    expect(s.server.listing()).toEqual(['a.txt']);
  });
});

describe('coverage', () => {
  it('maps a node to its root and path', async () => {
    const s = await setup({ seed: (server, disk, rootId) => disk.write(rootId, 'Docs/a.txt', 'a') });
    const id = s.server.find('Sync/Docs/a.txt')!.id;
    expect(s.engine.coverage('a1', id)).toEqual({ rootId: 'r1', kind: 'folder', path: 'Docs/a.txt' });
    expect(s.engine.coverage('a1', s.server.find('Sync')!.id)).toEqual({ rootId: 'r1', kind: 'folder', path: '' });
    expect(s.engine.coverage('a2', id)).toBeNull();
    expect(s.engine.items('a1')[id]).toBe('synced');
  });
});

void str;
void text;
