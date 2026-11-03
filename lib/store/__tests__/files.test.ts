// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCOPE, type StoreEvent, type StoreScope } from '../area';
import { AccountEngine } from '../engine/account-engine';
import { TransportError } from '../engine/transport';
import { fileBlob, FILE_CACHE_CAP_BYTES, filesArea } from '../files';
import type { StorageAdapter } from '../storage';
import { JMAP_ACCOUNT } from './helpers/fake-jmap';
import { FakeFiles, FILES_SESSION, SHARED_FILES_ACCOUNT } from './helpers/fake-files';
import { openMemoryStore } from './helpers/node-adapter';

const NOW = Date.UTC(2026, 10, 3);

/* eslint-disable @typescript-eslint/no-explicit-any -- answers are shaped like the server's */

interface Rig {
  db: StorageAdapter;
  engine: AccountEngine;
  clock: { at: number };
  events: StoreEvent[];
}

function rigFor(server: FakeFiles, scope: Partial<StoreScope> = {}): Rig {
  const db = openMemoryStore();
  const clock = { at: NOW };
  const events: StoreEvent[] = [];
  const engine = new AccountEngine({
    account: 'a@fake.test',
    db,
    session: FILES_SESSION,
    transport: server,
    areas: [filesArea],
    scope: { ...DEFAULT_SCOPE, ...scope },
    emit: (event) => events.push(event),
    now: () => clock.at,
    sleep: async () => {},
  });
  return { db, engine, clock, events };
}

async function synced(server: FakeFiles, scope: Partial<StoreScope> = {}): Promise<Rig> {
  const rig = rigFor(server, scope);
  await rig.engine.requestSync();
  return rig;
}

async function call(engine: AccountEngine, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const response = await engine.answer([[name, { accountId: JMAP_ACCOUNT, ...args }, '0']]);
  if (!response) throw new Error('nothing answered');
  const [answered, result] = response.methodResponses[0];
  if (answered === 'error') throw new Error(result.type);
  return result;
}

const ref = (id: string, jmap = JMAP_ACCOUNT) => ({ jmap, id });

function names(rows: Array<{ name?: unknown }>): unknown[] {
  return rows.map((row) => row.name).sort();
}

describe('file metadata sync', () => {
  it('stores small accounts from one FileNode/get', async () => {
    const server = new FakeFiles();
    const folder = server.addFolder('Docs');
    server.addFile('a.txt', folder.id);
    const { engine } = await synced(server);
    expect(server.calls.filter(([n]) => n === 'FileNode/query')).toHaveLength(0);
    expect(names((await call(engine, 'FileNode/get', { ids: null })).list)).toEqual(['Docs', 'a.txt']);
  });

  it.each([
    ['0.16 cuts the list at 500', { getAll: 'cut' as const }],
    ['1.0 refuses a list over 500', { getAll: 'refuse' as const }],
  ])('pages past the /get limit: %s', async (_label, options) => {
    const server = new FakeFiles(options);
    const folder = server.addFolder('Docs');
    for (let i = 0; i < 1234; i += 1) server.addFile(`f${i}.txt`, folder.id);
    const { db } = await synced(server);
    expect(Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM file_node')?.n)).toBe(1235);
    for (const [name, args] of server.calls) {
      if (name === 'FileNode/get' && Array.isArray(args.ids)) expect(args.ids.length).toBeLessThanOrEqual(500);
    }
  });

  it('finds folders the query leaves out on old servers, by the parents of what it did find', async () => {
    const server = new FakeFiles({ queryOmitsFolders: true, style: 'blob' });
    for (let i = 0; i < 600; i += 1) server.addFile(`early${i}.txt`);
    const top = server.addFolder('Top');
    const inner = server.addFolder('Inner', top.id);
    server.addFile('deep.txt', inner.id);
    const { db } = await synced(server);
    const kinds = db.all<{ name: string; kind: string }>("SELECT name, kind FROM file_node WHERE name IN ('Top', 'Inner', 'deep.txt') ORDER BY name");
    expect(kinds).toEqual([{ name: 'Inner', kind: 'directory' }, { name: 'Top', kind: 'directory' }, { name: 'deep.txt', kind: 'file' }]);
  });

  it('continues a stopped full sync from its cursor', async () => {
    const server = new FakeFiles({ getAll: 'refuse' });
    for (let i = 0; i < 6000; i += 1) server.addFile(`f${i}`);
    const rig = rigFor(server);
    let gets = 0;
    server.beforeRequest = () => {
      gets += 1;
      // State capture, the refused list, a query page of 5000 and two requests of gets: then the network goes.
      if (gets === 6) server.offline = true;
    };
    await rig.engine.requestSync();
    expect(Number(rig.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM file_node')?.n)).toBe(5000);
    server.offline = false;
    server.beforeRequest = null;
    server.calls.length = 0;
    await rig.engine.requestSync();
    expect(Number(rig.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM file_node')?.n)).toBe(6000);
    expect(server.calls.find(([n]) => n === 'FileNode/query')?.[1].position).toBe(5000);
    expect(server.calls.filter(([n, a]) => n === 'FileNode/get' && a.ids === null && a.accountId === JMAP_ACCOUNT)).toHaveLength(0);
  });

  it('follows changes through FileNode/changes', async () => {
    const server = new FakeFiles();
    const a = server.addFile('a.txt');
    const b = server.addFile('b.txt');
    const { engine } = await synced(server);
    server.calls.length = 0;
    server.renameNode(a.id, 'renamed.txt');
    server.removeNode(b.id);
    server.addFolder('New');
    await engine.requestSync();
    expect(server.calls.some(([n]) => n === 'FileNode/changes')).toBe(true);
    expect(server.calls.some(([n, args]) => n === 'FileNode/get' && args.ids === null)).toBe(false);
    expect(names((await call(engine, 'FileNode/get', { ids: null })).list)).toEqual(['New', 'renamed.txt']);
  });

  it('starts over when the server can no longer give changes, and keeps a pin on a file still there', async () => {
    const server = new FakeFiles();
    const gone = server.addFile('gone.txt');
    const kept = server.addFile('kept.txt');
    const { db, engine } = await synced(server);
    await engine.areaCall('files.pin', ref(kept.id));
    await engine.requestSync();
    server.removeNode(gone.id);
    server.account().coll.truncatedBelow = server.account().coll.log.length;
    await engine.requestSync();
    expect(db.all('SELECT id FROM file_node').map((r) => r.id)).toEqual([kept.id]);
    expect(db.get<{ pinned: number }>('SELECT pinned FROM file_node WHERE id = ?', [kept.id])?.pinned).toBe(1);
  });

  it('keeps accounts apart, even with the same ids', async () => {
    const server = new FakeFiles();
    server.addFile('own.txt', null, 5, { id: 'same' });
    server.addFile('team.txt', null, 5, { id: 'same', blobId: 'team-blob' }, SHARED_FILES_ACCOUNT);
    const { engine } = await synced(server);
    expect(names((await call(engine, 'FileNode/get', { ids: ['same'] })).list)).toEqual(['own.txt']);
    expect(names((await call(engine, 'FileNode/get', { ids: ['same'], accountId: SHARED_FILES_ACCOUNT })).list)).toEqual(['team.txt']);
  });
});

describe('file answers', () => {
  it('says so instead of an empty list when nothing was read yet', async () => {
    const { engine } = rigFor(new FakeFiles());
    expect(await engine.answer([['FileNode/get', { accountId: JMAP_ACCOUNT, ids: null }, '0']])).toBeNull();
  });

  it('gives the last server state and only asked-for properties', async () => {
    const server = new FakeFiles();
    const file = server.addFile('a.txt');
    const { engine } = await synced(server);
    const got = await call(engine, 'FileNode/get', { ids: [file.id, 'nope'], properties: ['name', 'parentId'] });
    expect(got.state).toBe(server.account().coll.state());
    expect(got.list).toEqual([{ id: file.id, name: 'a.txt', parentId: null }]);
    expect(got.notFound).toEqual(['nope']);
  });

  it('answers a query by parent, also at the root, which the real server refuses to take', async () => {
    const server = new FakeFiles();
    const folder = server.addFolder('Docs');
    const inside = server.addFile('in.txt', folder.id);
    const root = server.addFile('root.txt');
    const { engine } = await synced(server);
    expect((await call(engine, 'FileNode/query', { filter: { parentId: folder.id } })).ids).toEqual([inside.id]);
    expect((await call(engine, 'FileNode/query', { filter: { parentId: null } })).ids).toEqual([folder.id, root.id]);
  });

  it('pages and sorts a query', async () => {
    const server = new FakeFiles();
    server.addFile('b', null, 30);
    server.addFile('a', null, 10);
    server.addFile('c', null, 20);
    const { engine } = await synced(server);
    const page = await call(engine, 'FileNode/query', { filter: {}, position: 1, limit: 1, calculateTotal: true });
    expect(page).toMatchObject({ position: 1, total: 3, ids: [expect.any(String)] });
    const bySize = await call(engine, 'FileNode/query', { filter: {}, sort: [{ property: 'size', isAscending: false }] });
    const list = (await call(engine, 'FileNode/get', { ids: bySize.ids })).list;
    expect(list.map((n: { name: string }) => n.name)).toEqual(['b', 'c', 'a']);
  });

  it('refuses what it cannot read, for that call only', async () => {
    const server = new FakeFiles();
    server.addFile('a');
    const { engine } = await synced(server);
    const response = await engine.answer([
      ['FileNode/query', { accountId: JMAP_ACCOUNT, filter: { hasFoo: true } }, '0'],
      ['FileNode/get', { accountId: JMAP_ACCOUNT, ids: null }, '1'],
    ]);
    expect(response?.methodResponses[0][1].type).toBe('unsupportedFilter');
    expect(response?.methodResponses[1][0]).toBe('FileNode/get');
  });

  it('answers FileNode/set with a clear per-call error, not silence', async () => {
    const server = new FakeFiles();
    server.addFile('a');
    const { engine } = await synced(server);
    const response = await engine.answer([
      ['FileNode/set', { accountId: JMAP_ACCOUNT, create: { n0: { name: 'x' } } }, '0'],
      ['FileNode/get', { accountId: JMAP_ACCOUNT, ids: null }, '1'],
    ]);
    expect(response?.methodResponses[0]).toEqual(['error', { type: 'serverUnavailable', description: 'FileNode/set needs the server' }, '0']);
    expect(response?.methodResponses[1][0]).toBe('FileNode/get');
    expect(server.calls.some(([n]) => n === 'FileNode/set')).toBe(false);
  });
});

describe('pinned files', () => {
  it('fetches a pinned file and gives it back byte for byte, past the chunk size', async () => {
    const server = new FakeFiles();
    const content = new Uint8Array(3 * 1024 * 1024 + 17).map((_, i) => i % 251);
    const file = server.addFile('big.bin', null, content);
    const { db, engine } = await synced(server);
    expect(server.downloads).toEqual([]);

    expect(await engine.areaCall('files.pin', ref(file.id))).toEqual({ kept: false });
    await engine.requestSync();
    expect(server.downloads).toEqual([{ jmap: JMAP_ACCOUNT, blobId: file.blobId }]);
    expect(Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM file_blob_chunk')?.n)).toBe(4);

    const read = await engine.areaCall('files.read', ref(file.id)) as any;
    expect(read.name).toBe('big.bin');
    expect(read.type).toBe('text/plain');
    expect(Buffer.compare(read.data, content)).toBe(0);
    expect(Buffer.compare(fileBlob({ db }, JMAP_ACCOUNT, file.blobId as string)?.data as Uint8Array, content)).toBe(0);
    expect(await engine.areaCall('files.blob', { jmap: JMAP_ACCOUNT, blobId: file.blobId })).toMatchObject({ size: content.length });
    // Already kept: not fetched again.
    await engine.requestSync();
    expect(server.downloads).toHaveLength(1);
    expect(await engine.areaCall('files.pin', ref(file.id))).toEqual({ kept: true });
  });

  it('names a file with a %-encoded name from 0.16 WebDAV the way the client shows it', async () => {
    const server = new FakeFiles();
    const file = server.addFile('My%20Report.pdf');
    const { engine } = await synced(server);
    await engine.areaCall('files.pin', ref(file.id));
    await engine.requestSync();
    expect((await engine.areaCall('files.read', ref(file.id)) as any).name).toBe('My Report.pdf');
    expect((await engine.areaCall('files.kept', undefined) as any).files[0].name).toBe('My Report.pdf');
    // The stored node stays as the server sent it. The client decodes it once.
    expect((await call(engine, 'FileNode/get', { ids: [file.id] })).list[0].name).toBe('My%20Report.pdf');
  });

  it('gives nothing for a file not kept', async () => {
    const server = new FakeFiles();
    const file = server.addFile('a.txt');
    const { db, engine } = await synced(server);
    expect(await engine.areaCall('files.read', ref(file.id))).toBeNull();
    expect(fileBlob({ db }, JMAP_ACCOUNT, file.blobId as string)).toBeNull();
  });

  it('refuses to pin a folder or an unknown id', async () => {
    const server = new FakeFiles();
    const folder = server.addFolder('Docs');
    const { engine } = await synced(server);
    await expect(engine.areaCall('files.pin', ref(folder.id))).rejects.toThrow('Only files');
    await expect(engine.areaCall('files.pin', ref('nope'))).rejects.toThrow();
  });

  it('downloads one at a time', async () => {
    const server = new FakeFiles();
    const files = [server.addFile('a'), server.addFile('b'), server.addFile('c')];
    const { engine } = await synced(server);
    for (const file of files) await engine.areaCall('files.pin', ref(file.id));
    await engine.requestSync();
    expect(server.downloads).toHaveLength(3);
    expect(server.mostAtOnce).toBe(1);
  });

  it('fetches a pinned file over the one-file limit, and skips an opened one', async () => {
    const server = new FakeFiles();
    const pinned = server.addFile('pinned.bin', null, 100);
    const opened = server.addFile('opened.bin', null, 100);
    const { engine } = await synced(server, { maxAttachmentBytes: 50 });
    await engine.areaCall('files.pin', ref(pinned.id));
    await engine.areaCall('files.noteOpened', ref(opened.id));
    await engine.requestSync();
    expect(server.downloads.map((d) => d.blobId)).toEqual([pinned.blobId]);
    const status = await engine.areaCall('files.kept', undefined) as any;
    const row = (name: string) => status.files.find((f: { name: string }) => f.name === name);
    expect(row('pinned.bin')).toMatchObject({ pinned: true, kept: true, error: null });
    expect(row('opened.bin')).toMatchObject({ pinned: false, kept: false, error: 'tooLarge' });
  });

  it('does not take pins past the total limit, and says so', async () => {
    const server = new FakeFiles();
    const a = server.addFile('a', null, 60);
    const b = server.addFile('b', null, 60);
    const { engine, clock } = await synced(server, { maxTotalBytes: 100 });
    await engine.areaCall('files.pin', ref(a.id));
    clock.at += 1;
    await engine.areaCall('files.pin', ref(b.id));
    await engine.requestSync();
    expect(server.downloads).toHaveLength(1);
    const status = await engine.areaCall('files.kept', undefined) as any;
    expect(status.files.filter((f: { kept: boolean }) => f.kept)).toHaveLength(1);
    expect(status.files.filter((f: { error: string | null }) => f.error === 'overLimit')).toHaveLength(1);
  });

  describe('a tightened scope, with no network', () => {
    async function keptOffline(rig: Rig) {
      rig.engine.setOnline(false);
    }

    it('drops everything kept when files are forbidden, and the pins stay', async () => {
      const server = new FakeFiles();
      const file = server.addFile('a', null, 60);
      const rig = await synced(server);
      await rig.engine.areaCall('files.pin', ref(file.id));
      await rig.engine.requestSync();
      await keptOffline(rig);
      rig.engine.setScope({ ...DEFAULT_SCOPE, attachments: false });
      await rig.engine.requestSync();
      expect(await rig.engine.areaCall('files.read', ref(file.id))).toBeNull();
      expect((await rig.engine.areaCall('files.kept', undefined) as any).files[0]).toMatchObject({ pinned: true, kept: false, error: 'notAllowed' });
    });

    it('drops an opened file over the new size, not a pinned one', async () => {
      const server = new FakeFiles();
      const pinned = server.addFile('pinned', null, 60);
      const opened = server.addFile('opened', null, 60);
      const rig = await synced(server);
      await rig.engine.areaCall('files.pin', ref(pinned.id));
      await rig.engine.areaCall('files.noteOpened', ref(opened.id));
      await rig.engine.requestSync();
      await keptOffline(rig);
      rig.engine.setScope({ ...DEFAULT_SCOPE, maxAttachmentBytes: 10 });
      await rig.engine.requestSync();
      expect(await rig.engine.areaCall('files.read', ref(opened.id))).toBeNull();
      expect(await rig.engine.areaCall('files.read', ref(pinned.id))).not.toBeNull();
    });

    it('holds even pins to a lower total, newest out first, and doesn\'t fetch them back', async () => {
      const server = new FakeFiles();
      const older = server.addFile('older', null, 60);
      const newer = server.addFile('newer', null, 60);
      const rig = await synced(server);
      await rig.engine.areaCall('files.pin', ref(older.id));
      await rig.engine.requestSync();
      rig.clock.at += 1000;
      await rig.engine.areaCall('files.pin', ref(newer.id));
      await rig.engine.requestSync();
      await keptOffline(rig);
      rig.engine.setScope({ ...DEFAULT_SCOPE, maxTotalBytes: 100 });
      await rig.engine.requestSync();
      expect(await rig.engine.areaCall('files.read', ref(older.id))).not.toBeNull();
      expect(await rig.engine.areaCall('files.read', ref(newer.id))).toBeNull();
      const status = (await rig.engine.areaCall('files.kept', undefined) as any).files;
      expect(status.find((f: { id: string }) => f.id === newer.id).error).toBe('overLimit');

      server.downloads.length = 0;
      rig.engine.setOnline(true);
      await rig.engine.requestSync();
      expect(server.downloads).toEqual([]);
    });
  });

  it('counts towards the storage page, and takes its part of the total from mail', async () => {
    const server = new FakeFiles();
    const file = server.addFile('a', null, 60);
    const rig = await synced(server);
    await rig.engine.areaCall('files.pin', ref(file.id));
    await rig.engine.requestSync();
    const usage = await rig.engine.areaCall('store.usage', undefined) as { parts: Array<{ part: string; bytes: number; items: number }> };
    expect(usage.parts).toContainEqual({ part: 'files', bytes: 60, items: 1 });
    expect(filesArea.keptBytes?.({ db: rig.db })).toBe(60);
  });

  it('keeps nothing when the scope forbids it, and drops what was kept', async () => {
    const server = new FakeFiles();
    const file = server.addFile('a');
    const rig = await synced(server);
    await rig.engine.areaCall('files.pin', ref(file.id));
    await rig.engine.requestSync();
    expect(await rig.engine.areaCall('files.read', ref(file.id))).not.toBeNull();

    rig.engine.setScope({ ...DEFAULT_SCOPE, attachments: false });
    await rig.engine.requestSync();
    expect(await rig.engine.areaCall('files.read', ref(file.id))).toBeNull();
    expect(Number(rig.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM file_blob_chunk')?.n)).toBe(0);
    expect((await rig.engine.areaCall('files.kept', undefined) as any).files[0]).toMatchObject({ pinned: true, kept: false, error: 'notAllowed' });

    rig.engine.setScope(DEFAULT_SCOPE);
    await rig.engine.requestSync();
    expect(await rig.engine.areaCall('files.read', ref(file.id))).not.toBeNull();
  });

  it('goes by the real size when the metadata has it wrong', async () => {
    const server = new FakeFiles();
    const opened = server.addFile('opened', null, new Uint8Array(100), { size: 1 });
    const { engine } = await synced(server, { maxAttachmentBytes: 50 });
    await engine.areaCall('files.noteOpened', ref(opened.id));
    await engine.requestSync();
    expect(server.downloads).toHaveLength(1);
    expect(await engine.areaCall('files.read', ref(opened.id))).toBeNull();
    expect((await engine.areaCall('files.kept', undefined) as any).files[0].error).toBe('tooLarge');
  });

  it('does not store a file unpinned while it was downloading', async () => {
    const server = new FakeFiles();
    const file = server.addFile('a');
    const { engine } = await synced(server);
    await engine.areaCall('files.pin', ref(file.id));
    const original = server.download.bind(server);
    server.download = async (jmap, blobId) => {
      await engine.areaCall('files.unpin', ref(file.id));
      return original(jmap, blobId);
    };
    await engine.requestSync();
    expect(server.downloads).toHaveLength(1);
    expect(await engine.areaCall('files.read', ref(file.id))).toBeNull();
  });

  it('lets a never-opened file go on unpin, and keeps an opened one as recent', async () => {
    const server = new FakeFiles();
    const never = server.addFile('never');
    const opened = server.addFile('opened');
    const { engine } = await synced(server);
    await engine.areaCall('files.pin', ref(never.id));
    await engine.areaCall('files.pin', ref(opened.id));
    await engine.areaCall('files.noteOpened', ref(opened.id));
    await engine.requestSync();
    await engine.areaCall('files.unpin', ref(never.id));
    await engine.areaCall('files.unpin', ref(opened.id));
    expect(await engine.areaCall('files.read', ref(never.id))).toBeNull();
    expect(await engine.areaCall('files.read', ref(opened.id))).not.toBeNull();
    const status = await engine.areaCall('files.kept', undefined) as any;
    expect(status.files.map((f: { name: string; pinned: boolean }) => [f.name, f.pinned])).toEqual([['opened', false]]);
  });

  it('drops the old content and fetches the new one when a pinned file changes', async () => {
    const server = new FakeFiles();
    const file = server.addFile('a.txt', null, new Uint8Array([1, 2, 3]));
    const { db, engine } = await synced(server);
    await engine.areaCall('files.pin', ref(file.id));
    await engine.requestSync();
    const old = file.blobId as string;
    const fresh = server.replaceContent(file.id, new Uint8Array([9, 9]));
    await engine.requestSync();
    expect(fileBlob({ db }, JMAP_ACCOUNT, old)).toBeNull();
    expect([...(fileBlob({ db }, JMAP_ACCOUNT, fresh)?.data ?? [])]).toEqual([9, 9]);
    expect(Array.from((await engine.areaCall('files.read', ref(file.id)) as any).data)).toEqual([9, 9]);
  });

  it('drops the content when the file is removed on the server, unless another node shares it', async () => {
    const server = new FakeFiles();
    const a = server.addFile('a', null, 5, { blobId: 'shared-blob' });
    const b = server.addFile('b', null, 5, { blobId: 'shared-blob' });
    const { db, engine } = await synced(server);
    await engine.areaCall('files.pin', ref(a.id));
    await engine.areaCall('files.pin', ref(b.id));
    await engine.requestSync();
    expect(server.downloads).toHaveLength(1);
    server.removeNode(a.id);
    await engine.requestSync();
    expect(fileBlob({ db }, JMAP_ACCOUNT, 'shared-blob')).not.toBeNull();
    server.removeNode(b.id);
    await engine.requestSync();
    expect(fileBlob({ db }, JMAP_ACCOUNT, 'shared-blob')).toBeNull();
    expect(Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM file_blob_chunk')?.n)).toBe(0);
  });

  it('carries on past one bad file, and hands a network failure to the engine', async () => {
    const server = new FakeFiles();
    const bad = server.addFile('bad');
    const good = server.addFile('good');
    server.blobs.delete(bad.blobId as string);
    const { engine, clock } = await synced(server);
    await engine.areaCall('files.pin', ref(bad.id));
    clock.at += 1;
    await engine.areaCall('files.pin', ref(good.id));
    await engine.requestSync();
    expect(await engine.areaCall('files.read', ref(good.id))).not.toBeNull();
    const status = await engine.areaCall('files.kept', undefined) as any;
    expect(status.files.find((f: { name: string }) => f.name === 'bad').error).toBe('download');

  });

  it('hands a network failure to the engine, which ends the pass, and goes on next time', async () => {
    const server = new FakeFiles();
    const file = server.addFile('a');
    const rig = await synced(server);
    await rig.engine.areaCall('files.pin', ref(file.id));
    const original = server.download.bind(server);
    server.download = async () => {
      throw new TransportError('network', 'Failed to fetch');
    };
    const syncedBefore = rig.events.filter((e) => e.type === 'synced').length;
    await rig.engine.requestSync();
    expect(rig.events.some((e) => e.type === 'error')).toBe(false);
    expect(rig.events.filter((e) => e.type === 'synced').length).toBe(syncedBefore);
    expect((await rig.engine.areaCall('files.kept', undefined) as any).files[0]).toMatchObject({ kept: false, error: null });

    server.download = original;
    await rig.engine.requestSync();
    expect(await rig.engine.areaCall('files.read', ref(file.id))).not.toBeNull();
  });
});

describe('recently opened files', () => {
  it('keeps an opened file without a pin', async () => {
    const server = new FakeFiles();
    const file = server.addFile('a');
    const { engine } = await synced(server);
    expect(await engine.areaCall('files.noteOpened', ref(file.id))).toEqual({ kept: false });
    await engine.requestSync();
    expect(await engine.areaCall('files.read', ref(file.id))).not.toBeNull();
    expect(await engine.areaCall('files.noteOpened', ref(file.id))).toEqual({ kept: true });
  });

  it('pushes out the oldest unpinned first, and never a pinned one', async () => {
    const server = new FakeFiles();
    const files = Object.fromEntries(['old', 'pinnedOldest', 'mid', 'new', 'newest'].map((name) => [name, server.addFile(name, null, 10)]));
    const rig = await synced(server, { maxTotalBytes: 30 });
    const open = async (name: string) => {
      rig.clock.at += 1000;
      await rig.engine.areaCall('files.noteOpened', ref(files[name].id));
      await rig.engine.requestSync();
    };
    await open('pinnedOldest');
    await rig.engine.areaCall('files.pin', ref(files.pinnedOldest.id));
    await open('old');
    await open('mid');
    const kept = async () => (await rig.engine.areaCall('files.kept', undefined) as any).files
      .filter((f: { kept: boolean }) => f.kept).map((f: { name: string }) => f.name).sort();
    expect(await kept()).toEqual(['mid', 'old', 'pinnedOldest']);

    await open('new');
    expect(await kept()).toEqual(['mid', 'new', 'pinnedOldest']);
    await open('mid');
    await open('newest');
    expect(await kept()).toEqual(['mid', 'newest', 'pinnedOldest']);
    expect((await rig.engine.areaCall('files.kept', undefined) as any).bytes).toBe(30);

    // A pinned file was never pushed out and had to come back.
    expect(server.downloads.filter((d) => d.blobId === files.pinnedOldest.blobId)).toHaveLength(1);
    // Pushed out means forgotten: the next pass doesn't fetch it straight back.
    expect(server.downloads.filter((d) => d.blobId === files.old.blobId)).toHaveLength(1);
    const count = server.downloads.length;
    await rig.engine.requestSync();
    expect(server.downloads).toHaveLength(count);
    expect((await rig.engine.areaCall('files.kept', undefined) as any).files.map((f: { name: string }) => f.name)).not.toContain('old');
  });

  it('pushes out recent files for a pin, and keeps a pin past the cap', async () => {
    const server = new FakeFiles();
    const recent = server.addFile('recent', null, 20);
    const pin = server.addFile('pin', null, 20);
    const rig = await synced(server, { maxTotalBytes: 25 });
    await rig.engine.areaCall('files.noteOpened', ref(recent.id));
    await rig.engine.requestSync();
    rig.clock.at += 1000;
    await rig.engine.areaCall('files.pin', ref(pin.id));
    await rig.engine.requestSync();
    expect(await rig.engine.areaCall('files.read', ref(recent.id))).toBeNull();
    expect(await rig.engine.areaCall('files.read', ref(pin.id))).not.toBeNull();
  });

  it('keeps recently opened files under 500 MB whatever the total limit is', async () => {
    const server = new FakeFiles();
    const file = server.addFile('new', null, 10);
    const rig = await synced(server, { maxTotalBytes: 2 * FILE_CACHE_CAP_BYTES });
    // As if an older file already took all of it: only the row counts here.
    rig.db.run('INSERT INTO file_blob (jmap, blob_id, type, size, kept_at) VALUES (?, ?, ?, ?, ?)', [JMAP_ACCOUNT, 'huge', 'x', FILE_CACHE_CAP_BYTES, NOW - 1000]);
    rig.db.run("INSERT INTO file_node (jmap, id, name, kind, blob_id, size, json, opened_at) VALUES (?, 'hugenode', 'huge', 'file', 'huge', ?, '{}', ?)", [JMAP_ACCOUNT, FILE_CACHE_CAP_BYTES, NOW - 1000]);
    await rig.engine.areaCall('files.noteOpened', ref(file.id));
    await rig.engine.requestSync();
    expect(fileBlob({ db: rig.db }, JMAP_ACCOUNT, 'huge')).toBeNull();
    expect(await rig.engine.areaCall('files.read', ref(file.id))).not.toBeNull();
    expect((await rig.engine.areaCall('files.kept', undefined) as any).capBytes).toBe(FILE_CACHE_CAP_BYTES);
  });

  it('drops an old opened file that does not fit rather than a newer one', async () => {
    const server = new FakeFiles();
    const a = server.addFile('a', null, 20);
    const b = server.addFile('b', null, 20);
    const rig = await synced(server, { maxTotalBytes: 25 });
    await rig.engine.areaCall('files.noteOpened', ref(a.id));
    rig.clock.at += 1000;
    await rig.engine.areaCall('files.noteOpened', ref(b.id));
    await rig.engine.requestSync();
    expect(await rig.engine.areaCall('files.read', ref(b.id))).not.toBeNull();
    expect(await rig.engine.areaCall('files.read', ref(a.id))).toBeNull();
    expect(server.downloads.map((d) => d.blobId)).toEqual([b.blobId, a.blobId]);
    const count = server.downloads.length;
    await rig.engine.requestSync();
    expect(server.downloads).toHaveLength(count);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
