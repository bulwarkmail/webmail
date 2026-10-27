import { describe, it, expect, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';
import type { FileNodeListings } from '../jmap/client-interface';
import { jmapErrorProperties, jmapErrorType } from '../jmap/jmap-error';
import { fileErrorKind, isPartialCopy } from '../file-errors';

type Call = [string, Record<string, unknown>, string];

interface FakeOptions {
  /** The SetError the server answers a create with, if it refuses it. */
  refuseCreate?: (props: Record<string, unknown>) => Record<string, unknown> | undefined;
  /** The SetError the server answers an update or destroy of `id` with. */
  refuse?: (id: string) => Record<string, unknown> | undefined;
  /** The filenode account capability of "me" (and of "grp", unless `sharedCapability` says otherwise). */
  capability?: Record<string, unknown>;
  /** Null: "grp" lists no filenode capability, as a shared account may. */
  sharedCapability?: Record<string, unknown> | null;
  /** Someone else puts a node into the created node of this name right after it is made. */
  intrudeInto?: string;
}

// The rules Stalwart 1.0 publishes (0.16.23: the same with maxFileNodeDepth null).
const STALWART_10_CAPABILITY = {
  maxFileNodeDepth: 64,
  maxSizeFileNodeName: 255,
  forbiddenNameChars: '/<>:"\\|?*',
  forbiddenNodeNames: ['.', '..', 'CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT1'],
};

// Stalwart 1.0.0 (File Storage draft 18) also lists the node types it has.
const STALWART_100_CAPABILITY = {
  ...STALWART_10_CAPABILITY,
  supportedNodeTypes: ['Directory', 'File', 'SymLink'],
};

// A primary account "me" plus a shared drive "grp", as listed by
// listAllFileNodesAcrossAccounts ("grp:<id>").
function makeClient(nodes: Record<string, Array<Record<string, unknown>>>, options: FakeOptions = {}) {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  const fileCap = { 'urn:ietf:params:jmap:filenode': options.capability ?? {} };
  const sharedCap = options.sharedCapability === null
    ? {}
    : { 'urn:ietf:params:jmap:filenode': options.sharedCapability ?? options.capability ?? {} };
  Object.assign(client, {
    accountId: 'me',
    capabilities: { 'urn:ietf:params:jmap:filenode': {} },
    accounts: { me: { accountCapabilities: fileCap, isPersonal: true }, grp: { accountCapabilities: sharedCap, isPersonal: false } },
    session: {
      primaryAccounts: { 'urn:ietf:params:jmap:filenode': 'me' },
      accounts: { me: { accountCapabilities: fileCap, isPersonal: true }, grp: { accountCapabilities: sharedCap, isPersonal: false } },
    },
  });
  vi.spyOn(client as unknown as { getFilesCapableAccountIds: () => string[] }, 'getFilesCapableAccountIds')
    .mockReturnValue(['me', 'grp']);
  const calls: Call[] = [];
  let seq = 0;
  // Parent of every node the fake has created or been told about, to answer
  // destroys the way Stalwart does.
  const parents = new Map<string, string | null>();
  vi.spyOn(client as unknown as { request: (c: Call[]) => Promise<unknown> }, 'request')
    .mockImplementation(async (reqCalls: Call[]) => {
      const [method, args, id] = reqCalls[0];
      calls.push(reqCalls[0]);
      if (method === 'FileNode/get') {
        return { methodResponses: [['FileNode/get', { list: nodes[args.accountId as string] ?? [] }, id]] };
      }
      if (method === 'Blob/copy') {
        const blobIds = args.blobIds as string[];
        return { methodResponses: [['Blob/copy', { copied: Object.fromEntries(blobIds.map(b => [b, `${b}-copy`])) }, id]] };
      }
      if (method === 'FileNode/set' && args.create) {
        const props = (args.create as { n0: Record<string, unknown> }).n0;
        const refusal = options.refuseCreate?.(props);
        if (refusal) return { methodResponses: [['FileNode/set', { notCreated: { n0: refusal } }, id]] };
        const created = `new${++seq}`;
        parents.set(created, (props.parentId as string | undefined) ?? null);
        if (props.name === options.intrudeInto) parents.set('theirs', created);
        return { methodResponses: [['FileNode/set', { created: { n0: { id: created } } }, id]] };
      }
      if (method === 'FileNode/set' && args.update) {
        const ids = Object.keys(args.update as object);
        const refused = ids.filter(k => options.refuse?.(k));
        return { methodResponses: [['FileNode/set', {
          updated: Object.fromEntries(ids.filter(k => !refused.includes(k)).map(k => [k, null])),
          notUpdated: Object.fromEntries(refused.map(k => [k, options.refuse?.(k)])),
        }, id]] };
      }
      if (method === 'FileNode/set' && args.destroy) {
        const ids = args.destroy as string[];
        const destroyed: string[] = [];
        const notDestroyed: Record<string, unknown> = {};
        // Without onDestroyRemoveChildren, a folder that still holds anything
        // is refused. 0.16 checks against the tree as it was before the call,
        // so children destroyed in the same call still count (willDestroy).
        const childrenBefore = new Map(ids.map(k => [k, [...parents].filter(([, p]) => p === k).map(([c]) => c)]));
        for (const k of ids) {
          const refusal = options.refuse?.(k);
          const children = childrenBefore.get(k) ?? [];
          if (refusal) notDestroyed[k] = refusal;
          else if (args.onDestroyRemoveChildren || children.length === 0) destroyed.push(k);
          else if (children.some(c => ids.includes(c))) notDestroyed[k] = { type: 'willDestroy', description: 'File node or one of its children is already marked for deletion.' };
          else notDestroyed[k] = { type: 'nodeHasChildren', description: 'Cannot delete non-empty folder.' };
        }
        for (const k of destroyed) parents.delete(k);
        return { methodResponses: [['FileNode/set', { destroyed, notDestroyed }, id]] };
      }
      throw new Error(`unexpected ${method}`);
    });
  return { client, calls, parents };
}

const sets = (calls: Call[]) => calls.filter(([m]) => m === 'FileNode/set').map(([, a]) => a);

describe('FileNode writes', () => {
  it('writes inside a shared drive go to that account with bare ids', async () => {
    const { client, calls } = makeClient({});
    const dir = await client.createFileDirectory('New', 'grp:f1');
    await client.updateFileNode('grp:n1', { name: 'Renamed', parentId: 'grp:f2' });
    await client.destroyFileNodes(['grp:n1', 'n9']);

    expect(dir.id).toBe('grp:new1');
    const [create, update, destroyGrp, destroyMe] = sets(calls);
    expect(create).toMatchObject({ accountId: 'grp', onExists: 'rename', create: { n0: { name: 'New', parentId: 'f1' } } });
    expect(update).toMatchObject({ accountId: 'grp', update: { n1: { name: 'Renamed', parentId: 'f2' } } });
    expect(destroyGrp).toMatchObject({ accountId: 'grp', destroy: ['n1'] });
    expect(destroyMe).toMatchObject({ accountId: 'me', destroy: ['n9'] });
  });

  it('refuses a move into another account instead of sending a foreign id', async () => {
    const { client } = makeClient({});
    await expect(client.updateFileNode('grp:n1', { parentId: null })).rejects.toThrow('between accounts');
  });

  it('copies a folder with its whole subtree', async () => {
    const { client, calls } = makeClient({
      me: [
        { id: 'd1', name: 'Docs', parentId: null, blobId: null },
        { id: 'f1', name: 'a.txt', parentId: 'd1', blobId: 'b1', type: 'text/plain', size: 3 },
        { id: 'd2', name: 'Sub', parentId: 'd1', blobId: null },
        { id: 'f2', name: 'b.txt', parentId: 'd2', blobId: 'b2', type: 'text/plain', size: 4 },
      ],
    });
    await client.copyFileNode('d1', 'Docs (copy)', null);

    const creates = sets(calls).map(a => (a.create as { n0: Record<string, unknown> }).n0);
    // No `size`: the server takes it from the blob, and 1.0 refuses a mismatch.
    expect(creates).toEqual([
      { name: 'Docs (copy)' },
      { name: 'a.txt', parentId: 'new1', type: 'text/plain', blobId: 'b1' },
      { name: 'Sub', parentId: 'new1' },
      { name: 'b.txt', parentId: 'new3', type: 'text/plain', blobId: 'b2' },
    ]);
    expect(calls.some(([m]) => m === 'Blob/copy')).toBe(false);
  });

  it('leaves symlinks out of a folder copy instead of making them empty folders (Stalwart 1.0)', async () => {
    const { client, calls } = makeClient({
      me: [
        { id: 'd1', name: 'Docs', parentId: null, nodeType: 'directory', blobId: null, type: null, size: null },
        { id: 'l1', name: 'latest', parentId: 'd1', nodeType: 'symlink', blobId: null, type: null, size: null },
        { id: 'f1', name: 'a.txt', parentId: 'd1', nodeType: 'file', blobId: 'b1', type: 'text/plain', size: 3 },
      ],
    });
    await client.copyFileNode('d1', 'Docs (copy)', null);

    // Nor is nodeType ever sent: 1.0 treats it as immutable.
    const creates = sets(calls).map(a => (a.create as { n0: Record<string, unknown> }).n0);
    expect(creates).toEqual([
      { name: 'Docs (copy)' },
      { name: 'a.txt', parentId: 'new1', type: 'text/plain', blobId: 'b1' },
    ]);
  });

  it('refuses to copy a symlink itself', async () => {
    const { client, calls } = makeClient({
      me: [{ id: 'l1', name: 'latest', parentId: null, nodeType: 'symlink', blobId: null, type: null, size: null }],
    });
    await expect(client.copyFileNode('l1', 'latest (copy)', null)).rejects.toThrow('Symbolic links');
    expect(sets(calls)).toEqual([]);
  });

  it('copies WebDAV-created names inside a folder the way they are shown (#869)', async () => {
    const { client, calls } = makeClient({
      me: [
        { id: 'd1', name: 'Docs', parentId: null, blobId: null },
        { id: 'f1', name: 'My%20Notes.txt', parentId: 'd1', blobId: 'b1', type: 'text/plain', size: 3 },
      ],
    });
    await client.copyFileNode('d1', 'Docs (copy)', null);

    const creates = sets(calls).map(a => (a.create as { n0: Record<string, unknown> }).n0);
    expect(creates[1]).toMatchObject({ name: 'My Notes.txt' });
  });

  it('leaves the size of a new file to the server', async () => {
    const { client, calls } = makeClient({});
    await client.createFileNode('a.txt', 'b1', 'text/plain', 3, null);
    expect(sets(calls)).toEqual([
      { accountId: 'me', onExists: 'rename', create: { n0: { name: 'a.txt', type: 'text/plain', blobId: 'b1' } } },
    ]);
  });

  // Seen live: 1.0.0 answers a create without `@type` with "@type is
  // required on creation." and one with `type` with "Invalid property.";
  // 0.16.27 answers `@type` with "Invalid property.".
  it('creates with @type and mediaType on Stalwart 1.0.0, and copies its nodes', async () => {
    const { client, calls } = makeClient({
      me: [
        { id: 'd1', name: 'Docs', parentId: null, '@type': 'Directory' },
        { id: 'l1', name: 'latest', parentId: 'd1', '@type': 'SymLink' },
        { id: 'f1', name: 'a.txt', parentId: 'd1', '@type': 'File', mediaType: 'text/plain', blobId: 'b1', size: 3 },
      ],
    }, { capability: STALWART_100_CAPABILITY });

    const dir = await client.createFileDirectory('New', null);
    const made = await client.createFileNode('b.txt', 'b2', 'text/plain', 3, null);
    await client.copyFileNode('d1', 'Docs (copy)', null);

    expect(sets(calls).map(a => (a.create as { n0: Record<string, unknown> }).n0)).toEqual([
      { '@type': 'Directory', name: 'New' },
      { '@type': 'File', name: 'b.txt', mediaType: 'text/plain', blobId: 'b2' },
      { '@type': 'Directory', name: 'Docs (copy)' },
      { '@type': 'File', name: 'a.txt', parentId: 'new3', mediaType: 'text/plain', blobId: 'b1' },
    ]);
    expect(dir).toMatchObject({ id: 'new1', name: 'New', nodeType: 'directory' });
    expect(made).toMatchObject({ id: 'new2', type: 'text/plain', nodeType: 'file' });
  });

  it('shares with the mayWrite rights of servers before 0.16.6', async () => {
    const { client, calls } = makeClient({});
    await client.setFileNodeShare('n1', 'p1', {
      mayRead: true, mayAddChildren: true, mayRename: false, mayDelete: false, mayModifyContent: false, mayShare: false,
    }).catch(() => {});
    expect(sets(calls)[0]).toMatchObject({
      accountId: 'me',
      update: { n1: { 'shareWith/p1': { mayRead: true, mayWrite: true, mayShare: false } } },
    });
  });

  it('reads old mayWrite rights as the finer rights', async () => {
    const { client } = makeClient({
      me: [{ id: 'd1', name: 'Docs', parentId: null, blobId: null, myRights: { mayRead: true, mayWrite: true, mayShare: false } }],
    });
    const [node] = await client.listAllFileNodes();
    expect(node.myRights).toEqual({
      mayRead: true, mayAddChildren: true, mayRename: true, mayDelete: true, mayModifyContent: true, mayShare: false,
    });
  });

  // Stalwart (0.16.6+ and 1.0) accepts another account's FileNode blobId
  // from anyone who may read that node, so copies reuse it. Blob/copy would
  // reserve the content to the target account, usable by its members only.
  it('copies a file out of a shared drive by reusing its blobId, without Blob/copy', async () => {
    const { client, calls } = makeClient({
      grp: [{ id: 'f1', name: 'shared.pdf', parentId: null, blobId: 'b1', type: 'application/pdf', size: 9 }],
    });
    const copy = await client.copyFileNode('grp:f1', 'shared.pdf', null);

    expect(sets(calls)).toEqual([
      { accountId: 'me', onExists: 'rename', create: { n0: { name: 'shared.pdf', type: 'application/pdf', blobId: 'b1' } } },
    ]);
    expect(calls.some(([m]) => m === 'Blob/copy')).toBe(false);
    expect(copy.id).toBe('new1');
  });

  it('copies an own folder into someone else\'s shared drive with the same blobs', async () => {
    const { client, calls } = makeClient({
      me: [
        { id: 'd1', name: 'Docs', parentId: null, blobId: null },
        { id: 'f1', name: 'a.txt', parentId: 'd1', blobId: 'b1', type: 'text/plain', size: 3 },
      ],
    });
    const copy = await client.copyFileNode('d1', 'Docs', 'grp:d9');

    expect(sets(calls)).toEqual([
      { accountId: 'grp', onExists: 'rename', create: { n0: { name: 'Docs', parentId: 'd9' } } },
      { accountId: 'grp', onExists: 'rename', create: { n0: { name: 'a.txt', parentId: 'new1', type: 'text/plain', blobId: 'b1' } } },
    ]);
    expect(calls.some(([m]) => m === 'Blob/copy')).toBe(false);
    expect(copy.id).toBe('grp:new1');
  });

  const docs = [
    { id: 'd1', name: 'Docs', parentId: null, blobId: null },
    { id: 'f1', name: 'a.txt', parentId: 'd1', blobId: 'b1', type: 'text/plain', size: 3 },
    { id: 'f2', name: 'b.txt', parentId: 'd1', blobId: 'b2', type: 'text/plain', size: 4 },
  ];

  const destroys = (calls: Call[]) => sets(calls).filter(a => a.destroy);

  it('removes the half-made copy and reports why when a create fails part-way on Stalwart 1.0', async () => {
    const { client, calls } = makeClient({ me: docs }, {
      // 1.0 once an administrator has set maxFiles.
      refuseCreate: (props) => props.name === 'b.txt'
        ? { type: 'overQuota', description: 'There are too many files, please delete some before adding a new one.' }
        : undefined,
    });

    const refused = await client.copyFileNode('d1', 'Docs', 'grp:d9').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toContain('There are too many files');
    expect(isPartialCopy(refused)).toBe(false);
    // Only what the copy made, the file before its folder.
    expect(destroys(calls)).toEqual([
      { accountId: 'grp', destroy: ['new2'] },
      { accountId: 'grp', destroy: ['new1'] },
    ]);
  });

  it('removes the half-made copy when the server refuses a blob on 0.16', async () => {
    const { client, calls } = makeClient({ grp: docs }, {
      refuseCreate: (props) => props.blobId === 'b2'
        ? { type: 'forbidden', description: 'You do not have access to blobId b2.' }
        : undefined,
    });

    await expect(client.copyFileNode('grp:d1', 'Docs', null)).rejects.toThrow('You do not have access to blobId b2.');
    expect(destroys(calls)).toEqual([
      { accountId: 'me', destroy: ['new2'] },
      { accountId: 'me', destroy: ['new1'] },
    ]);
  });

  // Docs > a.txt, Sub > b.txt, c.txt: c.txt is refused after the rest was made.
  const nested = [
    { id: 'd1', name: 'Docs', parentId: null, blobId: null },
    { id: 'f1', name: 'a.txt', parentId: 'd1', blobId: 'b1', type: 'text/plain', size: 3 },
    { id: 'd2', name: 'Sub', parentId: 'd1', blobId: null },
    { id: 'f2', name: 'b.txt', parentId: 'd2', blobId: 'b2', type: 'text/plain', size: 4 },
    { id: 'f3', name: 'c.txt', parentId: 'd1', blobId: 'b3', type: 'text/plain', size: 5 },
  ];
  const quotaOnC = (props: Record<string, unknown>) => props.name === 'c.txt'
    ? { type: 'overQuota', description: 'There are too many files, please delete some before adding a new one.' }
    : undefined;

  it('takes a copy back one level per call, deepest first, without onDestroyRemoveChildren (0.16 and 1.0)', async () => {
    // The fake answers like 0.16: a folder destroyed in the same call as its
    // children is refused (willDestroy). 1.0 takes either.
    const { client, calls, parents } = makeClient({ me: nested }, { refuseCreate: quotaOnC });

    await expect(client.copyFileNode('d1', 'Docs', 'grp:d9')).rejects.toThrow('There are too many files');
    expect(destroys(calls)).toEqual([
      { accountId: 'grp', destroy: ['new4'] },
      { accountId: 'grp', destroy: ['new2', 'new3'] },
      { accountId: 'grp', destroy: ['new1'] },
    ]);
    expect([...parents.keys()]).toEqual([]);
  });

  it('leaves a folder of the copy that someone added to meanwhile, and says the copy is partly there (0.16 and 1.0)', async () => {
    const { client, calls, parents } = makeClient({ me: nested }, { refuseCreate: quotaOnC, intrudeInto: 'Sub' });

    const refused = await client.copyFileNode('d1', 'Docs', 'grp:d9').catch((error: unknown) => error);
    expect(isPartialCopy(refused)).toBe(true);
    // Still says why the copy stopped.
    expect(fileErrorKind(refused)).toBe('overQuota');
    expect((refused as Error).message).toContain('There are too many files');
    // Their file stays, and so do Sub (new3) and Docs (new1) above it.
    expect(destroys(calls).every(a => !('onDestroyRemoveChildren' in a))).toBe(true);
    expect(destroys(calls).flatMap(a => a.destroy as string[])).not.toContain('theirs');
    expect([...parents.keys()].sort()).toEqual(['new1', 'new3', 'theirs']);
  });

  it('has nothing to remove when the copy itself is refused', async () => {
    const { client, calls } = makeClient({ me: docs }, {
      refuseCreate: () => ({ type: 'forbidden', description: 'You are not allowed to create file nodes in this folder.' }),
    });

    await expect(client.copyFileNode('d1', 'Docs', 'grp:d9')).rejects.toThrow('not allowed');
    expect(sets(calls).some(a => a.destroy)).toBe(false);
  });
});

describe('FileNode write errors, names and types', () => {
  const caught = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);

  it('keeps the SetError\'s type and properties on what it throws on Stalwart 1.0', async () => {
    const { client } = makeClient({}, {
      refuseCreate: () => ({ type: 'invalidProperties', description: 'Maximum folder depth exceeded.', properties: ['parentId'] }),
      refuse: (id) => id === 'n1'
        ? { type: 'forbidden', description: 'You are not allowed to rename or move this file node.' }
        : { type: 'overQuota', description: 'There are too many folders, please delete some before adding a new one.' },
    });

    const tooDeep = await caught(client.createFileDirectory('Deeper', 'd63'));
    expect(jmapErrorType(tooDeep)).toBe('invalidProperties');
    expect(jmapErrorProperties(tooDeep)).toEqual(['parentId']);
    expect(fileErrorKind(tooDeep)).toBe('tooDeep');

    const renamed = await caught(client.updateFileNode('n1', { name: 'x' }));
    expect(renamed).toBeInstanceOf(Error);
    expect(fileErrorKind(renamed)).toBe('forbidden');

    expect(fileErrorKind(await caught(client.destroyFileNodes(['n2'])))).toBe('overQuota');
  });

  it('keeps the type of a name 0.16 refuses', async () => {
    const { client } = makeClient({}, {
      refuseCreate: () => ({ type: 'invalidProperties', description: 'Name is reserved and cannot be used.', properties: ['name'] }),
    });
    expect(fileErrorKind(await caught(client.createFileNode('x', 'b1', 'text/plain', 1, null)))).toBe('invalidName');
  });

  it('sends the bare media type Stalwart 1.0 insists on, when creating and copying', async () => {
    const { client, calls } = makeClient({
      me: [{ id: 'f1', name: 'data.csv', parentId: null, blobId: 'b1', type: 'TEXT/CSV', size: 3 }],
    }, { capability: STALWART_10_CAPABILITY });

    await client.createFileNode('a.txt', 'b0', 'Text/Plain; charset=utf-8', 3, null);
    // A type no browser sends, as old builds stored for folder markers.
    await client.createFileNode('marker', 'b9', 'd', 0, null);
    await client.copyFileNode('f1', 'data (copy).csv', null);

    expect(sets(calls).map(a => (a.create as { n0: { type: string } }).n0.type))
      .toEqual(['text/plain', 'application/octet-stream', 'text/csv']);
  });

  it('names a node in a shared drive by the user\'s own rules when the drive lists none', async () => {
    const { client, calls } = makeClient({}, { capability: STALWART_10_CAPABILITY, sharedCapability: null });
    await client.createFileNode('con.txt', 'b1', 'text/plain', 3, 'grp:d9');
    expect(sets(calls)[0]).toMatchObject({ accountId: 'grp', create: { n0: { name: 'con_.txt', parentId: 'd9' } } });
  });

  // Three levels: top > mid > target.
  const tree = [
    { id: 'top', name: 'top', parentId: null, blobId: null },
    { id: 'mid', name: 'mid', parentId: 'top', blobId: null },
    { id: 'target', name: 'target', parentId: 'mid', blobId: null },
    { id: 'src', name: 'src', parentId: null, blobId: null },
    { id: 'inner', name: 'inner', parentId: 'src', blobId: null },
    { id: 'f', name: 'f.txt', parentId: 'inner', blobId: 'b1', type: 'text/plain', size: 1 },
  ];

  it('stops a copy that would go past maxFileNodeDepth before creating anything (Stalwart 1.0)', async () => {
    // target sits at level 3; src/inner/f.txt adds three more.
    const { client, calls } = makeClient({ me: tree }, { capability: { ...STALWART_10_CAPABILITY, maxFileNodeDepth: 5 } });
    const refused = await caught(client.copyFileNode('src', 'src', 'target'));
    expect(fileErrorKind(refused)).toBe('tooDeep');
    expect(sets(calls)).toEqual([]);
  });

  it('copies when it fits, and checks the other account\'s tree for a shared drive', async () => {
    const fits = makeClient({ me: tree }, { capability: { ...STALWART_10_CAPABILITY, maxFileNodeDepth: 6 } });
    await fits.client.copyFileNode('src', 'src', 'target');
    expect(sets(fits.calls)).toHaveLength(3);

    const shared = makeClient({ me: tree, grp: tree }, { capability: { ...STALWART_10_CAPABILITY, maxFileNodeDepth: 5 } });
    expect(fileErrorKind(await caught(shared.client.copyFileNode('src', 'src', 'grp:target')))).toBe('tooDeep');
    expect(sets(shared.calls)).toEqual([]);
  });

  it('has no depth to check on 0.16, which advertises maxFileNodeDepth null', async () => {
    const { client, calls } = makeClient({ me: tree }, { capability: { ...STALWART_10_CAPABILITY, maxFileNodeDepth: null } });
    await client.copyFileNode('src', 'src', 'target');
    expect(sets(calls)).toHaveLength(3);
  });

  it('reads each account\'s tree once for all the copies of one paste (Stalwart 1.0)', async () => {
    const { client, calls } = makeClient({ me: tree, grp: tree }, { capability: STALWART_10_CAPABILITY });
    const listings: FileNodeListings = new Map();
    await client.copyFileNode('src', 'src', 'grp:target', listings);
    await client.copyFileNode('f', 'f.txt', 'grp:target', listings);

    // The source tree, then the target's for the depth check; not again per item.
    expect(calls.filter(([m]) => m === 'FileNode/get').map(([, a]) => a.accountId)).toEqual(['me', 'grp']);
    expect(sets(calls)).toHaveLength(4);
  });
});
