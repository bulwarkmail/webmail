import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEmailStore } from '../email-store';
import { useSettingsStore } from '../settings-store';
import type { Email, Mailbox, CollectionChanges, StateChange } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

/**
 * A push (StateChange) for the plain folder list is resolved with
 * Email/changes and Mailbox/changes (RFC 8620 §5.2) against the state the
 * list was loaded at, instead of re-querying the first page and every folder
 * tree. The full refresh stays the fallback whenever the delta cannot be
 * applied safely.
 */

const makeEmail = (id: string, extra: Partial<Email> = {}): Email =>
  ({
    id,
    threadId: `t-${id}`,
    mailboxIds: { inbox: true },
    keywords: {},
    from: [{ email: 'a@example.com' }],
    to: [{ email: 'b@example.com' }],
    subject: `mail ${id}`,
    receivedAt: '2026-08-29T10:00:00Z',
    preview: '',
    hasAttachment: false,
    size: 1,
    ...extra,
  }) as unknown as Email;

const inbox = {
  id: 'inbox',
  originalId: 'inbox',
  name: 'Inbox',
  role: 'inbox',
  accountId: 'acc',
  totalEmails: 3,
  unreadEmails: 1,
  totalThreads: 3,
  unreadThreads: 1,
  sortOrder: 0,
  isSubscribed: true,
  myRights: {},
} as unknown as Mailbox;

const delta = (partial: Partial<CollectionChanges>): CollectionChanges => ({
  oldState: 's1',
  newState: 's2',
  hasMoreChanges: false,
  created: [],
  updated: [],
  destroyed: [],
  updatedProperties: null,
  ...partial,
});

interface ClientMocks {
  getEmailChanges: ReturnType<typeof vi.fn>;
  getMailboxChanges: ReturnType<typeof vi.fn>;
  getMailboxesByIds: ReturnType<typeof vi.fn>;
  getSomeEmails: ReturnType<typeof vi.fn>;
  getEmails: ReturnType<typeof vi.fn>;
  getAllMailboxesWithState: ReturnType<typeof vi.fn>;
  getAllMailboxes: ReturnType<typeof vi.fn>;
  getTagCounts: ReturnType<typeof vi.fn>;
}

function makeClient(overrides: Partial<ClientMocks> = {}): IJMAPClient & ClientMocks {
  const mocks: ClientMocks = {
    getEmailChanges: vi.fn(async () => delta({})),
    getMailboxChanges: vi.fn(async () => delta({})),
    getMailboxesByIds: vi.fn(async () => []),
    getSomeEmails: vi.fn(async () => []),
    getEmails: vi.fn(async () => ({ emails: [], hasMore: false, total: 0, state: 's9' })),
    getAllMailboxesWithState: vi.fn(async () => ({ mailboxes: [inbox], states: { acc: 'm9' } })),
    getAllMailboxes: vi.fn(async () => [inbox]),
    getTagCounts: vi.fn(async () => ({})),
    ...overrides,
  };
  return {
    ...mocks,
    getAccountId: () => 'acc',
    getThreadEmails: vi.fn(async () => []),
  } as unknown as IJMAPClient & ClientMocks;
}

const push = (changed: StateChange['changed']): StateChange => ({ '@type': 'StateChange', changed });

describe('Email/changes delta sync', () => {
  beforeEach(() => {
    useSettingsStore.setState({ emailsPerPage: 3 });
    useEmailStore.setState({
      selectedMailbox: 'inbox',
      mailboxes: [inbox],
      accountMailboxes: {},
      viewingAccountId: null,
      emails: [makeEmail('a'), makeEmail('b'), makeEmail('c')],
      totalEmails: 3,
      hasMoreEmails: false,
      emailListSync: { state: 's1', accountId: 'acc', mailboxId: 'inbox' },
      mailboxSyncStates: { acc: 'm1' },
      threadEmailsCache: new Map([['t-b', [makeEmail('b')]]]),
      isUnifiedView: false,
      isScheduledView: false,
      selectedKeyword: null,
      searchQuery: '',
    });
  });

  it('skips every request when the push carries the state already held', async () => {
    const client = makeClient();
    await useEmailStore.getState().handleStateChange(push({ acc: { Email: 's1' } }), client);
    expect(client.getEmailChanges).not.toHaveBeenCalled();
    expect(client.getEmails).not.toHaveBeenCalled();
  });

  it('drops destroyed rows and patches updated ones without re-querying', async () => {
    const client = makeClient({
      getEmailChanges: vi.fn(async () => delta({ updated: ['b'], destroyed: ['c'] })),
      getSomeEmails: vi.fn(async () => [makeEmail('b', { keywords: { $seen: true } })]),
    });

    await useEmailStore.getState().handleStateChange(push({ acc: { Email: 's2' } }), client);

    const state = useEmailStore.getState();
    expect(client.getEmailChanges).toHaveBeenCalledWith('s1', undefined, expect.any(Number));
    expect(client.getEmails).not.toHaveBeenCalled();
    expect(state.emails.map((e) => e.id)).toEqual(['a', 'b']);
    expect(state.emails[1].keywords).toEqual({ $seen: true });
    expect(state.totalEmails).toBe(2);
    expect(state.emailListSync?.state).toBe('s2');
    // The patched row's thread cache is invalidated.
    expect(state.threadEmailsCache.has('t-b')).toBe(false);
  });

  it('removes a row the delta reports as updated but that left the folder', async () => {
    const client = makeClient({
      getEmailChanges: vi.fn(async () => delta({ updated: ['a'] })),
      getSomeEmails: vi.fn(async () => [makeEmail('a', { mailboxIds: { trash: true } })]),
    });

    await useEmailStore.getState().handleStateChange(push({ acc: { Email: 's2' } }), client);

    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['b', 'c']);
    expect(client.getEmails).not.toHaveBeenCalled();
  });

  it('ignores changes to mail in other folders', async () => {
    const client = makeClient({
      getEmailChanges: vi.fn(async () => delta({ created: ['x'], updated: ['y'] })),
      getSomeEmails: vi.fn(async () => [
        makeEmail('x', { mailboxIds: { sent: true } }),
        makeEmail('y', { mailboxIds: { archive: true } }),
      ]),
    });

    await useEmailStore.getState().handleStateChange(push({ acc: { Email: 's2' } }), client);

    expect(client.getSomeEmails).toHaveBeenCalledWith(['x', 'y'], undefined);
    expect(client.getEmails).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(useEmailStore.getState().emailListSync?.state).toBe('s2');
  });

  it('falls back to the first-page refresh when new mail entered the folder', async () => {
    const fresh = makeEmail('new');
    const client = makeClient({
      getEmailChanges: vi.fn(async () => delta({ created: ['new'] })),
      getSomeEmails: vi.fn(async () => [fresh]),
      getEmails: vi.fn(async () => ({ emails: [fresh, makeEmail('a'), makeEmail('b')], hasMore: true, total: 4, state: 's2' })),
    });

    await useEmailStore.getState().handleStateChange(push({ acc: { Email: 's2' } }), client);

    expect(client.getEmails).toHaveBeenCalledTimes(1);
    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['new', 'a', 'b', 'c']);
    // The refresh re-baselines the delta sync at the state it was read at.
    expect(useEmailStore.getState().emailListSync).toEqual({ state: 's2', accountId: 'acc', mailboxId: 'inbox' });
  });

  // A total of 0 beside the rows it was read with is a total the server did
  // not give; it says nothing about mail past the page (#1364).
  it('keeps paging when the refresh after new mail comes back without a total', async () => {
    useEmailStore.setState({ totalEmails: 10, hasMoreEmails: true });
    const client = makeClient({
      getEmailChanges: vi.fn(async () => delta({ created: ['new'] })),
      getSomeEmails: vi.fn(async () => [makeEmail('new')]),
      getEmails: vi.fn(async () => ({ emails: [makeEmail('new'), makeEmail('a'), makeEmail('b')], hasMore: true, total: 0, state: 's2' })),
    });

    await useEmailStore.getState().handleStateChange(push({ acc: { Email: 's2' } }), client);

    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['new', 'a', 'b']);
    expect(useEmailStore.getState().hasMoreEmails).toBe(true);
  });

  it('keeps paging when a delta is applied to a list whose total is not known', async () => {
    useEmailStore.setState({ totalEmails: 0, hasMoreEmails: true });
    const client = makeClient({ getEmailChanges: vi.fn(async () => delta({ destroyed: ['c'] })) });

    await useEmailStore.getState().handleStateChange(push({ acc: { Email: 's2' } }), client);

    expect(client.getEmails).not.toHaveBeenCalled();
    expect(useEmailStore.getState().emails.map((e) => e.id)).toEqual(['a', 'b']);
    expect(useEmailStore.getState().hasMoreEmails).toBe(true);
  });

  it('falls back when the server cannot compute the delta', async () => {
    const client = makeClient({ getEmailChanges: vi.fn(async () => null) });
    await useEmailStore.getState().handleStateChange(push({ acc: { Email: 's2' } }), client);
    expect(client.getEmails).toHaveBeenCalledTimes(1);
  });

  it('falls back when the delta is truncated (hasMoreChanges)', async () => {
    const client = makeClient({ getEmailChanges: vi.fn(async () => delta({ hasMoreChanges: true, destroyed: ['a'] })) });
    await useEmailStore.getState().handleStateChange(push({ acc: { Email: 's2' } }), client);
    expect(client.getEmails).toHaveBeenCalledTimes(1);
  });

  it('never applies a delta to a search result list', async () => {
    useEmailStore.setState({ searchQuery: 'invoice' });
    const client = makeClient({
      getEmailChanges: vi.fn(async () => delta({ destroyed: ['a'] })),
      // The refresh path re-runs the search; keep the mock minimal.
      advancedSearchEmails: vi.fn(async () => ({ emails: [], hasMore: false, total: 0 })),
    } as Partial<ClientMocks>);
    await useEmailStore.getState().handleStateChange(push({ acc: { Email: 's2' } }), client);
    expect(client.getEmailChanges).not.toHaveBeenCalled();
  });

  it('never applies a delta once the user navigated to another folder', async () => {
    useEmailStore.setState({ selectedMailbox: 'sent', mailboxes: [inbox, { ...inbox, id: 'sent', originalId: 'sent', role: 'sent' }] });
    const client = makeClient({ getEmailChanges: vi.fn(async () => delta({ destroyed: ['a'] })) });
    await useEmailStore.getState().handleStateChange(push({ acc: { Email: 's2' } }), client);
    expect(client.getEmailChanges).not.toHaveBeenCalled();
    expect(client.getEmails).toHaveBeenCalledTimes(1);
  });

  it('applies a delta for a shared folder whose owner account changed', async () => {
    const shared = { ...inbox, id: 'owner:inbox', originalId: 'inbox', accountId: 'owner', isShared: true } as Mailbox;
    useEmailStore.setState({
      selectedMailbox: 'owner:inbox',
      mailboxes: [inbox, shared],
      emails: [makeEmail('s1', { mailboxIds: { 'owner:inbox': true } })],
      totalEmails: 1,
      emailListSync: { state: 'o1', accountId: 'owner', mailboxId: 'owner:inbox' },
    });
    const client = makeClient({
      getEmailChanges: vi.fn(async () => delta({ oldState: 'o1', newState: 'o2', destroyed: ['s1'] })),
    });

    // The push names the owner account only.
    await useEmailStore.getState().handleStateChange(push({ owner: { Email: 'o2' } }), client);

    expect(client.getEmailChanges).toHaveBeenCalledWith('o1', 'owner', expect.any(Number));
    expect(useEmailStore.getState().emails).toEqual([]);
    expect(useEmailStore.getState().emailListSync?.state).toBe('o2');
  });

  it('records the sync baseline when a folder is loaded', async () => {
    useEmailStore.setState({ emailListSync: null });
    const client = makeClient({
      getEmails: vi.fn(async () => ({ emails: [makeEmail('a')], hasMore: false, total: 1, state: 's5' })),
    });
    await useEmailStore.getState().fetchEmails(client, 'inbox');
    expect(useEmailStore.getState().emailListSync).toEqual({ state: 's5', accountId: 'acc', mailboxId: 'inbox' });
  });

  it('records no baseline for a tag view', async () => {
    useEmailStore.setState({ emailListSync: null, selectedKeyword: 'work' });
    const client = makeClient({
      getEmails: vi.fn(async () => ({ emails: [makeEmail('a')], hasMore: false, total: 1, state: 's5' })),
    });
    await useEmailStore.getState().fetchEmails(client, 'inbox');
    expect(useEmailStore.getState().emailListSync).toBeNull();
  });
});

describe('Mailbox/changes delta sync', () => {
  beforeEach(() => {
    useSettingsStore.setState({ emailsPerPage: 3 });
    useEmailStore.setState({
      selectedMailbox: 'inbox',
      mailboxes: [inbox, { ...inbox, id: 'sent', originalId: 'sent', role: 'sent', name: 'Sent' }],
      accountMailboxes: {},
      viewingAccountId: null,
      emails: [],
      totalEmails: 0,
      emailListSync: null,
      mailboxSyncStates: { acc: 'm1' },
      isUnifiedView: false,
      isScheduledView: false,
      selectedKeyword: null,
      searchQuery: '',
    });
  });

  it('patches only the updated folders instead of refetching the tree', async () => {
    const client = makeClient({
      getMailboxChanges: vi.fn(async () => delta({ oldState: 'm1', newState: 'm2', updated: ['inbox'], updatedProperties: ['totalEmails', 'unreadEmails', 'totalThreads', 'unreadThreads'] })),
      getMailboxesByIds: vi.fn(async () => [{ ...inbox, totalEmails: 4, unreadEmails: 2 }]),
    });

    await useEmailStore.getState().handleStateChange(push({ acc: { Mailbox: 'm2' } }), client);

    expect(client.getMailboxChanges).toHaveBeenCalledWith('m1', 'acc');
    expect(client.getMailboxesByIds).toHaveBeenCalledWith(['inbox'], 'acc');
    expect(client.getAllMailboxesWithState).not.toHaveBeenCalled();
    const state = useEmailStore.getState();
    expect(state.mailboxes.find((m) => m.id === 'inbox')?.unreadEmails).toBe(2);
    expect(state.mailboxes.find((m) => m.id === 'sent')?.name).toBe('Sent');
    expect(state.mailboxSyncStates).toEqual({ acc: 'm2' });
  });

  it('skips the request when the pushed state is already held', async () => {
    const client = makeClient();
    await useEmailStore.getState().handleStateChange(push({ acc: { Mailbox: 'm1' } }), client);
    expect(client.getMailboxChanges).not.toHaveBeenCalled();
    expect(client.getAllMailboxesWithState).not.toHaveBeenCalled();
  });

  it('refetches the whole tree when a folder was created or destroyed', async () => {
    const client = makeClient({
      getMailboxChanges: vi.fn(async () => delta({ oldState: 'm1', newState: 'm2', created: ['new'] })),
    });
    await useEmailStore.getState().handleStateChange(push({ acc: { Mailbox: 'm2' } }), client);
    expect(client.getMailboxesByIds).not.toHaveBeenCalled();
    expect(client.getAllMailboxesWithState).toHaveBeenCalledTimes(1);
    // The full fetch re-baselines the sync state.
    expect(useEmailStore.getState().mailboxSyncStates).toEqual({ acc: 'm9' });
  });

  it('refetches when the changed account has no known baseline', async () => {
    const client = makeClient();
    await useEmailStore.getState().handleStateChange(push({ other: { Mailbox: 'x2' } }), client);
    expect(client.getMailboxChanges).not.toHaveBeenCalled();
    expect(client.getAllMailboxesWithState).toHaveBeenCalledTimes(1);
  });

  it('refetches with a client that cannot report changes (demo)', async () => {
    const client = makeClient();
    delete (client as Partial<ClientMocks>).getMailboxChanges;
    await useEmailStore.getState().handleStateChange(push({ acc: { Mailbox: 'm2' } }), client);
    expect(client.getAllMailboxesWithState).toHaveBeenCalledTimes(1);
  });
});
