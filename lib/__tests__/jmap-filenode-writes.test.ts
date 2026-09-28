import { describe, it, expect, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';

type Call = [string, Record<string, unknown>, string];

// A primary account "me" plus a shared drive "grp", as listed by
// listAllFileNodesAcrossAccounts ("grp:<id>").
function makeClient(nodes: Record<string, Array<Record<string, unknown>>>) {
  const client = new JMAPClient('https://jmap.example.com', 'user@example.com', 'pass');
  const fileCap = { 'urn:ietf:params:jmap:filenode': {} };
  Object.assign(client, {
    accountId: 'me',
    capabilities: { 'urn:ietf:params:jmap:filenode': {} },
    accounts: { me: { accountCapabilities: fileCap, isPersonal: true }, grp: { accountCapabilities: fileCap, isPersonal: false } },
    session: {
      primaryAccounts: { 'urn:ietf:params:jmap:filenode': 'me' },
      accounts: { me: { accountCapabilities: fileCap, isPersonal: true }, grp: { accountCapabilities: fileCap, isPersonal: false } },
    },
  });
  vi.spyOn(client as unknown as { getFilesCapableAccountIds: () => string[] }, 'getFilesCapableAccountIds')
    .mockReturnValue(['me', 'grp']);
  const calls: Call[] = [];
  let seq = 0;
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
        return { methodResponses: [['FileNode/set', { created: { n0: { id: `new${++seq}` } } }, id]] };
      }
      if (method === 'FileNode/set' && args.update) {
        return { methodResponses: [['FileNode/set', { updated: Object.fromEntries(Object.keys(args.update as object).map(k => [k, null])) }, id]] };
      }
      if (method === 'FileNode/set' && args.destroy) {
        return { methodResponses: [['FileNode/set', { destroyed: args.destroy }, id]] };
      }
      throw new Error(`unexpected ${method}`);
    });
  return { client, calls };
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
    expect(creates).toEqual([
      { name: 'Docs (copy)' },
      { name: 'a.txt', parentId: 'new1', type: 'text/plain', blobId: 'b1', size: 3 },
      { name: 'Sub', parentId: 'new1' },
      { name: 'b.txt', parentId: 'new3', type: 'text/plain', blobId: 'b2', size: 4 },
    ]);
    expect(calls.some(([m]) => m === 'Blob/copy')).toBe(false);
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

  it('copies file content across accounts with Blob/copy', async () => {
    const { client, calls } = makeClient({
      grp: [{ id: 'f1', name: 'shared.pdf', parentId: null, blobId: 'b1', type: 'application/pdf', size: 9 }],
    });
    const copy = await client.copyFileNode('grp:f1', 'shared.pdf', null);

    expect(calls.find(([m]) => m === 'Blob/copy')?.[1]).toEqual({ fromAccountId: 'grp', accountId: 'me', blobIds: ['b1'] });
    expect(sets(calls)[0]).toMatchObject({ accountId: 'me', create: { n0: { blobId: 'b1-copy' } } });
    expect(copy.id).toBe('new1');
  });
});
