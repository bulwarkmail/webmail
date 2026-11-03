// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SCOPE } from '../area';
import type { DraftError } from '../drafts/pending';
import type { LocalDraftSummary, PendingDraft, DraftGhost } from '../drafts/calls';
import { flushDrafts, type DraftFlushIo } from '../drafts/flush';
import { AccountEngine } from '../engine/account-engine';
import { TransportError, type MethodCall } from '../engine/transport';
import { mailArea } from '../mail';
import { outboxArea } from '../outbox';
import { flushPatches, type PatchOutcome, type PendingPatch } from '../outbox/flush-patches';
import type { StoredConflict } from '../outbox/items';
import { FakeJmapDrafts } from './helpers/fake-drafts';
import { FAKE_SESSION, JMAP_ACCOUNT, type FakeEmail } from './helpers/fake-jmap';
import { openMemoryStore } from './helpers/node-adapter';

const NOW = Date.UTC(2026, 10, 3);
const BOXES = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 0, unreadEmails: 0 },
  { id: 'drafts', name: 'Drafts', role: 'drafts', totalEmails: 0, unreadEmails: 0 },
  { id: 'trash', name: 'Trash', role: 'trash', totalEmails: 0, unreadEmails: 0 },
];

function setup() {
  const server = new FakeJmapDrafts({ mailboxes: BOXES.map((box) => ({ ...box })) });
  server.now = NOW;
  const db = openMemoryStore();
  const engine = new AccountEngine({
    account: 'a@fake.test',
    db,
    session: FAKE_SESSION,
    transport: server,
    areas: [mailArea, outboxArea],
    scope: { ...DEFAULT_SCOPE, days: null, attachments: false },
    now: () => NOW,
    sleep: async () => {},
  });
  return { server, db, engine };
}

let t: ReturnType<typeof setup>;

beforeEach(async () => {
  t = setup();
  await t.engine.requestSync();
});

interface SaveOptions {
  subject?: string;
  text?: string;
  previous?: string;
  attachments?: Array<Record<string, unknown>>;
  networkTried?: boolean;
  messageId?: string;
}

let nextMessage = 0;

/** What createDraft sends: a new version, then the old one goes. */
async function save(options: SaveOptions = {}): Promise<string> {
  nextMessage += 1;
  const answer = await t.engine.answer([['Email/set', {
    accountId: JMAP_ACCOUNT,
    ...(options.networkTried ? { networkTried: true } : {}),
    create: {
      c1: {
        messageId: [options.messageId ?? `draft-${nextMessage}@example.org`],
        from: [{ email: 'a@example.org' }],
        to: [{ email: 'b@example.org' }],
        subject: options.subject ?? 'A draft',
        keywords: { $seen: true, $draft: true },
        mailboxIds: { drafts: true },
        bodyValues: { 1: { value: options.text ?? 'Text' } },
        textBody: [{ partId: '1' }],
        ...(options.attachments ? { attachments: options.attachments } : {}),
      },
    },
  }, 's']]);
  const result = answer?.methodResponses[0][1];
  const id = result.created?.c1?.id as string;
  if (!id) throw new Error(`not created: ${JSON.stringify(result.notCreated)}`);
  if (options.previous) {
    await t.engine.answer([['Email/set', { accountId: JMAP_ACCOUNT, destroy: [options.previous], replacedBy: id }, 'd']]);
  }
  return id;
}

async function get(id: string, properties?: string[]) {
  const answer = await t.engine.answer([['Email/get', { accountId: JMAP_ACCOUNT, ids: [id], fetchAllBodyValues: true, ...(properties ? { properties } : {}) }, 'g']]);
  return answer?.methodResponses[0][1] as { list: Array<Record<string, never>>; notFound: string[] };
}

async function draftBox(): Promise<string[]> {
  const answer = await t.engine.answer([['Email/query', { accountId: JMAP_ACCOUNT, filter: { inMailbox: 'drafts' } }, 'q']]);
  return answer?.methodResponses[0][1].ids;
}

const list = () => t.engine.areaCall('drafts.list', {}) as Promise<LocalDraftSummary[]>;
const conflicts = async () => (await t.engine.areaCall('outbox.read', {}) as { conflicts: StoredConflict[] }).conflicts;

interface Run {
  refused: Array<[string, DraftError]>;
  conflicted: string[];
  sent: number;
}

/** The flush as the page runs it, with the file upload on the fake server. */
function ioFor(run: Run): DraftFlushIo {
  const { engine, server } = t;
  return {
    store: {
      read: () => engine.areaCall('drafts.read', { before: NOW - 60_000 }) as Promise<{ rows: PendingDraft[]; ghosts: DraftGhost[] }>,
      claim: (localId) => engine.areaCall('drafts.claim', { localId }) as Promise<boolean>,
      failed: async (localId, status, error, neverSent) => { await engine.areaCall('drafts.failed', { localId, status, error, neverSent }); },
      created: (result) => engine.areaCall('drafts.created', result) as Promise<{ conflicts: string[] }>,
      ghostsLooked: async (jmap, messageIds, found) => { await engine.areaCall('drafts.ghostsLooked', { jmap, messageIds, found }); },
    },
    request: (calls: MethodCall[]) => server.request(calls),
    upload: async (jmap, blobId) => {
      const held = await engine.areaCall('outbox.heldFile', { blobId }) as { blob: Blob } | null;
      if (!held) return null;
      return (await server.upload(jmap, new Uint8Array(await held.blob.arrayBuffer()))).blobId;
    },
    isRefusal: (error) => error instanceof TransportError && error.kind === 'http',
    onRefused: (subject, error) => run.refused.push([subject, error]),
    onConflict: (subject) => run.conflicted.push(subject),
    onSent: () => { run.sent += 1; },
  };
}

async function flush(): Promise<Run & { finished: boolean }> {
  const run: Run = { refused: [], conflicted: [], sent: 0 };
  const finished = await flushDrafts(ioFor(run));
  return { ...run, finished };
}

/** And what the flush left in the usual queue: the old versions go here. */
async function flushQueue(): Promise<boolean> {
  const pending = await t.engine.areaCall('outbox.pendingPatches', {}) as PendingPatch[];
  return flushPatches({ request: (calls) => t.server.request(calls) }, pending, async (outcomes: PatchOutcome[]) => {
    await t.engine.areaCall('outbox.patchResults', { outcomes });
  });
}

function serverDraft(subject: string, id = 'R') {
  t.server.addEmail({ id, subject, mailboxIds: { drafts: true }, keywords: { $seen: true, $draft: true } });
}

async function hold(text: string, name = 'note.txt'): Promise<string> {
  const held = await t.engine.areaCall('outbox.holdFile', { name, type: 'text/plain', data: new TextEncoder().encode(text) }) as { blobId: string };
  return held.blobId;
}

describe('a draft saved offline', () => {
  it('gets a stand-in id and answers as a server would, without going to the server', async () => {
    const requests = t.server.requests;
    const id = await save({ subject: 'Offline', text: 'Written on a train' });
    expect(id).toMatch(/^local-/);
    expect(t.server.requests).toBe(requests);
    expect(await draftBox()).toEqual([id]);

    const [email] = (await get(id)).list;
    expect(email.subject).toBe('Offline');
    expect(email.keywords).toEqual({ $seen: true, $draft: true });
    expect(email.preview).toBe('Written on a train');
    expect((email.bodyValues as Record<string, { value: string }>)['1'].value).toBe('Written on a train');
    expect(email.textBody).toEqual([{ partId: '1', type: 'text/plain', size: 18 }]);
  });

  it('adds itself to the folder count', async () => {
    await save();
    const answer = await t.engine.answer([['Mailbox/get', {}, 'm']]);
    const drafts = (answer?.methodResponses[0][1].list as Array<{ id: string; totalEmails: number }>).find((box) => box.id === 'drafts');
    expect(drafts?.totalEmails).toBe(1);
  });

  it('can be found by its words', async () => {
    const id = await save({ text: 'quarterly figures' });
    const answer = await t.engine.answer([['Email/query', { filter: { text: 'quarterly' } }, 'q']]);
    expect(answer?.methodResponses[0][1].ids).toEqual([id]);
  });

  it('reads headers back the way the composer does', async () => {
    const answer = await t.engine.answer([['Email/set', {
      create: { c: { keywords: { $draft: true }, mailboxIds: { drafts: true }, subject: 's', 'header:X-Priority:asText': '1 (Highest)', bodyValues: { 1: { value: 'x' } }, textBody: [{ partId: '1' }] } },
    }, 's']]);
    const id = answer?.methodResponses[0][1].created.c.id as string;
    const [email] = (await get(id, ['header:X-Priority:asText'])).list;
    expect(email['header:X-Priority:asText']).toBe('1 (Highest)');
  });

  it('survives a full resync, which asks the server about what it didn\'t list', async () => {
    const id = await save();
    t.server.addEmail({ id: 'new-mail', subject: 'Trigger' });
    t.server.truncateLog('Email');
    t.server.calls.length = 0;
    await t.engine.requestSync();
    // It did list everything again, and asked about what it didn't see.
    expect(t.server.calls.some(([name]) => name === 'Email/query')).toBe(true);
    expect((await get(id)).list).toHaveLength(1);
  });

  it('takes a flag and a move, which go up with it', async () => {
    const id = await save();
    await t.engine.answer([['Email/set', { update: { [id]: { 'keywords/$flagged': true } } }, 'u']]);
    expect((await get(id, ['keywords'])).list[0].keywords).toEqual({ $seen: true, $draft: true, $flagged: true });
    await flush();
    expect(t.server.drafts()[0].keywords).toEqual({ $seen: true, $draft: true, $flagged: true });
  });

  it('is refused as a draft when the same request sends it, or when it isn\'t in Drafts', async () => {
    const sendLike = await t.engine.answer([
      ['Email/set', { create: { c: { keywords: { $draft: true }, mailboxIds: { drafts: true } } } }, '0'],
      ['EmailSubmission/set', { create: { s: { emailId: '#c' } } }, '1'],
    ]);
    expect(sendLike?.methodResponses[0][1].notCreated.c.type).toBe('serverUnavailable');
    const elsewhere = await t.engine.answer([['Email/set', { create: { c: { keywords: { $draft: true }, mailboxIds: { inbox: true } } } }, '0']]);
    expect(elsewhere?.methodResponses[0][1].notCreated.c.type).toBe('serverUnavailable');
    const noKeyword = await t.engine.answer([['Email/set', { create: { c: { keywords: {}, mailboxIds: { drafts: true } } } }, '0']]);
    expect(noKeyword?.methodResponses[0][1].notCreated.c.type).toBe('serverUnavailable');
    expect(await list()).toEqual([]);
  });
});

describe('saving again', () => {
  it('leaves one pending draft after a hundred saves, and one on the server with the latest text', async () => {
    let id = await save({ text: 'Save 0' });
    for (let n = 1; n < 100; n += 1) id = await save({ text: `Save ${n}`, previous: id });
    expect(await list()).toHaveLength(1);
    expect(await draftBox()).toEqual([id]);

    const { finished, sent } = await flush();
    expect(finished).toBe(true);
    expect(sent).toBe(1);
    expect(t.server.drafts()).toHaveLength(1);
    expect((t.server.drafts()[0].bodyValues as Record<string, { value: string }>)['1'].value).toBe('Save 99');
    expect(await list()).toEqual([]);
  });

  it('removes the older stand-in from everything that reads', async () => {
    const first = await save();
    const second = await save({ previous: first });
    expect((await get(first)).notFound).toEqual([first]);
    expect((await get(second)).list).toHaveLength(1);
  });
});

describe('a stand-in in a destroy', () => {
  it('discards the draft, and nothing reaches the server', async () => {
    const id = await save();
    const answer = await t.engine.answer([['Email/set', { destroy: [id] }, 'd']]);
    expect(answer?.methodResponses[0][1].destroyed).toEqual([id]);
    expect((await get(id)).notFound).toEqual([id]);
    await flush();
    expect(t.server.drafts()).toEqual([]);
    expect(await t.engine.areaCall('outbox.pendingPatches', {})).toEqual([]);
  });

  it('after the flush goes to the real message, by the map', async () => {
    const id = await save();
    await flush();
    const real = t.server.drafts()[0].id;
    expect(await t.engine.areaCall('drafts.resolveStandIns', { ids: [id, 'local-unknown'] })).toEqual({ [id]: real, 'local-unknown': null });
    await t.engine.answer([['Email/set', { destroy: [id] }, 'd']]);
    await flushQueue();
    expect(t.server.emails.has(real)).toBe(false);
  });
});

describe('a draft from the server edited offline', () => {
  beforeEach(async () => {
    serverDraft('On the server');
    await t.engine.requestSync();
  });

  it('hides the old version here and leaves it on the server until the new one has arrived', async () => {
    const id = await save({ subject: 'Edited', previous: 'R' });
    expect(await draftBox()).toEqual([id]);
    expect(t.server.emails.has('R')).toBe(true);
    expect(await t.engine.areaCall('outbox.pendingPatches', {})).toEqual([]);
    // A sync doesn't bring it back.
    t.server.updateEmail('R', { keywords: { $seen: true, $draft: true } });
    t.server.coll.Email.push('updated', 'R');
    await t.engine.requestSync();
    expect(await draftBox()).toEqual([id]);
  });

  it('creates the new version first and destroys the old one after', async () => {
    await save({ subject: 'Edited', previous: 'R' });
    await flush();
    expect(t.server.emails.has('R')).toBe(true);
    await flushQueue();
    expect(t.server.log.filter((line) => /^(create|destroy)/.test(line))).toEqual(['create srv1', 'destroy R']);
    expect(t.server.drafts().map((email) => email.subject)).toEqual(['Edited']);
  });

  it('keeps both when the destroy fails: nothing is lost, and it goes again', async () => {
    await save({ subject: 'Edited', previous: 'R' });
    await flush();
    t.server.offline = true;
    expect(await flushQueue()).toBe(false);
    t.server.offline = false;
    expect(t.server.drafts()).toHaveLength(2);
    await flushQueue();
    expect(t.server.drafts().map((email) => email.subject)).toEqual(['Edited']);
  });

  it('keeps the old version when the create fails', async () => {
    t.server.refuseCreate = { type: 'overQuota' };
    await save({ subject: 'Edited', previous: 'R' });
    await flush();
    await flushQueue();
    expect(t.server.emails.has('R')).toBe(true);
  });

  it('carries what an earlier save replaced through later saves', async () => {
    const first = await save({ text: 'One', previous: 'R' });
    await save({ text: 'Two', previous: first });
    await flush();
    await flushQueue();
    expect(t.server.drafts()).toHaveLength(1);
    expect((t.server.drafts()[0].bodyValues as Record<string, { value: string }>)['1'].value).toBe('Two');
  });

  it('removes the old version too when the new one is discarded before it went up', async () => {
    const id = await save({ previous: 'R' });
    await t.engine.answer([['Email/set', { destroy: [id] }, 'd']]);
    await flushQueue();
    expect(t.server.drafts()).toEqual([]);
  });

  it('keeps both and says so when another device changed it meanwhile', async () => {
    await save({ subject: 'Mine', previous: 'R' });
    t.server.updateEmail('R', { keywords: { $seen: true, $draft: true, $flagged: true } });
    const { conflicted } = await flush();
    await flushQueue();
    expect(conflicted).toEqual(['On the server']);
    expect(t.server.drafts().map((email) => email.subject).sort()).toEqual(['Mine', 'On the server']);
    expect((await conflicts())[0].summary).toMatchObject({ op: 'draft', reason: 'changed', subject: 'On the server' });
    // The other version is back in view: nothing else would bring it.
    expect((await draftBox()).sort()).toEqual(['R', 'srv1'].sort());
  });

  it('keeps ours and says so when another device replaced or removed it', async () => {
    await save({ subject: 'Mine', previous: 'R' });
    t.server.destroyEmail('R');
    t.server.addEmail({ id: 'R2', subject: 'Theirs', mailboxIds: { drafts: true }, keywords: { $seen: true, $draft: true } });
    const { conflicted } = await flush();
    await flushQueue();
    expect(conflicted).toEqual(['On the server']);
    expect(t.server.drafts().map((email) => email.subject).sort()).toEqual(['Mine', 'Theirs']);
    expect((await conflicts())[0].summary).toMatchObject({ op: 'draft', reason: 'gone' });
  });
});

describe('a lost response', () => {
  it('doesn\'t make a second draft: the copy is found by its Message-ID', async () => {
    const id = await save({ messageId: 'fixed@example.org' });
    t.server.loseAnswerOf = 'Email/set';
    const first = await flush();
    expect(first.finished).toBe(false);
    expect(t.server.drafts()).toHaveLength(1);
    expect((await list())[0].status).toBe('uncertain');
    // It stays readable under its stand-in meanwhile.
    expect((await get(id)).list).toHaveLength(1);

    const second = await flush();
    expect(second.finished).toBe(true);
    expect(t.server.drafts()).toHaveLength(1);
    expect(await list()).toEqual([]);
    expect(await t.engine.areaCall('drafts.resolveStandIns', { ids: [id] })).toEqual({ [id]: t.server.drafts()[0].id });
  });

  it('creates it when the lookup finds that it never arrived', async () => {
    await save();
    t.server.offline = true;
    await flush();
    t.server.offline = false;
    await flush();
    expect(t.server.drafts()).toHaveLength(1);
  });

  it('removes the copy of a version replaced while the answer was missing', async () => {
    const first = await save({ text: 'Old', messageId: 'old@example.org' });
    t.server.loseAnswerOf = 'Email/set';
    await flush();
    await save({ text: 'New', previous: first });
    await flush();
    await flushQueue();
    expect(t.server.drafts()).toHaveLength(1);
    expect((t.server.drafts()[0].bodyValues as Record<string, { value: string }>)['1'].value).toBe('New');
    expect(await t.engine.areaCall('drafts.read', { before: 0 })).toMatchObject({ ghosts: [] });
  });

  it('looks a create up that came to the store after its own request broke', async () => {
    t.server.addEmail({ id: 'landed', subject: 'A draft', mailboxIds: { drafts: true }, keywords: { $draft: true }, messageId: ['tried@example.org'], receivedAt: new Date(NOW).toISOString() });
    const id = await save({ messageId: 'tried@example.org', networkTried: true });
    expect((await list())[0].status).toBe('uncertain');
    await flush();
    expect(t.server.drafts().map((email) => email.id)).toEqual(['landed']);
    expect(await t.engine.areaCall('drafts.resolveStandIns', { ids: [id] })).toEqual({ [id]: 'landed' });
  });

  it('counts a tab closed on the way as uncertain', async () => {
    const id = await save({ messageId: 'closed@example.org' });
    expect(await t.engine.areaCall('drafts.claim', { localId: id })).toBe(true);
    await t.engine.areaCall('drafts.read', { before: NOW + 1 });
    expect((await list())[0].status).toBe('uncertain');
  });

  it('removes a copy that arrives after the draft was replaced on the way, only once the new one is up', async () => {
    const id = await save({ text: 'Old', messageId: 'late@example.org' });
    await t.engine.areaCall('drafts.claim', { localId: id });
    const next = await save({ text: 'New', previous: id });
    t.server.addEmail({ id: 'late', subject: 'A draft', mailboxIds: { drafts: true }, keywords: { $seen: true, $draft: true }, messageId: ['late@example.org'], size: 3, receivedAt: new Date(NOW).toISOString() });
    await t.engine.areaCall('drafts.created', { localId: id, seq: 1, jmap: JMAP_ACCOUNT, messageId: 'late@example.org', serverId: 'late', email: null, server: {}, ghostCopies: [] });
    expect(await t.engine.areaCall('outbox.pendingPatches', {})).toEqual([]);
    expect((await get(next)).list).toHaveLength(1);
    await flush();
    await flushQueue();
    expect(t.server.emails.has('late')).toBe(false);
    expect((t.server.drafts()[0].bodyValues as Record<string, { value: string }>)['1'].value).toBe('New');
  });
});

describe('a refused draft', () => {
  it('stays on the device with its error, and the composer can still open it', async () => {
    t.server.refuseCreate = { type: 'overQuota', description: 'No room left' };
    const id = await save({ subject: 'Too much', text: 'Keep me' });
    const { refused, finished } = await flush();
    expect(finished).toBe(true);
    expect(refused).toEqual([['Too much', { type: 'overQuota', text: 'No room left' }]]);
    expect(await list()).toMatchObject([{ localId: id, status: 'refused', error: { type: 'overQuota', text: 'No room left' } }]);
    expect((await get(id)).list[0].bodyValues).toMatchObject({ 1: { value: 'Keep me' } });
    expect(await draftBox()).toEqual([id]);
  });

  it('isn\'t asked about again by itself, and goes up when the user tries again', async () => {
    t.server.refuseCreate = { type: 'overQuota' };
    const id = await save();
    await flush();
    t.server.refuseCreate = null;
    await flush();
    expect(t.server.drafts()).toEqual([]);
    await t.engine.areaCall('drafts.retry', { localId: id });
    await flush();
    expect(t.server.drafts()).toHaveLength(1);
    expect(await list()).toEqual([]);
  });

  it('goes up again once it\'s edited', async () => {
    t.server.refuseCreate = { type: 'overQuota' };
    const id = await save({ text: 'One' });
    await flush();
    t.server.refuseCreate = null;
    await save({ text: 'Two', previous: id });
    await flush();
    expect((t.server.drafts()[0].bodyValues as Record<string, { value: string }>)['1'].value).toBe('Two');
  });

  it('says so when the request itself is refused for good', async () => {
    const id = await save();
    const original = t.server.request.bind(t.server);
    t.server.request = async () => { throw new TransportError('http', 'Too large', 413); };
    const { refused } = await flush();
    t.server.request = original;
    expect(refused).toHaveLength(1);
    expect((await list())[0]).toMatchObject({ localId: id, status: 'refused' });
  });
});

describe('files attached offline', () => {
  it('are shown on the draft with their size, stay readable, and go up on the flush', async () => {
    const blobId = await hold('hello');
    const id = await save({ attachments: [{ blobId, type: 'text/plain', name: 'note.txt', disposition: 'attachment' }] });
    const [email] = (await get(id)).list;
    expect(email.hasAttachment).toBe(true);
    expect(email.attachments).toMatchObject([{ blobId, name: 'note.txt', size: 5, type: 'text/plain', disposition: 'attachment' }]);
    const file = await t.engine.areaCall('outbox.heldFile', { blobId }) as { name: string; blob: Blob };
    expect(await file.blob.text()).toBe('hello');

    await flush();
    const [draft] = t.server.drafts();
    expect(t.server.uploads).toHaveLength(1);
    const [part] = draft.attachments as Array<{ blobId: string; size: number }>;
    expect(part.size).toBe(5);
    expect(new TextDecoder().decode(t.server.bytesOf(part.blobId))).toBe('hello');
  });

  it('go up before the create that names them', async () => {
    const blobId = await hold('hello');
    await save({ attachments: [{ blobId, type: 'text/plain', name: 'note.txt' }] });
    await flush();
    expect(t.server.log.slice(0, 2)).toEqual(['upload up1', 'create srv1']);
  });

  it('come in pieces, and a broken one leaves nothing readable', async () => {
    const started = await t.engine.areaCall('outbox.holdStart', { name: 'big.bin', type: '', size: 6 }) as { blobId: string };
    await t.engine.areaCall('outbox.holdChunk', { blobId: started.blobId, seq: 0, data: new Uint8Array([1, 2, 3]) });
    expect(await t.engine.areaCall('outbox.heldFile', { blobId: started.blobId })).toBeNull();
    await t.engine.areaCall('outbox.holdChunk', { blobId: started.blobId, seq: 1, data: new Uint8Array([4, 5, 6]) });
    await t.engine.areaCall('outbox.holdEnd', { blobId: started.blobId });
    const file = await t.engine.areaCall('outbox.heldFile', { blobId: started.blobId }) as { blob: Blob };
    expect([...new Uint8Array(await file.blob.arrayBuffer())]).toEqual([1, 2, 3, 4, 5, 6]);
    await t.engine.areaCall('outbox.holdAbort', { blobId: started.blobId });
    expect(await t.engine.areaCall('outbox.heldFile', { blobId: started.blobId })).toBeNull();
    expect(t.db.get('SELECT 1 AS x FROM upload_chunk')).toBeUndefined();
  });

  it('wait when the upload hits an outage, without counting as maybe sent', async () => {
    const blobId = await hold('hello');
    await save({ attachments: [{ blobId, type: 'text/plain', name: 'note.txt' }] });
    t.server.failUpload = true;
    const { finished } = await flush();
    expect(finished).toBe(false);
    expect(t.server.drafts()).toEqual([]);
    expect((await list())[0].status).toBe('waiting');
  });

  it('refuse the draft when a file is gone from the device', async () => {
    const blobId = await hold('hello');
    const id = await save({ attachments: [{ blobId, type: 'text/plain', name: 'note.txt' }] });
    await t.engine.areaCall('outbox.holdAbort', { blobId });
    const { refused } = await flush();
    expect(refused).toEqual([['A draft', { code: 'file_missing' }]]);
    expect((await list())[0]).toMatchObject({ localId: id, status: 'refused', error: { code: 'file_missing' } });
  });

  it('count as needed for as long as a draft or a send names them', async () => {
    const forDraft = await hold('a');
    const forNothing = await hold('b');
    const id = await save({ attachments: [{ blobId: forDraft, type: 'text/plain', name: 'a' }] });
    expect(await t.engine.areaCall('outbox.dropOrphans', { olderThan: NOW + 1 })).toBe(1);
    expect(await t.engine.areaCall('outbox.heldFile', { blobId: forNothing })).toBeNull();
    expect(await t.engine.areaCall('outbox.heldFile', { blobId: forDraft })).not.toBeNull();
    await t.engine.answer([['Email/set', { destroy: [id] }, 'd']]);
    expect(await t.engine.areaCall('outbox.dropOrphans', { olderThan: NOW + 1 })).toBe(1);
  });

  it('survive removing the send that shared them with a draft', async () => {
    const blobId = await hold('a');
    await save({ attachments: [{ blobId, type: 'text/plain', name: 'a' }] });
    const entry = await t.engine.areaCall('outbox.queueSend', {
      summary: { subject: 's', to: [] },
      item: { kind: 'email', args: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, [{ blobId }]] },
    }) as number;
    await t.engine.areaCall('outbox.remove', { id: entry });
    expect(await t.engine.areaCall('outbox.heldFile', { blobId })).not.toBeNull();
  });

  it('are found inside a body structure too, as a draft with inline images writes them', async () => {
    const blobId = await hold('png');
    const answer = await t.engine.answer([['Email/set', {
      create: {
        c: {
          keywords: { $draft: true },
          mailboxIds: { drafts: true },
          bodyValues: { text: { value: 'text' }, html: { value: '<img src="cid:i">' } },
          bodyStructure: {
            type: 'multipart/alternative',
            subParts: [
              { partId: 'text', type: 'text/plain' },
              { type: 'multipart/related', subParts: [{ partId: 'html', type: 'text/html' }, { blobId, type: 'image/png', name: 'i.png', disposition: 'inline', cid: 'i' }] },
            ],
          },
        },
      },
    }, 's']]);
    const id = answer?.methodResponses[0][1].created.c.id as string;
    const [email] = (await get(id)).list;
    expect(email.hasAttachment).toBe(false);
    expect(email.attachments).toMatchObject([{ blobId, cid: 'i', disposition: 'inline', size: 3 }]);
    expect(email.htmlBody).toMatchObject([{ partId: 'html', type: 'text/html' }]);
    await flush();
    const leaf = (t.server.calls.find(([name, args]) => name === 'Email/set' && args.create)?.[1].create as Record<string, { bodyStructure: { subParts: Array<{ subParts: Array<{ blobId?: string }> }> } }>).draft.bodyStructure.subParts[1].subParts[1];
    expect(leaf.blobId).toBe(t.server.uploads[0].blobId);
  });
});

describe('sending a draft that\'s on the device', () => {
  it('leaves the draft alone while the send waits, and the send takes care of it', async () => {
    const id = await save({ previous: undefined });
    await t.engine.areaCall('outbox.queueSend', {
      summary: { subject: 's', to: [] },
      item: { kind: 'email', args: [['b@example.org'], 's', 'x', undefined, undefined, undefined, undefined, id] },
    });
    await flush();
    expect(t.server.drafts()).toEqual([]);
    expect((await get(id)).list).toHaveLength(1);
    // It's that message, in the outbox: not counted a second time as unsent.
    expect(await list()).toEqual([]);

    await t.engine.areaCall('drafts.discard', { jmap: JMAP_ACCOUNT, id });
    expect((await get(id)).notFound).toEqual([id]);
  });

  it('goes up as a draft if the send fails, so nothing depends on the outbox', async () => {
    const id = await save();
    const entry = await t.engine.areaCall('outbox.queueSend', {
      summary: { subject: 's', to: [] },
      item: { kind: 'email', args: [['b@example.org'], 's', 'x', undefined, undefined, undefined, undefined, id] },
    }) as number;
    await t.engine.areaCall('outbox.update', { id: entry, status: 'failed', error: { text: 'refused' } });
    await flush();
    expect(t.server.drafts()).toHaveLength(1);
  });
});

const valueOf = (email: FakeEmail) => (email.bodyValues as Record<string, { value: string }>)['1'].value;

describe('a draft naming a part that died with its message', () => {
  function partOnServer(id: string, part: string, bytes: string) {
    t.server.parts.set(part, new TextEncoder().encode(bytes));
    t.server.addEmail({
      id,
      subject: 'On the server',
      mailboxIds: { drafts: true },
      keywords: { $seen: true, $draft: true },
      attachments: [{ partId: part, blobId: part, name: 'a.txt', type: 'text/plain', size: bytes.length }] as never,
    });
  }

  it('is pointed at the part of the version it replaces, and goes up', async () => {
    partOnServer('R', 'part-live', 'abc');
    await t.engine.requestSync();
    await save({ previous: 'R', attachments: [{ blobId: 'part-dead', type: 'text/plain', name: 'a.txt' }] });
    const { refused, finished } = await flush();
    expect(refused).toEqual([]);
    expect(finished).toBe(true);
    await flushQueue();
    const [draft] = t.server.drafts();
    expect(t.server.drafts()).toHaveLength(1);
    expect(new TextDecoder().decode(t.server.bytesOf((draft.attachments as Array<{ blobId: string }>)[0].blobId))).toBe('abc');
  });

  it('keeps two files of one name apart: one that\'s alive keeps its part', async () => {
    t.server.parts.set('p-short', new Uint8Array(3));
    t.server.parts.set('p-long', new Uint8Array(9));
    t.server.addEmail({
      id: 'R',
      subject: 'Two',
      mailboxIds: { drafts: true },
      keywords: { $draft: true },
      attachments: [
        { partId: 'p-short', blobId: 'p-short', name: 'a.txt', type: 'text/plain', size: 3 },
        { partId: 'p-long', blobId: 'p-long', name: 'a.txt', type: 'text/plain', size: 9 },
      ] as never,
    });
    await t.engine.requestSync();
    await save({ previous: 'R', attachments: [{ blobId: 'p-long', type: 'text/plain', name: 'a.txt' }, { blobId: 'dead', type: 'text/plain', name: 'a.txt' }] });
    await flush();
    const parts = t.server.drafts().find((email) => email.id !== 'R')?.attachments as Array<{ size: number }>;
    expect(parts.map((part) => part.size).sort()).toEqual([3, 9]);
  });

  it('stays here with its error when nothing matches', async () => {
    partOnServer('R', 'part-live', 'abc');
    await t.engine.requestSync();
    const id = await save({ previous: 'R', attachments: [{ blobId: 'part-dead', type: 'text/plain', name: 'other.txt' }] });
    const { refused } = await flush();
    expect(refused[0][1]).toMatchObject({ type: 'blobNotFound' });
    expect((await list())[0]).toMatchObject({ localId: id, status: 'refused' });
    expect(t.server.emails.has('R')).toBe(true);
  });
});

describe('a version that may have reached the server, once replaced', () => {
  async function lostThenReplaced(text = 'New') {
    const first = await save({ text: 'Old', messageId: 'old@example.org' });
    t.server.loseAnswerOf = 'Email/set';
    await flush();
    return { first, copy: t.server.drafts()[0].id, next: () => save({ text, previous: first }) };
  }

  it('is removed when it\'s the copy this device made', async () => {
    const { next } = await lostThenReplaced();
    await next();
    await flush();
    await flushQueue();
    expect(t.server.drafts().map(valueOf)).toEqual(['New']);
  });

  it('is left alone when another client saved again under that Message-ID', async () => {
    const { copy, next } = await lostThenReplaced();
    t.server.destroyEmail(copy);
    t.server.addEmail({ id: 'theirs', subject: 'Theirs now', mailboxIds: { drafts: true }, keywords: { $draft: true }, messageId: ['old@example.org'], size: 3, receivedAt: new Date(NOW).toISOString() });
    await next();
    await flush();
    await flushQueue();
    expect(t.server.emails.has('theirs')).toBe(true);
    expect(t.server.drafts()).toHaveLength(2);
  });

  it('is left alone when it was received long after the attempt', async () => {
    const { copy, next } = await lostThenReplaced();
    t.server.updateEmail(copy, { receivedAt: new Date(NOW + 6 * 60 * 60 * 1000).toISOString() });
    await next();
    await flush();
    await flushQueue();
    expect(t.server.emails.has(copy)).toBe(true);
  });

  it('is left alone when its size doesn\'t fit', async () => {
    const { copy, next } = await lostThenReplaced();
    t.server.updateEmail(copy, { size: 5_000_000 });
    await next();
    await flush();
    await flushQueue();
    expect(t.server.emails.has(copy)).toBe(true);
  });

  it('is left alone when it\'s in another folder too, or no longer a draft', async () => {
    const { copy, next } = await lostThenReplaced();
    t.server.updateEmail(copy, { mailboxIds: { drafts: true, inbox: true } });
    await next();
    await flush();
    await flushQueue();
    expect(t.server.emails.has(copy)).toBe(true);

    t = setup();
    await t.engine.requestSync();
    const again = await lostThenReplaced();
    t.server.updateEmail(again.copy, { keywords: { $seen: true } });
    await again.next();
    await flush();
    await flushQueue();
    expect(t.server.emails.has(again.copy)).toBe(true);
  });

  it('is left alone when it moves between the lookup and the destroy', async () => {
    const { copy, next } = await lostThenReplaced();
    await next();
    await flush();
    t.server.updateEmail(copy, { mailboxIds: { trash: true } });
    await flushQueue();
    expect(t.server.emails.has(copy)).toBe(true);
    expect((t.server.emails.get(copy)?.mailboxIds as Record<string, boolean>).trash).toBe(true);
  });

  it('isn\'t touched while the newer version is refused, and goes once that one is up', async () => {
    const { copy, next } = await lostThenReplaced();
    const newer = await next();
    t.server.refuseCreate = { type: 'overQuota' };
    await flush();
    expect(await t.engine.areaCall('outbox.pendingPatches', {})).toEqual([]);
    await flushQueue();
    expect(t.server.emails.has(copy)).toBe(true);

    t.server.refuseCreate = null;
    await t.engine.areaCall('drafts.retry', { localId: newer });
    await flush();
    await flushQueue();
    expect(t.server.emails.has(copy)).toBe(false);
    expect(t.server.drafts().map(valueOf)).toEqual(['New']);
  });

  it('carries through later saves', async () => {
    const { copy, first } = await lostThenReplaced();
    const second = await save({ text: 'Two', previous: first });
    await save({ text: 'Three', previous: second });
    await flush();
    await flushQueue();
    expect(t.server.emails.has(copy)).toBe(false);
    expect(t.server.drafts().map(valueOf)).toEqual(['Three']);
  });

  it('is looked up and removed under the same rules when the draft is discarded', async () => {
    const { first, copy } = await lostThenReplaced();
    await t.engine.answer([['Email/set', { destroy: [first] }, 'd']]);
    await flush();
    await flushQueue();
    expect(t.server.emails.has(copy)).toBe(false);

    t = setup();
    await t.engine.requestSync();
    const again = await lostThenReplaced();
    t.server.updateEmail(again.copy, { subject: 'Renamed elsewhere' });
    await t.engine.answer([['Email/set', { destroy: [again.first] }, 'd']]);
    await flush();
    await flushQueue();
    expect(t.server.emails.has(again.copy)).toBe(true);
  });

  it('isn\'t taken for this draft\'s own copy when another client saved under its Message-ID', async () => {
    const id = await save({ text: 'Mine', messageId: 'same@example.org' });
    t.server.loseAnswerOf = 'Email/set';
    await flush();
    const copy = t.server.drafts()[0].id;
    t.server.destroyEmail(copy);
    t.server.addEmail({ id: 'theirs', subject: 'Theirs now', mailboxIds: { drafts: true }, keywords: { $draft: true }, messageId: ['same@example.org'], size: 3, receivedAt: new Date(NOW).toISOString() });
    await flush();
    expect(t.server.emails.has('theirs')).toBe(true);
    expect(t.server.drafts().map((email) => email.subject).sort()).toEqual(['A draft', 'Theirs now']);
    const resolved = await t.engine.areaCall('drafts.resolveStandIns', { ids: [id] }) as Record<string, string>;
    expect(resolved[id]).not.toBe('theirs');
  });
});

describe('a version the device doesn\'t keep, replaced', () => {
  it('goes after the new one when it\'s a plain draft, checked against what the server says then', async () => {
    t.server.addEmail({ id: 'R', subject: 'Not kept', mailboxIds: { drafts: true }, keywords: { $draft: true } });
    await save({ subject: 'Mine', previous: 'R' });
    await flush();
    await flushQueue();
    expect(t.server.emails.has('R')).toBe(false);
  });

  it('stays, and the user is told, when it\'s no longer a plain draft', async () => {
    t.server.addEmail({ id: 'R', subject: 'Moved', mailboxIds: { trash: true }, keywords: { $draft: true } });
    const { conflicted } = await (async () => {
      await save({ subject: 'Mine', previous: 'R' });
      return flush();
    })();
    await flushQueue();
    expect(t.server.emails.has('R')).toBe(true);
    expect(conflicted).toEqual(['Moved']);
  });

  it('stays when it moves between the read and the destroy', async () => {
    t.server.addEmail({ id: 'R', subject: 'Moves', mailboxIds: { drafts: true }, keywords: { $draft: true } });
    await save({ subject: 'Mine', previous: 'R' });
    await flush();
    t.server.updateEmail('R', { mailboxIds: { trash: true } });
    await flushQueue();
    expect(t.server.emails.has('R')).toBe(true);
  });
});

describe('a lookup that fails', () => {
  function queryFails(error: Error) {
    const original = t.server.request.bind(t.server);
    t.server.request = async (calls) => {
      if (calls.some(([name]) => name === 'Email/query')) throw error;
      return original(calls);
    };
    return () => { t.server.request = original; };
  }

  it('waits on an outage', async () => {
    const first = await save({ messageId: 'old@example.org' });
    t.server.loseAnswerOf = 'Email/set';
    await flush();
    const restore = queryFails(new TransportError('network', 'gone'));
    const { finished } = await flush();
    restore();
    expect(finished).toBe(false);
    expect((await list())[0].localId).toBe(first);
  });

  it('counts as no copies when the server refuses it for good, so the rest can go', async () => {
    await save({ messageId: 'old@example.org' });
    t.server.loseAnswerOf = 'Email/set';
    await flush();
    const restore = queryFails(new TransportError('http', 'Refused', 400));
    const { finished } = await flush();
    restore();
    expect(finished).toBe(true);
    expect(await list()).toEqual([]);
  });

  it('drops a ghost it can\'t ever look up', async () => {
    const first = await save({ messageId: 'old@example.org' });
    t.server.loseAnswerOf = 'Email/set';
    await flush();
    const copy = t.server.drafts()[0].id;
    await t.engine.answer([['Email/set', { destroy: [first] }, 'd']]);
    const restore = queryFails(new TransportError('http', 'Refused', 400));
    await flush();
    restore();
    expect(await t.engine.areaCall('drafts.read', { before: 0 })).toMatchObject({ ghosts: [] });
    expect(t.server.emails.has(copy)).toBe(true);
  });
});

describe('a held file whose pieces don\'t add up', () => {
  it('reads as gone, not as an empty file', async () => {
    const blobId = await hold('hello');
    t.db.run('DELETE FROM upload_chunk WHERE local_id = ?', [blobId]);
    expect(await t.engine.areaCall('outbox.heldFile', { blobId })).toBeNull();
  });
});
