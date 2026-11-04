import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IJMAPClient } from '../jmap/client-interface';
import { saveBlobsToFiles } from '../files-save';
import { fileHooks } from '../plugin-hooks';

// Saving attachments to Files (the reader's Save to Files and
// api.files.saveAttachments): filed by blob, copied over from another
// account first, and announced to plugins like an upload in Files.

function makeClient() {
  let n = 0;
  return {
    getFilesAccountId: vi.fn(() => 'me'),
    copyBlobs: vi.fn(async (_from: string, ids: string[]) => Object.fromEntries(ids.map((id) => [id, `${id}-mine`]))),
    createFileNode: vi.fn(async (name: string, blobId: string, type: string, _size: number, parentId: string | null) => ({ id: `n${++n}`, name, blobId, type, parentId, size: 0, created: '', modified: '' })),
  };
}
const blobs = [
  { blobId: 'b1', name: 'invoice.pdf', type: 'application/pdf', size: 1234 },
  { blobId: 'b2', name: null, type: null, size: 9 },
];

afterEach(() => {
  fileHooks.onBeforeFileUpload.clear();
  fileHooks.onAfterFileUpload.clear();
});

describe('saveBlobsToFiles', () => {
  it('files each blob in the folder and tells plugins as for an upload', async () => {
    const client = makeClient();
    const before = vi.fn(() => true);
    const after = vi.fn();
    fileHooks.onBeforeFileUpload.register('p', before);
    fileHooks.onAfterFileUpload.register('p', after);
    const { saved, stopped } = await saveBlobsToFiles(blobs, { client: client as unknown as IJMAPClient, parentId: 'docs', path: '/Documents' });
    expect(client.createFileNode.mock.calls).toEqual([
      ['invoice.pdf', 'b1', 'application/pdf', 1234, 'docs'],
      ['attachment', 'b2', 'application/octet-stream', 9, 'docs'],
    ]);
    expect(client.copyBlobs).not.toHaveBeenCalled();
    expect(before.mock.calls).toEqual([
      [{ name: 'invoice.pdf', size: 1234, type: 'application/pdf', path: '/Documents' }],
      [{ name: 'attachment', size: 9, type: 'application/octet-stream', path: '/Documents' }],
    ]);
    await vi.waitFor(() => expect(after).toHaveBeenCalledTimes(2));
    expect(after.mock.calls[0][0]).toMatchObject({ name: 'invoice.pdf', type: 'file', path: '/Documents' });
    expect(saved.map((n) => [n.name, n.size])).toEqual([['invoice.pdf', 1234], ['attachment', 9]]);
    expect(stopped).toEqual([]);
  });

  it('copies blobs of another account of the login into the Files account first', async () => {
    const client = makeClient();
    await saveBlobsToFiles([blobs[0]], { client: client as unknown as IJMAPClient, parentId: null, path: '/', blobAccountId: 'team' });
    expect(client.copyBlobs).toHaveBeenCalledWith('team', ['b1'], 'me');
    expect(client.createFileNode).toHaveBeenCalledWith('invoice.pdf', 'b1-mine', 'application/pdf', 1234, null);
  });

  it('skips a file another plugin stops, and saves the rest', async () => {
    const client = makeClient();
    fileHooks.onBeforeFileUpload.register('dlp', (info: { name: string }) => info.name !== 'invoice.pdf');
    const { saved, stopped } = await saveBlobsToFiles(blobs, { client: client as unknown as IJMAPClient, parentId: null, path: '/' });
    expect(stopped).toEqual(['invoice.pdf']);
    expect(saved.map((n) => n.name)).toEqual(['attachment']);
    expect(client.createFileNode).toHaveBeenCalledTimes(1);
  });
});
