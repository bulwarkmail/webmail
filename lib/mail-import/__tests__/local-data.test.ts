import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runImport, type ImportOptions, type ImportProgress } from '@/lib/mail-import/engine';
import { checkpointKey, clearCheckpointsFor, deleteCheckpoint, readCheckpoint } from '@/lib/mail-import/checkpoints';
import { localDedupe, messageIdOf } from '@/lib/mail-import/dedupe';
import { durationWords, importHours } from '@/lib/mail-import/estimate';
import { rangeBacking, registerPstFile, openSync, readSync } from '@/lib/mail-import/pst/shims/fs';
import { maildirSource, mboxSource, type ImportItem, type MaildirFile, type SourceOptions } from '@/lib/mail-import/sources';
import { isOstFile, LOCAL_FILE_UNAVAILABLE, LocalFile, toImportFile } from '@/lib/desktop/local-import';
import type { IJMAPClient, UploadedEmailImport } from '@/lib/jmap/client-interface';
import type { Mailbox } from '@/lib/jmap/types';

const message = (name: string, extra = '') =>
  `Message-ID: <${name}@example.org>\r\nDate: Tue, 05 May 2020 10:00:00 +0000\r\nSubject: ${name}\r\n${extra}\r\nbody of ${name}\r\n`;
const mbox = (names: string[]) => names.map((name) => `From - Tue May 05 10:00:00 2020\r\n${message(name)}\r\n`).join('');
const file = (content: string, name: string, lastModified = 1000) => new File([content], name, { lastModified });

const box = (id: string, name: string, role?: string): Mailbox => ({
  id, name, role, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
  myRights: {} as Mailbox['myRights'],
} as Mailbox);

/** A server that keeps what it was given, where it was told to put it. */
function fakeServer() {
  const blobs: string[] = [];
  const imported: { text: string; mailboxId: string }[] = [];
  const mailboxes = [box('inbox', 'Inbox', 'inbox'), box('sent', 'Sent', 'sent')];
  const client = {
    getMaxSizeUpload: () => 0,
    getCapabilities: () => ({}),
    getMaxConcurrentRequests: () => 4,
    getAccountId: () => 'acc',
    getMailboxes: async () => mailboxes,
    createMailbox: async (name: string, parentId?: string) => {
      const created = { ...box(`m${mailboxes.length}`, name), parentId };
      mailboxes.push(created);
      return created;
    },
    uploadBlob: async (data: Blob) => {
      blobs.push(await data.text());
      return { blobId: String(blobs.length - 1) };
    },
    importUploadedEmails: async (entries: UploadedEmailImport[]) => entries.map((entry) => {
      imported.push({ text: blobs[Number(entry.blobId)], mailboxId: Object.keys(entry.mailboxIds)[0] });
      return { id: `e${imported.length}` };
    }),
  } as unknown as IJMAPClient;
  const subjects = () => imported.map((m) => /Subject: (.*)/.exec(m.text)?.[1]).sort();
  return { client, imported, mailboxes, subjects };
}

function run(options: Partial<ImportOptions> & Pick<ImportOptions, 'client' | 'files'>): Promise<ImportProgress> {
  return runImport({
    accountId: 'acc',
    targetMailboxId: null,
    keepFolders: true,
    scope: 'scope-a',
    resume: false,
    signal: new AbortController().signal,
    onProgress: () => {},
    sleep: async () => {},
    ...options,
  });
}

let scopeCounter = 0;
const freshScope = () => `scope-${++scopeCounter}`;

describe('a file with its folder given from outside', () => {
  it('mboxSource keeps the folder it was given, and stays at the top without one', async () => {
    const options: SourceOptions = { maxMessageBytes: Infinity, skipBefore: 0 };
    const collect = async (folder?: string[]) => {
      const out: ImportItem[] = [];
      for await (const item of mboxSource(file(mbox(['a']), 'x'), options, folder)) out.push(item);
      return out;
    };
    expect((await collect(['Archives', '2020']))[0]).toMatchObject({ kind: 'message', folder: ['Archives', '2020'] });
    expect((await collect())[0]).toMatchObject({ kind: 'message', folder: [] });
  });

  it('maps folders onto the account: Inbox to its own, a nested one created under its parent', async () => {
    const server = fakeServer();
    const result = await run({
      client: server.client,
      files: [
        { file: file(mbox(['one']), 'p/Inbox'), format: 'mbox', folder: ['Inbox'] },
        { file: file(mbox(['two']), 'p/Sent'), format: 'mbox', folder: ['Sent'] },
        { file: file(mbox(['three']), 'p/Projects/Alpha'), format: 'mbox', folder: ['Projects', 'Alpha'] },
      ],
    });
    expect(result.phase).toBe('done');
    const where = Object.fromEntries(server.imported.map((m) => [/Subject: (.*)/.exec(m.text)![1], m.mailboxId]));
    expect(where.one).toBe('inbox');
    expect(where.two).toBe('sent');
    const projects = server.mailboxes.find((m) => m.name === 'Projects')!;
    const alpha = server.mailboxes.find((m) => m.name === 'Alpha')!;
    expect(where.three).toBe(alpha.id);
    expect(alpha.parentId).toBe(projects.id);
  });
});

describe('Maildir', () => {
  const folder = (messages: (string | null)[]): MaildirFile => {
    const bytes = messages.map((m) => (m === null ? null : new TextEncoder().encode(m)));
    return {
      name: 'p/Box',
      size: bytes.reduce((n, b) => n + (b?.length ?? 1), 0),
      lastModified: 5,
      entrySizes: bytes.map((b) => b?.length ?? 1),
      readEntry: async (index) => bytes[index],
    };
  };
  const options: SourceOptions = { maxMessageBytes: Infinity, skipBefore: 0 };
  const collect = async (source: MaildirFile, opts = options) => {
    const out: ImportItem[] = [];
    for await (const item of maildirSource(source, opts, ['Box'])) out.push(item);
    return out;
  };

  it('reads a message per position, drops the envelope line and the state headers, and skips what was deleted', async () => {
    const items = await collect(folder([
      message('plain', 'X-Mozilla-Status: 0001\r\n'),
      `From - Tue May 05 10:00:00 2020\r\n${message('with-envelope', 'X-Mozilla-Status: 0001\r\n')}`,
      message('deleted', 'X-Mozilla-Status: 0009\r\n'),
      null,
    ]));
    expect(items.map((i) => i.kind)).toEqual(['message', 'message', 'skipped', 'skipped']);
    const second = items[1] as Extract<ImportItem, { kind: 'message' }>;
    const text = await second.data.text();
    expect(text.startsWith('Message-ID:')).toBe(true);
    expect(text).not.toContain('X-Mozilla-Status');
    expect(second.folder).toEqual(['Box']);
    expect(second.receivedAt).toBeDefined();
    expect(items[2]).toMatchObject({ reason: 'deleted' });
    expect(items[3]).toMatchObject({ reason: 'deleted' });
  });

  it('resumes by position and skips what is over the limit without reading it', async () => {
    const source = folder([message('a'), message('b'), message('c', 'X-Pad: pad\r\n')]);
    const read = vi.spyOn(source, 'readEntry');
    const items = await collect(source, { maxMessageBytes: source.entrySizes[2] - 1, skipBefore: 1 });
    expect(items.map((i) => (i.kind === 'skipped' ? i.reason : 'message'))).toEqual(['resumed', 'message', 'too_large']);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(1);
  });

  it('runs through the engine as a format of its own', async () => {
    const server = fakeServer();
    const result = await run({ client: server.client, files: [{ file: folder([message('m1'), message('m2')]) as unknown as File, format: 'maildir', folder: ['Box'] }] });
    expect(result.imported).toBe(2);
    expect(server.mailboxes.find((m) => m.name === 'Box')).toBeDefined();
  });
});

describe('dedupe across runs', () => {
  it('reads the Message-ID, folded or not, and only from the headers', () => {
    expect(messageIdOf('Subject: x\r\nMessage-ID: <a@b>\r\n\r\nbody')).toBe('a@b');
    expect(messageIdOf('message-id:\r\n <folded@b>\r\n\r\nbody')).toBe('folded@b');
    expect(messageIdOf('Subject: x\r\n\r\nMessage-ID: <in-the-body@b>')).toBeNull();
  });

  it('a compacted file has a new key and starts over: nothing goes in twice', async () => {
    const server = fakeServer();
    const scope = freshScope();
    const dedupe = localDedupe(scope, 'acc');
    const before = mbox(['a', 'b', 'c']);
    await run({ client: server.client, scope, dedupe, files: [{ file: file(before, 'p/Inbox', 1000), format: 'mbox', folder: ['Inbox'] }] });
    expect(server.subjects()).toEqual(['a', 'b', 'c']);
    // Thunderbird compacted away b and fetched d: other size, other date, other positions.
    const after = mbox(['a', 'c', 'd']);
    const second = await run({ client: server.client, scope, dedupe, resume: true, files: [{ file: file(after, 'p/Inbox', 2000), format: 'mbox', folder: ['Inbox'] }] });
    expect(server.subjects()).toEqual(['a', 'b', 'c', 'd']);
    expect(second.imported).toBe(1);
    expect(second.skipped.duplicate).toBe(2);
  });

  it('without dedupe the same run does import twice, which is why it exists', async () => {
    const server = fakeServer();
    const scope = freshScope();
    await run({ client: server.client, scope, files: [{ file: file(mbox(['a']), 'p/Inbox', 1000), format: 'mbox', folder: ['Inbox'] }] });
    await run({ client: server.client, scope, resume: true, files: [{ file: file(mbox(['a']), 'p/Inbox', 2000), format: 'mbox', folder: ['Inbox'] }] });
    expect(server.subjects()).toEqual(['a', 'a']);
  });

  it('the same message in two folders goes into both, and twice in one folder only once', async () => {
    const server = fakeServer();
    const scope = freshScope();
    const result = await run({
      client: server.client,
      scope,
      dedupe: localDedupe(scope, 'acc'),
      files: [
        { file: file(mbox(['a', 'a']), 'p/Inbox'), format: 'mbox', folder: ['Inbox'] },
        { file: file(mbox(['a']), 'p/Sent'), format: 'mbox', folder: ['Sent'] },
      ],
    });
    expect(server.imported.map((m) => m.mailboxId).sort()).toEqual(['inbox', 'sent']);
    expect(result.skipped.duplicate).toBe(1);
  });

  it('a different size under the same Message-ID is another message, and no Message-ID goes by the bytes', async () => {
    const dedupe = localDedupe(freshScope(), 'acc');
    const item = (text: string) => ({ data: new Blob([text]), size: text.length });
    const a = await dedupe.keyFor(item(message('same')), 'inbox');
    expect(await dedupe.keyFor(item(message('same')), 'inbox')).toBe(a);
    expect(await dedupe.keyFor(item(`${message('same')}more`), 'inbox')).not.toBe(a);
    expect(await dedupe.keyFor(item(message('same')), 'sent')).not.toBe(a);
    const none = await dedupe.keyFor(item('Subject: x\r\n\r\none'), 'inbox');
    expect(await dedupe.keyFor(item('Subject: x\r\n\r\ntwo'), 'inbox')).not.toBe(none);
  });

  it('a sign-out forgets what was imported', async () => {
    const scope = freshScope();
    const dedupe = localDedupe(scope, 'acc');
    await dedupe.add(['k']);
    expect(await dedupe.has('k')).toBe(true);
    await clearCheckpointsFor(scope);
    expect(await dedupe.has('k')).toBe(false);
  });

  it('stopping mid-way leaves a checkpoint, and the next run neither repeats nor loses a message', async () => {
    const server = fakeServer();
    const scope = freshScope();
    const dedupe = localDedupe(scope, 'acc');
    const big = mbox(Array.from({ length: 60 }, (_, i) => `m${i}`));
    const theFile = file(big, 'p/Inbox');
    const controller = new AbortController();
    let uploads = 0;
    const upload = server.client.uploadBlob.bind(server.client);
    server.client.uploadBlob = (async (data: Blob, options: { signal?: AbortSignal }) => {
      if (++uploads === 25) controller.abort();
      return upload(data as File, options as never);
    }) as typeof server.client.uploadBlob;
    const first = await run({ client: server.client, scope, dedupe, signal: controller.signal, files: [{ file: theFile, format: 'mbox', folder: ['Inbox'] }] });
    expect(first.phase).toBe('cancelled');
    const done = server.imported.length;
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(60);
    const key = checkpointKey({ scope, accountId: 'acc', target: null, keepFolders: true, file: theFile });
    expect(await readCheckpoint(key)).not.toBeNull();

    const second = await run({ client: server.client, scope, dedupe, resume: true, files: [{ file: theFile, format: 'mbox', folder: ['Inbox'] }] });
    expect(second.phase).toBe('done');
    const subjects = server.subjects();
    expect(subjects).toHaveLength(60);
    expect(new Set(subjects).size).toBe(60);
    await deleteCheckpoint(key);
  });
});

describe('when the server can not be reached', () => {
  const offlineError = () => Object.assign(new Error('Not available offline'), { name: 'OfflineUnavailableError' });

  it('never keeps the mail on this device: every upload says so', async () => {
    const server = fakeServer();
    const upload = vi.spyOn(server.client, 'uploadBlob');
    await run({ client: server.client, scope: freshScope(), files: [{ file: file(mbox(['a']), 'p/Inbox'), format: 'mbox', folder: ['Inbox'] }] });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][1]).toMatchObject({ noHold: true });
  });

  it('waits out an offline spell on uploads, without losing a message or using up its tries', async () => {
    const server = fakeServer();
    const real = server.client.uploadBlob.bind(server.client);
    let left = 15;
    server.client.uploadBlob = (async (data: File, options: never) => {
      if (left-- > 0) throw offlineError();
      return real(data, options);
    }) as typeof server.client.uploadBlob;
    let clock = Date.now();
    const seen: ImportProgress[] = [];
    const result = await run({
      client: server.client,
      scope: freshScope(),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      onProgress: (p) => seen.push(p),
      files: [{ file: file(mbox(['a', 'b']), 'p/Inbox'), format: 'mbox', folder: ['Inbox'] }],
    });
    expect(result.phase).toBe('done');
    expect(result.failed).toBe(0);
    expect(server.subjects()).toEqual(['a', 'b']);
    expect(seen.some((p) => p.phase === 'paused')).toBe(true);
  });

  it('waits out an offline spell on Email/import too: the uploaded messages still go in', async () => {
    const server = fakeServer();
    const real = server.client.importUploadedEmails!.bind(server.client);
    let left = 8;
    server.client.importUploadedEmails = (async (entries: UploadedEmailImport[]) => {
      if (left-- > 0) throw offlineError();
      return real(entries);
    }) as typeof server.client.importUploadedEmails;
    const result = await run({ client: server.client, scope: freshScope(), files: [{ file: file(mbox(['a']), 'p/Inbox'), format: 'mbox', folder: ['Inbox'] }] });
    expect(result.failed).toBe(0);
    expect(server.subjects()).toEqual(['a']);
  });

  it('with the browser offline nothing is tried, not even the folder, until it is back', async () => {
    const server = fakeServer();
    const create = vi.spyOn(server.client, 'createMailbox');
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    let naps = 0;
    let clock = Date.now();
    const result = await run({
      client: server.client,
      scope: freshScope(),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (++naps <= 3) expect(create).not.toHaveBeenCalled();
        if (naps === 3) onLine.mockReturnValue(true);
      },
      files: [{ file: file(mbox(['a']), 'p/Folder'), format: 'mbox', folder: ['Folder'] }],
    });
    onLine.mockRestore();
    expect(naps).toBeGreaterThanOrEqual(3);
    expect(result.phase).toBe('done');
    expect(create).toHaveBeenCalled();
    expect(server.subjects()).toEqual(['a']);
  });

  it('stops at once on a client that can only answer from this device', async () => {
    const server = fakeServer();
    (server.client as unknown as { isOfflineOnly: () => boolean }).isOfflineOnly = () => true;
    const upload = vi.spyOn(server.client, 'uploadBlob');
    const result = await run({ client: server.client, scope: freshScope(), files: [{ file: file(mbox(['a']), 'p/Inbox'), format: 'mbox', folder: ['Inbox'] }] });
    expect(result).toMatchObject({ phase: 'failed', error: 'import:network' });
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('a file read from disk through the shell', () => {
  const grant = { url: 'bulwark-import://f/token', name: 'p/Inbox', kind: 'mbox' as const, folder: ['Inbox'], size: 10, lastModified: 7 };
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reads like a File to the engine, by range', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array(4), { status: 206 }));
    const local = new LocalFile(grant);
    expect([local.name, local.size, local.lastModified]).toEqual(['p/Inbox', 10, 7]);
    const buffer = await local.slice(2, 6).arrayBuffer();
    expect(buffer.byteLength).toBe(4);
    expect(fetchMock).toHaveBeenCalledWith(grant.url, { headers: { Range: 'bytes=2-5' } });
    // An empty slice needs no request.
    fetchMock.mockClear();
    expect((await local.slice(10, 10).arrayBuffer()).byteLength).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(local.slice(8, 99).size).toBe(2);
  });

  it('a file that changed, or a short answer, stops with the code the dialog explains', async () => {
    const local = new LocalFile(grant);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 409 }));
    await expect(local.slice(0, 4).arrayBuffer()).rejects.toThrow(LOCAL_FILE_UNAVAILABLE);
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(2), { status: 206 }));
    await expect(local.slice(0, 4).arrayBuffer()).rejects.toThrow(LOCAL_FILE_UNAVAILABLE);
    // The right length with the wrong status is no range of the file either.
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(4), { status: 200 }));
    await expect(local.slice(0, 4).arrayBuffer()).rejects.toThrow(LOCAL_FILE_UNAVAILABLE);
  });

  it('a Maildir message comes by position, and one that has gone is null', async () => {
    const local = new LocalFile({ ...grant, kind: 'maildir', entrySizes: [3] });
    fetchMock.mockResolvedValueOnce(new Response('abc', { status: 200 }));
    expect(new TextDecoder().decode((await local.readEntry(0))!)).toBe('abc');
    expect(fetchMock).toHaveBeenCalledWith(`${grant.url}/0`);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await local.readEntry(1)).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(local.readEntry(1)).rejects.toThrow(LOCAL_FILE_UNAVAILABLE);
  });

  it('knows an .ost by its name and by its header, and a PST for what it is', async () => {
    const header = (client: string) => new Blob([`!BDN\u0000\u0000\u0000\u0000${client}rest`]);
    expect(await isOstFile(new File(['x'], 'mine.OST'))).toBe(true);
    expect(await isOstFile(Object.assign(header('SO'), { name: 'renamed.pst' }))).toBe(true);
    expect(await isOstFile(Object.assign(header('SM'), { name: 'real.pst' }))).toBe(false);
    expect(await isOstFile(new File(['From - x'], 'Inbox'))).toBe(false);
  });

  it('toImportFile carries the kind and the folder', () => {
    expect(toImportFile(grant)).toMatchObject({ format: 'mbox', folder: ['Inbox'] });
  });
});

describe('the PST reader on a file behind a range URL', () => {
  const data = Uint8Array.from({ length: 200_000 }, (_, i) => i % 251);

  function stubXhr(status: (range: string) => number = () => 206) {
    const seen: string[] = [];
    class FakeXhr {
      status = 0;
      response: ArrayBuffer | null = null;
      responseType = '';
      opened: unknown[] = [];
      private range = '';
      open(...args: unknown[]) { this.opened = args; }
      setRequestHeader(name: string, value: string) { if (name === 'Range') this.range = value; }
      send() {
        expect(this.opened[2]).toBe(false);
        seen.push(this.range);
        this.status = status(this.range);
        const m = /bytes=(\d+)-(\d+)/.exec(this.range)!;
        const bytes = data.slice(Number(m[1]), Number(m[2]) + 1);
        this.response = this.status === 206 ? bytes.buffer : null;
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    return seen;
  }
  afterEach(() => vi.unstubAllGlobals());

  it('reads through synchronous ranges, a page at a time with its cache', () => {
    const seen = stubXhr();
    registerPstFile('range.pst', rangeBacking('bulwark-import://f/token', data.length));
    const fd = openSync('range.pst');
    const out = new Uint8Array(10);
    expect(readSync(fd, out, 0, 10, 70_000)).toBe(10);
    expect([...out]).toEqual([...data.subarray(70_000, 70_010)]);
    // One 64 KB page, and the second read of it comes from the cache.
    expect(seen).toEqual(['bytes=65536-131071']);
    readSync(fd, out, 0, 10, 70_100);
    expect(seen).toHaveLength(1);
  });

  it('refuses a failed or short answer, so it is never read as data', () => {
    stubXhr(() => 409);
    registerPstFile('bad.pst', rangeBacking('bulwark-import://f/token', data.length));
    expect(() => readSync(openSync('bad.pst'), new Uint8Array(4), 0, 4, 0)).toThrow(/read failed/);
    const short = rangeBacking('bulwark-import://f/token', data.length * 2);
    stubXhr();
    expect(() => short.read(data.length - 10, data.length + 10)).toThrow(/read failed/);
  });
});

describe('how long it takes', () => {
  it('goes by whichever limit comes first', () => {
    expect(importHours({ bytes: 100_000_000 })).toBe(2);
    expect(importHours({ bytes: 1_000_000, messages: 3000 })).toBe(3);
    expect(importHours({ bytes: 100_000_000 }, { files: 10_000, bytes: 200_000_000 })).toBe(0.5);
  });

  it('says it in hours, then days, rounded up', () => {
    expect(durationWords(2.2)).toEqual({ unit: 'hours', count: 3 });
    expect(durationWords(47)).toEqual({ unit: 'hours', count: 47 });
    expect(durationWords(49)).toEqual({ unit: 'days', count: 3 });
  });
});
