import { describe, expect, it, vi } from 'vitest';

// pim-p3-1: a second Save to Files of the same document must not report a
// conflict. Stalwart 1.0 keeps an uploaded file under a blob id of its own, so
// the session has to remember what the server holds after each save, not the
// upload's id.

vi.mock('@/stores/auth-store', () => ({ useAuthStore: { getState: () => ({}) } }));
vi.mock('@/stores/file-store', () => ({ useFileStore: { getState: () => ({}) } }));

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { nodeUnchanged, saveBackToNode, saveBesideNode, type NodeEditSource } from '../save-to-files';

/** A server that stores each new content under a blob id of its own, as Stalwart 1.0 does. */
function fakeServer(start: { blobId: string; size: number; modified: string }) {
  let node = { id: 'n1', name: 'budget.xlsx', parentId: 'p1', ...start };
  let stored = 0;
  let uploaded = 0;
  const client = {
    getFileNodes: vi.fn(async (ids: string[]) => ids.includes(node.id) ? [{ ...node }] : ids.includes('n2') ? [{ id: 'n2', name: 'budget (2).xlsx', parentId: 'p1', blobId: 'srv-copy', size: 7, modified: '2026-11-04T10:30:00Z' }] : []),
    uploadBlob: vi.fn(async (file: File) => ({ blobId: `upload-${++uploaded}`, size: file.size, type: 'x/y' })),
    replaceFileNodeBlob: vi.fn(async (_id: string, _blobId: string) => {
      stored += 1;
      node = { ...node, blobId: `srv-${stored}`, size: 10 + stored, modified: `2026-11-04T10:0${stored}:00Z` };
    }),
    createFileNode: vi.fn(async () => ({ id: 'n2', name: 'budget (2).xlsx', parentId: 'p1' })),
  };
  return {
    client: client as unknown as IJMAPClient & typeof client,
    /** Someone else saves the file meanwhile. */
    changeElsewhere: () => { node = { ...node, blobId: 'someone-else', size: 99, modified: '2026-11-04T11:00:00Z' }; },
  };
}

const file = (text: string) => new File([text], 'budget.xlsx', { type: 'x/y' });

describe('Save to Files twice (pim-p3-1)', () => {
  it('saves the second time into the same file, without a conflict', async () => {
    const server = fakeServer({ blobId: 'b-open', size: 5, modified: '2026-11-04T09:00:00Z' });
    let source: NodeEditSource = { kind: 'node', nodeId: 'n1', blobId: 'b-open', parentId: 'p1', size: 5, modified: '2026-11-04T09:00:00Z' };

    const first = await saveBackToNode(server.client, source, file('one'));
    expect(first.status).toBe('saved');
    if (first.status !== 'saved') return;
    // The base is what the server reports now, not the upload's id.
    expect(first.source).toEqual({ kind: 'node', nodeId: 'n1', blobId: 'srv-1', parentId: 'p1', size: 11, modified: '2026-11-04T10:01:00Z' });
    source = first.source;

    const second = await saveBackToNode(server.client, source, file('two'));
    expect(second.status).toBe('saved');
    expect(server.client.replaceFileNodeBlob).toHaveBeenCalledTimes(2);
  });

  it('still reports a real change by someone else', async () => {
    const server = fakeServer({ blobId: 'b-open', size: 5, modified: '2026-11-04T09:00:00Z' });
    const first = await saveBackToNode(server.client, { kind: 'node', nodeId: 'n1', blobId: 'b-open', parentId: 'p1' }, file('one'));
    if (first.status !== 'saved') throw new Error('first save failed');
    server.changeElsewhere();
    expect((await saveBackToNode(server.client, first.source, file('two'))).status).toBe('changed');
    expect(server.client.replaceFileNodeBlob).toHaveBeenCalledTimes(1);
  });

  it('keeps the copy that Keep both made under the id the server gave it', async () => {
    const server = fakeServer({ blobId: 'b-open', size: 5, modified: '2026-11-04T09:00:00Z' });
    const saved = await saveBesideNode(server.client, { kind: 'node', nodeId: 'n1', blobId: 'b-open', parentId: 'p1' }, file('copy'));
    expect(saved.source).toEqual({ kind: 'node', nodeId: 'n2', blobId: 'srv-copy', parentId: 'p1', size: 7, modified: '2026-11-04T10:30:00Z' });
  });

  it('counts the same size and change time as unchanged when only the blob id differs', () => {
    const source: NodeEditSource = { kind: 'node', nodeId: 'n1', blobId: 'a', parentId: null, size: 3, modified: 'm' };
    expect(nodeUnchanged(source, { blobId: 'b', size: 3, modified: 'm' })).toBe(true);
    expect(nodeUnchanged(source, { blobId: 'b', size: 4, modified: 'm' })).toBe(false);
    expect(nodeUnchanged({ ...source, size: undefined }, { blobId: 'b', size: 3, modified: 'm' })).toBe(false);
  });
});
