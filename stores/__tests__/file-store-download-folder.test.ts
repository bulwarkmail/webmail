import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFileStore } from '../file-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { FileNode } from '@/lib/jmap/types';
import type { FolderHandle } from '@/lib/attachments/save-to-folder';
import { setDownloadGuard } from '@/lib/download-guard';

// #1810: Download to a folder writes a Files folder as folders and files,
// fetched one at a time, instead of building a zip in memory.

const node = (id: string, name: string, parentId: string | null, blobId: string | null = null, size = 0): FileNode => ({
  id, name, parentId, type: blobId ? 'image/jpeg' : '', blobId, size,
  created: '2026-10-01T00:00:00Z', modified: '2026-10-01T00:00:00Z',
});

const NODES = [
  node('photos', 'Photos', null),
  node('trip', 'Trip', 'photos'),
  node('empty', 'Empty', 'photos'),
  node('a', 'a.jpg', 'photos', 'blob-a', 3),
  node('b', 'b.jpg', 'trip', 'blob-b', 5),
  node('c', 'c.jpg', null, 'blob-c', 1),
];

class Folder implements FolderHandle {
  files = new Map<string, unknown>();
  dirs = new Map<string, Folder>();
  constructor(public name: string) {}
  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!options?.create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      this.files.set(name, null);
    }
    return {
      createWritable: async () => ({
        write: async (data: unknown) => { this.files.set(name, data); },
        close: async () => {},
      }),
    };
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!options?.create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      dir = new Folder(name);
      this.dirs.set(name, dir);
    }
    return dir;
  }
}

function useClient() {
  const fetchBlob = vi.fn(async (blobId: string) => new Blob([blobId]));
  const client = {
    listAllFileNodes: async () => NODES.map((n) => ({ ...n })),
    fetchBlob,
  } as unknown as IJMAPClient;
  useFileStore.setState({ client });
  return { fetchBlob };
}

afterEach(() => {
  setDownloadGuard(null);
  useFileStore.setState({ client: null });
});

describe('downloadToFolder', () => {
  it('writes a folder with its sub-folders and files', async () => {
    const { fetchBlob } = useClient();
    const root = new Folder('Downloads');
    const result = await useFileStore.getState().downloadToFolder(['photos'], root);
    expect(result).toMatchObject({ folder: 'Downloads', saved: 2, total: 2, stopped: null });
    const photos = root.dirs.get('Photos')!;
    expect([...photos.files.keys()]).toEqual(['a.jpg']);
    expect([...photos.dirs.get('Trip')!.files.keys()]).toEqual(['b.jpg']);
    expect(photos.dirs.get('Empty')).toBeDefined();
    // One at a time, only what was asked for.
    expect(fetchBlob.mock.calls.map((call) => call[0]).sort()).toEqual(['blob-a', 'blob-b']);
  });

  it('puts a file picked next to a folder at the top', async () => {
    useClient();
    const root = new Folder('Downloads');
    await useFileStore.getState().downloadToFolder(['photos', 'c'], root);
    expect([...root.files.keys()]).toEqual(['c.jpg']);
    expect(root.dirs.has('Photos')).toBe(true);
  });

  it('saves nothing when the device policy turned downloads off', async () => {
    const { fetchBlob } = useClient();
    setDownloadGuard(() => false);
    const root = new Folder('Downloads');
    expect(await useFileStore.getState().downloadToFolder(['photos'], root)).toBeNull();
    expect(fetchBlob).not.toHaveBeenCalled();
    expect(root.dirs.size).toBe(0);
  });
});
