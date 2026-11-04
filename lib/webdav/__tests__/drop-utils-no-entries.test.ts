import { describe, expect, it } from 'vitest';
import { getDroppedFilesAndFolders } from '../drop-utils';

// A drop whose items have no file system entry (files a page put into a
// DataTransfer itself) still hands over its files instead of nothing.

describe('getDroppedFilesAndFolders', () => {
  it('falls back to the files when no item has an entry', async () => {
    const file = new File(['x'], 'a.txt');
    const transfer = {
      items: [{ kind: 'file', webkitGetAsEntry: () => null }],
      files: [file],
    } as unknown as DataTransfer;
    expect(await getDroppedFilesAndFolders(transfer)).toEqual({ files: [file], hasDirectories: false });
  });
});
