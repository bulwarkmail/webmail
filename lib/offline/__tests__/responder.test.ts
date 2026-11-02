import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { answerOffline, type ResponderContext } from '../responder';
import { emailIndex, emailKey, forgetIndexes, putEmails, putMisc } from '../cache';
import { forgetDeviceKey } from '../crypto';
import { allowOfflineDbCreation, deleteOfflineDb } from '../db';

const day = 24 * 60 * 60 * 1000;
const at = (ageDays: number) => new Date(Date.now() - ageDays * day).toISOString();

let queued: Array<{ jmap: string; update: Record<string, Record<string, unknown>> }>;
let refused: string[];
const ctx: ResponderContext = {
  account: 'acc',
  defaultJmap: 'j1',
  queuePatch: async (jmap, update) => { queued.push({ jmap, update }); },
  onRefused: (what) => { refused.push(what); },
};

beforeEach(async () => {
  forgetIndexes();
  forgetDeviceKey();
  await deleteOfflineDb();
  allowOfflineDbCreation();
  queued = [];
  refused = [];
  await putEmails('acc', 'j1', [
    { id: 'a', threadId: 't1', mailboxIds: { inbox: true }, keywords: {}, receivedAt: at(3), subject: 'Older', bodyValues: { 1: { value: 'Body A' } }, textBody: [{ partId: '1' }] },
    { id: 'b', threadId: 't1', mailboxIds: { inbox: true }, keywords: { $flagged: true }, receivedAt: at(1), subject: 'Newer' },
    { id: 'c', threadId: 't2', mailboxIds: { archive: true }, keywords: {}, receivedAt: at(2), subject: 'Archived' },
  ]);
  await putMisc('acc', 'mailboxes', { j1: [
    { id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 2, unreadEmails: 1 },
    { id: 'archive', name: 'Archive', role: 'archive', totalEmails: 1, unreadEmails: 1 },
  ] });
});

describe('answering a folder list offline', () => {
  it('answers the list request the client makes, back-references included', async () => {
    const response = await answerOffline(ctx, [
      ['Email/query', { accountId: 'j1', filter: { inMailbox: 'inbox' }, sort: [{ property: 'receivedAt', isAscending: false }], limit: 50, position: 0, calculateTotal: true }, '0'],
      ['Email/get', { accountId: 'j1', '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['id', 'threadId', 'subject', 'keywords'] }, '1'],
      ['Thread/get', { accountId: 'j1', '#ids': { resultOf: '1', name: 'Email/get', path: '/list/*/threadId' } }, '2'],
    ]);
    expect(response).not.toBeNull();
    const [query, get, thread] = response!.methodResponses;
    expect(query[1].ids).toEqual(['b', 'a']);
    expect(query[1].total).toBe(2);
    expect(get[1].list).toEqual([
      { id: 'b', threadId: 't1', subject: 'Newer', keywords: { $flagged: true } },
      { id: 'a', threadId: 't1', subject: 'Older', keywords: {} },
    ]);
    expect(thread[1].list).toEqual([{ id: 't1', emailIds: ['a', 'b'] }]);
  });

  it('pins flagged mail first when the list sorts that way', async () => {
    const response = await answerOffline(ctx, [
      ['Email/query', { filter: { inMailbox: 'inbox' }, sort: [{ property: 'receivedAt', isAscending: true }] }, '0'],
    ]);
    expect(response!.methodResponses[0][1].ids).toEqual(['a', 'b']);
    const pinned = await answerOffline(ctx, [
      ['Email/query', { filter: { inMailbox: 'inbox' }, sort: [{ property: 'hasKeyword', keyword: '$flagged', isAscending: false }, { property: 'receivedAt', isAscending: true }] }, '0'],
    ]);
    expect(pinned!.methodResponses[0][1].ids).toEqual(['b', 'a']);
  });

  it('opens a kept message with its body and refuses one without', async () => {
    const full = { properties: ['id', 'subject', 'bodyValues', 'textBody'], fetchTextBodyValues: true };
    const response = await answerOffline(ctx, [['Email/get', { ids: ['a', 'b'], ...full }, '0']]);
    const result = response!.methodResponses[0][1];
    expect(result.list).toEqual([{ id: 'a', subject: 'Older', bodyValues: { 1: { value: 'Body A' } }, textBody: [{ partId: '1' }] }]);
    expect(result.notFound).toEqual(['b']);
  });

  it('answers the folder list', async () => {
    const response = await answerOffline(ctx, [['Mailbox/get', { accountId: 'j1' }, '0']]);
    expect(response!.methodResponses[0][1].list.map((m: { id: string }) => m.id)).toEqual(['inbox', 'archive']);
  });

  it('leaves search to the server', async () => {
    expect(await answerOffline(ctx, [['Email/query', { filter: { text: 'invoice' } }, '0']])).toBeNull();
    expect(await answerOffline(ctx, [['SearchSnippet/get', {}, '0']])).toBeNull();
  });
});

describe('changes made offline', () => {
  it('queues read, flag and move, and shows them at once', async () => {
    const response = await answerOffline(ctx, [
      ['Email/set', { accountId: 'j1', update: { a: { 'keywords/$seen': true, 'keywords/$flagged': true }, c: { 'mailboxIds/archive': null, 'mailboxIds/inbox': true } } }, '0'],
    ]);
    expect(response!.methodResponses[0][1].updated).toEqual({ a: null, c: null });
    expect(queued).toEqual([{ jmap: 'j1', update: { a: { 'keywords/$seen': true, 'keywords/$flagged': true }, c: { 'mailboxIds/archive': null, 'mailboxIds/inbox': true } } }]);
    const index = await emailIndex('acc');
    expect(index.get(emailKey('acc', 'j1', 'a'))?.keywords).toEqual({ $seen: true, $flagged: true });
    const inbox = await answerOffline(ctx, [['Email/query', { filter: { inMailbox: 'inbox' } }, '0']]);
    expect(inbox!.methodResponses[0][1].ids).toEqual(['b', 'c', 'a']);
  });

  it('keeps the folder counts in step', async () => {
    await answerOffline(ctx, [['Email/set', { update: { a: { 'keywords/$seen': true }, c: { 'mailboxIds/archive': null, 'mailboxIds/inbox': true } } }, '0']]);
    const boxes = (await answerOffline(ctx, [['Mailbox/get', {}, '0']]))!.methodResponses[0][1].list;
    expect(boxes.find((b: { id: string }) => b.id === 'inbox')).toMatchObject({ totalEmails: 3, unreadEmails: 1 });
    expect(boxes.find((b: { id: string }) => b.id === 'archive')).toMatchObject({ totalEmails: 0, unreadEmails: 0 });
  });

  it('refuses deleting for good and emptying a folder', async () => {
    expect(await answerOffline(ctx, [['Email/set', { destroy: ['a'] }, '0']])).toBeNull();
    expect(await answerOffline(ctx, [['Email/set', { update: { a: { mailboxIds: {} } } }, '0']])).toBeNull();
    expect(await answerOffline(ctx, [['Email/set', { update: { c: { 'mailboxIds/archive': null } } }, '0']])).toBeNull();
    expect(refused).toEqual(['destroy', 'destroy', 'destroy']);
    expect(queued).toEqual([]);
    expect((await emailIndex('acc')).size).toBe(3);
  });

  it('refuses other changes and new messages without queueing', async () => {
    const onRefused = vi.fn();
    expect(await answerOffline({ ...ctx, onRefused }, [['Email/set', { update: { a: { subject: 'x' } } }, '0']])).toBeNull();
    expect(await answerOffline({ ...ctx, onRefused }, [['Email/set', { create: { d: { subject: 'draft' } } }, '0']])).toBeNull();
    expect(onRefused).toHaveBeenCalledTimes(1);
    expect(queued).toEqual([]);
  });
});
