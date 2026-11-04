// @vitest-environment node
/** The Files side over JMAP, against the fake server's 0.16 and 1.0 behaviours, and names on disk. */
import { describe, expect, it } from 'vitest';
import { conflictName, diskName, freeLocalName, namingFor, nameKey } from '../names';
import { RemoteTree } from '../remote';
import { FakeServer } from './helpers/fake-server';

describe('listing the whole tree', () => {
  function big(options: ConstructorParameters<typeof FakeServer>[0]): FakeServer {
    const server = new FakeServer(options);
    for (let f = 0; f < 6; f += 1) {
      const folder = server.folder(`folder ${f}`);
      for (let i = 0; i < 120; i += 1) server.file(`f${i}.txt`, folder.id, `${f}/${i}`);
    }
    return server;
  }

  it('finds every folder past the /get ceiling where the query leaves folders out (0.16 before 0.16.6)', async () => {
    const server = big({ queryOmitsFolders: true, style: 'blob' });
    const { nodes } = await server.remote().listAll();
    expect(nodes.length).toBe(6 + 720);
    expect(nodes.filter((node) => node.kind === 'directory').length).toBe(6);
  });

  it('lists everything where the return-all /get is refused (1.0)', async () => {
    const server = big({ getAll: 'refuse', style: 'draft' });
    const { nodes, state } = await server.remote().listAll();
    expect(nodes.length).toBe(726);
    expect(nodes.filter((node) => node.kind === 'directory').length).toBe(6);
    expect(state).toBe(server.account().coll.state());
  });

  it('fails rather than give part of the tree', async () => {
    const server = big({});
    let calls = 0;
    server.beforeRequest = () => {
      calls += 1;
      if (calls === 3) server.offline = true;
    };
    await expect(server.remote().listAll()).rejects.toMatchObject({ name: 'TransportError' });
  });
});

describe('writes', () => {
  it('creates in the draft Stalwart 1.0 wants, and folders without content', async () => {
    const server = new FakeServer();
    const accountCaps = server.session.accounts.acc1.accountCapabilities as Record<string, Record<string, unknown>>;
    accountCaps['urn:ietf:params:jmap:filenode'].supportedNodeTypes = ['File', 'Directory'];
    const remote = server.remote();
    const folder = await remote.createFolder('Docs', null);
    const blob = await remote.upload(new TextEncoder().encode('hi'), 'text/plain; charset=utf-8');
    await remote.createFile('a.txt', folder.id, blob);
    const creates = server.sets.map((set) => Object.values(set.create as Record<string, unknown>)[0]);
    expect(creates[0]).toEqual({ '@type': 'Directory', name: 'Docs' });
    expect(creates[1]).toEqual({ '@type': 'File', name: 'a.txt', parentId: folder.id, blobId: blob.blobId, mediaType: 'text/plain' });
  });

  it('moves into the Files trash the way the Files screen does', async () => {
    const server = new FakeServer();
    const remote = server.remote();
    const a = server.file('a.txt', null, 'a');
    const { trashId, batchId } = await remote.trash([a.id], null, null, 1_790_000_000_000);
    expect(server.nodes.get(trashId)?.name).toBe('.Trash');
    expect(server.nodes.get(batchId)?.name).toBe('1790000000000~');
    expect(server.nodes.get(a.id)?.parentId).toBe(batchId);
  });

  it('keeps the tree in order as changes come', () => {
    const tree = new RemoteTree();
    tree.reset([
      { id: 'd', parentId: null, name: 'D', kind: 'directory', blobId: null, size: 0, modifiedMs: 0, type: '' },
      { id: 'f', parentId: 'd', name: 'f', kind: 'file', blobId: 'b', size: 1, modifiedMs: 0, type: '' },
      { id: 't', parentId: null, name: '.Trash', kind: 'directory', blobId: null, size: 0, modifiedMs: 0, type: '' },
      { id: 'x', parentId: 't', name: 'x', kind: 'file', blobId: 'b', size: 1, modifiedMs: 0, type: '' },
    ], 's1');
    expect(tree.subtree(null)?.map((node) => node.id)).toEqual(['d', 'f']);
    expect(tree.inTrash('x')).toBe(true);
    tree.apply({ changed: [], destroyed: ['d'] });
    expect(tree.get('f')).toBeUndefined();
    expect(tree.subtree('d')).toBeNull();
  });
});

describe('names on disk', () => {
  const win = namingFor('win32');

  it('maps what Windows refuses and leaves the rest', () => {
    expect(diskName('a<b>c:d"e|f?g*h\\i.txt', win)).toBe('a＜b＞c：d＂e｜f？g＊h＼i.txt');
    expect(diskName('CON', win)).toBe('CON_');
    expect(diskName('nul.tar.gz', win)).toBe('nul_.tar.gz');
    expect(diskName('com1.txt', win)).toBe('com1_.txt');
    expect(diskName('console.txt', win)).toBe('console.txt');
    expect(diskName('ends with dot.', win)).toBe('ends with dot._');
    expect(diskName('ends with space ', win)).toBe('ends with space _');
    expect(diskName('tab\there', win)).toBe('tab␉here');
    expect(diskName('Grüße, Ärger.txt', win)).toBe('Grüße, Ärger.txt');
    expect(diskName('a:b', namingFor('linux'))).toBe('a:b');
  });

  it('numbers a second name that differs only in case', () => {
    const taken = new Set([nameKey('Report.txt', win)]);
    expect(freeLocalName('report.txt', taken, win)).toBe('report (2).txt');
    const linux = namingFor('linux');
    expect(freeLocalName('report.txt', new Set([nameKey('Report.txt', linux)]), linux)).toBe('report.txt');
  });

  it('names a conflict copy with the device and the time', () => {
    expect(conflictName('report.final.pdf', 'Windows', new Date(2026, 10, 4, 9, 5))).toBe('report.final (conflict, Windows, 2026-11-04 09.05).pdf');
    expect(conflictName('.env', 'Mac', new Date(2026, 0, 1, 0, 0))).toBe('.env (conflict, Mac, 2026-01-01 00.00)');
  });
});
