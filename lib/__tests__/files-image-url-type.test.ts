import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { imageBlobUrl, previewBlobType } from '@/lib/file-preview';
import { useWebDAVStore } from '@/stores/webdav-store';

// The Files app shows a stored file as an <img> on an object URL made from
// the file's FileNode `type` (stores/file-store.ts getImageUrl,
// components/files/file-preview-modal.tsx). Stalwart 0.16 stores any string
// with a slash as the type, so a file shared by another user can be typed
// `image/gif,text/html`. A browser reads a Blob type like a Content-Type
// header: after a comma the last value wins and the type ends at a space, so
// that object URL would be an HTML page on the webmail origin as soon as it
// is opened on its own ("Open image in new tab", a drag to the tab strip).
//
// Whatever type the helpers give a Blob must be one plain `type/subtype`
// that a browser shows as an image or downloads, never a document.

const GIF_THEN_HTML = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x3c, 0x68, 0x31, 0x3e]);

const HOSTILE_FILE_TYPES = [
  'image/gif,text/html',
  'image/gif, text/html',
  'IMAGE/GIF,TEXT/HTML',
  'image/x;charset=utf-8,text/html',
  'image/svg+xml x',
  'image/svg+xml,',
  'image/gif,image/svg+xml',
  'image/gif,application/xhtml+xml',
];

/** What a browser takes a Blob type for: the last comma-separated value, cut at the first space, `;` or `(`. */
function browserEssence(type: string): string {
  const last = type.split(',').map((part) => part.trim()).filter(Boolean).pop() ?? '';
  return last.split(/[\s;(]/, 1)[0].toLowerCase();
}

const DOCUMENT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml']);

let minted: Blob[];

beforeEach(() => {
  minted = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    minted.push(blob as Blob);
    return `blob:test/${minted.length}`;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('object URLs for stored files with a hostile type', () => {
  for (const type of HOSTILE_FILE_TYPES) {
    it(`thumbnail of a file typed ${JSON.stringify(type)} is no document (file-store getImageUrl)`, async () => {
      // client.fetchBlob answers with the type it asked for; getImageUrl passes the node's type along.
      const fetched = new Blob([GIF_THEN_HTML], { type });
      const url = await imageBlobUrl(fetched, type);
      if (url.startsWith('data:')) {
        // The SVG path: a data: URL has an opaque origin, which is inert.
        expect(url.startsWith('data:image/svg+xml')).toBe(true);
        return;
      }
      expect(minted).toHaveLength(1);
      expect(minted[0].type).toMatch(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/);
      expect(DOCUMENT_TYPES.has(browserEssence(minted[0].type))).toBe(false);
    });

    it(`preview of a file typed ${JSON.stringify(type)} is no document (file-preview-modal)`, async () => {
      const fetched = new Blob([GIF_THEN_HTML], { type });
      const effective = previewBlobType('holiday-photo.gif', type, fetched.type);
      const typed = fetched.type !== effective ? new Blob([fetched], { type: effective }) : fetched;
      const url = await imageBlobUrl(typed);
      if (url.startsWith('data:')) {
        expect(url.startsWith('data:image/svg+xml')).toBe(true);
        return;
      }
      expect(minted).toHaveLength(1);
      expect(minted[0].type).toMatch(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/);
      expect(DOCUMENT_TYPES.has(browserEssence(minted[0].type))).toBe(false);
    });

    it(`WebDAV thumbnail of a file served as ${JSON.stringify(type)} is no document (webdav-store getImageUrl)`, async () => {
      const downloadFile = vi.fn(async () => ({ blob: new Blob([GIF_THEN_HTML], { type }), contentType: type, filename: 'holiday-photo.gif' }));
      useWebDAVStore.setState({ webdavClient: { downloadFile } as never, currentPath: '/photos' });
      const url = await useWebDAVStore.getState().getImageUrl('holiday-photo.gif');
      expect(downloadFile).toHaveBeenCalledWith('/photos/holiday-photo.gif');
      if (url.startsWith('data:')) {
        expect(url.startsWith('data:image/svg+xml')).toBe(true);
        return;
      }
      expect(minted).toHaveLength(1);
      expect(minted[0].type).toMatch(/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/);
      expect(DOCUMENT_TYPES.has(browserEssence(minted[0].type))).toBe(false);
    });
  }

  it('keeps a plain image type as it is', async () => {
    await imageBlobUrl(new Blob([GIF_THEN_HTML], { type: 'image/gif' }), 'image/gif');
    expect(minted[0].type).toBe('image/gif');
  });

  it('keeps a plain image type from WebDAV as it is', async () => {
    const downloadFile = vi.fn(async () => ({ blob: new Blob([GIF_THEN_HTML], { type: 'image/gif' }), contentType: 'image/gif', filename: 'a.gif' }));
    useWebDAVStore.setState({ webdavClient: { downloadFile } as never, currentPath: '/' });
    expect(await useWebDAVStore.getState().getImageUrl('a.gif')).toBe('blob:test/1');
    expect(minted.map((blob) => blob.type)).toEqual(['image/gif']);
  });
});
