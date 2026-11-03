/**
 * What the import needs from a file the desktop app reads from disk. The engine only uses
 * name, size, lastModified and slice().arrayBuffer() of an mbox file, so these act as a
 * File for it without being one, and no copy of the file ever lands in the browser's
 * storage. The bytes come from the shell's own scheme, by range, for files the user
 * confirmed in a native dialog (src/main/features/import.ts in the desktop repo).
 */

import { getDesktopBridge } from './bridge';
import type { DesktopLocalImportFile } from './types';
import { clearStoredJobs, readStoredJob, writeStoredJob } from '@/lib/mail-import/checkpoints';
import type { ImportFile } from '@/lib/mail-import/engine';

/** Why an import stopped when a file can't be read any more. See errorText in the dialog. */
export const LOCAL_FILE_UNAVAILABLE = 'import:local_file_unavailable';

/** Another program holding a file is usually over in moments: a virus scanner, a compaction. */
const RETRY_DELAYS_MS = [1000, 3000];

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A 5xx or no answer is tried again; anything else is the shell's final word. */
async function fetchRetrying(url: string, init: RequestInit | undefined, sleep: Sleep): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response | null = null;
    try {
      response = init ? await fetch(url, init) : await fetch(url);
    } catch {
      response = null;
    }
    if (response && response.status < 500) return response;
    if (attempt >= RETRY_DELAYS_MS.length) throw new Error(LOCAL_FILE_UNAVAILABLE);
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

class LocalFileSlice {
  readonly size: number;
  constructor(
    private readonly url: string,
    private readonly start: number,
    private readonly end: number,
    readonly type: string,
    private readonly sleep: Sleep,
  ) {
    this.size = Math.max(0, end - start);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    if (this.size === 0) return new ArrayBuffer(0);
    const response = await fetchRetrying(this.url, { headers: { Range: `bytes=${this.start}-${this.end - 1}` } }, this.sleep);
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

  constructor(
    file: DesktopLocalImportFile,
    private readonly sleep: Sleep = realSleep,
  ) {
    this.name = file.name;
    this.size = file.size;
    this.lastModified = file.lastModified;
    this.rangeUrl = file.url;
    this.entrySizes = file.entrySizes ?? [];
  }

  slice(start = 0, end = this.size, type = ''): LocalFileSlice {
    const from = Math.min(start, this.size);
    return new LocalFileSlice(this.rangeUrl, from, Math.min(end, this.size), type, this.sleep);
  }

  /** A Maildir folder's message. Null only when it has really gone since the folder was listed. */
  async readEntry(index: number): Promise<Uint8Array | null> {
    const response = await fetchRetrying(`${this.rangeUrl}/${index}`, undefined, this.sleep);
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

/** What's needed to go on with a job after a restart, one per Bulwark account. The shell holds the paths. */
export interface LocalImportJobRecord {
  id: string;
  scope: string;
  accountId: string;
  targetMailboxId: string | null;
  keepFolders: boolean;
  dedupe: boolean;
  /** Files chosen by hand in the same dialog: no way back to them after a restart, so they get named. */
  handPicked?: string[];
  /** The folders still to do after a resume left some out: they're tried at the next start. */
  retryOnly?: string[];
}

export function readLocalImportJob(scope: string): Promise<LocalImportJobRecord | null> {
  return readStoredJob<LocalImportJobRecord>(scope);
}

export function saveLocalImportJob(job: LocalImportJobRecord): Promise<void> {
  return writeStoredJob(job.scope, job);
}

export function forgetLocalImportJob(scope: string): Promise<void> {
  return writeStoredJob(scope, null);
}

/**
 * A sign-out or a wipe takes the job along, and the shell's list of paths with it. Has to run
 * before the checkpoints' database goes: after that nothing here knows which job to name. A
 * bridge call and nothing else, so it's fine in a wipe.
 */
export async function forgetLocalImportOf(account: string): Promise<void> {
  const bridge = getDesktopBridge()?.localImport;
  if (account === 'all') {
    await bridge?.releaseAll().catch(() => {});
    await clearStoredJobs();
    return;
  }
  const job = await readLocalImportJob(account);
  if (!job) return;
  await forgetLocalImportJob(account);
  await bridge?.release(job.id).catch(() => {});
}
