import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JMAPClient } from '../jmap/client';

function createClient(): JMAPClient {
  const client = new JMAPClient('https://jmap.example.com', 'user', 'pass');
  Object.assign(client, {
    apiUrl: 'https://jmap.example.com/api',
    accountId: 'account-1',
    accounts: { 'account-1': { name: 'user', isPersonal: true, isReadOnly: false, accountCapabilities: { 'urn:ietf:params:jmap:filenode': {} } } },
    capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:filenode': {} },
  });
  return client;
}

function mockFetch(response: object) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(response)),
    json: () => Promise.resolve(response),
  } as Response);
}

// What Stalwart hands back for nodes created over WebDAV: the raw
// percent-encoded href segment as the name (#869).
const webdavFolder = { id: 'f1', parentId: null, name: 'Spares%20Catalog%20%D8%B9%D8%B1%D8%A8%D9%8A', type: '', blobId: null, size: 0, created: '2026-01-01T00:00:00Z', modified: '2026-01-01T00:00:00Z' };
const jmapFile = { id: 'f2', parentId: 'f1', name: '100% done.txt', type: 'text/plain', blobId: 'b2', size: 3, created: '2026-01-01T00:00:00Z', modified: '2026-01-01T00:00:00Z' };

type MethodCall = [string, Record<string, unknown>, string];

interface FakeNode { id: string; parentId: string | null; name: string; blobId: string | null }

const file = (id: string, parentId: string | null = null): FakeNode => ({ id, parentId, name: `${id}.txt`, blobId: `blob-${id}` });
const folder = (id: string, parentId: string | null = null): FakeNode => ({ id, parentId, name: id, blobId: null });

/**
 * Answers like Stalwart: `FileNode/get { ids: null }` stops at maxObjectsInGet
 * without saying so, an over-long id list is refused, and FileNode/query clamps
 * `limit` to the server's own maximum.
 */
function fakeFilesServer(nodes: FakeNode[], opts: {
  maxObjectsInGet: number;
  queryMaxResults?: number;
  // Stalwart before 0.16.6 returns leaf files only.
  queryOmitsFolders?: boolean;
  queryFails?: boolean;
}) {
  const sent: MethodCall[][] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (_url: string, init: RequestInit) => {
    const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: MethodCall[] };
    sent.push(methodCalls);
    const methodResponses = methodCalls.map(([method, args, callId]) => {
      if (method === 'FileNode/get') {
        const ids = args.ids as string[] | null;
        if (ids === null) return [method, { list: nodes.slice(0, opts.maxObjectsInGet), notFound: [] }, callId];
        if (ids.length > opts.maxObjectsInGet) return ['error', { type: 'requestTooLarge' }, callId];
        return [method, { list: nodes.filter(n => ids.includes(n.id)), notFound: ids.filter(id => !nodes.some(n => n.id === id)) }, callId];
      }
      if (method === 'FileNode/query') {
        if (opts.queryFails) return ['error', { type: 'unknownMethod' }, callId];
        const matching = opts.queryOmitsFolders ? nodes.filter(n => n.blobId !== null) : nodes;
        const position = (args.position as number) ?? 0;
        const limit = Math.min((args.limit as number) ?? Infinity, opts.queryMaxResults ?? Infinity);
        return [method, { ids: matching.slice(position, position + limit).map(n => n.id), position, total: matching.length }, callId];
      }
      return ['error', { type: 'unknownMethod' }, callId];
    });
    const body = JSON.stringify({ methodResponses });
    return { ok: true, status: 200, text: () => Promise.resolve(body) } as Response;
  }) as never);
  return sent;
}

function createLimitedClient(core: Record<string, number>): JMAPClient {
  const client = createClient();
  Object.assign(client, {
    capabilities: { 'urn:ietf:params:jmap:core': core, 'urn:ietf:params:jmap:filenode': {} },
  });
  return client;
}

const sortedIds = (nodes: { id: string }[]) => nodes.map(n => n.id).sort();

describe('JMAPClient FileNode listing past maxObjectsInGet (#1069)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('stays a single request while the account fits in one /get', async () => {
    const client = createLimitedClient({ maxObjectsInGet: 5 });
    const sent = fakeFilesServer([folder('d1'), file('a', 'd1'), file('b')], { maxObjectsInGet: 5 });

    const nodes = await client.listAllFileNodes();
    expect(sortedIds(nodes)).toEqual(['a', 'b', 'd1']);
    expect(sent).toHaveLength(1);
    expect(sent[0][0][1].ids).toBeNull();
  });

  it('pages the query and fetches the nodes the first /get cut off', async () => {
    const all = [folder('d1'), ...Array.from({ length: 10 }, (_, i) => file(`f${i}`, 'd1')), folder('d2')];
    const client = createLimitedClient({ maxObjectsInGet: 3, maxCallsInRequest: 2 });
    // The server hands out fewer ids per page than the client asks for.
    const sent = fakeFilesServer(all, { maxObjectsInGet: 3, queryMaxResults: 5 });

    const nodes = await client.listAllFileNodes();
    expect(sortedIds(nodes)).toEqual(sortedIds(all));

    const calls = sent.flat();
    expect(calls.filter(([m]) => m === 'FileNode/query').map(([, a]) => a.position)).toEqual([0, 5, 10]);
    // Only the nine missing nodes are fetched again, never more than the
    // server allows per /get or per request.
    const idGets = calls.filter(([m, a]) => m === 'FileNode/get' && a.ids !== null);
    expect(idGets.flatMap(([, a]) => a.ids as string[]).sort()).toEqual(sortedIds(all.slice(3)));
    for (const [, args] of idGets) expect((args.ids as string[]).length).toBeLessThanOrEqual(3);
    for (const request of sent) expect(request.length).toBeLessThanOrEqual(2);
  });

  it('recovers folders when the query returns files only (Stalwart < 0.16.6)', async () => {
    // Both folders sit past the first /get, and only `deep` has files in it.
    const all = [file('f0'), file('f1'), file('f2', 'deep'), folder('top'), folder('deep', 'top')];
    const client = createLimitedClient({ maxObjectsInGet: 2 });
    fakeFilesServer(all, { maxObjectsInGet: 2, queryOmitsFolders: true });

    const nodes = await client.listAllFileNodes();
    expect(sortedIds(nodes)).toEqual(sortedIds(all));
  });

  it('asks for an unreadable parent once and moves on', async () => {
    // A node shared out of a folder the user cannot read.
    const all = [file('f0'), file('f1'), file('f2', 'hidden')];
    const client = createLimitedClient({ maxObjectsInGet: 2 });
    const sent = fakeFilesServer(all, { maxObjectsInGet: 2 });

    const nodes = await client.listAllFileNodes();
    expect(sortedIds(nodes)).toEqual(['f0', 'f1', 'f2']);
    const askedForHidden = sent.flat().filter(([m, a]) => m === 'FileNode/get' && (a.ids as string[] | null)?.includes('hidden'));
    expect(askedForHidden).toHaveLength(1);
  });

  it('keeps the first page when the query is refused', async () => {
    const all = [file('f0'), file('f1'), file('f2')];
    const client = createLimitedClient({ maxObjectsInGet: 2 });
    fakeFilesServer(all, { maxObjectsInGet: 2, queryFails: true });

    const nodes = await client.listAllFileNodes();
    expect(sortedIds(nodes)).toEqual(['f0', 'f1']);
  });

  it('lists shared accounts past the limit too', async () => {
    const all = [file('f0'), file('f1'), file('f2'), file('f3')];
    const client = createLimitedClient({ maxObjectsInGet: 2 });
    fakeFilesServer(all, { maxObjectsInGet: 2 });

    const nodes = await client.listAllFileNodesAcrossAccounts();
    expect(sortedIds(nodes)).toEqual(['f0', 'f1', 'f2', 'f3']);
  });

  it('asks for nodeType, which tells Stalwart 1.0 symlinks from folders', async () => {
    const all = [folder('d1'), file('f0'), file('f1'), file('f2')];
    const client = createLimitedClient({ maxObjectsInGet: 2 });
    const sent = fakeFilesServer(all, { maxObjectsInGet: 2 });

    await client.listAllFileNodes();
    const gets = sent.flat().filter(([method]) => method === 'FileNode/get');
    expect(gets.length).toBeGreaterThan(1);
    for (const [, args] of gets) expect(args.properties).toContain('nodeType');
  });
});

describe('JMAPClient FileNode shapes of both drafts', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the kind and media type from @type and mediaType on Stalwart 1.0.0', async () => {
    const client = createClient();
    // As 1.0.0 answers: it leaves `type` and `nodeType` out, 0.16.27 ignores
    // `@type` and `mediaType`.
    const fetchSpy = mockFetch({ methodResponses: [['FileNode/get', { list: [
      { id: 'd1', parentId: null, name: 'Docs', '@type': 'Directory', created: '2026-10-26T19:00:30Z', modified: '2026-10-26T19:00:30Z' },
      { id: 'l1', parentId: 'd1', name: 'latest', '@type': 'SymLink', created: '2026-10-26T19:00:30Z', modified: '2026-10-26T19:00:30Z' },
      { id: 'f1', parentId: 'd1', name: 'a.txt', '@type': 'File', mediaType: 'text/plain', blobId: 'b1', size: 11, created: '2026-10-26T19:00:30Z', modified: '2026-10-26T19:00:30Z' },
    ] }, 'fng0']] });

    const nodes = await client.listAllFileNodes();
    expect(nodes.map(n => [n.id, n.nodeType, n.type])).toEqual([
      ['d1', 'directory', undefined],
      ['l1', 'symlink', undefined],
      ['f1', 'file', 'text/plain'],
    ]);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.methodCalls[0][1].properties).toEqual(expect.arrayContaining(['type', 'nodeType', '@type', 'mediaType']));
  });

  it('keeps the 0.16 shape as it is', async () => {
    const client = createClient();
    mockFetch({ methodResponses: [['FileNode/get', { list: [
      { id: 'f1', parentId: null, name: 'a.txt', type: 'text/plain', nodeType: 'file', blobId: 'b1', size: 11, created: '2026-10-26T19:00:10Z', modified: '2026-10-26T19:00:10Z' },
    ] }, 'fng0']] });

    const [node] = await client.listAllFileNodes();
    expect(node).toMatchObject({ nodeType: 'file', type: 'text/plain' });
  });
});

describe('JMAPClient FileNode name decoding (#869)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('listAllFileNodes decodes WebDAV-created names and keeps JMAP-created ones', async () => {
    const client = createClient();
    mockFetch({ methodResponses: [['FileNode/get', { list: [webdavFolder, jmapFile] }, 'fng0']] });

    const nodes = await client.listAllFileNodes();
    expect(nodes.map(n => n.name)).toEqual(['Spares Catalog عربي', '100% done.txt']);
    // Other properties pass through untouched.
    expect(nodes[0]).toMatchObject({ id: 'f1', parentId: null, blobId: null });
  });

  it('getFileNodes decodes names', async () => {
    const client = createClient();
    mockFetch({ methodResponses: [['FileNode/get', { list: [webdavFolder] }, 'fn0']] });

    const nodes = await client.getFileNodes(['f1']);
    expect(nodes[0].name).toBe('Spares Catalog عربي');
  });

  it('listAllFileNodesAcrossAccounts decodes names', async () => {
    const client = createClient();
    mockFetch({ methodResponses: [['FileNode/get', { list: [webdavFolder, jmapFile] }, 'fng0']] });

    const nodes = await client.listAllFileNodesAcrossAccounts();
    expect(nodes.map(n => n.name)).toEqual(['Spares Catalog عربي', '100% done.txt']);
    expect(nodes[0]).toMatchObject({ id: 'f1', accountId: 'account-1', isShared: false });
  });
});

describe('JMAPClient folders listed only on the way to a shared node', () => {
  const NO_RIGHTS = { mayRead: false, mayAddChildren: false, mayRename: false, mayDelete: false, mayModifyContent: false, mayShare: false };
  const READ = { ...NO_RIGHTS, mayRead: true };
  const T = '2026-09-01T08:00:00Z';
  // What Stalwart 1.0 returns for an ancestor the user may not read
  // (`discoverable_only`): name and place in the tree, nothing else.
  const placeholder = { blobId: null, type: null, size: null, created: null, modified: null, shareWith: null, myRights: NO_RIGHTS };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /** The user's own drive plus another user's, answered per account. */
  function sharingClient(drives: Record<string, object[]>): JMAPClient {
    const client = createClient();
    const fileCap = { 'urn:ietf:params:jmap:filenode': {} };
    Object.assign(client, {
      accounts: {
        'account-1': { name: 'user', isPersonal: true, isReadOnly: false, accountCapabilities: fileCap },
        owner: { name: 'owner@example.com', isPersonal: false, isReadOnly: false, accountCapabilities: fileCap },
      },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (_url: string, init: RequestInit) => {
      const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: MethodCall[] };
      const methodResponses = methodCalls.map(([method, args, callId]) =>
        [method, { list: drives[args.accountId as string] ?? [], notFound: [] }, callId]);
      const body = JSON.stringify({ methodResponses });
      return { ok: true, status: 200, text: () => Promise.resolve(body) } as Response;
    }) as never);
    return client;
  }

  it('marks the owner\'s folders above a shared folder on Stalwart 1.0', async () => {
    const client = sharingClient({
      // Not a real shape for an own node; only other accounts are marked.
      'account-1': [{ id: 'mine', parentId: null, name: 'Mine', ...placeholder }],
      owner: [
        { id: 'a', parentId: null, name: 'Documents', ...placeholder },
        { id: 'b', parentId: 'a', name: 'Projects', ...placeholder },
        { id: 'c', parentId: 'b', name: 'Project X', blobId: null, type: null, size: null, created: T, modified: T, shareWith: null, myRights: READ },
      ],
    });

    const nodes = await client.listAllFileNodesAcrossAccounts();
    expect(nodes.filter(n => n.discoverableOnly).map(n => n.id)).toEqual(['owner:a', 'owner:b']);
  });

  it('marks nothing on 0.16, where a child the share predates has no rights but has dates', async () => {
    const client = sharingClient({
      owner: [
        { id: 'f', parentId: 'hidden', name: 'Shared', blobId: null, type: null, size: null, created: T, modified: T, myRights: READ },
        { id: 'g', parentId: 'f', name: 'old.txt', blobId: 'b1', type: 'text/plain', size: 3, created: T, modified: T, myRights: NO_RIGHTS },
      ],
    });

    const nodes = await client.listAllFileNodesAcrossAccounts();
    expect(nodes).toHaveLength(2);
    expect(nodes.some(n => n.discoverableOnly)).toBe(false);
  });
});
