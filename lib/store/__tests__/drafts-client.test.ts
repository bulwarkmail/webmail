/**
 * The real JMAPClient's createDraft, getEmail and blob calls against the store
 * while offline and a fake server online, through a stubbed fetch: what the
 * composer does around a save.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import { setOfflineHooks, type OfflineMethodCall, type OfflineResponse } from '@/lib/jmap/offline-hooks';
import { DEFAULT_SCOPE } from '../area';
import type { DraftGhost, PendingDraft } from '../drafts/calls';
import { flushDrafts } from '../drafts/flush';
import { AccountEngine } from '../engine/account-engine';
import { TransportError, type MethodCall } from '../engine/transport';
import { mailArea } from '../mail';
import { outboxArea } from '../outbox';
import { flushPatches, type PatchOutcome, type PendingPatch } from '../outbox/flush-patches';
import { FakeJmapDrafts } from './helpers/fake-drafts';
import { JMAP_ACCOUNT } from './helpers/fake-jmap';
import { openMemoryStore } from './helpers/node-adapter';

const NOW = Date.UTC(2026, 10, 3);
const MAIL = 'urn:ietf:params:jmap:mail';
const SESSION = {
  capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 500, maxObjectsInSet: 500 }, [MAIL]: {} },
  accounts: { [JMAP_ACCOUNT]: { name: 'a@example.org', isPersonal: true, accountCapabilities: { [MAIL]: {} } } },
  primaryAccounts: { [MAIL]: JMAP_ACCOUNT },
  username: 'a@example.org',
  apiUrl: 'https://fake.test/api',
  downloadUrl: 'https://fake.test/d/{accountId}/{blobId}/{name}?type={type}',
  uploadUrl: 'https://fake.test/u/{accountId}',
  eventSourceUrl: '',
  state: 's',
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

let server: FakeJmapDrafts;
let engine: AccountEngine;
let online: boolean;
/** The server comes back right after the next create was answered on the device. */
let backAfterCreate: boolean;
let spy: ReturnType<typeof vi.spyOn>;
let client: JMAPClient;
/** What reached the network. */
let wire: MethodCall[];

beforeEach(async () => {
  server = new FakeJmapDrafts({ mailboxes: [{ id: 'inbox', role: 'inbox' }, { id: 'drafts', role: 'drafts' }] });
  server.now = NOW;
  engine = new AccountEngine({
    account: 'a@fake.test',
    db: openMemoryStore(),
    session: SESSION as never,
    transport: server,
    areas: [mailArea, outboxArea],
    scope: { ...DEFAULT_SCOPE, days: null, attachments: false },
    now: () => NOW,
    sleep: async () => {},
  });
  online = true;
  backAfterCreate = false;
  wire = [];
  spy = vi.spyOn(globalThis, 'fetch');
  spy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!online) throw new TypeError('Failed to fetch');
    if (url.includes('/u/')) {
      const uploaded = await server.upload(JMAP_ACCOUNT, new Uint8Array(await (init?.body as Blob).arrayBuffer()));
      return json(uploaded);
    }
    if (url.includes('/d/')) return new Response(new Uint8Array([9]), { status: 200 });
    if (!init?.body) return json(SESSION);
    const calls = (JSON.parse(String(init.body)) as { methodCalls: MethodCall[] }).methodCalls;
    wire.push(...calls);
    return json(await server.request(calls));
  });
  setOfflineHooks({
    skipNetwork: () => !online,
    answer: async (_client, calls: OfflineMethodCall[], options) => {
      const marked = options?.networkTried
        ? calls.map((call): OfflineMethodCall => (call[0] === 'Email/set' && call[1].create ? [call[0], { ...call[1], networkTried: true }, call[2]] : call))
        : calls;
      const answer = await engine.answer(marked);
      if (backAfterCreate && calls.some(([name, args]) => name === 'Email/set' && args.create)) online = true;
      return answer as OfflineResponse | null;
    },
    record: () => {},
    noteNetwork: () => {},
    serverGone: async () => true,
    blob: async (_client, blobId) => {
      const held = await engine.areaCall('outbox.heldFile', { blobId }) as { blob: Blob } | null;
      return held?.blob ?? null;
    },
    recordBlob: () => {},
    holdUpload: async (_client, file) => engine.areaCall('outbox.holdFile', { name: file.name, type: file.type, data: new Uint8Array(await file.arrayBuffer()) }) as Promise<{ blobId: string; size: number; type: string }>,
    resolveStandIns: (_client, ids) => engine.areaCall('drafts.resolveStandIns', { ids }) as Promise<Record<string, string | null>>,
    resolveHeldAttachments: async (_client, attachments) => {
      const out = [];
      for (const attachment of attachments) {
        const held = await engine.areaCall('outbox.heldFile', { blobId: attachment.blobId }) as { blob: Blob } | null;
        out.push(held ? { ...attachment, blobId: (await server.upload(JMAP_ACCOUNT, new Uint8Array(await held.blob.arrayBuffer()))).blobId } : attachment);
      }
      return out;
    },
  });
  await engine.requestSync();
  client = new JMAPClient('https://fake.test', 'a@example.org', 'pw');
  await client.connect();
  wire.length = 0;
});

afterEach(() => {
  spy.mockRestore();
  setOfflineHooks(null);
});

const saveDraft = (text: string, previous?: string, attachments?: Array<{ blobId: string; name: string; type: string; size: number }>) =>
  client.createDraft(['b@example.org'], 'Subject', text, undefined, undefined, undefined, 'a@example.org', previous, attachments);

async function flushAll(): Promise<void> {
  await flushDrafts({
    store: {
      read: () => engine.areaCall('drafts.read', { before: NOW - 60_000 }) as Promise<{ rows: PendingDraft[]; ghosts: DraftGhost[] }>,
      claim: (localId) => engine.areaCall('drafts.claim', { localId }) as Promise<boolean>,
      failed: async (localId, status, error, neverSent) => { await engine.areaCall('drafts.failed', { localId, status, error, neverSent }); },
      created: (result) => engine.areaCall('drafts.created', result) as Promise<{ conflicts: string[] }>,
      ghostsLooked: async (jmap, messageIds, found) => { await engine.areaCall('drafts.ghostsLooked', { jmap, messageIds, found }); },
    },
    request: (calls) => server.request(calls),
    upload: async (jmap, blobId) => {
      const held = await engine.areaCall('outbox.heldFile', { blobId }) as { blob: Blob } | null;
      return held ? (await server.upload(jmap, new Uint8Array(await held.blob.arrayBuffer()))).blobId : null;
    },
    isRefusal: (error) => error instanceof TransportError && error.kind === 'http',
    onRefused: () => {},
    onConflict: () => {},
    onSent: () => {},
  });
  const pending = await engine.areaCall('outbox.pendingPatches', {}) as PendingPatch[];
  await flushPatches({ request: (calls) => server.request(calls), isRefusal: () => false }, pending, async (outcomes: PatchOutcome[]) => {
    await engine.areaCall('outbox.patchResults', { outcomes });
  });
}

describe('createDraft offline', () => {
  it('saves on the device, and the composer can read the draft straight back', async () => {
    online = false;
    const id = await saveDraft('Written offline');
    expect(id).toMatch(/^local-/);
    expect(server.drafts()).toEqual([]);
    const email = await client.getEmail(id);
    expect(email?.id).toBe(id);
    expect(email?.bodyValues?.['1']?.value).toBe('Written offline');
    expect(email?.to?.[0]?.email).toBe('b@example.org');
  });

  it('merges saves, so a hundred leave one draft on the server with the latest text', async () => {
    online = false;
    let id = await saveDraft('Save 0');
    for (let n = 1; n < 100; n += 1) id = await saveDraft(`Save ${n}`, id);
    online = true;
    await flushAll();
    expect(server.drafts()).toHaveLength(1);
    expect((server.drafts()[0].bodyValues as Record<string, { value: string }>)['1'].value).toBe('Save 99');
  });

  it('leaves the old version alone on the server, even when it comes back between the two steps', async () => {
    const real = await saveDraft('Online version');
    online = false;
    backAfterCreate = true;
    wire.length = 0;
    const id = await saveDraft('Offline version', real);
    expect(id).toMatch(/^local-/);
    expect(online).toBe(true);
    expect(server.emails.has(real)).toBe(true);
    expect(wire.filter(([name, args]) => name === 'Email/set' && args.destroy)).toEqual([]);
    await flushAll();
    expect(server.drafts().map((email) => (email.bodyValues as Record<string, { value: string }>)['1'].value)).toEqual(['Offline version']);
  });

  it('gives each create a Message-ID of its own, online too, for finding it after a lost answer', async () => {
    await saveDraft('One');
    const create = wire.find(([name]) => name === 'Email/set')?.[1].create as Record<string, { messageId: string[] }>;
    expect(Object.values(create)[0].messageId[0]).toMatch(/@example\.org$/);
  });

  it('marks a create whose connection broke, so the flush looks before it creates', async () => {
    const original = spy.getMockImplementation();
    spy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? String(init.body) : '';
      if (body.includes('"Email/set"')) throw new TypeError('Failed to fetch');
      return original!(input, init);
    });
    const id = await saveDraft('On the way');
    spy.mockImplementation(original!);
    expect(id).toMatch(/^local-/);
    expect(await engine.areaCall('drafts.list', {})).toMatchObject([{ status: 'uncertain' }]);
  });
});

describe('after a flush the page still holds the stand-in', () => {
  it('reads the real message by it, and the answer says what the caller asked', async () => {
    online = false;
    const id = await saveDraft('Text');
    online = true;
    await flushAll();
    const real = server.drafts()[0].id;
    wire.length = 0;
    const email = await client.getEmail(id);
    expect(email?.id).toBe(real);
    expect((wire.find(([name]) => name === 'Email/get')?.[1].ids as string[])).toEqual([real]);
  });

  it('replaces the real message on the next save, online', async () => {
    online = false;
    const id = await saveDraft('First');
    online = true;
    await flushAll();
    const next = await saveDraft('Second', id);
    expect(server.drafts().map((email) => email.id)).toEqual([next]);
  });

  it('also finds it offline again', async () => {
    online = false;
    const id = await saveDraft('First');
    online = true;
    await flushAll();
    await engine.requestSync();
    online = false;
    const email = await client.getEmail(id);
    expect(email?.bodyValues?.['1']?.value).toBe('First');
  });

  it('replaces the real message on the next save, offline, after the new one is up', async () => {
    online = false;
    const id = await saveDraft('First');
    online = true;
    await flushAll();
    const real = server.drafts()[0].id;
    online = false;
    await saveDraft('Second', id);
    expect(server.emails.has(real)).toBe(true);
    online = true;
    await flushAll();
    expect(server.emails.has(real)).toBe(false);
    expect((server.drafts()[0].bodyValues as Record<string, { value: string }>)['1'].value).toBe('Second');
  });
});

describe('before the flush, with the server back', () => {
  it('answers a read of the stand-in from the device, not the server', async () => {
    online = false;
    const id = await saveDraft('Text');
    online = true;
    wire.length = 0;
    expect((await client.getEmail(id))?.bodyValues?.['1']?.value).toBe('Text');
    expect(wire.filter(([name]) => name === 'Email/get')).toEqual([]);
  });

  it('replaces the stand-in with a save that goes straight to the server', async () => {
    online = false;
    const id = await saveDraft('Offline');
    online = true;
    const real = await saveDraft('Online', id);
    expect(real).not.toMatch(/^local-/);
    await flushAll();
    expect(server.drafts().map((email) => email.id)).toEqual([real]);
    expect(await engine.areaCall('drafts.list', {})).toEqual([]);
  });

  it('uploads files attached offline before the save goes to the server', async () => {
    online = false;
    const { blobId } = await client.uploadBlob(new File(['hello'], 'note.txt', { type: 'text/plain' }));
    expect(blobId).toMatch(/^bulwark-local-/);
    const id = await saveDraft('With a file', undefined, [{ blobId, name: 'note.txt', type: 'text/plain', size: 5 }]);
    online = true;
    await saveDraft('With a file, later', id, [{ blobId, name: 'note.txt', type: 'text/plain', size: 5 }]);
    const [draft] = server.drafts();
    expect((draft.attachments as Array<{ blobId: string }>)[0].blobId).toBe(server.uploads[0].blobId);
  });
});

describe('a file attached offline', () => {
  it('stays readable and downloadable, offline and once the server is back', async () => {
    online = false;
    const { blobId } = await client.uploadBlob(new File(['hello'], 'note.txt', { type: 'text/plain' }));
    expect(await (await client.fetchBlob(blobId, 'note.txt', 'text/plain')).text()).toBe('hello');
    online = true;
    expect(await (await client.fetchBlob(blobId, 'note.txt', 'text/plain')).text()).toBe('hello');
    expect(spy.mock.calls.filter(([url]: [unknown]) => String(url).includes('/d/'))).toEqual([]);
  });

  it('isn\'t held a second time when its own upload hits an outage', async () => {
    const holdUpload = vi.fn();
    const hooks = { skipNetwork: () => false, answer: async () => null, record: () => {}, noteNetwork: () => {}, serverGone: async () => true, blob: async () => null, recordBlob: () => {}, holdUpload };
    setOfflineHooks(hooks as never);
    online = false;
    await expect(client.uploadBlob(new File(['x'], 'x.txt'), { noHold: true })).rejects.toThrow();
    expect(holdUpload).not.toHaveBeenCalled();
  });
});
