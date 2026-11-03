/**
 * What the import needs from a file the desktop app reads from disk. The engine only uses
 * name, size, lastModified and slice().arrayBuffer() of an mbox file, so these act as a
 * File for it without being one, and no copy of the file ever lands in the browser's
 * storage. The bytes come from the shell's own scheme, by range, for files the user
 * confirmed in a native dialog (src/main/features/import.ts in the desktop repo).
 */

import type { DesktopLocalImportFile } from './types';
import type { ImportFile } from '@/lib/mail-import/engine';

/** Why an import stopped when a file can't be read any more. See errorText in the dialog. */
export const LOCAL_FILE_UNAVAILABLE = 'import:local_file_unavailable';

class LocalFileSlice {
  readonly size: number;
  constructor(
    private readonly url: string,
    private readonly start: number,
    private readonly end: number,
    readonly type: string,
  ) {
    this.size = Math.max(0, end - start);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    if (this.size === 0) return new ArrayBuffer(0);
    const response = await fetch(this.url, { headers: { Range: `bytes=${this.start}-${this.end - 1}` } });
    if (response.status !== 206) throw new Error(LOCAL_FILE_UNAVAILABLE);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== this.size) throw new Error(LOCAL_FILE_UNAVAILABLE);
    return bytes;
  }
}

export class LocalFile {
  readonly name: string;
  readonly size: number;
  readonly lastModified: number;
  readonly type = '';
  /** pst-source.ts hands this to the PST worker, which can't take this object. */
  readonly rangeUrl: string;
  readonly entrySizes: number[];

  constructor(file: DesktopLocalImportFile) {
    this.name = file.name;
    this.size = file.size;
    this.lastModified = file.lastModified;
    this.rangeUrl = file.url;
    this.entrySizes = file.entrySizes ?? [];
  }

  slice(start = 0, end = this.size, type = ''): LocalFileSlice {
    const from = Math.min(start, this.size);
    return new LocalFileSlice(this.rangeUrl, from, Math.min(end, this.size), type);
  }

  /** A Maildir folder's message. Null when it has gone since the folder was listed. */
  async readEntry(index: number): Promise<Uint8Array | null> {
    const response = await fetch(`${this.rangeUrl}/${index}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(LOCAL_FILE_UNAVAILABLE);
    return new Uint8Array(await response.arrayBuffer());
  }
}

/** An Outlook .ost, by name or by the header's client magic (SO; a PST has SM), whatever it is called. */
export async function isOstFile(file: Blob & { name?: string }): Promise<boolean> {
  if (/\.ost$/i.test(file.name ?? '')) return true;
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  const magic = String.fromCharCode(...head);
  return magic.startsWith('!BDN') && magic.slice(8, 10) === 'SO';
}

export function toImportFile(file: DesktopLocalImportFile): ImportFile {
  return { file: new LocalFile(file) as unknown as File, format: file.kind, folder: file.folder };
}
