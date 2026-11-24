import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import type { FileNode } from '@/lib/jmap/types';
import { buildZip, isCompressedAlready, planZip } from '../files-zip';

const dir = (id: string, name: string, parentId: string | null): FileNode => ({
  id, parentId, name, type: '', blobId: null, size: 0, created: '', modified: '',
});
const file = (id: string, name: string, parentId: string | null, size = 4): FileNode => ({
  id, parentId, name, type: 'text/plain', blobId: `b-${id}`, size, created: '', modified: '2026-10-01T10:00:00Z',
});

const DRIVE = [
  dir('taxes', 'Taxes', null),
  dir('y25', '2025', 'taxes'),
  dir('empty', 'Drafts', 'taxes'),
  file('ret', 'return.pdf', 'y25'),
  file('note', 'notes.txt', 'taxes'),
  file('other', 'other.txt', null),
];

const fetchFile = async (node: FileNode) => new Blob([`body of ${node.id}`]);

describe('folder zip', () => {
  it('packs a folder with everything in it under its own name, empty folders included', () => {
    const plan = planZip(DRIVE, ['taxes']);
    expect(plan.files.map(f => f.path).sort()).toEqual(['Taxes/2025/return.pdf', 'Taxes/notes.txt']);
    expect(plan.emptyFolders).toEqual(['Taxes/Drafts']);
    expect(plan.totalBytes).toBe(8);
  });

  it('numbers two picked items of the same name instead of overwriting one', () => {
    const plan = planZip([file('a', 'x.txt', null), file('b', 'x.txt', 'taxes'), dir('taxes', 'Taxes', null)], ['a', 'b']);
    expect(plan.files.map(f => f.path)).toEqual(['x.txt', 'x (1).txt']);
  });

  it('builds a zip that holds the files', async () => {
    const progress: number[] = [];
    const blob = await buildZip(planZip(DRIVE, ['taxes', 'other']), fetchFile, { onProgress: (p) => progress.push(p.progress) });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(await zip.file('Taxes/2025/return.pdf')!.async('string')).toBe('body of ret');
    expect(await zip.file('other.txt')!.async('string')).toBe('body of other');
    expect(zip.folder('Taxes/Drafts')).not.toBeNull();
    expect(progress[progress.length - 1]).toBeCloseTo(1);
  });

  // #1810: photos and videos are compressed already; packing them again
  // made a big folder take far longer than the download itself.
  it('stores photos, videos and archives as they are, and packs the rest', async () => {
    const same = 'a'.repeat(20000);
    const photo = { ...file('p', 'photo.jpg', null, same.length), type: 'image/jpeg' };
    const text = file('t', 'notes.txt', null, same.length);
    const sizeOf = async (node: FileNode) => (await buildZip(planZip([node], [node.id]), async () => new Blob([same]))).size;
    expect(await sizeOf(photo)).toBeGreaterThan(same.length);
    expect(await sizeOf(text)).toBeLessThan(1000);
  });

  it('knows compressed files by type or by name', () => {
    expect(isCompressedAlready({ name: 'x', type: 'video/mp4' })).toBe(true);
    expect(isCompressedAlready({ name: 'IMG_1.HEIC', type: 'application/octet-stream' })).toBe(true);
    expect(isCompressedAlready({ name: 'sheet.xlsx', type: '' })).toBe(true);
    expect(isCompressedAlready({ name: 'take.wav', type: 'audio/wav' })).toBe(false);
    expect(isCompressedAlready({ name: 'notes.txt', type: 'text/plain' })).toBe(false);
    expect(isCompressedAlready({ name: 'image.bmp', type: 'image/bmp' })).toBe(false);
  });

  it('stops when canceled', async () => {
    const controller = new AbortController();
    const plan = planZip(DRIVE, ['taxes']);
    const slowFetch = async (node: FileNode) => {
      controller.abort();
      return fetchFile(node);
    };
    await expect(buildZip(plan, slowFetch, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
