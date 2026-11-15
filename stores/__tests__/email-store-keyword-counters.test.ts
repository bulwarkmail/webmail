import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '../settings-store';
import { useToastStore } from '../toast-store';
import { emailKeyFor } from '@/lib/thread-utils';
import { undoKeywordAction } from '@/lib/email-action-toast';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

const initial = useEmailStore.getInitialState();
const folder = (id: string, unread = 2, extra: Partial<Mailbox> = {}) => ({
  id, name: id, totalEmails: 9, totalThreads: 8, unreadEmails: unread, unreadThreads: unread, ...extra,
}) as Mailbox;
const mail = (id = 'same', extra: Partial<Email> = {}) => ({
  id, keywords: { $seen: true, '$label:work': true }, mailboxIds: { inbox: true }, ...extra,
}) as Email;
let client: IJMAPClient;
const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const counts = () => ({ mailboxes: useEmailStore.getState().mailboxes, accountMailboxes: useEmailStore.getState().accountMailboxes });
const expectCount = (box: Mailbox, unread: number) => expect(box).toMatchObject({
  totalEmails: 9, totalThreads: 8, unreadEmails: unread, unreadThreads: unread,
});

beforeEach(() => {
  client = { getAccountId: () => 'owner-a', batchUpdateKeywords: vi.fn().mockResolvedValue(undefined) } as unknown as IJMAPClient;
  useAuthStore.setState({ client, activeAccountId: 'login-a', getClientForAccount: (() => client) as never });
  useEmailStore.setState(initial, true);
  useEmailStore.setState({ emails: [mail()], mailboxes: [folder('inbox')], selectedMailbox: 'inbox' });
  useSettingsStore.setState({ emailKeywords: [{ id: 'work', label: 'Work', color: 'blue' }] } as never);
  useEmailStore.setState({ tagCounts: { work: { total: 9, unread: 2 } } });
  useToastStore.setState({ toasts: [] });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network'); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('uses the keyed message and its folders in accountMailboxes, leaving active namesakes alone', () => {
  const own = mail('same', { sourceClientAccountId: 'login-a', sourceAccountId: 'owner-a' });
  const other = mail('same', { sourceClientAccountId: 'login-b', sourceAccountId: 'owner-b', mailboxIds: { inbox: true, archive: true } });
  useEmailStore.setState({
    emails: [own, other], selectedEmail: own,
    accountMailboxes: { 'login-b': [folder('inbox', 4), folder('archive', 3), folder('elsewhere', 7)] },
  });
  const before = counts();
  const restore = () => useEmailStore.getState().setEmailKeywordsLocal('same', { ...other.keywords, $seen: false }, emailKeyFor(other));
  restore();
  expect(useEmailStore.getState().mailboxes).toBe(before.mailboxes);
  expectCount(useEmailStore.getState().accountMailboxes['login-b'][0], 5);
  expectCount(useEmailStore.getState().accountMailboxes['login-b'][1], 4);
  expectCount(useEmailStore.getState().accountMailboxes['login-b'][2], 7);
  expect(useEmailStore.getState().selectedEmail).toBe(own);
  expect(useEmailStore.getState().emails[0]).toBe(own);
  // A repeated confirmed state must not apply another delta.
  const after = counts(); restore(); expect(counts()).toEqual(after);
});

it('keeps a shared owner separate from the reaching login and another shared namesake', () => {
  const target = mail('same', { sourceClientAccountId: 'login-a', sourceAccountId: 'shared-x', mailboxIds: { 'shared-x:inbox': true } });
  const namesake = mail('same', { sourceClientAccountId: 'login-a', sourceAccountId: 'shared-y', mailboxIds: { 'shared-y:inbox': true } });
  useEmailStore.setState({ emails: [namesake, target], selectedEmail: namesake, mailboxes: [
    folder('inbox'), folder('shared-x:inbox', 4, { isShared: true, accountId: 'shared-x', originalId: 'inbox' }),
    folder('shared-y:inbox', 5, { isShared: true, accountId: 'shared-y', originalId: 'inbox' }),
  ] });
  useEmailStore.getState().setEmailKeywordsLocal('same', { ...target.keywords, $seen: false }, emailKeyFor(target));
  const boxes = useEmailStore.getState().mailboxes;
  expectCount(boxes[0], 2); expectCount(boxes[1], 5); expectCount(boxes[2], 5);
  expect(useEmailStore.getState().selectedEmail).toBe(namesake);
});

it('uses a matching reader when the message is not listed', () => {
  const reader = mail('reader', { mailboxIds: { archive: true } });
  useEmailStore.setState({ emails: [], selectedEmail: reader, mailboxes: [folder('inbox'), folder('archive', 4)] });
  useEmailStore.getState().setEmailKeywordsLocal('reader', { ...reader.keywords, $seen: false }, 'reader');
  expectCount(useEmailStore.getState().mailboxes[0], 2);
  expectCount(useEmailStore.getState().mailboxes[1], 5);
  expect(useEmailStore.getState().selectedEmail?.keywords.$seen).toBe(false);
});

it('routes an unstamped row of the viewed login to that login’s cached folders', () => {
  useEmailStore.setState({ viewingAccountId: 'login-b', accountMailboxes: { 'login-b': [folder('inbox', 4)] } });
  useEmailStore.getState().setEmailKeywordsLocal('same', { $seen: false }, 'same');
  expectCount(useEmailStore.getState().mailboxes[0], 2);
  expectCount(useEmailStore.getState().accountMailboxes['login-b'][0], 5);
});

it('does not infer a missing message’s read state or membership from an unrelated reader', () => {
  useEmailStore.setState({ emails: [], selectedEmail: mail('unrelated') });
  const before = counts(); const tags = useEmailStore.getState().tagCounts;
  useEmailStore.getState().setEmailKeywordsLocal('missing', { $seen: false, '$label:work': true }, 'missing');
  expect(counts()).toEqual(before);
  expect(useEmailStore.getState().tagCounts).toEqual(tags);
  expect(useEmailStore.getState().selectedEmail?.id).toBe('unrelated');
});

it('leaves folder counters unchanged for unchanged seen, tag-only and star-only patches', async () => {
  const before = counts();
  await useEmailStore.getState().patchEmailKeywords(client, 'same', { $seen: true });
  await useEmailStore.getState().patchEmailKeywords(client, 'same', { $flagged: true });
  await useEmailStore.getState().patchEmailKeywords(client, 'same', { '$label:other': true });
  expect(counts()).toEqual(before);
  expect(useEmailStore.getState().emails[0].keywords).toEqual({ $seen: true, '$label:work': true, $flagged: true, '$label:other': true });
});

it.each([{ refused: ['a'] }, { refused: ['a', 'b'] }])('adjusts only confirmed restorations when the server refuses $refused', async ({ refused }) => {
  const pending = { a: deferred(), b: deferred() };
  vi.mocked(client.batchUpdateKeywords).mockImplementation(ids => pending[ids[0] as 'a' | 'b'].promise);
  useEmailStore.setState({ emails: [mail('a'), mail('b')], selectedEmail: mail('a') });
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  const undo = undoKeywordAction(client, ['a', 'b'].map(id => ({ id, key: id, changes: { $seen: false } })),
    { undo: 'Undo', done: 'Done', failed: 'Failed', undone: 'Undone' });
  undo!.onClick();
  expectCount(useEmailStore.getState().mailboxes[0], 2);
  for (const id of ['a', 'b'] as const) {
    if (refused.includes(id)) pending[id].reject(new Error('Synthetic refusal'));
    else pending[id].resolve();
  }
  await vi.waitFor(() => expect(useToastStore.getState().toasts.at(-1)?.title).toBe('Failed'));
  const succeeded = 2 - refused.length;
  expectCount(useEmailStore.getState().mailboxes[0], 2 + succeeded);
  expect(useEmailStore.getState().tagCounts.work.unread).toBe(2 + succeeded);
  for (const row of useEmailStore.getState().emails) expect(!!row.keywords.$seen).toBe(refused.includes(row.id));
  expect(consoleError).toHaveBeenCalledTimes(1);
  expect(client.batchUpdateKeywords).toHaveBeenCalledWith(['a'], { 'keywords/$seen': null }, undefined);
  expect(client.batchUpdateKeywords).toHaveBeenCalledWith(['b'], { 'keywords/$seen': null }, undefined);
});
