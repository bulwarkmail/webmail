import { describe, it, expect, vi } from 'vitest';
import { runImport, uploadWindowEnd, quotaFrom, FolderResolver, type ImportProgress, type ImportOptions } from '@/lib/mail-import/engine';
import { checkpointKey, deleteCheckpoint, readCheckpoint } from '@/lib/mail-import/checkpoints';
import type { IJMAPClient, UploadedEmailImport } from '@/lib/jmap/client-interface';
import type { Mailbox } from '@/lib/jmap/types';

const mbox = (n: number, opts: { status?: (i: number) => string } = {}) =>
  Array.from({ length: n }, (_, i) =>
    `From a@example.org Tue May  5 10:${String(i % 60).padStart(2, '0')}:00 2020\nSubject: m${i}\n${opts.status?.(i) ?? ''}Date: Tue, 5 May 2020 10:00:00 +0000\n\nbody ${i}\n\n`,
  ).join('');

// Checkpoints older than 30 days are dropped, so the fake clock starts now.
const T0 = Date.now();

const file = (content: string, name = 'mail.mbox') => new File([content], name, { lastModified: 1000 });

const mailbox = (id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox => ({
  id, name, sortOrder: 0, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0, isSubscribed: true,
  myRights: {} as Mailbox['myRights'], ...extra,
});

function fakeClient(opts: {
  failWhen?: (text: string) => boolean;
  quotaAfter?: number;
  uploadConcurrency?: number;
  /** Upload errors with no HTTP status (a dropped connection), for the first n uploads. */
  networkErrors?: number;
  /** Milliseconds an upload of a message takes. */
  delay?: (text: string) => number;
  /** An Email/import error for a message. */
  importError?: (text: string) => { type: string; error: string } | undefined;
} = {}) {
  let uploads = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let quotaHit = false;
  const imported: Array<UploadedEmailImport & { accountId?: string; text: string }> = [];
  const blobs = new Map<string, string>();
  const created: Array<{ name: string; parentId?: string; accountId?: string }> = [];
  const mailboxes: Mailbox[] = [mailbox('inbox', 'Inbox', { role: 'inbox' }), mailbox('target', 'Target')];
  const importCalls: number[] = [];
  const uploadAccounts: (string | undefined)[] = [];
  const client = {
    getAccountId: () => 'acc-own',
    getCapabilities: () => ({ 'urn:ietf:params:jmap:core': { maxConcurrentUpload: opts.uploadConcurrency ?? 4 } }),
    getMaxConcurrentRequests: () => 4,
    getMaxSizeUpload: () => 1000,
    getMailboxes: vi.fn(async () => mailboxes.map((m) => ({ ...m }))),
    createMailbox: vi.fn(async (name: string, parentId?: string, accountId?: string) => {
      created.push({ name, parentId, accountId });
      const box = mailbox(`new-${created.length}`, name, { parentId });
      return box;
    }),
    uploadBlob: vi.fn(async (f: File, o: { accountId?: string; signal?: AbortSignal }) => {
      const n = uploads++;
      uploadAccounts.push(o.accountId);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const body = await f.text();
        await new Promise((r) => setTimeout(r, opts.delay?.(body) ?? 1));
        if (o.signal?.aborted) throw new DOMException('Upload aborted', 'AbortError');
        if (opts.networkErrors && n < opts.networkErrors) throw new Error('Upload network error');
        if (opts.quotaAfter !== undefined && n >= opts.quotaAfter && !quotaHit) {
          quotaHit = true;
          throw new Error('Failed to upload file: 429 - {"title":"Quota exceeded","detail":"You have exceeded the blob upload quota of 1000 files or 50000000 bytes."}');
        }
        const text = await f.text();
        if (opts.failWhen?.(text)) throw new Error('Failed to upload file: 500 - oops');
        const id = `blob-${n}`;
        blobs.set(id, text);
        return { blobId: id, size: f.size, type: f.type };
      } finally {
        inFlight--;
      }
    }),
    importUploadedEmails: vi.fn(async (entries: UploadedEmailImport[], accountId?: string) => {
      importCalls.push(entries.length);
      return entries.map((e) => {
        const text = blobs.get(e.blobId)!;
        const refused = opts.importError?.(text);
        if (refused) return refused;
        imported.push({ ...e, accountId, text });
        return { id: `email-${imported.length}` };
      });
    }),
  } as unknown as IJMAPClient;
  return { client, imported, created, importCalls, uploadAccounts, get maxInFlight() { return maxInFlight; }, get uploads() { return uploads; } };
}

function options(client: IJMAPClient, files: File[], extra: Partial<ImportOptions> = {}): ImportOptions {
  let clock = T0;
  return {
    client,
    accountId: 'acc-shared',
    targetMailboxId: 'target',
    keepFolders: false,
    files: files.map((f) => ({ file: f, format: f.name.endsWith('.zip') ? 'zip' : f.name.endsWith('.eml') ? 'eml' : 'mbox' })),
    scope: 'bulwark-1',
    resume: false,
    signal: new AbortController().signal,
    onProgress: () => {},
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    reportEveryMs: 0,
    ...extra,
  };
}

describe('runImport', () => {
  it('imports every message of an mbox into the target folder of its own account, with state and date', async () => {
    const fake = fakeClient();
    const status = (i: number) => (i === 1 ? 'Status: O\nX-Status: F\n' : i === 2 ? 'X-Mozilla-Status: 0009\n' : '');
    const result = await runImport(options(fake.client, [file(mbox(4, { status }))]));
    expect(result.phase).toBe('done');
    expect(result.imported).toBe(3);
    expect(result.skipped).toEqual({ deleted: 1 });
    expect(fake.imported.map((e) => e.accountId)).toEqual(['acc-shared', 'acc-shared', 'acc-shared']);
    // Uploads go to the user's own account: one in the shared account can't be imported there.
    expect(new Set(fake.uploadAccounts)).toEqual(new Set(['acc-own']));
    expect(fake.imported.every((e) => e.mailboxIds.target)).toBe(true);
    expect(fake.imported.map((e) => e.keywords)).toEqual([{ $seen: true }, { $flagged: true }, { $seen: true }]);
    expect(fake.imported[0].receivedAt).toBe('2020-05-05T10:00:00Z');
    // The envelope line is gone; Email/import would keep it as a broken header.
    expect(fake.imported[0].text.startsWith('Subject: m0\n')).toBe(true);
  });

  it('takes the arrival time from Bulwark\'s own envelope line and leaves the state headers out of the stored message', async () => {
    const fake = fakeClient();
    const raw = 'From bulwark-export Sat Jan  2 03:04:05 2021\nStatus: RO\nX-Mozilla-Status: 0001\nSubject: s\nDate: Tue, 5 May 2020 10:00:00 +0000\n\nbody\n';
    await runImport(options(fake.client, [file(raw)]));
    expect(fake.imported[0].receivedAt).toBe('2021-01-02T03:04:05Z');
    expect(fake.imported[0].text).toBe('Subject: s\nDate: Tue, 5 May 2020 10:00:00 +0000\n\nbody\n');
    expect(fake.imported[0].keywords).toEqual({ $seen: true });
  });

  it('reads Thunderbird state headers in .eml files, and imports a plain .eml as read like before', async () => {
    const fake = fakeClient();
    const unread = new File(['X-Mozilla-Status: 0004\r\nSubject: u\r\n\r\nStatus: R in the body\r\n'], 'u.eml');
    const plain = new File(['Subject: p\r\n\r\nbody\r\n'], 'p.eml');
    await runImport(options(fake.client, [unread, plain]));
    expect(fake.imported.map((e) => e.keywords)).toEqual([{ $flagged: true }, { $seen: true }]);
  });

  it('dates a Thunderbird message by its Date header, not by when it was copied into the folder', async () => {
    const fake = fakeClient();
    await runImport(options(fake.client, [file('From - Sat Nov  1 09:00:00 2025\nSubject: s\nDate: Mon, 2 Jan 2017 08:30:00 +0100\n\nb\n')]));
    expect(fake.imported[0].receivedAt).toBe('2017-01-02T07:30:00Z');
  });

  it('trusts an envelope line with a time zone (Google Takeout)', async () => {
    const fake = fakeClient();
    await runImport(options(fake.client, [file('From 1234@xxx Sat Apr 18 08:29:01 +0200 2020\nSubject: s\nDate: Fri, 17 Apr 2020 22:00:00 +0000\n\nb\n')]));
    expect(fake.imported[0].receivedAt).toBe('2020-04-18T06:29:01Z');
  });

  it('falls back to the Date header when the envelope line has no usable date', async () => {
    const fake = fakeClient();
    await runImport(options(fake.client, [file('From MAILER-DAEMON Thu Jan  1 00:00:00 1970\nSubject: s\nDate: Tue, 5 May 2020 10:00:00 +0000\n\nb\n')]));
    expect(fake.imported[0].receivedAt).toBe('2020-05-05T10:00:00Z');
  });

  it('moves the progress message by message through a small mbox', async () => {
    const fake = fakeClient();
    const fractions: number[] = [];
    await runImport(options(fake.client, [file(mbox(10))], { onProgress: (p) => { if (p.phase === 'running') fractions.push(p.fraction); } }));
    const between = new Set(fractions.filter((f) => f > 0 && f < 1).map((f) => f.toFixed(2)));
    expect(between.size).toBeGreaterThanOrEqual(5);
  });

  it('puts several messages in one Email/import and keeps uploads within the server limit', async () => {
    const fake = fakeClient({ uploadConcurrency: 4 });
    await runImport(options(fake.client, [file(mbox(45))]));
    expect(fake.imported).toHaveLength(45);
    expect(Math.max(...fake.importCalls)).toBeGreaterThan(1);
    expect(fake.importCalls.length).toBeLessThan(45);
    // maxConcurrentRequests 4 leaves two requests for the rest of the app.
    expect(fake.maxInFlight).toBeLessThanOrEqual(2);
  });

  it('pauses on the hourly upload limit until the window ends, then goes on', async () => {
    const fake = fakeClient({ quotaAfter: 3 });
    const seen: ImportProgress[] = [];
    const result = await runImport(options(fake.client, [file(mbox(6))], { onProgress: (p) => seen.push(p) }));
    const paused = seen.find((p) => p.phase === 'paused');
    expect(paused?.pausedUntil).toBe(uploadWindowEnd(T0) + 5000);
    expect(paused?.quota).toEqual({ files: 1000, bytes: 50_000_000 });
    expect(result.phase).toBe('done');
    expect(result.imported).toBe(6);
    expect(fake.imported.map((e) => e.text.split('\n')[0]).sort()).toEqual(['Subject: m0', 'Subject: m1', 'Subject: m2', 'Subject: m3', 'Subject: m4', 'Subject: m5']);
  });

  it('counts a message that keeps failing and carries on with the rest', async () => {
    const fake = fakeClient({ failWhen: (text) => text.startsWith('Subject: m1\n') });
    const result = await runImport(options(fake.client, [file(mbox(3))]));
    expect(result.imported).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.failures).toEqual([{ label: 'm1', reason: 'HTTP 500' }]);
    // Tried three times before giving up.
    expect(fake.uploads).toBe(5);
  });

  it('skips messages over the upload size', async () => {
    const fake = fakeClient();
    const big = `From a Tue May  5 10:11:12 2020\nSubject: big\n\n${'x'.repeat(2000)}\n\n`;
    const result = await runImport(options(fake.client, [file(big + mbox(1))]));
    expect(result.skipped).toEqual({ too_large: 1 });
    expect(result.imported).toBe(1);
  });

  it('keeps a checkpoint when cancelled and continues there without importing twice', async () => {
    const fake = fakeClient();
    const controller = new AbortController();
    const f = file(mbox(30));
    let cancelledAt = 0;
    const first = await runImport(options(fake.client, [f], {
      signal: controller.signal,
      onProgress: (p) => { if (p.imported >= 5 && !controller.signal.aborted) { cancelledAt = p.imported; controller.abort(); } },
    }));
    expect(first.phase).toBe('cancelled');
    expect(cancelledAt).toBeGreaterThan(0);
    const key = checkpointKey({ scope: 'bulwark-1', accountId: 'acc-shared', target: 'target', keepFolders: false, file: f });
    const saved = await readCheckpoint(key);
    expect(saved?.done).toBe(first.imported);

    const second = await runImport(options(fake.client, [f], { resume: true }));
    expect(second.phase).toBe('done');
    expect(second.imported).toBe(30);
    const subjects = fake.imported.map((e) => e.text.split('\n')[0]);
    expect(new Set(subjects).size).toBe(30);
    expect(subjects).toHaveLength(30);
    await expect(readCheckpoint(key)).resolves.toBeNull();
  });

  it('tries a message that failed again on the next run, and only that one', async () => {
    const fake = fakeClient({ failWhen: (text) => text.startsWith('Subject: m1\n') });
    const f = file(mbox(4));
    const first = await runImport(options(fake.client, [f]));
    expect(first).toMatchObject({ phase: 'done', imported: 3, failed: 1, retryable: 1 });
    const again = fakeClient();
    const second = await runImport(options(again.client, [f], { resume: true }));
    expect(again.imported.map((e) => e.text.split('\n')[0])).toEqual(['Subject: m1']);
    expect(second).toMatchObject({ phase: 'done', imported: 4, failed: 0 });
  });

  it('stops after ten failures in a row instead of burning through the file, and keeps the checkpoint', async () => {
    const fake = fakeClient({ failWhen: () => true });
    const f = file(mbox(40));
    const result = await runImport(options(fake.client, [f]));
    expect(result).toMatchObject({ phase: 'failed', error: 'import:failures' });
    expect(fake.uploads).toBeLessThan(40 * 3);
    const key = checkpointKey({ scope: 'bulwark-1', accountId: 'acc-shared', target: 'target', keepFolders: false, file: f });
    // Nothing was done, so nothing is skipped next time: the failures are tried again.
    expect((await readCheckpoint(key))?.done ?? 0).toBe(0);
  });

  it('stops at once when the mailbox is over quota', async () => {
    const fake = fakeClient({ importError: (text) => (text.includes('Subject: m3\n') ? { type: 'overQuota', error: 'over quota' } : undefined) });
    const result = await runImport(options(fake.client, [file(mbox(60))]));
    expect(result).toMatchObject({ phase: 'failed', error: 'import:over_quota' });
    expect(fake.uploads).toBeLessThan(60);
  });

  it('pauses on an upload with no answer and goes on, instead of failing the message', async () => {
    const fake = fakeClient({ networkErrors: 1 });
    const seen: ImportProgress[] = [];
    const result = await runImport(options(fake.client, [file(mbox(3))], { onProgress: (p) => seen.push(p) }));
    expect(seen.some((p) => p.phase === 'paused' && p.pausedUntil === T0 + 30_000)).toBe(true);
    expect(result).toMatchObject({ phase: 'done', imported: 3, failed: 0 });
  });

  it('resumes without importing again what came in after a slow message', async () => {
    // m2 is a slow upload; the messages after it are imported first.
    const fake = fakeClient({ delay: (text) => (text.startsWith('Subject: m2\n') ? 300 : 1) });
    const controller = new AbortController();
    const f = file(mbox(12));
    await runImport(options(fake.client, [f], {
      signal: controller.signal,
      onProgress: () => { if (fake.uploads >= 8 && !controller.signal.aborted) controller.abort(); },
    }));
    const firstRun = fake.imported.map((e) => e.text.split('\n')[0]);
    expect(firstRun).not.toContain('Subject: m2');
    expect(firstRun.some((s) => Number(s.slice(10)) > 2)).toBe(true);
    await runImport(options(fake.client, [f], { resume: true }));
    const subjects = fake.imported.map((e) => e.text.split('\n')[0]);
    expect(subjects).toHaveLength(12);
    expect(new Set(subjects).size).toBe(12);
  });

  it('writes no checkpoint and imports nothing more once the account signs out', async () => {
    const fake = fakeClient({ delay: () => 20 });
    const controller = new AbortController();
    const f = file(mbox(30));
    const key = checkpointKey({ scope: 'bulwark-1', accountId: 'acc-shared', target: 'target', keepFolders: false, file: f });
    let callsAtSignOut = -1;
    const result = await runImport(options(fake.client, [f], {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.imported >= 2 && !controller.signal.aborted) {
          callsAtSignOut = fake.importCalls.length;
          controller.abort('signout');
          // What the sign-out does next: clear the account's checkpoints.
          void deleteCheckpoint(key);
        }
      },
    }));
    expect(result.phase).toBe('cancelled');
    expect(fake.importCalls.length).toBe(callsAtSignOut);
    await expect(readCheckpoint(key)).resolves.toBeNull();
  });

  it('refuses a file another tab is importing', async () => {
    const locks = { request: vi.fn(async (_n: string, _o: unknown, cb: (lock: unknown) => unknown) => cb(null)) };
    vi.stubGlobal('navigator', { ...navigator, locks });
    try {
      const fake = fakeClient();
      const result = await runImport(options(fake.client, [file(mbox(2))]));
      expect(result).toMatchObject({ phase: 'failed', error: 'import:busy' });
      expect(fake.uploads).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('starts again from the top when not resuming', async () => {
    const fake = fakeClient();
    const f = file(mbox(3));
    await runImport(options(fake.client, [f]));
    await runImport(options(fake.client, [f]));
    expect(fake.imported).toHaveLength(6);
  });

  it('recreates a file\'s folders under the target, once, reusing ones that exist', async () => {
    const { ZipWriter } = await import('@/lib/mail-export/zip-writer');
    const parts: Uint8Array[] = [];
    const z = new ZipWriter(async (c) => { parts.push(c.slice()); });
    const enc = new TextEncoder();
    await z.addFile('Projects/2020/a.eml', enc.encode('Subject: a\r\n\r\nA'));
    await z.addFile('Projects/2020/b.eml', enc.encode('Subject: b\r\n\r\nB'));
    await z.addFile('Projects/c.eml', enc.encode('Subject: c\r\n\r\nC'));
    await z.addFile('Target/d.eml', enc.encode('Subject: d\r\n\r\nD'));
    await z.addFile('top.eml', enc.encode('Subject: t\r\n\r\nT'));
    await z.finish();
    const zip = new File(parts as BlobPart[], 'export.zip', { lastModified: 1 });

    const fake = fakeClient();
    const result = await runImport(options(fake.client, [zip], { keepFolders: true, targetMailboxId: null }));
    expect(result.imported).toBe(5);
    expect(fake.created).toEqual([
      { name: 'Projects', parentId: undefined, accountId: 'acc-shared' },
      { name: '2020', parentId: 'new-1', accountId: 'acc-shared' },
    ]);
    const byText = Object.fromEntries(fake.imported.map((e) => [e.text.split('\r\n')[0], Object.keys(e.mailboxIds)[0]]));
    // "Target" exists at the top; a message at the top of the file goes to the Inbox.
    expect(byText).toEqual({ 'Subject: a': 'new-2', 'Subject: b': 'new-2', 'Subject: c': 'new-1', 'Subject: d': 'target', 'Subject: t': 'inbox' });
    expect(result.foldersCreated).toBe(2);
  });

  it('puts everything into the target when folders are not kept', async () => {
    const { ZipWriter } = await import('@/lib/mail-export/zip-writer');
    const parts: Uint8Array[] = [];
    const z = new ZipWriter(async (c) => { parts.push(c.slice()); });
    await z.addFile('Deep/x.eml', new TextEncoder().encode('Subject: x\r\n\r\nX'));
    await z.finish();
    const fake = fakeClient();
    await runImport(options(fake.client, [new File(parts as BlobPart[], 'e.zip')]));
    expect(fake.created).toEqual([]);
    expect(Object.keys(fake.imported[0].mailboxIds)).toEqual(['target']);
  });

  it('puts a top folder into the special folder the file names, in any language', async () => {
    const mailboxes = [mailbox('in', 'Posteingang', { role: 'inbox' }), mailbox('sent', 'Gesendet', { role: 'sent' }), mailbox('bin', 'Papierkorb', { role: 'trash' })];
    const client = { getMailboxes: async () => mailboxes, createMailbox: vi.fn() } as unknown as IJMAPClient;
    const folders = new FolderResolver(client, 'acc', null);
    // A Spanish PST whose store says this is Sent Items.
    await expect(folders.resolve(['Elementos enviados'], 'sent')).resolves.toBe('sent');
    // Names in the languages Outlook ships most often.
    await expect(folders.resolve(['Éléments supprimés'])).resolves.toBe('bin');
    await expect(folders.resolve(['Bandeja de entrada'])).resolves.toBe('in');
  });

  it('reads the hour window and the quota from the server', () => {
    expect(uploadWindowEnd(Date.UTC(2026, 10, 1, 13, 20))).toBe(Date.UTC(2026, 10, 1, 14, 0));
    expect(quotaFrom('You have exceeded the blob upload quota of 1000 files or 50000000 bytes.')).toEqual({ files: 1000, bytes: 50000000 });
  });
});
