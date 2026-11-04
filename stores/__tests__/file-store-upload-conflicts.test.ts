import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileStore } from '../file-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { FileNode } from '@/lib/jmap/types';
import type { UploadConflict, UploadConflictChoice } from '@/lib/files-upload-conflicts';

// pim-10: an upload whose name is taken asks Replace / Keep both / Skip.
// Replace gives the existing node new content (same id), Keep both adds
// "name (1)", Skip leaves it alone.

function makeClient(initial: FileNode[]) {
  let nodes: FileNode[] = initial.map(n => ({ ...n }));
  let seq = 0;
  const client = {
    getCapabilities: () => ({}),
    getFilesAccountId: () => 'acct',
    async listAllFileNodes() { return nodes.map(n => ({ ...n })); },
    async createFileDirectory(name: string, parentId: string | null) {
      const node: FileNode = { id: `n${++seq}`, parentId, name, type: '', blobId: null, size: 0, created: '', modified: '' };
      nodes.push(node);
      return { ...node };
    },
    async createFileNode(name: string, blobId: string, type: string, size: number, parentId: string | null) {
      const node: FileNode = { id: `n${++seq}`, parentId, name, type, blobId, size, created: '', modified: '' };
      nodes.push(node);
      return { ...node };
    },
    replaceFileNodeBlob: vi.fn(async (id: string, blobId: string) => {
      const node = nodes.find(n => n.id === id);
      if (!node) throw new Error('not found');
      node.blobId = blobId;
    }),
    async uploadBlob() { return { blobId: `blob${++seq}`, type: 'text/plain' }; },
    _nodes: () => nodes,
    _reset: (next: FileNode[]) => { nodes = next; },
  };
  return client as unknown as IJMAPClient & { _nodes: () => FileNode[]; replaceFileNodeBlob: ReturnType<typeof vi.fn> };
}

const folder = (id: string, name: string, parentId: string | null): FileNode => ({
  id, parentId, name, type: '', blobId: null, size: 0, created: '', modified: '',
});
const file = (id: string, name: string, parentId: string | null): FileNode => ({
  id, parentId, name, type: 'text/plain', blobId: `old-${id}`, size: 3, created: '', modified: '',
});
const upload = (name: string, path?: string) => {
  const f = new File(['new'], name, { type: 'text/plain' });
  if (path) Object.defineProperty(f, 'webkitRelativePath', { value: path });
  return f;
};

/** Answers every conflict with `choice`, and records what was asked. */
function answering(choice: UploadConflictChoice | null) {
  const asked: UploadConflict[][] = [];
  const resolveConflicts = vi.fn(async (conflicts: UploadConflict[]) => {
    asked.push(conflicts);
    return choice ? new Map(conflicts.map(c => [c.name, choice])) : null;
  });
  return { asked, resolveConflicts };
}

async function start(nodes: FileNode[]) {
  const client = makeClient(nodes);
  useFileStore.getState().initClient(client);
  await useFileStore.getState().navigate(null);
  return client;
}

beforeEach(() => {
  useFileStore.setState({
    client: null, currentParentId: null, currentPath: '/', pathStack: [{ id: null, name: '' }],
    resources: [], selectedResources: new Set(), clipboard: null, lastAction: null,
  });
});

describe('uploading files whose name is taken (pim-10)', () => {
  it('asks only about the taken names', async () => {
    await start([file('r', 'report.txt', null), folder('d', 'new.txt', null)]);
    const { asked, resolveConflicts } = answering('keep');
    await useFileStore.getState().uploadFiles([upload('report.txt'), upload('other.txt'), upload('new.txt')], { resolveConflicts });
    // A folder named like the file is no conflict: the file is numbered beside it.
    expect(asked).toEqual([[{ name: 'report.txt', kind: 'file' }]]);
  });

  it('Replace gives the existing node the new content and keeps its id', async () => {
    const client = await start([file('r', 'report.txt', null)]);
    const { resolveConflicts } = answering('replace');
    const report = await useFileStore.getState().uploadFiles([upload('report.txt')], { resolveConflicts });
    expect(report.uploaded).toBe(1);
    expect(client.replaceFileNodeBlob).toHaveBeenCalledWith('r', expect.stringMatching(/^blob/));
    const named = client._nodes().filter(n => n.name.startsWith('report'));
    expect(named.map(n => [n.id, n.name])).toEqual([['r', 'report.txt']]);
    expect(named[0].blobId).not.toBe('old-r');
  });

  it('Keep both adds a numbered copy', async () => {
    const client = await start([file('r', 'report.txt', null)]);
    const { resolveConflicts } = answering('keep');
    await useFileStore.getState().uploadFiles([upload('report.txt')], { resolveConflicts });
    expect(client._nodes().map(n => n.name).sort()).toEqual(['report (1).txt', 'report.txt']);
    expect(client.replaceFileNodeBlob).not.toHaveBeenCalled();
  });

  it('Skip leaves the file alone and uploads the rest', async () => {
    const client = await start([file('r', 'report.txt', null)]);
    const { resolveConflicts } = answering('skip');
    const report = await useFileStore.getState().uploadFiles([upload('report.txt'), upload('other.txt')], { resolveConflicts });
    expect(report).toMatchObject({ uploaded: 1, skipped: 1 });
    expect(client._nodes().map(n => [n.name, n.blobId]).sort()).toEqual([['other.txt', expect.stringMatching(/^blob/)], ['report.txt', 'old-r']]);
  });

  it('calling it off uploads nothing', async () => {
    const client = await start([file('r', 'report.txt', null)]);
    const { resolveConflicts } = answering(null);
    const report = await useFileStore.getState().uploadFiles([upload('report.txt'), upload('other.txt')], { resolveConflicts });
    expect(report).toMatchObject({ uploaded: 0, canceled: true });
    expect(client._nodes().map(n => n.name)).toEqual(['report.txt']);
  });
});

describe('uploading a folder whose name is taken (pim-10)', () => {
  const tree = () => [
    folder('docs', 'Docs', null),
    file('a', 'a.txt', 'docs'),
    folder('sub', 'Sub', 'docs'),
    file('b', 'b.txt', 'sub'),
  ];
  const files = () => [upload('a.txt', 'Docs/a.txt'), upload('b.txt', 'Docs/Sub/b.txt'), upload('c.txt', 'Docs/Sub/c.txt')];

  it('asks about the folder, and Replace merges into it', async () => {
    const client = await start(tree());
    const { asked, resolveConflicts } = answering('replace');
    const report = await useFileStore.getState().uploadFolder(files(), { resolveConflicts });
    expect(asked).toEqual([[{ name: 'Docs', kind: 'folder' }]]);
    expect(report.uploaded).toBe(3);
    const nodes = client._nodes();
    // No second Docs or Sub; a.txt and b.txt keep their ids with new content; c.txt is new in Sub.
    expect(nodes.filter(n => n.blobId === null).map(n => n.id)).toEqual(['docs', 'sub']);
    expect(nodes.find(n => n.id === 'a')!.blobId).toMatch(/^blob/);
    expect(nodes.find(n => n.id === 'b')!.blobId).toMatch(/^blob/);
    expect(nodes.filter(n => n.parentId === 'sub').map(n => n.name).sort()).toEqual(['b.txt', 'c.txt']);
  });

  it('Keep both makes a second folder', async () => {
    const client = await start(tree());
    const { resolveConflicts } = answering('keep');
    await useFileStore.getState().uploadFolder(files(), { resolveConflicts });
    expect(client._nodes().filter(n => n.parentId === null).length).toBe(2);
    expect(client.replaceFileNodeBlob).not.toHaveBeenCalled();
  });

  it('Skip leaves the folder out', async () => {
    const client = await start(tree());
    const { resolveConflicts } = answering('skip');
    const report = await useFileStore.getState().uploadFolder(files(), { resolveConflicts });
    expect(report).toMatchObject({ uploaded: 0, skipped: 3 });
    expect(client._nodes()).toHaveLength(4);
  });
});
