// @vitest-environment node
/**
 * An export from the local store, on real SQLite: the store keeps raw messages as it
 * does in a browser, and what comes out is read back from the file.
 */
import { describe, expect, it, vi } from 'vitest';
import { runExport, type ExportFormat, type ExportProgress } from '../engine';
import { localExportClient } from '../local-store-client';
import { memorySink, type ExportSink } from '../sinks';
import { MboxSplitter } from '@/lib/mail-import/mbox';
import { withoutStateHeaders } from '@/lib/mail-import/mbox-status';
import { listZipEntries, readZipEntry } from '@/lib/mail-import/zip-reader';
import { DEFAULT_SCOPE, type StoreScope } from '@/lib/store/area';
import { AccountEngine } from '@/lib/store/engine/account-engine';
import { TransportError, type MethodCall } from '@/lib/store/engine/transport';
import { mailArea } from '@/lib/store/mail';
import { outboxArea } from '@/lib/store/outbox';
import { FakeJmapDrafts } from '@/lib/store/__tests__/helpers/fake-drafts';
import { FAKE_SESSION, JMAP_ACCOUNT } from '@/lib/store/__tests__/helpers/fake-jmap';
import { openMemoryStore } from '@/lib/store/__tests__/helpers/node-adapter';

const SCOPE: StoreScope = { ...DEFAULT_SCOPE, days: null };
const enc = new TextEncoder();

/** Bytes a rebuilt or re-encoded message wouldn't have: bare LF, CRLF, Latin-1, trailing space, an mbox trap. */
function rawMessage(n: number): Uint8Array {
  const head = enc.encode(`From: a${n}@example.org\r\nSubject:   Secret subject ${n}  \r\nDKIM-Signature: v=1; b=abc${n}\r\n\r\n`);
  const body = enc.encode(`From the start of a line\n>From quoted once\r\nlast line ${n}\r\n`);
  const out = new Uint8Array(head.length + 2 + body.length);
  out.set(head);
  out.set([0xe4, 0x0a], head.length);
  out.set(body, head.length + 2);
  return out;
}

class Server extends FakeJmapDrafts {
  readonly files = new Map<string, Uint8Array>();
  readonly fetched: string[] = [];
  gone = new Set<string>();

  private read(blobId: string): Uint8Array {
    this.fetched.push(blobId);
    if (this.gone.has(blobId)) throw new TransportError('http', 'Gone', 404);
    return this.files.get(blobId) ?? new Uint8Array();
  }

  override async download(_jmap?: string, blobId?: string): Promise<Uint8Array> {
    return this.read(String(blobId));
  }

  async downloadStream(_jmap: string, blobId: string, _type: string, _name: string, sink: (part: Uint8Array) => void): Promise<void> {
    sink(this.read(blobId));
  }
}

function serverWith(ids: Record<string, string>): Server {
  const server = new Server({ mailboxes: [{ id: 'inbox', name: 'Inbox', role: 'inbox' }, { id: 'archive', name: 'Archive' }] });
  let n = 0;
  for (const [id, box] of Object.entries(ids)) {
    n += 1;
    const data = rawMessage(n);
    server.files.set(`raw-${id}`, data);
    server.addEmail({ id, blobId: `raw-${id}`, size: data.length, subject: `Secret subject ${n}`, mailboxIds: { [box]: true }, receivedAt: new Date(Date.UTC(2026, 9, n)).toISOString() });
  }
  return server;
}

async function storeOf(server: Server, scope: StoreScope = SCOPE, areas = [mailArea]) {
  const engine = new AccountEngine({
    account: 'acc',
    db: openMemoryStore(),
    session: FAKE_SESSION,
    transport: server,
    areas,
    scope,
    now: () => Date.UTC(2026, 10, 3),
    sleep: async () => {},
  });
  await engine.requestSync();
  return {
    engine,
    store: {
      answer: (_account: string, calls: MethodCall[]) => engine.answer(calls),
      area: <T>(_account: string, name: string, params?: unknown) => engine.areaCall(name, params) as Promise<T>,
    },
  };
}

function collecting(): { sink: ExportSink; bytes: () => Uint8Array } {
  const inner = memorySink('x', 'application/octet-stream');
  const parts: Uint8Array[] = [];
  return {
    sink: { ...inner, write: async (chunk) => { parts.push(chunk.slice()); } },
    bytes: () => new Uint8Array(Buffer.concat(parts)),
  };
}

type Store = Awaited<ReturnType<typeof storeOf>>['store'];
type Online = Parameters<typeof localExportClient>[0]['online'];

async function run(store: Store, format: ExportFormat, mailboxes: string[], online: Online = () => null): Promise<{ result: ExportProgress; bytes: Uint8Array }> {
  const { sink, bytes } = collecting();
  const result = await runExport({
    client: localExportClient({ account: 'acc', jmap: JMAP_ACCOUNT, store, online }),
    accountId: JMAP_ACCOUNT,
    folders: mailboxes.map((mailboxId) => ({ mailboxId, path: [mailboxId] })),
    format,
    sink,
    signal: new AbortController().signal,
    requestsPerMinute: Infinity,
    sleep: async () => {},
    onProgress: () => {},
  });
  return { result, bytes: bytes() };
}

async function zipEntries(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const file = new Blob([bytes as BlobPart]);
  const out = new Map<string, Uint8Array>();
  for (const entry of await listZipEntries(file)) out.set(entry.name, await readZipEntry(file, entry));
  return out;
}

/** The messages of an mbox file with the quoting and state undone, the way the import reads it. */
function mboxMessages(bytes: Uint8Array): Uint8Array[] {
  const splitter = new MboxSplitter();
  const out = [...splitter.push(bytes), ...splitter.end()];
  return out.map((message) => new Uint8Array(Buffer.concat(withoutStateHeaders(message.parts))));
}

describe('an export from the local store', () => {
  it('writes a folder offline as a ZIP of .eml files with the exact bytes the server has', async () => {
    const server = serverWith({ a: 'inbox', b: 'inbox', other: 'archive' });
    const { store } = await storeOf(server);
    const before = server.fetched.length;
    const { result, bytes } = await run(store, 'eml', ['inbox']);
    expect(result.phase).toBe('done');
    expect(result.exported).toBe(2);
    expect(result.failed).toBe(0);
    const entries = await zipEntries(bytes);
    expect([...entries.keys()]).toEqual(['inbox/00001 Secret subject 1.eml', 'inbox/00002 Secret subject 2.eml']);
    expect([...entries.values()][0]).toEqual(server.files.get('raw-a'));
    expect([...entries.values()][1]).toEqual(server.files.get('raw-b'));
    // Offline in truth: nothing was asked of the server.
    expect(server.fetched.length).toBe(before);
  });

  it('writes a folder offline as an mbox whose messages read back as the exact bytes', async () => {
    const server = serverWith({ a: 'inbox', b: 'inbox', other: 'archive' });
    const { store } = await storeOf(server);
    const { result, bytes } = await run(store, 'mbox', ['inbox']);
    expect(result.phase).toBe('done');
    const messages = mboxMessages(bytes);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(server.files.get('raw-a'));
    expect(messages[1]).toEqual(server.files.get('raw-b'));
  });

  it('counts what it has no original for by reason, and still writes the rest', async () => {
    const server = serverWith({ a: 'inbox', b: 'inbox', c: 'inbox' });
    server.gone.add('raw-b');
    server.gone.add('raw-c');
    const { store } = await storeOf(server);
    expect(await store.area('acc', 'mail.rawStatus', { jmap: JMAP_ACCOUNT, mailboxId: 'inbox' })).toEqual({ total: 3, kept: 1 });
    const { result, bytes } = await run(store, 'eml', ['inbox']);
    expect(result.phase).toBe('done');
    expect(result.exported).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.notKept).toEqual({ not_kept: 2 });
    // Counted, not a list of 2 errors the dialog would print one by one.
    expect(result.failures).toEqual([]);
    expect([...(await zipEntries(bytes)).values()]).toEqual([server.files.get('raw-a')]);
  });

  it('says it is because attachments are off when they are', async () => {
    const server = serverWith({ a: 'inbox', b: 'inbox' });
    const { store } = await storeOf(server, { ...SCOPE, attachments: false });
    const { result } = await run(store, 'mbox', ['inbox']);
    expect(result.notKept).toEqual({ attachments_off: 2 });
    expect(result.exported).toBe(0);
  });

  it('fetches what isn\'t kept when online, one at a time or in a batch, and reads the rest from the store', async () => {
    const server = serverWith({ a: 'inbox', b: 'inbox', c: 'inbox' });
    server.gone.add('raw-b');
    server.gone.add('raw-c');
    const { store } = await storeOf(server);
    const fetchBlobForTransfer = vi.fn(async (blobId: string) => server.files.get(blobId)!);
    const getBlobsAsBase64 = vi.fn(async (blobIds: string[]) => ({
      data: new Map([[blobIds[0], Buffer.from(server.files.get(blobIds[0])!).toString('base64')]]),
      failed: [],
    }));
    const { result, bytes } = await run(store, 'eml', ['inbox'], () => ({ fetchBlobForTransfer, getBlobsAsBase64, getMaxConcurrentRequests: () => 4 }));
    expect(result.exported).toBe(3);
    expect(result.notKept).toBeUndefined();
    // The kept one isn't asked for, once it isn't missing from the batch.
    expect(getBlobsAsBase64.mock.calls[0][0]).toEqual(['raw-b', 'raw-c']);
    expect(fetchBlobForTransfer.mock.calls.map((call) => call[0])).toEqual(['raw-c']);
    expect([...(await zipEntries(bytes)).values()]).toEqual([server.files.get('raw-a'), server.files.get('raw-b'), server.files.get('raw-c')]);
  });

  it('counts the rest as not kept when the connection goes during the run, instead of waiting on each', async () => {
    const server = serverWith({ a: 'inbox', b: 'inbox', c: 'inbox' });
    for (const id of ['raw-a', 'raw-b', 'raw-c']) server.gone.add(id);
    const { store } = await storeOf(server);
    const fetchBlobForTransfer = vi.fn(async () => { throw new TypeError('Load failed'); });
    const { result } = await run(store, 'mbox', ['inbox'], () => ({ fetchBlobForTransfer }));
    expect(result.phase).toBe('done');
    expect(result.notKept).toEqual({ not_kept: 3 });
    // Three tries in all, not three per message.
    expect(fetchBlobForTransfer).toHaveBeenCalledTimes(3);
  });

  it('reports a server\'s refusal of one message as that message\'s failure', async () => {
    const server = serverWith({ a: 'inbox' });
    server.gone.add('raw-a');
    const { store } = await storeOf(server);
    const { result } = await run(store, 'mbox', ['inbox'], () => ({
      fetchBlobForTransfer: async () => { throw new Error('Failed to fetch blob: 403'); },
    }));
    expect(result.notKept).toBeUndefined();
    expect(result.failures).toEqual([{ label: 'Secret subject 1', reason: 'Failed to fetch blob: 403' }]);
  });

  it('counts a draft written on this device, which has no original yet, and never asks the server for it', async () => {
    const server = new Server({ mailboxes: [{ id: 'drafts', name: 'Drafts', role: 'drafts' }] });
    const { engine, store } = await storeOf(server, SCOPE, [mailArea, outboxArea]);
    await engine.answer([['Email/set', { create: { c: { subject: 'Draft', keywords: { $draft: true }, mailboxIds: { drafts: true }, receivedAt: new Date().toISOString(), bodyValues: { 1: { value: 'x' } }, textBody: [{ partId: '1' }] } } }, 's']]);
    const fetchBlobForTransfer = vi.fn(async () => new Uint8Array());
    const { result } = await run(store, 'mbox', ['drafts'], () => ({ fetchBlobForTransfer }));
    expect(result.total).toBe(1);
    expect(result.notKept).toEqual({ not_kept: 1 });
    expect(fetchBlobForTransfer).not.toHaveBeenCalled();
  });

  it('reads the folder list and every message past one page', async () => {
    const ids: Record<string, string> = {};
    for (let i = 0; i < 503; i += 1) ids[`m${i}`] = 'inbox';
    const server = serverWith(ids);
    for (let i = 0; i < 503; i += 1) server.gone.add(`raw-m${i}`);
    const { store } = await storeOf(server, { ...SCOPE, attachments: false });
    const client = localExportClient({ account: 'acc', jmap: JMAP_ACCOUNT, store, online: () => null });
    expect((await client.getMailboxes()).map((box) => box.id).sort()).toEqual(['archive', 'inbox']);
    const list = await client.queryEmailFields({ inMailbox: 'inbox' }, ['blobId', 'subject'], JMAP_ACCOUNT, Number.MAX_SAFE_INTEGER);
    expect(list).toHaveLength(503);
    expect(new Set(list.map((email) => email.id)).size).toBe(503);
  });

  it('keeps to the server\'s pace only for what goes to the network', async () => {
    const server = serverWith({ a: 'inbox', b: 'inbox' });
    server.gone.add('raw-b');
    const { store } = await storeOf(server);
    const take = vi.fn(async () => {});
    const fetchBlobForTransfer = vi.fn(async (blobId: string) => server.files.get(blobId)!);
    const client = localExportClient({ account: 'acc', jmap: JMAP_ACCOUNT, store, online: () => ({ fetchBlobForTransfer }), gate: { take } });
    await client.fetchBlobForTransfer!('raw-a', JMAP_ACCOUNT);
    expect(take).not.toHaveBeenCalled();
    await client.fetchBlobForTransfer!('raw-b', JMAP_ACCOUNT);
    expect(take).toHaveBeenCalledTimes(1);
  });
});
