import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '../settings-store';
import { clearAllHooks } from '@/lib/plugin-hooks';
import { emailKeyFor, threadKeyFor } from '@/lib/thread-utils';
import { clearAllStores } from '@/lib/account-state-manager';
import { currentStoreEpoch } from '@/lib/store-epoch';
import { jmapError } from '@/lib/jmap/jmap-error';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mail(id: string, read: boolean, login?: string, owner?: string): Email {
  return { id, threadId: `thread-${id}`, blobId: `blob-${id}`, subject: id,
    mailboxIds: { inbox: true }, keywords: { '$label:work': true, ...(read ? { $seen: true } : {}) },
    receivedAt: '2026-11-12T09:00:00Z', size: 42, hasAttachment: false,
    sourceClientAccountId: login, sourceAccountId: owner } as Email;
}
const makeClient = () => ({ getAccountId: () => 'owner', batchMarkAsRead: vi.fn<() => Promise<void>>() });
let client: ReturnType<typeof makeClient>;
let otherClient: ReturnType<typeof makeClient>;
const asClient = () => client as unknown as IJMAPClient;
function seed(read: boolean, scoped = false) {
  const a = mail('a', !read, scoped ? 'login' : undefined, scoped ? 'owner' : undefined);
  const b = mail('b', !read, scoped ? 'login' : undefined, scoped ? 'owner' : undefined);
  const rich = { ...a, preview: 'Loaded reader', keywords: { ...a.keywords, $answered: true },
    textBody: [{ partId: '1', blobId: 'body-1', size: 16, type: 'text/plain' }], bodyValues: { '1': { value: 'Reader body', isTruncated: false } } };
  useEmailStore.setState({ emails: [a, b], isUnifiedView: scoped, unifiedRole: scoped ? 'inbox' : null,
    mailboxes: [{ id: 'inbox', name: 'Inbox', role: 'inbox', totalEmails: 2, totalThreads: 2,
      unreadEmails: read ? 2 : 0, unreadThreads: read ? 2 : 0 } as Mailbox],
    tagCounts: { work: { total: 2, unread: read ? 2 : 0 } }, selectedMailbox: 'inbox',
    threadEmailsCache: new Map([[threadKeyFor(a), [a]], [threadKeyFor(b), [b]]]),
    selectedEmailKeys: new Set([emailKeyFor(a), emailKeyFor(b)]) });
  useEmailStore.getState().selectEmail(rich);
  return { a, b, rich };
}
function expectCounts(unread: number) {
  expect(useEmailStore.getState().mailboxes[0]).toMatchObject({ totalEmails: 2, totalThreads: 2, unreadEmails: unread, unreadThreads: unread });
  expect(useEmailStore.getState().tagCounts).toEqual({ work: { total: 2, unread } });
}
beforeEach(() => {
  clearAllHooks(); useEmailStore.setState(useEmailStore.getInitialState(), true);
  client = makeClient(); otherClient = makeClient();
  useAuthStore.setState({ client: asClient(), activeAccountId: 'login',
    getClientForAccount: ((id: string) => id === 'login' ? asClient() : otherClient as unknown as IJMAPClient) as never });
  useSettingsStore.setState({ emailKeywords: [{ id: 'work', label: 'Work', color: 'blue' }] } as never);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in bulk reader regressions'); }));
});
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); clearAllHooks(); });

for (const read of [true, false]) {
  it(`bulk read=${read} patches the current rich reader only after acceptance and keeps caches/counters`, async () => {
    const { a, b, rich } = seed(read, true);
    const service = deferred(); client.batchMarkAsRead.mockReturnValueOnce(service.promise);
    const running = useEmailStore.getState().batchMarkAsRead(asClient(), read);
    expect(useEmailStore.getState().selectedEmail).toBe(rich); expectCounts(read ? 2 : 0);
    // A fuller version of the same open message arrives before completion.
    const fuller = { ...rich, preview: 'More complete reader', bodyValues: { '1': { value: 'Latest body', isTruncated: false } } };
    useEmailStore.getState().selectEmail(fuller);
    service.resolve(); expect(await running).toBe(true);
    expect(useEmailStore.getState().selectedEmail).toEqual({ ...fuller, keywords: { ...fuller.keywords, $seen: read } });
    expectCounts(read ? 0 : 2);
    for (const row of [a, b]) expect(useEmailStore.getState().threadEmailsCache.get(threadKeyFor(row))?.[0].keywords.$seen).toBe(read);
    expect(useEmailStore.getState().selectedEmailKeys.size).toBe(0);
    expect(useEmailStore.getState().processingReadStatus.size).toBe(0);
    expect(useEmailStore.getState().error).toBeNull();
  });

  it(`leaves a refused selected reader unchanged for bulk read=${read}`, async () => {
    const { rich } = seed(read);
    const service = deferred(); client.batchMarkAsRead.mockReturnValueOnce(service.promise);
    const running = useEmailStore.getState().batchMarkAsRead(asClient(), read);
    const refused = jmapError('Refused a', { type: 'forbidden' }); refused.jmapFailedIds = ['a'];
    service.reject(refused); expect(await running).toBe(true);
    expect(useEmailStore.getState().selectedEmail).toBe(rich); expectCounts(1);
    expect(useEmailStore.getState().error).toBe('Refused a');
  });

  it.each(['unrelated', 'other owner', 'other login', 'unstamped namesake'])(`bulk read=${read} leaves %s reader alone`, async kind => {
    seed(read, true);
    const selected = kind === 'unrelated' ? mail('outside', !read, 'login', 'owner')
      : kind === 'other owner' ? mail('a', !read, 'login', 'other-owner')
        : kind === 'other login' ? mail('a', !read, 'other-login', 'owner') : mail('a', !read);
    useEmailStore.getState().selectEmail(selected);
    const service = deferred(); client.batchMarkAsRead.mockReturnValueOnce(service.promise);
    const running = useEmailStore.getState().batchMarkAsRead(asClient(), read);
    service.resolve(); await running;
    expect(useEmailStore.getState().selectedEmail).toBe(selected);
  });

  it(`bulk read=${read} does not restore an old reader after another message is opened`, async () => {
    seed(read);
    const service = deferred(); client.batchMarkAsRead.mockReturnValueOnce(service.promise);
    const running = useEmailStore.getState().batchMarkAsRead(asClient(), read);
    const outside = mail('outside', !read); useEmailStore.getState().selectEmail(outside);
    service.resolve(); await running;
    expect(useEmailStore.getState().selectedEmail).toBe(outside);
  });

  it.each(['same source', 'other owner', 'other login'])('targeted bulk completion checks reader source (%s)', async kind => {
    seed(read, true);
    const selected = mail('a', !read, kind === 'other login' ? 'other-login' : 'login', kind === 'other owner' ? 'other-owner' : 'owner');
    useEmailStore.getState().selectEmail(selected);
    const service = deferred(); client.batchMarkAsRead.mockReturnValueOnce(service.promise);
    const running = useEmailStore.getState().batchMarkAsRead(asClient(), read, { emailIds: ['a'], client: asClient(), accountId: 'owner' });
    service.resolve(); await running;
    if (kind === 'same source') expect(useEmailStore.getState().selectedEmail).toEqual({ ...selected, keywords: { ...selected.keywords, $seen: read } });
    else expect(useEmailStore.getState().selectedEmail).toBe(selected);
  });
}

it.each(['record', 'method', 'transport'])('preserves the reader, selection and counters after complete %s refusal/rejection', async kind => {
  const { rich } = seed(true);
  const service = deferred(); client.batchMarkAsRead.mockReturnValueOnce(service.promise);
  const running = useEmailStore.getState().batchMarkAsRead(asClient(), true);
  const error = kind === 'transport' ? new TypeError('Outcome unknown') : jmapError('Refused', { type: 'forbidden' });
  if (kind === 'record') Object.assign(error, { jmapFailedIds: ['a', 'b'] });
  service.reject(error); expect(await running).toBe(false);
  expect(useEmailStore.getState().selectedEmail).toBe(rich); expectCounts(2);
  expect([...useEmailStore.getState().selectedEmailKeys]).toEqual(['a', 'b']);
  expect(useEmailStore.getState().processingReadStatus.size).toBe(0);
  expect(useEmailStore.getState().isLoading).toBe(false);
});

for (const read of [true, false]) {
  it(`targeted read=${read} does not infer an unstamped reader's client from the old passed client`, async () => {
    seed(read);
    const service = deferred(); client.batchMarkAsRead.mockReturnValueOnce(service.promise);
    const running = useEmailStore.getState().batchMarkAsRead(asClient(), read,
      { emailIds: ['a'], client: asClient(), accountId: 'owner' });
    // The current client changes without relying on an epoch change: the old
    // method argument alone cannot establish ownership of this unstamped copy.
    useAuthStore.setState({ activeAccountId: 'other-login', client: otherClient as unknown as IJMAPClient });
    const bReader = { ...mail('a', !read), subject: 'B namesake' };
    useEmailStore.getState().setEmails([bReader]); useEmailStore.getState().selectEmail(bReader);
    service.resolve(); await running;
    expect(useEmailStore.getState().selectedEmail).toBe(bReader);
  });

  it(`read=${read} leaves an unstamped reader alone after an account-store epoch change`, async () => {
    seed(read);
    const service = deferred(); client.batchMarkAsRead.mockReturnValueOnce(service.promise);
    const running = useEmailStore.getState().batchMarkAsRead(asClient(), read);
    clearAllStores();
    useAuthStore.setState({ activeAccountId: 'other-login', client: otherClient as unknown as IJMAPClient });
    const bReader = { ...mail('a', !read), subject: 'B namesake' };
    useEmailStore.getState().setEmails([bReader]); useEmailStore.getState().selectEmail(bReader);
    service.resolve(); await running;
    expect(useEmailStore.getState().selectedEmail).toBe(bReader);
  });

  it(`read=${read} still synchronizes a rich accepted reader after same-account folder navigation`, async () => {
    const { a, rich } = seed(read);
    const sharedRow = { ...a, mailboxIds: { inbox: true, archive: true } };
    const full = { ...rich, mailboxIds: sharedRow.mailboxIds };
    useEmailStore.getState().setEmails([sharedRow]);
    const service = deferred(); client.batchMarkAsRead.mockReturnValueOnce(service.promise);
    const epoch = currentStoreEpoch();
    const running = useEmailStore.getState().batchMarkAsRead(asClient(), read);
    useEmailStore.getState().selectMailbox('archive');
    useEmailStore.getState().setEmails([sharedRow]); useEmailStore.getState().selectEmail(full);
    expect(currentStoreEpoch()).toBe(epoch);
    service.resolve(); await running;
    expect(useEmailStore.getState().selectedEmail).toEqual({ ...full, keywords: { ...full.keywords, $seen: read } });
  });
}
