// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCOPE, type StoreScope } from '../area';
import { AccountEngine } from '../engine/account-engine';
import { TransportError } from '../engine/transport';
import { mailArea } from '../mail';
import { outboxArea } from '../outbox';
import { FakeJmapDrafts } from './helpers/fake-drafts';
import { FAKE_SESSION, JMAP_ACCOUNT, type FakeEmail } from './helpers/fake-jmap';
import { openMemoryStore } from './helpers/node-adapter';

const SCOPE: StoreScope = { ...DEFAULT_SCOPE, days: null };
const RAW = 'message/rfc822';

/** Hands out files in pieces, so a test can tell a stream from a whole download. */
class Files extends FakeJmapDrafts {
  readonly downloads: string[] = [];
  readonly rawDownloads: string[] = [];
  readonly files = new Map<string, Uint8Array>();
  gone = new Set<string>();
  breakAfter: { blobId: string; bytes: number } | null = null;
  pieces = 0;
  onDownload: ((blobId: string) => void) | null = null;

  private record(blobId: string, type: string): Uint8Array {
    if (type === RAW) this.rawDownloads.push(blobId);
    else this.downloads.push(blobId);
    this.onDownload?.(blobId);
    if (this.gone.has(blobId)) throw new TransportError('http', 'Gone', 404);
    return this.files.get(blobId) ?? new Uint8Array(type === RAW ? [9, 9] : [1, 2, 3]);
  }

  override async download(_jmap?: string, blobId?: string, type?: string): Promise<Uint8Array> {
    return this.record(String(blobId), String(type));
  }

  async downloadStream(_jmap: string, blobId: string, type: string, _name: string, sink: (part: Uint8Array) => void): Promise<void> {
    const data = this.record(blobId, type);
    const step = 256 * 1024;
    for (let at = 0; at < data.length; at += step) {
      if (this.breakAfter?.blobId === blobId && at >= this.breakAfter.bytes) throw new TransportError('network', 'The download broke off');
      this.pieces += 1;
      sink(data.subarray(at, at + step));
    }
  }
}

function engineFor(server: Files, scope: StoreScope = SCOPE, areas = [mailArea]) {
  const db = openMemoryStore();
  const engine = new AccountEngine({
    account: 'a@fake.test',
    db,
    session: FAKE_SESSION,
    transport: server,
    areas,
    scope,
    now: () => Date.UTC(2026, 10, 3),
    sleep: async () => {},
  });
  return { engine, db };
}

const kept = (engine: AccountEngine, blobId: string) => engine.areaCall('mail.getBlob', { jmap: JMAP_ACCOUNT, blobId }) as Promise<{ type: string; size: number; blob: Blob } | null>;

function withFile(server: Files, id: string, blobId: string, size = 3, day = 1, extra: Partial<FakeEmail> = {}): FakeEmail {
  server.files.set(blobId, new Uint8Array(size).fill(7));
  return server.addEmail({
    id,
    size: 100_000_000,
    receivedAt: new Date(Date.UTC(2026, 9, day)).toISOString(),
    attachments: [{ partId: '2', blobId, name: `${blobId}.pdf`, type: 'application/pdf', size }],
    ...extra,
  });
}

describe('what\'s fetched', () => {
  it('goes newest mail first, after the rest of the pass', async () => {
    const server = new Files();
    withFile(server, 'old', 'b-old', 3, 1);
    withFile(server, 'new', 'b-new', 3, 20);
    withFile(server, 'mid', 'b-mid', 3, 10);
    const { engine } = engineFor(server);
    await engine.requestSync();
    expect(server.downloads).toEqual(['b-new', 'b-mid', 'b-old']);
  });

  it('runs after every other syncer, and a newer pass goes first', async () => {
    const server = new Files();
    withFile(server, 'one', 'b-1', 3, 2);
    withFile(server, 'two', 'b-2', 3, 1);
    const order: string[] = [];
    const later = { name: 'later', migrations: [], methods: {}, syncers: [{ name: 'later', capability: 'urn:ietf:params:jmap:mail', run: async () => { order.push('later'); } }] };
    const { engine } = engineFor(server, SCOPE, [mailArea, later]);
    let wanted = false;
    server.onDownload = () => {
      order.push('file');
      // Asked for while a file comes in: the next file waits for that pass.
      if (!wanted) {
        wanted = true;
        void engine.requestSync();
      }
    };
    await engine.requestSync();
    expect(order[0]).toBe('later');
    // later, file 1, then the wanted pass: later again before file 2.
    expect(order.slice(0, 3)).toEqual(['later', 'file', 'later']);
    expect(server.downloads).toEqual(['b-1', 'b-2']);
  });

  it('includes inline images that only the body lists, as Stalwart 1.0 answers', async () => {
    const server = new Files();
    server.addEmail({
      id: 'm',
      attachments: [],
      htmlBody: [{ partId: '1', type: 'text/html' }, { partId: '2', blobId: 'b-inline', type: 'image/png', name: 'i.png', size: 3, cid: 'i', disposition: 'inline' }] as never,
      bodyStructure: {
        type: 'multipart/related',
        subParts: [{ partId: '1', blobId: 'b-text', type: 'text/html', size: 10 }, { partId: '3', blobId: 'b-tree', type: 'image/gif', size: 3, cid: 'j', disposition: 'inline' }],
      } as never,
    });
    const { engine } = engineFor(server);
    await engine.requestSync();
    expect(server.downloads.sort()).toEqual(['b-inline', 'b-tree']);
    expect(await kept(engine, 'b-inline')).toMatchObject({ type: 'image/png' });
  });

  it('comes through the stream in chunks that are each kept, and is readable whole', async () => {
    const server = new Files();
    const size = 2 * 1024 * 1024 + 5;
    withFile(server, 'm', 'b-big', size);
    server.files.get('b-big')?.fill(3);
    const { engine, db } = engineFor(server);
    await engine.requestSync();
    expect(server.pieces).toBeGreaterThan(3);
    expect(Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM blob_chunk WHERE blob_id = 'b-big'")?.n)).toBe(3);
    const file = await kept(engine, 'b-big');
    expect(file?.size).toBe(size);
    const bytes = new Uint8Array(await (file as { blob: Blob }).blob.arrayBuffer());
    expect(bytes.length).toBe(size);
    expect(bytes.every((value) => value === 3)).toBe(true);
  });

  it('leaves nothing readable when a download breaks, and tries again next time', async () => {
    const server = new Files();
    withFile(server, 'm', 'b-big', 2 * 1024 * 1024);
    server.breakAfter = { blobId: 'b-big', bytes: 1024 * 1024 + 1 };
    const { engine, db } = engineFor(server);
    await engine.requestSync();
    expect(await kept(engine, 'b-big')).toBeNull();
    expect(db.get("SELECT 1 AS x FROM blob_chunk WHERE blob_id = 'b-big'")).toBeUndefined();
    server.breakAfter = null;
    await engine.requestSync();
    expect((await kept(engine, 'b-big'))?.size).toBe(2 * 1024 * 1024);
  });

  it('drops a file larger than it said, and doesn\'t fetch it again', async () => {
    const server = new Files();
    withFile(server, 'm', 'b-liar', 3);
    server.files.set('b-liar', new Uint8Array(5000));
    const { engine } = engineFor(server, { ...SCOPE, maxAttachmentBytes: 1000 });
    await engine.requestSync();
    await engine.requestSync();
    expect(await kept(engine, 'b-liar')).toBeNull();
    expect(server.downloads).toEqual(['b-liar']);
  });
});

describe('the cap', () => {
  it('pushes out older mail\'s files for a newer message\'s', async () => {
    const server = new Files();
    withFile(server, 'old', 'b-old', 40, 1);
    const { engine } = engineFor(server, { ...SCOPE, maxTotalBytes: 60 });
    await engine.requestSync();
    expect(await kept(engine, 'b-old')).not.toBeNull();
    withFile(server, 'new', 'b-new', 40, 20);
    await engine.requestSync();
    expect(await kept(engine, 'b-new')).not.toBeNull();
    expect(await kept(engine, 'b-old')).toBeNull();
  });

  it('doesn\'t fetch an older file back that a newer one pushed out', async () => {
    const server = new Files();
    withFile(server, 'old', 'b-old', 40, 1);
    withFile(server, 'new', 'b-new', 40, 20);
    const { engine } = engineFor(server, { ...SCOPE, maxTotalBytes: 60 });
    await engine.requestSync();
    await engine.requestSync();
    expect(server.downloads).toEqual(['b-new']);
  });

  it('doesn\'t let a file of older mail the user opened push out a newer one', async () => {
    const server = new Files();
    withFile(server, 'new', 'b-new', 40, 20);
    server.addEmail({ id: 'old', size: 100_000_000, receivedAt: new Date(Date.UTC(2026, 9, 1)).toISOString(), attachments: [{ partId: '2', blobId: 'b-old', size: 40, type: 'image/png' }] });
    server.gone.add('b-old');
    const { engine } = engineFor(server, { ...SCOPE, maxTotalBytes: 60 });
    await engine.requestSync();
    expect(await engine.areaCall('mail.recordBlob', { jmap: JMAP_ACCOUNT, blobId: 'b-old', type: null, data: new Uint8Array(40) })).toBe(false);
    expect(await kept(engine, 'b-new')).not.toBeNull();
  });

  it('keeps a smaller older file that still fits past one that doesn\'t', async () => {
    const server = new Files();
    withFile(server, 'new', 'b-new', 40, 20);
    withFile(server, 'mid', 'b-mid', 40, 10);
    withFile(server, 'old', 'b-old', 10, 1);
    const { engine } = engineFor(server, { ...SCOPE, maxTotalBytes: 60 });
    await engine.requestSync();
    expect(server.downloads).toEqual(['b-new', 'b-old']);
  });

  it('stops looking after a long run of files that don\'t fit, instead of reading the kept list for each', async () => {
    const server = new Files();
    withFile(server, 'fills', 'b-fills', 50, 28);
    for (let n = 0; n < 60; n += 1) withFile(server, `no-${n}`, `b-no-${n}`, 40, 27);
    withFile(server, 'small-old', 'b-small-old', 5, 1);
    const { engine } = engineFor(server, { ...SCOPE, maxTotalBytes: 60 });
    await engine.requestSync();
    expect(server.downloads).toEqual(['b-fills']);
  });

  it('never pushes out the files of a pinned message', async () => {
    const server = new Files();
    withFile(server, 'pinned', 'b-pinned', 40, 1, { keywords: { $pinned: true } });
    const { engine } = engineFor(server, { ...SCOPE, maxTotalBytes: 60 });
    await engine.requestSync();
    withFile(server, 'new', 'b-new', 40, 20);
    await engine.requestSync();
    expect(await kept(engine, 'b-pinned')).not.toBeNull();
    expect(await kept(engine, 'b-new')).toBeNull();
  });

  it('never touches a file held for a draft', async () => {
    const server = new Files();
    withFile(server, 'old', 'b-old', 40, 1);
    const { engine } = engineFor(server, { ...SCOPE, maxTotalBytes: 60 }, [mailArea, outboxArea]);
    const held = await engine.areaCall('outbox.holdFile', { name: 'mine', type: '', data: new Uint8Array(100) }) as { blobId: string };
    await engine.requestSync();
    withFile(server, 'new', 'b-new', 40, 20);
    await engine.requestSync();
    expect(await kept(engine, 'b-old')).toBeNull();
    expect(await engine.areaCall('outbox.heldFile', { blobId: held.blobId })).not.toBeNull();
  });

  it('applies a lowered total at once, oldest first', async () => {
    const server = new Files();
    withFile(server, 'old', 'b-old', 40, 1);
    withFile(server, 'new', 'b-new', 40, 20);
    const { engine } = engineFor(server);
    await engine.requestSync();
    engine.setScope({ ...SCOPE, maxTotalBytes: 50 });
    expect(await kept(engine, 'b-old')).toBeNull();
    expect(await kept(engine, 'b-new')).not.toBeNull();
  });

  it('applies a lowered size limit at once', async () => {
    const server = new Files();
    withFile(server, 'big', 'b-big', 40, 1);
    withFile(server, 'small', 'b-small', 4, 2);
    const { engine } = engineFor(server);
    await engine.requestSync();
    engine.setScope({ ...SCOPE, maxAttachmentBytes: 10 });
    expect(await kept(engine, 'b-big')).toBeNull();
    expect(await kept(engine, 'b-small')).not.toBeNull();
  });
});

describe('a policy forbidding attachments', () => {
  it('fetches nothing, drops what\'s kept at once, and gives nothing out', async () => {
    const server = new Files();
    withFile(server, 'm', 'b-1');
    const { engine, db } = engineFor(server);
    await engine.requestSync();
    expect(await kept(engine, 'b-1')).not.toBeNull();

    engine.setScope({ ...SCOPE, attachments: false });
    expect(db.get('SELECT 1 AS x FROM blob')).toBeUndefined();
    expect(db.get('SELECT 1 AS x FROM blob_chunk')).toBeUndefined();
    expect(await kept(engine, 'b-1')).toBeNull();

    server.downloads.length = 0;
    server.rawDownloads.length = 0;
    server.addEmail({ id: 'more', attachments: [{ partId: '2', blobId: 'b-2', size: 3, type: 'application/pdf' }] });
    await engine.requestSync();
    expect(server.downloads).toEqual([]);
    expect(server.rawDownloads).toEqual([]);
  });

  it('refuses a file the user opened online too', async () => {
    const server = new Files();
    server.addEmail({ id: 'm', attachments: [{ partId: '2', blobId: 'b-1', size: 3, type: 'image/png' }] });
    const { engine } = engineFor(server, { ...SCOPE, attachments: false });
    await engine.requestSync();
    expect(await engine.areaCall('mail.recordBlob', { jmap: JMAP_ACCOUNT, blobId: 'b-1', type: null, data: new Uint8Array([1]) })).toBe(false);
  });

  it('applies when the store opens with it, without waiting for a sync', async () => {
    const server = new Files();
    withFile(server, 'm', 'b-1');
    const { engine, db } = engineFor(server);
    await engine.requestSync();
    expect(db.get('SELECT 1 AS x FROM blob')).toBeTruthy();
    new AccountEngine({ account: 'a@fake.test', db, session: FAKE_SESSION, transport: server, areas: [mailArea], scope: { ...SCOPE, attachments: false }, sleep: async () => {} });
    expect(db.get('SELECT 1 AS x FROM blob')).toBeUndefined();
  });

  it('keeps a file the user attached to a draft: it\'s theirs, not a copy of mail', async () => {
    const server = new Files();
    const { engine } = engineFor(server, { ...SCOPE, attachments: false }, [mailArea, outboxArea]);
    const held = await engine.areaCall('outbox.holdFile', { name: 'mine', type: '', data: new Uint8Array(3) }) as { blobId: string };
    await engine.requestSync();
    engine.setScope({ ...SCOPE, attachments: false });
    expect(await engine.areaCall('outbox.heldFile', { blobId: held.blobId })).not.toBeNull();
  });
});

describe('raw messages for an export', () => {
  it('are kept with the attachments, and handed out by Email.blobId', async () => {
    const server = new Files();
    server.addEmail({ id: 'm', blobId: 'raw-m', size: 2 });
    server.files.set('raw-m', new TextEncoder().encode('From: a\r\n\r\nx'));
    const { engine } = engineFor(server);
    await engine.requestSync();
    expect(server.rawDownloads).toEqual(['raw-m']);
    const raw = await engine.areaCall('mail.rawBlob', { jmap: JMAP_ACCOUNT, blobId: 'raw-m' }) as { ok: true; type: string; blob: Blob };
    expect(raw.ok).toBe(true);
    expect(raw.type).toBe(RAW);
    expect(await raw.blob.text()).toBe('From: a\r\n\r\nx');
    expect(await engine.areaCall('mail.rawStatus', { jmap: JMAP_ACCOUNT })).toEqual({ total: 1, kept: 1 });
  });

  it('come after the files of the same message', async () => {
    const server = new Files();
    const order: string[] = [];
    server.onDownload = (blobId) => order.push(blobId);
    withFile(server, 'm', 'b-1', 3, 1, { blobId: 'raw-m', size: 3 });
    const { engine } = engineFor(server);
    await engine.requestSync();
    expect(order).toEqual(['b-1', 'raw-m']);
  });

  it('are refused plainly with attachments off, and counted as not there', async () => {
    const server = new Files();
    server.addEmail({ id: 'm', blobId: 'raw-m', mailboxIds: { inbox: true } });
    const { engine } = engineFor(server, { ...SCOPE, attachments: false });
    await engine.requestSync();
    expect(await engine.areaCall('mail.rawBlob', { jmap: JMAP_ACCOUNT, blobId: 'raw-m' })).toEqual({ ok: false, reason: 'attachments_off' });
    expect(await engine.areaCall('mail.rawStatus', { jmap: JMAP_ACCOUNT })).toEqual({ total: 1, kept: 0 });
  });

  it('are refused when they aren\'t kept, whatever else is', async () => {
    const server = new Files();
    server.addEmail({ id: 'm', blobId: 'raw-m', size: 5_000, attachments: [{ partId: '2', blobId: 'b-1', size: 3, type: 'image/png' }] });
    const { engine } = engineFor(server, { ...SCOPE, maxAttachmentBytes: 1000 });
    await engine.requestSync();
    expect(await engine.areaCall('mail.rawBlob', { jmap: JMAP_ACCOUNT, blobId: 'raw-m' })).toEqual({ ok: false, reason: 'not_kept' });
    // An attachment isn't a whole message.
    expect(await engine.areaCall('mail.rawBlob', { jmap: JMAP_ACCOUNT, blobId: 'b-1' })).toEqual({ ok: false, reason: 'not_kept' });
    expect(await engine.areaCall('mail.rawStatus', { jmap: JMAP_ACCOUNT })).toEqual({ total: 1, kept: 0 });
  });

  it('count per folder for an export of one', async () => {
    const server = new Files({ mailboxes: [{ id: 'inbox', role: 'inbox' }, { id: 'other', name: 'Other' }] });
    server.addEmail({ id: 'a', blobId: 'raw-a', size: 2, mailboxIds: { inbox: true } });
    server.addEmail({ id: 'b', blobId: 'raw-b', size: 2, mailboxIds: { other: true } });
    server.gone.add('raw-b');
    const { engine } = engineFor(server);
    await engine.requestSync();
    expect(await engine.areaCall('mail.rawStatus', { jmap: JMAP_ACCOUNT, mailboxId: 'inbox' })).toEqual({ total: 1, kept: 1 });
    expect(await engine.areaCall('mail.rawStatus', { jmap: JMAP_ACCOUNT, mailboxId: 'other' })).toEqual({ total: 1, kept: 0 });
  });

  it('don\'t exist for a draft on the device', async () => {
    const server = new Files({ mailboxes: [{ id: 'drafts', role: 'drafts' }] });
    const { engine, db } = engineFor(server, SCOPE, [mailArea, outboxArea]);
    await engine.requestSync();
    const answer = await engine.answer([['Email/set', { create: { c: { keywords: { $draft: true }, mailboxIds: { drafts: true }, bodyValues: { 1: { value: 'x' } }, textBody: [{ partId: '1' }] } } }, 's']]);
    const id = answer?.methodResponses[0][1].created.c.id as string;
    expect(await engine.areaCall('mail.rawBlob', { jmap: JMAP_ACCOUNT, blobId: id })).toEqual({ ok: false, reason: 'not_kept' });
    expect(db.get('SELECT 1 AS x FROM email_part')).toBeUndefined();
  });
});

describe('a kept file read back', () => {
  it('isn\'t emptied by a download of the same file that the user opening it overtook', async () => {
    const server = new Files();
    withFile(server, 'm', 'b-1', 2 * 1024 * 1024 + 5);
    server.files.get('b-1')?.fill(3);
    const { engine } = engineFor(server);
    server.onDownload = () => {
      server.onDownload = null;
      void engine.areaCall('mail.recordBlob', { jmap: JMAP_ACCOUNT, blobId: 'b-1', type: 'application/pdf', data: new Uint8Array(2 * 1024 * 1024 + 5).fill(3) });
    };
    await engine.requestSync();
    const file = await kept(engine, 'b-1');
    expect(file?.size).toBe(2 * 1024 * 1024 + 5);
    expect((file as { blob: Blob }).blob.size).toBe(2 * 1024 * 1024 + 5);
  });

  it('doesn\'t lose what a kept file has when the next pass looks at it', async () => {
    const server = new Files();
    withFile(server, 'm', 'b-1', 300);
    const { engine } = engineFor(server);
    await engine.requestSync();
    server.addEmail({ id: 'n', attachments: [{ partId: '2', blobId: 'b-1', size: 300, type: 'application/pdf', name: 'same.pdf' }] });
    await engine.requestSync();
    expect((await kept(engine, 'b-1'))?.blob.size).toBe(300);
  });

  it('reads as not kept when its pieces don\'t add up, and is fetched again', async () => {
    const server = new Files();
    withFile(server, 'm', 'b-1', 300);
    const { engine, db } = engineFor(server);
    await engine.requestSync();
    db.run("DELETE FROM blob_chunk WHERE blob_id = 'b-1'");
    expect(await kept(engine, 'b-1')).toBeNull();
    server.downloads.length = 0;
    await engine.requestSync();
    expect(server.downloads).toEqual(['b-1']);
    expect((await kept(engine, 'b-1'))?.blob.size).toBe(300);
  });
});

describe('raw messages come last', () => {
  it('after every file, even of older mail', async () => {
    const server = new Files();
    const order: string[] = [];
    server.onDownload = (blobId) => order.push(blobId);
    server.addEmail({ id: 'new', blobId: 'raw-new', size: 3, receivedAt: new Date(Date.UTC(2026, 9, 20)).toISOString() });
    withFile(server, 'old', 'b-old', 3, 1, { blobId: 'raw-old', size: 3 });
    const { engine } = engineFor(server);
    await engine.requestSync();
    expect(order).toEqual(['b-old', 'raw-new', 'raw-old']);
  });

  it('never push out a file, however old', async () => {
    const server = new Files();
    withFile(server, 'old', 'b-old', 40, 1);
    const { engine } = engineFor(server, { ...SCOPE, maxTotalBytes: 60 });
    await engine.requestSync();
    const raw = new Uint8Array(40);
    server.files.set('raw-new', raw);
    server.addEmail({ id: 'new', blobId: 'raw-new', size: 40, receivedAt: new Date(Date.UTC(2026, 9, 20)).toISOString() });
    await engine.requestSync();
    expect(await kept(engine, 'b-old')).not.toBeNull();
    expect(await engine.areaCall('mail.rawBlob', { jmap: JMAP_ACCOUNT, blobId: 'raw-new' })).toEqual({ ok: false, reason: 'not_kept' });
  });

  it('go first when a file needs the room, whatever their age', async () => {
    const server = new Files();
    server.files.set('raw-newest', new Uint8Array(40));
    server.addEmail({ id: 'newest', blobId: 'raw-newest', size: 40, receivedAt: new Date(Date.UTC(2026, 9, 25)).toISOString() });
    withFile(server, 'old', 'b-old', 10, 1);
    const { engine } = engineFor(server, { ...SCOPE, maxTotalBytes: 60 });
    await engine.requestSync();
    expect(await engine.areaCall('mail.rawBlob', { jmap: JMAP_ACCOUNT, blobId: 'raw-newest' })).toMatchObject({ ok: true });
    withFile(server, 'mid', 'b-mid', 30, 10);
    await engine.requestSync();
    expect(await kept(engine, 'b-mid')).not.toBeNull();
    expect(await kept(engine, 'b-old')).not.toBeNull();
    expect(await engine.areaCall('mail.rawBlob', { jmap: JMAP_ACCOUNT, blobId: 'raw-newest' })).toEqual({ ok: false, reason: 'not_kept' });
  });
});

describe('a transfer that breaks', () => {
  it('doesn\'t end the pass: the next file still comes, and this one is tried again', async () => {
    const server = new Files();
    withFile(server, 'new', 'b-new', 300, 20);
    withFile(server, 'old', 'b-old', 300, 1);
    server.onDownload = (blobId) => {
      if (blobId === 'b-new') throw new TransportError('network', 'The download broke off', undefined, undefined, undefined, true);
    };
    const { engine } = engineFor(server);
    await engine.requestSync();
    expect(await kept(engine, 'b-old')).not.toBeNull();
    expect(await kept(engine, 'b-new')).toBeNull();
    server.onDownload = null;
    await engine.requestSync();
    expect(await kept(engine, 'b-new')).not.toBeNull();
  });
});
