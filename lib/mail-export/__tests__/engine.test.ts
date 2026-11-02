import { describe, it, expect, vi } from 'vitest';
import { runExport, folderTree, safeName, type ExportProgress } from '@/lib/mail-export/engine';
import { memorySink, ExportTooLargeError, type ExportSink } from '@/lib/mail-export/sinks';
import { runImport } from '@/lib/mail-import/engine';
import type { IJMAPClient, UploadedEmailImport } from '@/lib/jmap/client-interface';
import type { Mailbox } from '@/lib/jmap/types';

const enc = new TextEncoder();
const T0 = Date.now();

interface Msg { id: string; mailbox: string; raw: string; keywords: Record<string, boolean>; receivedAt: string; subject: string }

const msg = (i: number, mailbox: string, extra: Partial<Msg> = {}): Msg => ({
  id: `m${mailbox}${i}`, mailbox, subject: `Subject ${i}`,
  raw: `From: a@example.org\r\nSubject: Subject ${i}\r\nDate: Tue, 5 May 2020 10:0${i % 10}:00 +0000\r\n\r\nFrom the body ${i}\r\n`,
  keywords: i % 2 ? { $seen: true } : { $flagged: true }, receivedAt: `2020-05-0${(i % 9) + 1}T10:00:00Z`, ...extra,
});

function fakeClient(messages: Msg[], opts: { blobGet?: boolean; rateLimitOnce?: boolean } = {}) {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls = { blobGet: 0, download: 0 };
  let limited = false;
  const track = async <T>(run: () => T): Promise<T> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    try { return run(); } finally { inFlight--; }
  };
  const byBlob = new Map(messages.map((m) => [`blob-${m.id}`, m]));
  const client = {
    getMaxConcurrentRequests: () => 4,
    queryEmailFields: vi.fn(async (filter: { inMailbox: string }) => messages
      .filter((m) => m.mailbox === filter.inMailbox)
      .map((m) => ({ id: m.id, blobId: `blob-${m.id}`, size: m.raw.length, keywords: m.keywords, receivedAt: m.receivedAt, subject: m.subject }))
      .reverse()),
    getBlobsAsBase64: opts.blobGet === false ? undefined : vi.fn(async (ids: string[]) => track(() => {
      calls.blobGet++;
      return { data: new Map(ids.map((id) => [id, btoa(byBlob.get(id)!.raw)])), failed: [] };
    })),
    fetchBlobForTransfer: vi.fn(async (blobId: string) => track(() => {
      calls.download++;
      if (opts.rateLimitOnce && !limited) {
        limited = true;
        throw Object.assign(new Error('Rate limited by server'), { name: 'RateLimitError', retryAfterMs: 30_000 });
      }
      return enc.encode(byBlob.get(blobId)!.raw);
    })),
  } as unknown as IJMAPClient;
  return { client, calls, get maxInFlight() { return maxInFlight; } };
}

function collectingSink() {
  const parts: Uint8Array[] = [];
  const sink: ExportSink = {
    kind: 'memory',
    write: async (c) => { parts.push(c.slice()); },
    close: async () => ({ name: 'x', size: parts.reduce((n, p) => n + p.length, 0), discard: async () => {} }),
    abort: async () => {},
  };
  return { sink, file: (name: string) => new File(parts as BlobPart[], name, { lastModified: 1 }) };
}

function importClient() {
  const imported: Array<UploadedEmailImport & { text: string }> = [];
  const blobs = new Map<string, string>();
  const created: Array<{ name: string; parentId?: string }> = [];
  let n = 0;
  const client = {
    getCapabilities: () => ({}),
    getMaxConcurrentRequests: () => 4,
    getMaxSizeUpload: () => 50_000_000,
    getMailboxes: async () => [{ id: 'in', name: 'Inbox', role: 'inbox' } as Mailbox, { id: 'target', name: 'Restore' } as Mailbox],
    createMailbox: async (name: string, parentId?: string) => { created.push({ name, parentId }); return { id: `c${created.length}`, name } as Mailbox; },
    uploadBlob: async (f: File) => { const id = `b${n++}`; blobs.set(id, await f.text()); return { blobId: id, size: f.size, type: f.type }; },
    importUploadedEmails: async (entries: UploadedEmailImport[]) => entries.map((e) => { imported.push({ ...e, text: blobs.get(e.blobId)! }); return { id: `e${imported.length}` }; }),
  } as unknown as IJMAPClient;
  return { client, imported, created };
}

const exportOpts = { signal: new AbortController().signal, onProgress: () => {}, sleep: async () => {}, now: () => T0, reportEveryMs: 0 };
const importOpts = { scope: 's', resume: false, signal: new AbortController().signal, onProgress: () => {}, sleep: async () => {}, reportEveryMs: 0 };

describe('runExport', () => {
  it('exports a folder as mbox that imports back to the same messages, dates and state', async () => {
    const messages = Array.from({ length: 12 }, (_, i) => msg(i, 'inbox'));
    const fake = fakeClient(messages);
    const out = collectingSink();
    const result = await runExport({ ...exportOpts, client: fake.client, accountId: 'acc', folders: [{ mailboxId: 'inbox', path: [] }], format: 'mbox', sink: out.sink });
    expect(result.phase).toBe('done');
    expect(result.exported).toBe(12);
    // Small messages travel in one Blob/get, not one download each.
    expect(fake.calls.blobGet).toBe(1);
    expect(fake.calls.download).toBe(0);

    const back = importClient();
    const imported = await runImport({ ...importOpts, client: back.client, accountId: 'acc', targetMailboxId: 'target', keepFolders: false, files: [{ file: out.file('Inbox.mbox'), format: 'mbox' }] });
    expect(imported.imported).toBe(12);
    // Same bytes (the state headers the mbox carried are gone again), same order, state and arrival time.
    expect(back.imported.map((e) => e.text)).toEqual(messages.map((m) => m.raw));
    expect(back.imported.map((e) => e.keywords)).toEqual(messages.map((m) => Object.fromEntries(Object.keys(m.keywords).map((k) => [k, true]))));
    expect(back.imported.map((e) => e.receivedAt)).toEqual(messages.map((m) => m.receivedAt));
  });

  it('exports the account as a ZIP of .eml files whose folders come back on import', async () => {
    const messages = [msg(1, 'inbox'), msg(2, 'arch'), msg(3, 'y2020'), msg(4, 'y2020')];
    const fake = fakeClient(messages);
    const out = collectingSink();
    const folders = [
      { mailboxId: 'inbox', path: ['Inbox'] }, { mailboxId: 'arch', path: ['Archive'] },
      { mailboxId: 'y2020', path: ['Archive', '2020'] }, { mailboxId: 'empty', path: ['Empty'] },
    ];
    await runExport({ ...exportOpts, client: fake.client, accountId: 'acc', folders, format: 'eml', sink: out.sink });
    const { listZipEntries } = await import('@/lib/mail-import/zip-reader');
    const names = (await listZipEntries(out.file('a.zip'))).map((e) => e.name);
    expect(names).toEqual(['Inbox/00001 Subject 1.eml', 'Archive/00001 Subject 2.eml', 'Archive/2020/00001 Subject 3.eml', 'Archive/2020/00002 Subject 4.eml', 'Empty/']);

    const back = importClient();
    await runImport({ ...importOpts, client: back.client, accountId: 'acc', targetMailboxId: 'target', keepFolders: true, files: [{ file: out.file('a.zip'), format: 'zip' }] });
    expect(back.created).toEqual([{ name: 'Inbox', parentId: 'target' }, { name: 'Archive', parentId: 'target' }, { name: '2020', parentId: 'c2' }]);
    expect(back.imported).toHaveLength(4);
  });

  it('exports the account as a ZIP with one mbox per folder', async () => {
    const fake = fakeClient([msg(1, 'inbox'), msg(2, 'y2020')]);
    const out = collectingSink();
    await runExport({ ...exportOpts, client: fake.client, accountId: 'acc', folders: [{ mailboxId: 'inbox', path: ['Inbox'] }, { mailboxId: 'y2020', path: ['Archive', '2020'] }], format: 'mbox', sink: out.sink });
    const back = importClient();
    await runImport({ ...importOpts, client: back.client, accountId: 'acc', targetMailboxId: null, keepFolders: true, files: [{ file: out.file('a.zip'), format: 'zip' }] });
    expect(back.created).toEqual([{ name: 'Archive', parentId: undefined }, { name: '2020', parentId: 'c1' }]);
    expect(Object.keys(back.imported[0].mailboxIds)).toEqual(['in']);
  });

  it('keeps at most maxConcurrentRequests - 2 requests in flight and downloads large messages one by one', async () => {
    const big = 'x'.repeat(1_100_000);
    const messages = Array.from({ length: 8 }, (_, i) => msg(i, 'inbox', { raw: `Subject: ${i}\r\n\r\n${big}` }));
    const fake = fakeClient(messages);
    await runExport({ ...exportOpts, client: fake.client, accountId: 'acc', folders: [{ mailboxId: 'inbox', path: [] }], format: 'eml', sink: collectingSink().sink });
    expect(fake.calls.download).toBe(8);
    expect(fake.calls.blobGet).toBe(0);
    expect(fake.maxInFlight).toBeLessThanOrEqual(2);
    expect(fake.maxInFlight).toBeGreaterThan(1);
  });

  it('downloads without Blob/get and pauses on a 429 by itself', async () => {
    const fake = fakeClient([msg(1, 'inbox'), msg(2, 'inbox')], { blobGet: false, rateLimitOnce: true });
    const seen: ExportProgress[] = [];
    const result = await runExport({ ...exportOpts, client: fake.client, accountId: 'acc', folders: [{ mailboxId: 'inbox', path: [] }], format: 'mbox', sink: collectingSink().sink, onProgress: (p) => seen.push(p) });
    expect(seen.some((p) => p.phase === 'paused' && p.pausedUntil === T0 + 30_000)).toBe(true);
    expect(result.phase).toBe('done');
    expect(result.exported).toBe(2);
  });

  it('stays under the requests-per-minute it allows itself', async () => {
    let clock = T0;
    const fake = fakeClient(Array.from({ length: 6 }, (_, i) => msg(i, 'inbox')), { blobGet: false });
    const waits: number[] = [];
    await runExport({ ...exportOpts, client: fake.client, accountId: 'acc', folders: [{ mailboxId: 'inbox', path: [] }], format: 'mbox', sink: collectingSink().sink,
      requestsPerMinute: 3, now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
    // 1 query + 6 downloads at 3 a minute: two waits of about a minute.
    expect(waits.filter((w) => w > 50_000)).toHaveLength(2);
  });

  it('stops cleanly when cancelled and aborts the sink', async () => {
    const controller = new AbortController();
    const fake = fakeClient(Array.from({ length: 300 }, (_, i) => msg(i, 'inbox')));
    const out = collectingSink();
    const abort = vi.spyOn(out.sink, 'abort');
    const result = await runExport({ ...exportOpts, client: fake.client, accountId: 'acc', folders: [{ mailboxId: 'inbox', path: [] }], format: 'eml', sink: out.sink, signal: controller.signal,
      onProgress: (p) => { if (p.exported >= 100) controller.abort(); } });
    expect(result.phase).toBe('cancelled');
    expect(result.exported).toBeLessThan(300);
    expect(abort).toHaveBeenCalled();
  });
});

describe('folderTree', () => {
  it('orders special folders first, nests children and makes sibling names unique', () => {
    const mb = (id: string, name: string, extra: Partial<Mailbox> = {}) => ({ id, name, sortOrder: 0, ...extra }) as Mailbox;
    const tree = folderTree([
      mb('t', 'Trash', { role: 'trash' }), mb('a', 'Projects'), mb('a2', 'projects'), mb('i', 'Inbox', { role: 'inbox' }),
      mb('c', 'Q1/Q2', { parentId: 'a' }), mb('acc:x', 'Shared', { originalId: 'x' }),
    ]);
    expect(tree).toEqual([
      { mailboxId: 'i', path: ['Inbox'] }, { mailboxId: 't', path: ['Trash'] }, { mailboxId: 'a2', path: ['projects'] },
      { mailboxId: 'a', path: ['Projects (2)'] }, { mailboxId: 'c', path: ['Projects (2)', 'Q1 Q2'] }, { mailboxId: 'x', path: ['Shared'] },
    ]);
  });
  it('makes names safe for every file system', () => {
    expect(safeName('a:b*c?.', 'x')).toBe('a b c');
    expect(safeName('...', 'x')).toBe('x');
  });
});

describe('memorySink', () => {
  it('refuses more than its limit', async () => {
    const sink = memorySink('a.mbox', 'application/mbox', 10);
    await sink.write(new Uint8Array(8));
    await expect(sink.write(new Uint8Array(8))).rejects.toBeInstanceOf(ExportTooLargeError);
  });
});
