// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PSTFile } from 'pst-extractor';
import { walkPst, type PstItem } from '@/lib/mail-import/pst/items';
import { openPstSource, pstWorkerUrl } from '@/lib/mail-import/pst-source';
import { runImport } from '@/lib/mail-import/engine';
import type { IJMAPClient, UploadedEmailImport } from '@/lib/jmap/client-interface';
import type { Mailbox } from '@/lib/jmap/types';

const FIXTURE = path.join(__dirname, 'fixtures', 'Outlook.pst');

/** Runs the worker's protocol in this thread over the real fixture. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  static failWith: { code: string; message: string } | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  terminated = false;
  pulls: number[] = [];
  private items: Generator<PstItem> | null = null;
  constructor(readonly url: string) { FakeWorker.instances.push(this); }
  postMessage(msg: { type: string; skipBefore?: number; maxMessageBytes?: number; count?: number }) {
    queueMicrotask(() => {
      if (msg.type === 'open') {
        if (FakeWorker.failWith) { this.onmessage?.({ data: { type: 'error', ...FakeWorker.failWith } }); return; }
        const walk = walkPst(new PSTFile(fs.readFileSync(FIXTURE)), { skipBefore: msg.skipBefore ?? 0, maxMessageBytes: msg.maxMessageBytes ?? Infinity });
        this.items = walk.items;
        this.onmessage?.({ data: { type: 'opened', total: walk.total } });
      } else if (msg.type === 'pull') {
        this.pulls.push(msg.count ?? 1);
        for (let i = 0; i < (msg.count ?? 1); i++) {
          const next = this.items!.next();
          if (next.done) { this.onmessage?.({ data: { type: 'done' } }); return; }
          const item = next.value;
          const data = item.kind === 'message' ? { ...item, mime: item.mime.slice().buffer } : item;
          this.onmessage?.({ data: { type: 'item', item: data, fraction: 0.5 } });
        }
      }
    });
  }
  terminate() { this.terminated = true; }
}

afterEach(() => {
  FakeWorker.instances = [];
  FakeWorker.failWith = null;
  vi.unstubAllGlobals();
});

const box = (id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox => ({
  id, name, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
  myRights: {} as Mailbox['myRights'], ...extra,
});

function fakeClient() {
  const imported: Array<UploadedEmailImport & { text: string }> = [];
  const blobs = new Map<string, string>();
  const created: string[] = [];
  let n = 0;
  const client = {
    getCapabilities: () => ({ 'urn:ietf:params:jmap:core': { maxConcurrentUpload: 4 } }),
    getMaxConcurrentRequests: () => 4,
    getMaxSizeUpload: () => 50_000_000,
    getMailboxes: async () => [box('in', 'Inbox', { role: 'inbox' }), box('sent', 'Sent Items', { role: 'sent' })],
    createMailbox: async (name: string) => { created.push(name); return box(`c${created.length}`, name); },
    uploadBlob: async (f: File) => { const id = `b${n++}`; blobs.set(id, await f.text()); return { blobId: id, size: f.size, type: f.type }; },
    importUploadedEmails: async (entries: UploadedEmailImport[]) => entries.map((e) => {
      imported.push({ ...e, text: blobs.get(e.blobId)! });
      return { id: `e${imported.length}` };
    }),
  } as unknown as IJMAPClient;
  return { client, imported, created };
}

describe('openPstSource', () => {
  it('loads the worker from the public file, with the build in the URL', () => {
    expect(pstWorkerUrl()).toMatch(/^\/pst-worker\.js\?v=/);
  });

  it('imports a PST into its own folders: Inbox and Sent Items into the account\'s, with read state', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const { client, imported, created } = fakeClient();
    const file = new File([fs.readFileSync(FIXTURE)], 'Outlook.pst');
    const result = await runImport({
      client, accountId: 'acc', targetMailboxId: null, keepFolders: true,
      files: [{ file, format: 'pst' }], scope: 's', resume: false, signal: new AbortController().signal,
      onProgress: () => {}, openPst: openPstSource, sleep: async () => {}, reportEveryMs: 0,
    });
    expect(result.phase).toBe('done');
    expect(result.imported).toBe(14);
    expect(result.skipped).toEqual({ contact: 1, calendar: 1, embedded: 4 });
    // No folder was created: both exist with their special roles.
    expect(created).toEqual([]);
    const byBox = imported.reduce<Record<string, number>>((acc, e) => { const k = Object.keys(e.mailboxIds)[0]; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
    expect(byBox).toEqual({ in: 8, sent: 6 });
    expect(imported.filter((e) => !e.keywords.$seen)).toHaveLength(2);
    expect(imported.every((e) => typeof e.receivedAt === 'string' && e.receivedAt.startsWith('2011-06-2'))).toBe(true);
    // The worker is asked for a few messages at a time, never the whole file at once.
    expect(Math.max(...FakeWorker.instances[0].pulls)).toBeLessThanOrEqual(4);
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });

  it('gives up on a worker that stops answering (killed for memory sends no error)', async () => {
    class SilentWorker {
      onmessage: unknown = null;
      onerror: unknown = null;
      terminated = false;
      postMessage() {}
      terminate() { this.terminated = true; }
    }
    vi.stubGlobal('Worker', SilentWorker);
    const source = openPstSource(new File(['!BDN'], 'x.pst'), { skipBefore: 0, maxMessageBytes: 1e9 }, { watchdogMs: 30 });
    await expect(source.next()).rejects.toMatchObject({ name: 'PstReadError', code: 'unreadable' });
  });

  it('turns a worker error into a coded failure', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.failWith = { code: 'encrypted', message: 'PSTFile::open PST is encrypted' };
    const { client } = fakeClient();
    const result = await runImport({
      client, accountId: 'acc', targetMailboxId: 'in', keepFolders: false,
      files: [{ file: new File(['!BDN'], 'x.pst'), format: 'pst' }], scope: 's', resume: false, signal: new AbortController().signal,
      onProgress: () => {}, openPst: openPstSource, sleep: async () => {},
    });
    expect(result.phase).toBe('failed');
    expect(result.error).toMatch(/^pst:encrypted:/);
    expect(FakeWorker.instances[0].terminated).toBe(true);
  });
});
