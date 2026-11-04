import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileStore } from '../file-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { FileNode } from '@/lib/jmap/types';
import type { UploadConflict } from '@/lib/files-upload-conflicts';

// pim-p2-6: files dropped on a folder's row go into that folder, and a name
// taken there (not in the folder in view) asks.

function makeClient(initial: FileNode[]) {
  const nodes: FileNode[] = initial.map(n => ({ ...n }));
  let seq = 0;
  const client = {
    getCapabilities: () => ({}),
    getFilesAccountId: () => 'acct',
    async listAllFileNodes() { return nodes.map(n => ({ ...n })); },
    async listFileNodes(parentId: string | null) { return nodes.filter(n => (n.parentId ?? null) === parentId).map(n => ({ ...n })); },
    async createFileNode(name: string, blobId: string, type: string, size: number, parentId: string | null) {
      const node: FileNode = { id: `n${++seq}`, parentId, name, type, blobId, size, created: '', modified: '' };
      nodes.push(node);
      return { ...node };
    },
    replaceFileNodeBlob: vi.fn(async () => {}),
    async uploadBlob() { return { blobId: `blob${++seq}`, type: 'text/plain' }; },
    _nodes: () => nodes,
  };
  return client as unknown as IJMAPClient & { _nodes: () => FileNode[] };
}

const folder = (id: string, name: string, parentId: string | null): FileNode => ({
  id, parentId, name, type: '', blobId: null, size: 0, created: '', modified: '',
});
const file = (id: string, name: string, parentId: string | null): FileNode => ({
  id, parentId, name, type: 'text/plain', blobId: `old-${id}`, size: 3, created: '', modified: '',
});

beforeEach(() => {
  useFileStore.setState({
    client: null, currentParentId: null, currentPath: '/', pathStack: [{ id: null, name: '' }],
    resources: [], selectedResources: new Set(), clipboard: null, lastAction: null,
  });
});

describe('uploading into a folder of the one in view (pim-p2-6)', () => {
  it('creates the files in that folder and asks about names taken there', async () => {
    const client = makeClient([folder('d', 'Documents', null), file('r', 'report.txt', 'd'), file('t', 'top.txt', null)]);
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(null);
    const asked: UploadConflict[][] = [];
    const resolveConflicts = vi.fn(async (conflicts: UploadConflict[]) => {
      asked.push(conflicts);
      return new Map(conflicts.map(c => [c.name, 'keep' as const]));
    });
    await useFileStore.getState().uploadFiles(
      [new File(['x'], 'report.txt'), new File(['y'], 'top.txt')],
      { resolveConflicts, into: { id: 'd', name: 'Documents' } },
    );
    // report.txt is taken in Documents, top.txt only in the folder in view.
    expect(asked).toEqual([[{ name: 'report.txt', kind: 'file' }]]);
    const added = client._nodes().filter(n => n.id.startsWith('n'));
    expect(added.map(n => [n.name, n.parentId]).sort()).toEqual([['report (1).txt', 'd'], ['top.txt', 'd']]);
  });
});
