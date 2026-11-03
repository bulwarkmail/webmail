// @vitest-environment node
/**
 * The real JMAPClient listing files from the store, in each way a server says
 * what a node is, plus what it does with a write.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import { fileNodeKind } from '@/lib/jmap/filenode-kind';
import { setOfflineHooks, type OfflineHooks } from '@/lib/jmap/offline-hooks';
import { DEFAULT_SCOPE } from '../area';
import { AccountEngine } from '../engine/account-engine';
import { filesArea } from '../files';
import { FakeFiles, FILES, FILES_SESSION, SHARED_FILES_ACCOUNT, type FakeFilesOptions } from './helpers/fake-files';
import { openMemoryStore } from './helpers/node-adapter';

afterEach(() => setOfflineHooks(null));

async function offlineClient(server: FakeFiles): Promise<JMAPClient> {
  const engine = new AccountEngine({
    account: 'a@fake.test',
    db: openMemoryStore(),
    session: FILES_SESSION,
    transport: server,
    areas: [filesArea],
    scope: DEFAULT_SCOPE,
    sleep: async () => {},
  });
  await engine.requestSync();
  engine.setOnline(false);
  setOfflineHooks({
    skipNetwork: () => true,
    answer: (_client, calls) => engine.answer(calls),
    record: () => {},
    noteNetwork: () => {},
  } as Partial<OfflineHooks> as OfflineHooks);
  return JMAPClient.fromOfflineSession('https://fake.test', 'a@example.org', {
    ...FILES_SESSION,
    capabilities: { ...FILES_SESSION.capabilities, 'urn:ietf:params:jmap:core': { maxObjectsInGet: 500 } },
  });
}

describe('file listing offline', () => {
  it.each<[string, FakeFilesOptions]>([
    ['nodeType (0.16.6 and later, 1.0 as tested)', { style: 'nodeType' }],
    ['blobId null only (0.16.0-5)', { style: 'blob' }],
    ['@type and mediaType (1.0.0)', { style: 'draft' }],
  ])('tells folders from files: %s', async (_label, options) => {
    const server = new FakeFiles(options);
    const folder = server.addFolder('Docs');
    server.addFile('note.txt', folder.id);
    const client = await offlineClient(server);
    expect(client.supportsFiles()).toBe(true);

    const nodes = await client.listAllFileNodes();
    const byName = new Map(nodes.map((n) => [n.name, n]));
    expect(fileNodeKind(byName.get('Docs') as never)).toBe('directory');
    expect(fileNodeKind(byName.get('note.txt') as never)).toBe('file');
    expect(byName.get('note.txt')).toMatchObject({ parentId: folder.id, type: 'text/plain', size: 10 });
    expect((await client.listFileNodes(folder.id)).map((n) => n.name)).toEqual(['note.txt']);
    expect((await client.listFileNodes(null)).map((n) => n.name)).toEqual(['Docs']);
  });

  it('lists an account larger than one /get, ending its paging cleanly', async () => {
    const server = new FakeFiles({ getAll: 'refuse' });
    const folder = server.addFolder('Docs');
    for (let i = 0; i < 700; i += 1) server.addFile(`f${i}`, folder.id);
    const client = await offlineClient(server);
    expect(await client.listAllFileNodes()).toHaveLength(701);
  });

  it('lists shared accounts with namespaced ids', async () => {
    const server = new FakeFiles();
    server.addFolder('Mine');
    const shared = server.addFolder('Theirs', null, undefined, SHARED_FILES_ACCOUNT);
    const client = await offlineClient(server);
    const nodes = await client.listAllFileNodesAcrossAccounts();
    expect(nodes.find((n) => n.name === 'Theirs')).toMatchObject({ id: `${SHARED_FILES_ACCOUNT}:${shared.id}`, isShared: true });
    expect(nodes.find((n) => n.name === 'Mine')).toMatchObject({ isShared: false });
  });

  it('fails a write with an error rather than losing it', async () => {
    const server = new FakeFiles();
    const client = await offlineClient(server);
    await expect(client.createFileDirectory('New', null)).rejects.toThrow();
    expect(FILES in FILES_SESSION.capabilities).toBe(true);
    expect(server.calls.some(([n]) => n === 'FileNode/set')).toBe(false);
  });
});
