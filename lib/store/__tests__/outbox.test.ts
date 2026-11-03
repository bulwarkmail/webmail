// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SCOPE } from '../area';
import { AccountEngine } from '../engine/account-engine';
import { TransportError, type MethodCall } from '../engine/transport';
import { mailArea } from '../mail';
import { outboxArea } from '../outbox';
import { CLOCK_SKEW_MARGIN_MS, decideRetry, LOOKUP_TRUSTED_MS, type LookupArgs } from '../outbox/dedupe';
import { flushPatches, type PatchOutcome, type PendingPatch } from '../outbox/flush-patches';
import type { StoredConflict, StoredOutboxEntry } from '../outbox/items';
import { mergePatches, patchConflicts } from '../outbox/patches';
import { FAKE_SESSION, JMAP_ACCOUNT, type FakeEmail } from './helpers/fake-jmap';
import { FakeJmapMail } from './helpers/fake-jmap-mail';
import { openMemoryStore } from './helpers/node-adapter';

const NOW = Date.UTC(2026, 10, 3);
const BOXES = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 2, unreadEmails: 1 },
  { id: 'trash', name: 'Trash', role: 'trash', totalEmails: 1, unreadEmails: 0 },
  { id: 'drafts', name: 'Drafts', role: 'drafts', totalEmails: 0, unreadEmails: 0 },
  { id: 'sent', name: 'Sent', role: 'sent', totalEmails: 0, unreadEmails: 0 },
];

function setup() {
  const server = new FakeJmapMail({ mailboxes: BOXES.map((box) => ({ ...box })) });
  server.addEmail({ id: 'a', threadId: 't1', subject: 'Aye', keywords: {}, mailboxIds: { inbox: true } });
  server.addEmail({ id: 'b', threadId: 't1', subject: 'Bee', keywords: { $seen: true }, mailboxIds: { inbox: true } });
  server.addEmail({ id: 'c', threadId: 't2', subject: 'Sea', keywords: { $seen: true }, mailboxIds: { trash: true } });
  const db = openMemoryStore();
  const engine = new AccountEngine({
    account: 'a@fake.test',
    db,
    session: FAKE_SESSION,
    transport: server,
    areas: [mailArea, outboxArea],
    scope: { ...DEFAULT_SCOPE, days: null },
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

const set = (args: Record<string, unknown>) => t.engine.answer([['Email/set', args, 's']]);
const update = (patches: Record<string, Record<string, unknown>>) => set({ update: patches });
const pending = () => t.engine.areaCall('outbox.pendingPatches', {}) as Promise<PendingPatch[]>;
const read = () => t.engine.areaCall('outbox.read', {}) as Promise<{ patches: number; entries: StoredOutboxEntry[]; conflicts: StoredConflict[] }>;

async function local(id: string) {
  const answer = await t.engine.answer([['Email/get', { ids: [id], properties: ['keywords', 'mailboxIds', 'subject'] }, 'g']]);
  return answer?.methodResponses[0][1].list[0];
}

async function boxes() {
  const answer = await t.engine.answer([['Mailbox/get', {}, 'm']]);
  return Object.fromEntries((answer?.methodResponses[0][1].list as Array<{ id: string; totalEmails: number; unreadEmails: number }>).map((box) => [box.id, [box.totalEmails, box.unreadEmails]]));
}

const io = (server: FakeJmapMail = t.server, isRefusal: (error: unknown) => boolean = () => false) => ({
  request: (calls: MethodCall[]) => server.request(calls),
  isRefusal,
});

async function flush(ioOverride = io()) {
  const outcomes: PatchOutcome[] = [];
  const finished = await flushPatches(ioOverride, await pending(), async (batch) => {
    outcomes.push(...batch);
    await t.engine.areaCall('outbox.patchResults', { outcomes: batch });
  });
  return { outcomes, finished };
}

describe('merging patches per record', () => {
  it('keeps one row per record, with later paths on top of earlier ones', async () => {
    await update({ a: { 'keywords/$seen': true } });
    await update({ a: { 'keywords/$flagged': true } });
    await update({ a: { 'keywords/$seen': null } });
    const rows = await pending();
    expect(rows).toHaveLength(1);
    expect(rows[0].patch).toEqual({ 'keywords/$seen': null, 'keywords/$flagged': true });
    expect((await local('a')).keywords).toEqual({ $flagged: true });
  });

  it('lets a whole map replace earlier paths into it, and takes later paths into the map', () => {
    expect(mergePatches({ 'keywords/$seen': true, 'mailboxIds/x': true }, { keywords: { $flagged: true } }))
      .toEqual({ keywords: { $flagged: true }, 'mailboxIds/x': true });
    expect(mergePatches({ keywords: { $flagged: true } }, { 'keywords/$seen': true }))
      .toEqual({ keywords: { $flagged: true, $seen: true } });
    expect(mergePatches({ keywords: { $flagged: true } }, { 'keywords/$flagged': null })).toEqual({ keywords: {} });
    expect(mergePatches({ mailboxIds: { a: true } }, { mailboxIds: { b: true } })).toEqual({ mailboxIds: { b: true } });
  });

  it('reads escaped keyword names', () => {
    expect(mergePatches({ keywords: {} }, { 'keywords/a~1b': true })).toEqual({ keywords: { 'a/b': true } });
  });

  it('queues a change to a message it doesn\'t keep, and answers it as done', async () => {
    const answer = await update({ unknown: { 'keywords/$seen': true } });
    expect(answer?.methodResponses[0][1].updated).toEqual({ unknown: null });
    expect((await pending()).map((row) => [row.recordId, row.base])).toEqual([['unknown', null]]);
  });

  it('refuses per record what can\'t wait: other properties, a new folder, no folder at all', async () => {
    const answer = await update({
      a: { subject: 'x' },
      b: { 'mailboxIds/#new': true },
      c: { mailboxIds: {} },
    });
    const result = answer?.methodResponses[0][1];
    expect(Object.keys(result.notUpdated).sort()).toEqual(['a', 'b', 'c']);
    expect(result.notUpdated.a.type).toBe('forbidden');
    expect(result.notUpdated.c.type).toBe('invalidProperties');
    expect(await pending()).toEqual([]);
    const emptied = await update({ c: { 'mailboxIds/trash': null } });
    expect(emptied?.methodResponses[0][1].notUpdated.c.type).toBe('invalidProperties');
    expect(await pending()).toEqual([]);
    expect((await local('c')).mailboxIds).toEqual({ trash: true });
  });

  it('answers a create per message, so the composer\'s "not saved" path runs (seam for the drafts agent)', async () => {
    const answer = await set({ create: { draft: { subject: 'x' } } });
    expect(answer?.methodResponses[0][0]).toBe('Email/set');
    expect(answer?.methodResponses[0][1].notCreated.draft.type).toBe('serverUnavailable');
  });
});

describe('showing changes at once', () => {
  it('moves a message and keeps the folder counts right', async () => {
    expect(await boxes()).toMatchObject({ inbox: [2, 1], trash: [1, 0] });
    await update({ a: { 'mailboxIds/inbox': null, 'mailboxIds/trash': true } });
    expect(await boxes()).toMatchObject({ inbox: [1, 0], trash: [2, 1] });
    const answer = await t.engine.answer([['Email/query', { filter: { inMailbox: 'trash' }, sort: [{ property: 'receivedAt', isAscending: false }] }, 'q']]);
    expect(answer?.methodResponses[0][1].ids).toEqual(['c', 'a']);
  });

  it('counts a read change once, also after later changes to the same record', async () => {
    await update({ a: { 'keywords/$seen': true } });
    expect((await boxes()).inbox).toEqual([2, 0]);
    await update({ a: { 'keywords/$flagged': true } });
    expect((await boxes()).inbox).toEqual([2, 0]);
    await update({ a: { 'keywords/$seen': null } });
    expect((await boxes()).inbox).toEqual([2, 1]);
  });

  it('whole-map patches count the same', async () => {
    await update({ a: { keywords: { $seen: true } } });
    expect((await boxes()).inbox).toEqual([2, 0]);
    await update({ b: { mailboxIds: { trash: true } } });
    expect(await boxes()).toMatchObject({ inbox: [1, 0], trash: [2, 0] });
  });

  it('deletes for good right away, from lists, threads and counts', async () => {
    const answer = await set({ destroy: ['a'] });
    expect(answer?.methodResponses[0][1].destroyed).toEqual(['a']);
    expect(await boxes()).toMatchObject({ inbox: [1, 0] });
    const check = await t.engine.answer([
      ['Email/get', { ids: ['a'], properties: ['id'] }, 'g'],
      ['Thread/get', { ids: ['t1'] }, 't'],
    ]);
    expect(check?.methodResponses[0][1].notFound).toEqual(['a']);
    expect(check?.methodResponses[1][1].list).toEqual([{ id: 't1', emailIds: ['b'] }]);
    expect((await pending()).map((row) => row.op)).toEqual(['destroy']);
  });

  it('empties a folder through the back-reference the client sends', async () => {
    const answer = await t.engine.answer([
      ['Email/query', { filter: { inMailbox: 'trash' }, limit: 500 }, '0'],
      ['Email/set', { '#destroy': { resultOf: '0', name: 'Email/query', path: '/ids' } }, '1'],
    ]);
    expect(answer?.methodResponses[1][1].destroyed).toEqual(['c']);
    expect((await boxes()).trash).toEqual([0, 0]);
    const again = await t.engine.answer([['Email/query', { filter: { inMailbox: 'trash' } }, '0']]);
    expect(again?.methodResponses[0][1].ids).toEqual([]);
    await flush();
    expect(t.server.emails.has('c')).toBe(false);
    expect(await pending()).toEqual([]);
  });

  it('a change to a message waiting to be deleted is not found', async () => {
    await set({ destroy: ['a'] });
    const answer = await update({ a: { 'keywords/$seen': true } });
    expect(answer?.methodResponses[0][1].notUpdated.a.type).toBe('notFound');
    expect((await pending())[0].op).toBe('destroy');
  });
});

describe('sync and waiting changes', () => {
  it('reapplies a waiting change over what the server sends', async () => {
    await update({ a: { 'keywords/$flagged': true } });
    t.server.updateEmail('a', { subject: 'Renamed', keywords: { $seen: true } });
    await t.engine.requestSync();
    expect(await local('a')).toMatchObject({ subject: 'Renamed', keywords: { $seen: true, $flagged: true } });
    expect(await pending()).toHaveLength(1);
  });

  it('survives a full resync, and keeps a pending delete away', async () => {
    await update({ a: { 'keywords/$flagged': true } });
    await set({ destroy: ['b'] });
    t.server.truncateLog('Email');
    t.server.addEmail({ id: 'new' });
    await t.engine.requestSync();
    expect((await local('a')).keywords).toEqual({ $flagged: true });
    expect(await local('b')).toBeUndefined();
    expect(await local('new')).toBeTruthy();
  });

  it('doesn\'t bring back a message waiting to be deleted when the server changes it', async () => {
    await set({ destroy: ['a'] });
    t.server.updateEmail('a', { keywords: { $flagged: true } });
    await t.engine.requestSync();
    expect(await local('a')).toBeUndefined();
  });

  it('follows the server\'s new counts without counting a waiting change twice', async () => {
    await update({ a: { 'keywords/$seen': true } });
    expect((await boxes()).inbox).toEqual([2, 0]);
    t.server.mailboxes.get('inbox')!.totalEmails = 3;
    t.server.mailboxes.get('inbox')!.unreadEmails = 2;
    t.server.coll.Mailbox.push('updated', 'inbox');
    t.server.addEmail({ id: 'new', keywords: {} });
    await t.engine.requestSync();
    expect((await boxes()).inbox).toEqual([3, 1]);
  });

  it('drops the patch once the server took it, and the next run brings the truth', async () => {
    await update({ a: { 'keywords/$seen': true } });
    const { outcomes, finished } = await flush();
    expect(finished).toBe(true);
    expect(outcomes).toEqual([expect.objectContaining({ recordId: 'a', outcome: 'done' })]);
    expect(await pending()).toEqual([]);
    expect((t.server.emails.get('a') as FakeEmail).keywords).toEqual({ $seen: true });
    t.server.updateEmail('a', { keywords: { $seen: true, $answered: true } });
    await t.engine.requestSync();
    expect((await local('a')).keywords).toEqual({ $seen: true, $answered: true });
  });
});

describe('conflicts', () => {
  it('holds back a change to what the server changed since, and shows the server\'s state', async () => {
    await update({ a: { 'keywords/$flagged': true } });
    t.server.updateEmail('a', { keywords: { $flagged: true, $seen: true } });
    // The same outcome as wanted: not a conflict.
    let run = await flush();
    expect(run.outcomes[0]).toMatchObject({ outcome: 'done' });

    await update({ b: { 'keywords/$seen': null } });
    t.server.updateEmail('b', { keywords: { $seen: true, $flagged: true } });
    // Another keyword moved: this one still stands.
    run = await flush();
    expect(run.outcomes[0]).toMatchObject({ outcome: 'done' });

    await update({ c: { 'mailboxIds/trash': null, 'mailboxIds/inbox': true } });
    t.server.updateEmail('c', { mailboxIds: { sent: true } });
    run = await flush();
    expect(run.outcomes[0]).toMatchObject({ outcome: 'conflict', reason: 'changed' });
    const { conflicts, patches } = await read();
    expect(patches).toBe(0);
    expect(conflicts).toEqual([expect.objectContaining({ recordId: 'c', jmap: JMAP_ACCOUNT, summary: { subject: 'Sea', op: 'update', reason: 'changed' } })]);
    expect((t.server.emails.get('c') as FakeEmail).mailboxIds).toEqual({ sent: true });
    expect((await local('c')).mailboxIds).toEqual({ sent: true });
  });

  it('never sends a conflicting change, and sends the rest of the batch', async () => {
    await update({ a: { 'mailboxIds/inbox': null, 'mailboxIds/trash': true }, b: { 'keywords/$flagged': true } });
    t.server.updateEmail('a', { mailboxIds: { sent: true } });
    await flush();
    expect((t.server.emails.get('a') as FakeEmail).mailboxIds).toEqual({ sent: true });
    expect((t.server.emails.get('b') as FakeEmail).keywords).toEqual({ $seen: true, $flagged: true });
  });

  it('shows what the server refused', async () => {
    await update({ a: { 'keywords/$flagged': true } });
    t.server.refuse.set('a', { type: 'forbidden', description: 'Read only' });
    await flush();
    const { conflicts } = await read();
    expect(conflicts[0].summary).toEqual({ subject: 'Aye', op: 'update', reason: 'refused', detail: 'Read only' });
    expect((await local('a')).keywords).toEqual({});
    await t.engine.areaCall('outbox.dismissConflict', { id: conflicts[0].id });
    expect((await read()).conflicts).toEqual([]);
  });

  it('shows a change to a message gone from the server, and removes the local copy', async () => {
    await update({ a: { 'keywords/$flagged': true } });
    t.server.destroyEmail('a');
    await flush();
    expect((await read()).conflicts[0].summary).toMatchObject({ reason: 'gone', subject: 'Aye' });
    expect(await local('a')).toBeUndefined();
  });

  it('a delete of what\'s already gone is simply done', async () => {
    await set({ destroy: ['a'] });
    t.server.destroyEmail('a');
    const { outcomes } = await flush();
    expect(outcomes[0]).toMatchObject({ outcome: 'done' });
    expect((await read()).conflicts).toEqual([]);
  });

  it('holds back a delete of what changed on the server, and the message comes back', async () => {
    await set({ destroy: ['a'] });
    t.server.updateEmail('a', { keywords: { $flagged: true } });
    await t.engine.requestSync();
    await flush();
    expect(t.server.emails.has('a')).toBe(true);
    expect((await read()).conflicts[0].summary).toMatchObject({ op: 'destroy', reason: 'changed' });
    expect((await local('a')).keywords).toEqual({ $flagged: true });
  });

  it('shows a refused delete', async () => {
    await set({ destroy: ['a'] });
    t.server.refuse.set('a', { type: 'forbidden' });
    await flush();
    expect((await read()).conflicts[0].summary).toMatchObject({ op: 'destroy', reason: 'refused', detail: 'forbidden' });
    expect((await local('a'))?.subject).toBe('Aye');
  });

  it('compares per property, ignoring case in keyword names', () => {
    const base = { keywords: { '$Label:A': true }, mailboxIds: { x: true } };
    expect(patchConflicts({ 'keywords/$label:a': null }, base, { keywords: { '$label:a': true }, mailboxIds: { x: true } })).toBe(false);
    expect(patchConflicts({ 'keywords/$seen': true }, base, { keywords: {}, mailboxIds: { x: true } })).toBe(false);
    expect(patchConflicts({ keywords: { $seen: true } }, base, { keywords: {}, mailboxIds: { x: true } })).toBe(true);
    expect(patchConflicts({ keywords: { $seen: true } }, base, { keywords: { $seen: true }, mailboxIds: { x: true } })).toBe(false);
    expect(patchConflicts({ keywords: { $seen: true } }, null, { keywords: {}, mailboxIds: {} })).toBe(false);
  });
});

describe('when the server can\'t be reached during a flush', () => {
  it('stops and keeps every change, without calling anything a conflict', async () => {
    await update({ a: { 'keywords/$seen': true } });
    t.server.offline = true;
    const { outcomes, finished } = await flush();
    expect(finished).toBe(false);
    expect(outcomes).toEqual([]);
    expect(await pending()).toHaveLength(1);
    expect((await read()).conflicts).toEqual([]);
    expect((await local('a')).keywords).toEqual({ $seen: true });
  });

  it('stops on "not now" from the server too', async () => {
    await update({ a: { 'keywords/$seen': true } });
    t.server.failNext.set('Email/set', 'serverUnavailable');
    const { finished } = await flush();
    expect(finished).toBe(false);
    expect(await pending()).toHaveLength(1);
  });

  it('turns a request the server refuses for good into a conflict, not a stuck queue', async () => {
    await update({ a: { 'keywords/$seen': true } });
    const refusing = {
      request: async () => { throw new Error('Request failed: 400 - bad'); },
      isRefusal: (error: unknown) => /^Request failed: 400/.test((error as Error).message),
    };
    const { outcomes, finished } = await flush(refusing);
    expect(finished).toBe(true);
    expect(outcomes[0]).toMatchObject({ outcome: 'conflict', reason: 'refused' });
    expect(await pending()).toEqual([]);
  });

  it('keeps a change made while the flush ran, and doesn\'t compare it with the state the flush caused', async () => {
    await update({ a: { 'keywords/$seen': true } });
    const rows = await pending();
    await update({ a: { 'keywords/$flagged': true } });
    await flushPatches(io(), rows, async (batch) => { await t.engine.areaCall('outbox.patchResults', { outcomes: batch }); });
    const left = await pending();
    expect(left).toHaveLength(1);
    expect(left[0].base).toBeNull();
    await flush();
    expect((t.server.emails.get('a') as FakeEmail).keywords).toEqual({ $seen: true, $flagged: true });
    expect((await read()).conflicts).toEqual([]);
  });
});

describe('sends', () => {
  const summary = { subject: 'S', to: ['b@example.org'] };
  const item = { kind: 'email', args: [['b@example.org'], 'S', 'x'] };

  it('takes an entry for sending once: a second claim loses', async () => {
    const id = await t.engine.areaCall('outbox.queueSend', { summary, item, messageId: 'fixed@example.org' }) as number;
    expect(await t.engine.areaCall('outbox.claim', { id })).toBe(true);
    expect(await t.engine.areaCall('outbox.claim', { id })).toBe(false);
    const entry = (await read()).entries[0];
    expect(entry).toMatchObject({ status: 'sending', sendingSince: NOW, firstAttemptAt: NOW, messageId: 'fixed@example.org', item });
  });

  it('marks what a closed tab left behind uncertain', async () => {
    const id = await t.engine.areaCall('outbox.queueSend', { summary, item }) as number;
    await t.engine.areaCall('outbox.claim', { id });
    await t.engine.areaCall('outbox.settleStale', { before: NOW });
    expect((await read()).entries[0].status).toBe('sending');
    await t.engine.areaCall('outbox.settleStale', { before: NOW + 1 });
    expect((await read()).entries[0].status).toBe('uncertain');
  });

  it('keeps the first attempt time across retries, so the lookup covers the first copy', async () => {
    const id = await t.engine.areaCall('outbox.queueSend', { summary, item }) as number;
    await t.engine.areaCall('outbox.claim', { id });
    await t.engine.areaCall('outbox.update', { id, status: 'waiting' });
    await t.engine.areaCall('outbox.claim', { id });
    expect((await read()).entries[0].firstAttemptAt).toBe(NOW);
  });

  it('keeps order across changes and sends, and a later merge moves a change later', async () => {
    await update({ a: { 'keywords/$seen': true } });
    await t.engine.areaCall('outbox.queueSend', { summary, item });
    await update({ b: { 'keywords/$flagged': true } });
    const { entries } = await read();
    const before = await t.engine.areaCall('outbox.pendingPatches', { upToSeq: entries[0].seq }) as PendingPatch[];
    expect(before.map((row) => row.recordId)).toEqual(['a']);
    await update({ a: { 'keywords/$flagged': true } });
    expect(await t.engine.areaCall('outbox.pendingPatches', { upToSeq: entries[0].seq })).toEqual([]);
  });

  it('removes the files of a removed entry, and keeps an update from bringing a deleted one back', async () => {
    const data = new TextEncoder().encode('hello');
    const held = await t.engine.areaCall('outbox.holdFile', { name: 'note.txt', type: 'text/plain', data }) as { blobId: string; size: number };
    expect(held).toMatchObject({ size: 5, type: 'text/plain' });
    expect(held.blobId).toMatch(/^bulwark-local-/);
    const file = await t.engine.areaCall('outbox.heldFile', { blobId: held.blobId }) as { name: string; blob: Blob };
    expect(file.name).toBe('note.txt');
    expect(await file.blob.text()).toBe('hello');
    const id = await t.engine.areaCall('outbox.queueSend', { summary, item: { kind: 'raw', blobId: held.blobId, identityId: 'i' } }) as number;
    await t.engine.areaCall('outbox.remove', { id });
    expect(await t.engine.areaCall('outbox.heldFile', { blobId: held.blobId })).toBeNull();
    await t.engine.areaCall('outbox.update', { id, status: 'failed' });
    expect((await read()).entries).toEqual([]);
  });

  it('drops old files nothing needs', async () => {
    const data = new Uint8Array([1]);
    const orphan = await t.engine.areaCall('outbox.holdFile', { name: 'a', type: '', data }) as { blobId: string };
    const used = await t.engine.areaCall('outbox.holdFile', { name: 'b', type: '', data }) as { blobId: string };
    await t.engine.areaCall('outbox.queueSend', { summary, item: { kind: 'email', args: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, [{ blobId: used.blobId }]] } });
    expect(await t.engine.areaCall('outbox.dropOrphans', { olderThan: NOW })).toBe(0);
    expect(await t.engine.areaCall('outbox.dropOrphans', { olderThan: NOW + 1 })).toBe(1);
    expect(await t.engine.areaCall('outbox.heldFile', { blobId: orphan.blobId })).toBeNull();
    expect(await t.engine.areaCall('outbox.heldFile', { blobId: used.blobId })).not.toBeNull();
  });
});

describe('looking a send up before it goes again', () => {
  const MESSAGE_ID = 'k3x.11111111@example.org';
  const args = (over: Partial<LookupArgs> = {}): LookupArgs => ({
    jmap: JMAP_ACCOUNT,
    submissionJmap: JMAP_ACCOUNT,
    messageId: MESSAGE_ID,
    attemptAt: NOW - 60_000,
    now: NOW,
    copyKept: true,
    ...over,
  });

  function server() {
    return new FakeJmapMail({ mailboxes: BOXES.map((box) => ({ ...box })) });
  }

  const inDrafts = (s: FakeJmapMail, over: Partial<FakeEmail> = {}) => s.addEmail({
    id: 'copy',
    messageId: [MESSAGE_ID],
    mailboxIds: { drafts: true },
    keywords: { $seen: true, $draft: true },
    receivedAt: new Date(NOW - 30_000).toISOString(),
    ...over,
  });

  // The five cases of decision 4.
  it('request never arrived: send again', async () => {
    const s = server();
    // A message from before, and another with its own id.
    s.addEmail({ id: 'other', messageId: ['other@example.org'], mailboxIds: { sent: true }, receivedAt: new Date(NOW - 10_000).toISOString() });
    expect(await decideRetry(io(s), args())).toEqual({ action: 'send' });
  });

  it('draft arrived, submission didn\'t: submit that copy, don\'t create another', async () => {
    const s = server();
    inDrafts(s);
    expect(await decideRetry(io(s), args())).toEqual({ action: 'submit', emailId: 'copy' });
  });

  it('both arrived: done', async () => {
    const s = server();
    inDrafts(s, { mailboxIds: { sent: true }, keywords: { $seen: true } });
    s.addSubmission('copy', 'final');
    expect(await decideRetry(io(s), args())).toEqual({ action: 'done', emailId: 'copy', why: 'sent' });
    // A record Stalwart already removed doesn't change that.
    s.submissions.clear();
    expect(await decideRetry(io(s), args())).toEqual({ action: 'done', emailId: 'copy', why: 'sent' });
  });

  it('scheduled and waiting: done, leave it', async () => {
    const s = server();
    inDrafts(s);
    s.addSubmission('copy', 'pending');
    expect(await decideRetry(io(s), args())).toEqual({ action: 'done', emailId: 'copy', why: 'scheduled' });
  });

  it('canceled: someone decided against it, so it doesn\'t go', async () => {
    const s = server();
    inDrafts(s);
    s.addSubmission('copy', 'canceled');
    expect(await decideRetry(io(s), args())).toEqual({ action: 'done', emailId: 'copy', why: 'canceled' });
  });

  it('never uses a header or text filter, which find nothing on either version', async () => {
    const s = server();
    inDrafts(s, { mailboxIds: { sent: true }, keywords: {} });
    await decideRetry(io(s), args());
    const filters = JSON.stringify(s.calls.filter(([name]) => name === 'Email/query').map(([, a]) => a.filter));
    expect(filters).not.toMatch(/header|text/);
    expect(filters).toMatch(/inMailbox/);
  });

  it('finds a copy whose server time is behind this device\'s clock, within the margin', async () => {
    const s = server();
    const skew = CLOCK_SKEW_MARGIN_MS - 60_000;
    inDrafts(s, { receivedAt: new Date(NOW - 60_000 - skew).toISOString() });
    expect((await decideRetry(io(s), args())).action).toBe('submit');
  });

  it('matches with or without angle brackets', async () => {
    const s = server();
    inDrafts(s);
    expect((await decideRetry(io(s), args({ messageId: `<${MESSAGE_ID}>` }))).action).toBe('submit');
  });

  it('can\'t tell without a Message-ID (a send from before they were fixed)', async () => {
    expect(await decideRetry(io(server()), args({ messageId: undefined }))).toEqual({ action: 'undecided', why: 'no-message-id' });
  });

  it('can\'t tell without the folders', async () => {
    const s = new FakeJmapMail();
    expect(await decideRetry(io(s), args())).toEqual({ action: 'undecided', why: 'no-folders' });
  });

  it('can\'t tell when nothing stays after a good send, and nothing is found', async () => {
    expect(await decideRetry(io(server()), args({ copyKept: false }))).toEqual({ action: 'undecided', why: 'no-copy-kept' });
  });

  it('can\'t tell once the server may have forgotten the submission', async () => {
    const old = args({ attemptAt: NOW - LOOKUP_TRUSTED_MS - 1000 });
    expect(await decideRetry(io(server()), old)).toEqual({ action: 'undecided', why: 'too-old' });
    const s = server();
    inDrafts(s, { receivedAt: new Date(old.attemptAt).toISOString() });
    expect(await decideRetry(io(s), old)).toEqual({ action: 'undecided', why: 'too-old' });
  });

  it('can\'t tell when more mail arrived than it reads, unless the copy is among it', async () => {
    const s = server();
    for (let i = 0; i < 2500; i += 1) s.addEmail({ mailboxIds: { sent: true }, receivedAt: new Date(NOW - 1000).toISOString() });
    expect(await decideRetry(io(s), args())).toEqual({ action: 'undecided', why: 'too-many' });
  }, 30_000);

  it('lets a failed lookup fail, so the caller leaves the entry alone', async () => {
    const s = server();
    s.offline = true;
    await expect(decideRetry(io(s), args())).rejects.toBeInstanceOf(TransportError);
  });
});

describe('moving the old outbox in', () => {
  const legacy = {
    entries: [
      { summary: { subject: 'Old', to: [] }, item: { kind: 'email', args: [] }, status: 'uncertain', createdAt: 5 },
      { summary: { subject: 'Older file', to: [] }, item: { kind: 'raw', blobId: 'bulwark-local-x', identityId: 'i' }, status: 'waiting', createdAt: 6 },
    ],
    patches: [{ jmap: JMAP_ACCOUNT, update: { a: { 'keywords/$seen': true } } }],
    files: [{ blobId: 'bulwark-local-x', name: 'x.eml', type: 'message/rfc822', data: new Uint8Array([1, 2]) }],
  };

  it('takes all of it once, keeping stand-in ids and order', async () => {
    expect(await t.engine.areaCall('outbox.importLegacy', legacy)).toBe(true);
    expect(await t.engine.areaCall('outbox.importLegacy', legacy)).toBe(false);
    const { entries, patches } = await read();
    expect(entries.map((e) => [e.summary.subject, e.status, e.createdAt])).toEqual([['Old', 'uncertain', 5], ['Older file', 'waiting', 6]]);
    expect(patches).toBe(1);
    expect(await t.engine.areaCall('outbox.heldFile', { blobId: 'bulwark-local-x' })).toMatchObject({ name: 'x.eml' });
    expect((await local('a')).keywords).toEqual({ $seen: true });
  });

  it('takes nothing when a part of it fails, and can run again', async () => {
    const broken = { ...legacy, files: [{ blobId: 'x', name: null, type: null, data: null }] };
    await expect(t.engine.areaCall('outbox.importLegacy', broken)).rejects.toThrow();
    expect((await read()).entries).toEqual([]);
    expect(await pending()).toEqual([]);
    expect(await t.engine.areaCall('outbox.importLegacy', legacy)).toBe(true);
  });
});
