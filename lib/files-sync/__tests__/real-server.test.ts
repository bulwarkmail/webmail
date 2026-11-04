// @vitest-environment node
/**
 * The engine against a real Stalwart, with the in-memory disk. Skipped unless asked for:
 *
 *   FILES_SYNC_REAL_URL=https://stalwart.internal.bulwarkmail.org FILES_SYNC_REAL_LABEL=0.16 \
 *   vw exec --env FILES_SYNC_REAL_PASSWORD="vault://<dso-* item>/password" -- npx vitest run lib/files-sync/__tests__/real-server.test.ts
 *
 * Uses the throwaway accounts dso-fs and dso-fs-b (VM 106 ~/desktop-offline/dso_fs_provision.py,
 * which also seeds dso-fs's "Seed" folder; dso_fs_dav_seed.py adds names Windows can't hold over
 * WebDAV). It signs in once per account and stops there if that's refused: nothing polls as a
 * missing user.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FetchTransport, type StoreSession } from '@/lib/store/engine/transport';
import { FilesSyncEngine, type EngineTiming } from '../engine';
import { namingFor } from '../names';
import { FilesRemote, type RemoteNode } from '../remote';
import { FakeDisk, str, text } from './helpers/fake-disk';

const URL_BASE = process.env.FILES_SYNC_REAL_URL ?? '';
const LABEL = process.env.FILES_SYNC_REAL_LABEL ?? '';
const PASSWORD = process.env.FILES_SYNC_REAL_PASSWORD ?? '';
const run = !!URL_BASE && !!PASSWORD;
const FAST: Partial<EngineTiming> = { localDelayMs: 0, remoteDelayMs: 0, pollMs: 1e9, rescanMs: 1e9, retryMs: [1e9], soonMs: 50, fetchWaitMs: 30_000 };

function basic(user: string): string {
  return `Basic ${Buffer.from(`${user}@example.org:${PASSWORD}`).toString('base64')}`;
}

async function signIn(user: string): Promise<FilesRemote> {
  const response = await fetch(`${URL_BASE}/jmap/session`, { headers: { Authorization: basic(user) } });
  if (response.status !== 200) throw new Error(`${user} on ${LABEL}: session ${response.status}; run dso_fs_provision.py first`);
  const session = (await response.json()) as StoreSession;
  const transport = new FetchTransport({ session: () => session, auth: () => basic(user), refreshAuth: async () => basic(user) });
  return new FilesRemote(transport, () => session);
}

async function tree(remote: FilesRemote): Promise<Map<string, RemoteNode>> {
  return new Map((await remote.listAll()).nodes.map((node) => [node.id, node]));
}

/** Paths below a folder, as Files has them, folders with a slash. */
function pathsUnder(nodes: Map<string, RemoteNode>, folderId: string): string[] {
  const out: string[] = [];
  const walk = (parent: string, prefix: string) => {
    for (const node of nodes.values()) {
      if (node.parentId !== parent) continue;
      const path = prefix ? `${prefix}/${node.name}` : node.name;
      out.push(node.kind === 'directory' ? `${path}/` : path);
      if (node.kind === 'directory') walk(node.id, path);
    }
  };
  walk(folderId, '');
  return out.sort();
}

function find(nodes: Map<string, RemoteNode>, parentId: string | null, name: string): RemoteNode | undefined {
  return [...nodes.values()].find((node) => node.parentId === parentId && node.name === name);
}

async function download(remote: FilesRemote, node: RemoteNode): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  await remote.download(node, (part) => parts.push(new Uint8Array(part)));
  return new Uint8Array(Buffer.concat(parts));
}

describe.runIf(run)(`files sync against Stalwart ${LABEL}`, () => {
  let a: FilesRemote;
  let b: FilesRemote;
  let other: FilesRemote;
  let testFolder: RemoteNode;
  let disk: FakeDisk;
  let engine: FilesSyncEngine;
  const created: string[] = [];

  const sync = async () => {
    await engine.refreshRoots();
    engine.syncNow();
    await engine.settled();
  };

  beforeAll(async () => {
    a = await signIn('dso-fs');
    b = await signIn('dso-fs-b');
    // "Another device" of dso-fs: its own session and transport.
    other = await signIn('dso-fs');
    const nodes = await tree(a);
    // What an earlier run left.
    const old = [...nodes.values()].filter((node) => node.parentId === null && node.name.startsWith('Sync test '));
    if (old.length > 0) await a.destroy(old.map((node) => node.id));
    testFolder = await a.createFolder(`Sync test ${Date.now()}`, null);
    created.push(testFolder.id);
    disk = new FakeDisk({ caseInsensitive: true, drive: true });
    engine = new FilesSyncEngine({ controls: disk, naming: namingFor('win32'), device: 'Test', readUrl: disk.readUrl, timing: FAST });
    engine.start();
    engine.setAccount('fs', a);
    engine.setAccount('fs-b', b);
  }, 120_000);

  afterAll(async () => {
    engine?.stop();
    if (a && created.length > 0) await a.destroy(created).catch(() => {});
    if (a) {
      const nodes = await tree(a).catch(() => new Map<string, RemoteNode>());
      const trash = find(nodes, null, '.Trash');
      if (trash) await a.destroy([trash.id]).catch(() => {});
    }
  }, 120_000);

  it('brings the seeded folder down whole, with names the disk can hold, and changes nothing in Files', async () => {
    const before = await tree(a);
    const seed = find(before, null, 'Seed');
    expect(seed, 'run dso_fs_provision.py create').toBeDefined();
    disk.addRoot({ id: 'seed', account: 'fs', remoteId: seed!.id });
    await sync();
    const listing = disk.listing('seed');
    expect(listing).toEqual(expect.arrayContaining([
      'Documents/', 'Documents/Level 1/Level 2/deep note.md', 'Documents/Quarterly report 2026.txt', 'Empty folder/',
      'Pictures/photo 1.png', 'Ärger und Grüße/Übersicht März.txt', 'Large/large 1.bin', 'Large/large 2.bin',
      'Report.txt', 'report (2).txt', 'trailing dot._',
      'a：b.txt', 'what？.txt', 'quote＂.txt', 'pipe｜star＊.txt', 'less＜more＞.txt', 'back＼slash.txt',
    ]));
    if (LABEL === '0.16') expect(listing).toContain('CON_.txt');
    expect(disk.read('seed', 'Ärger und Grüße/Übersicht März.txt')).toBe('Grüße aus Köln\n');
    const large = find(before, find(before, seed!.id, 'Large')!.id, 'large 2.bin')!;
    expect(disk.node('seed', 'Large/large 2.bin').size).toBe(large.size);
    expect(Buffer.from(disk.node('seed', 'Large/large 2.bin').data!).equals(Buffer.from(await download(a, large)))).toBe(true);
    const after = await tree(a);
    expect(pathsUnder(after, seed!.id)).toEqual(pathsUnder(before, seed!.id));
    expect(engine.status().seed.state).toBe('idle');
    await engine.removeRoot('seed');
  }, 180_000);

  it('sends what is made here, with a large file, and keeps one over the limit here', async () => {
    disk.addRoot({ id: 'pair', account: 'fs', remoteId: testFolder.id });
    const big = new Uint8Array(3 * 1024 * 1024 + 11).map((_, i) => (i * 7) % 256);
    disk.write('pair', 'Docs/Notes/plan.txt', 'the plan');
    disk.write('pair', 'Grüße/übung.txt', 'Umlaute');
    disk.write('pair', 'with space.txt', 'spaces');
    disk.write('pair', 'big.bin', big);
    const limit = a.maxUpload();
    expect(limit).toBeGreaterThan(0);
    disk.write('pair', 'too big.bin', new Uint8Array(limit + 1));
    await sync();
    const nodes = await tree(a);
    expect(pathsUnder(nodes, testFolder.id)).toEqual(['Docs/', 'Docs/Notes/', 'Docs/Notes/plan.txt', 'Grüße/', 'Grüße/übung.txt', 'big.bin', 'with space.txt']);
    expect(Buffer.from(await download(a, find(nodes, testFolder.id, 'big.bin')!)).equals(Buffer.from(big))).toBe(true);
    expect(engine.activity.filter((entry) => entry.kind === 'too-large').map((entry) => entry.path)).toEqual(['too big.bin']);
  }, 180_000);

  it('follows renames, moves, edits, conflicts and deletes both ways', async () => {
    let nodes = await tree(a);
    const plan = find(nodes, find(nodes, find(nodes, testFolder.id, 'Docs')!.id, 'Notes')!.id, 'plan.txt')!;
    // Here: rename and move.
    disk.moveUser('pair', 'Docs/Notes/plan.txt', 'Grüße/Plan.txt');
    await sync();
    nodes = await tree(a);
    expect(find(nodes, find(nodes, testFolder.id, 'Grüße')!.id, 'Plan.txt')?.id).toBe(plan.id);
    // Another device: rename a folder and edit a file.
    const spaced = find(nodes, testFolder.id, 'with space.txt')!;
    await other.move(find(nodes, testFolder.id, 'Docs')!.id, { name: 'Documents' });
    const blob = await other.upload(text('edited elsewhere'), 'text/plain');
    await other.replaceBlob(spaced.id, blob.blobId);
    engine.remoteChanged('fs');
    await new Promise((resolve) => setTimeout(resolve, 200));
    await sync();
    expect(disk.listing('pair')).toEqual(expect.arrayContaining(['Documents/', 'Documents/Notes/']));
    expect(disk.read('pair', 'with space.txt')).toBe('edited elsewhere');
    // Both sides edit one file.
    disk.write('pair', 'with space.txt', 'edited here, longer');
    const blob2 = await other.upload(text('edited there'), 'text/plain');
    await other.replaceBlob(spaced.id, blob2.blobId);
    await sync();
    const copy = disk.listing('pair').find((path) => path.startsWith('with space (conflict, Test, '))!;
    expect(copy).toBeDefined();
    expect(disk.read('pair', 'with space.txt')).toBe('edited there');
    nodes = await tree(a);
    expect(str(await download(a, find(nodes, testFolder.id, copy)!))).toBe('edited here, longer');
    // Deleted here: into the Files trash.
    disk.deleteUser('pair', 'big.bin');
    await sync();
    nodes = await tree(a);
    expect(find(nodes, testFolder.id, 'big.bin')).toBeUndefined();
    const trash = find(nodes, null, '.Trash')!;
    expect(pathsUnder(nodes, trash.id).some((path) => path.endsWith('/big.bin'))).toBe(true);
    // Deleted in Files: into the computer's trash.
    await other.destroy([find(nodes, testFolder.id, 'Grüße')!.id]);
    engine.remoteChanged('fs');
    await new Promise((resolve) => setTimeout(resolve, 200));
    await sync();
    expect(disk.trashed).toContain('Grüße');
    expect(disk.listing('pair').some((path) => path.startsWith('Grüße'))).toBe(false);
  }, 240_000);

  it('places the drive for the whole account and streams a file from where Windows asks', async () => {
    disk.addRoot({ id: 'drive', account: 'fs', kind: 'drive', remoteId: null });
    await sync();
    const listing = disk.listing('drive');
    expect(listing).toEqual(expect.arrayContaining(['Seed/', 'Seed/Large/large 2.bin', 'Seed/Pictures/photo 2.png']));
    expect(listing.some((path) => path.startsWith('.Trash'))).toBe(false);
    expect(disk.node('drive', 'Seed/Large/large 2.bin').placeholder).toMatchObject({ hydrated: false, inSync: true });
    const request = disk.requestFetch('drive', 'Seed/Large/large 2.bin', 1024 * 1024 + 5);
    const nodes = await tree(a);
    const node = find(nodes, find(nodes, find(nodes, null, 'Seed')!.id, 'Large')!.id, 'large 2.bin')!;
    const whole = await download(a, node);
    for (let i = 0; i < 300 && disk.suppliedBytes(request.fetchId).length < node.size - request.offset; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const got = disk.suppliedBytes(request.fetchId);
    expect(request.offset).toBe(1024 * 1024);
    expect(got.length).toBe(node.size - request.offset);
    expect(Buffer.from(got).equals(Buffer.from(whole.subarray(request.offset)))).toBe(true);
    await engine.removeRoot('drive');
  }, 240_000);

  it('keeps each account to its own Files', async () => {
    const own = await b.createFolder(`Sync test ${Date.now()}`, null);
    disk.addRoot({ id: 'pair-b', account: 'fs-b', remoteId: own.id });
    disk.write('pair-b', 'only b.txt', 'b');
    await sync();
    expect(pathsUnder(await tree(b), own.id)).toEqual(['only b.txt']);
    expect([...(await tree(a)).values()].some((node) => node.name === 'only b.txt')).toBe(false);
    await b.destroy([own.id]);
  }, 120_000);
});
