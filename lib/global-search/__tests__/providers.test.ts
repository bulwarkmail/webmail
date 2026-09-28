import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSearchQuery } from '../query-parser';
import type { SearchAccount } from '../types';

// ---------------------------------------------------------------------------
// Store mocks. Providers read caches via `useXStore.getState()` and resolve
// logins via account/auth stores; all of that is replaced with plain state.
// ---------------------------------------------------------------------------

const emailState = { emails: [] as unknown[], mailboxes: [] as unknown[] };
const contactState = { contacts: [] as unknown[], addressBooks: [] as unknown[] };
const calendarState = { events: [] as unknown[], calendars: [] as unknown[] };
const fileState: Record<string, unknown> = { lastAction: null, uploadProgress: null, isLoading: false, currentAccountId: null };
const authState = { activeAccountId: 'login-a', client: null as unknown, getClientForAccount: () => undefined };

const buildUnifiedAccountClients = vi.fn(async (_opts?: unknown) => [] as unknown[]);

function storeHook(state: object) {
  const hook = (selector?: (s: object) => unknown) => (typeof selector === 'function' ? selector(state) : state);
  hook.getState = () => state;
  hook.setState = (patch: object) => Object.assign(state, patch);
  hook.subscribe = () => () => {};
  return hook;
}

vi.mock('@/stores/email-store', () => ({
  useEmailStore: storeHook(emailState),
  buildUnifiedAccountClients: (opts?: unknown) => buildUnifiedAccountClients(opts),
}));
vi.mock('@/stores/contact-store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useContactStore: storeHook(contactState),
}));
vi.mock('@/stores/calendar-store', () => ({ useCalendarStore: storeHook(calendarState) }));
vi.mock('@/stores/file-store', () => ({ useFileStore: storeHook(fileState) }));
vi.mock('@/stores/auth-store', () => ({ useAuthStore: storeHook(authState) }));
vi.mock('@/stores/account-store', () => ({ useAccountStore: storeHook({ accounts: [] }) }));
vi.mock('@/stores/settings-store', () => ({ useSettingsStore: storeHook({ includeGroupInUnified: true }) }));

const { mailProvider, andFilters, emailMatchesFilters, mailFilterFor } = await import('../providers/mail');
const { contactsProvider } = await import('../providers/contacts');
const { calendarProvider, calendarFilterFor } = await import('../providers/calendar');
const { filesProvider, invalidateFileSearchCache, pathOfNode, rawFileNodeId } = await import('../providers/files');

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    getAccountId: () => 'jmap-a',
    getContactsAccountId: () => 'jmap-a',
    getCalendarsAccountId: () => 'jmap-a',
    getFilesAccountId: () => 'jmap-a',
    supportsContacts: () => true,
    supportsCalendars: () => true,
    supportsFiles: () => true,
    ...overrides,
  } as unknown as SearchAccount['client'];
}

function account(id: string, overrides: Record<string, unknown> = {}): SearchAccount {
  return { localAccountId: id, label: id.toUpperCase(), email: `${id}@example.org`, client: fakeClient(overrides) };
}

const signal = new AbortController().signal;

beforeEach(() => {
  emailState.emails = [];
  emailState.mailboxes = [];
  contactState.contacts = [];
  contactState.addressBooks = [];
  calendarState.events = [];
  calendarState.calendars = [];
  authState.activeAccountId = 'login-a';
  buildUnifiedAccountClients.mockReset();
  invalidateFileSearchCache();
});

// ---------------------------------------------------------------------------

describe('mail provider', () => {
  const mailbox = (id: string, role?: string, extra: Record<string, unknown> = {}) => ({ id, name: id, role, ...extra });
  const entry = (mailboxes: unknown[], overrides: Record<string, unknown> = {}) => ({
    accountId: 'login-a', accountLabel: 'A', clientAccountId: 'login-a', jmapAccountId: 'jmap-a',
    mailboxes, isShared: false,
    client: fakeClient(overrides),
    ...overrides,
  });

  it('excludes Trash and Junk by default and lifts the exclusion for is:anything', () => {
    const boxes = [mailbox('in', 'inbox'), mailbox('tr', 'trash'), mailbox('ju', 'junk')];
    const filter = mailFilterFor(parseSearchQuery('report'), entry(boxes) as never);
    expect(filter).toEqual({ operator: 'AND', conditions: [{ text: 'report' }, { inMailboxOtherThan: ['tr', 'ju'] }] });
    const anything = mailFilterFor(parseSearchQuery('report is:anything'), entry(boxes) as never);
    expect(anything).toEqual({ text: 'report' });
  });

  it('searches only the role folder for in:trash, using originalId on shared entries', () => {
    const boxes = [mailbox('ns:tr', 'trash', { originalId: 'tr' })];
    const shared = entry(boxes, { isShared: true });
    const filter = mailFilterFor(parseSearchQuery('in:trash x'), shared as never);
    expect(filter).toEqual({ operator: 'AND', conditions: [{ text: 'x' }, { inMailbox: 'tr' }] });
  });

  it('flattens extra conditions into an existing AND', () => {
    expect(andFilters({ operator: 'AND', conditions: [{ a: 1 }] }, { b: 2 }))
      .toEqual({ operator: 'AND', conditions: [{ a: 1 }, { b: 2 }] });
    expect(andFilters({}, { b: 2 })).toEqual({ b: 2 });
    expect(andFilters({ a: 1 }, null)).toEqual({ a: 1 });
  });

  it('applies structured operators to cached emails', () => {
    const email = {
      id: 'm1', subject: 'Invoice', preview: '', receivedAt: '2026-05-05T10:00:00Z',
      from: [{ name: 'Alice', email: 'alice@x' }], to: [], keywords: { $seen: true }, hasAttachment: true, mailboxIds: {},
    };
    expect(emailMatchesFilters(email as never, parseSearchQuery('from:alice has:attachment is:read'))).toBe(true);
    expect(emailMatchesFilters(email as never, parseSearchQuery('is:unread'))).toBe(false);
    expect(emailMatchesFilters(email as never, parseSearchQuery('after:2026-06-01'))).toBe(false);
  });

  it('stamps local hits with login + owner and never returns another login’s cache rows', () => {
    emailState.emails = [
      { id: 'm1', subject: 'Report A', receivedAt: '2026-01-01T00:00:00Z', keywords: {}, mailboxIds: {}, sourceClientAccountId: 'login-a', sourceAccountId: 'jmap-a', sourceFolder: 'Inbox' },
      { id: 'm2', subject: 'Report B', receivedAt: '2026-01-02T00:00:00Z', keywords: {}, mailboxIds: {}, sourceClientAccountId: 'login-b', sourceAccountId: 'jmap-b' },
    ];
    const hits = mailProvider.local(parseSearchQuery('report'), [account('login-a')], 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'mail', id: 'm1', localAccountId: 'login-a', jmapAccountId: 'jmap-a', subtitle: 'Inbox' });
  });

  it('remote fans out over the login’s JMAP accounts and stamps source fields', async () => {
    const advancedSearchEmails = vi.fn(async () => ({
      emails: [{ id: 'm9', subject: 'Zebra', receivedAt: '2026-01-01T00:00:00Z', mailboxIds: { in: true }, keywords: {} }],
      hasMore: true,
      total: 51,
    }));
    buildUnifiedAccountClients.mockResolvedValue([
      entry([{ id: 'in', name: 'Inbox', role: 'inbox' }], { advancedSearchEmails }),
    ]);
    const result = await mailProvider.remote(parseSearchQuery('zebra'), account('login-a'), { limit: 25, signal });
    expect(buildUnifiedAccountClients).toHaveBeenCalledWith({ includeGroup: true, scopeToClientAccountId: 'login-a' });
    // The stub login has no trash/junk role folders, so no exclusion is added.
    expect(advancedSearchEmails).toHaveBeenCalledWith({ text: 'zebra' }, undefined, 25, 0);
    expect(result.hasMore).toBe(true);
    expect(result.hits[0]).toMatchObject({
      id: 'm9', localAccountId: 'login-a', jmapAccountId: 'jmap-a', source: 'remote', subtitle: 'Inbox',
    });
    expect((result.hits[0] as { email: { sourceClientAccountId: string } }).email.sourceClientAccountId).toBe('login-a');
  });
});

describe('contacts provider', () => {
  it('matches cached contacts by name/email substring and keeps store + raw ids apart', () => {
    contactState.contacts = [
      { id: 'login-a::c1', originalId: 'c1', localAccountId: 'login-a', name: { full: 'Bob Miller' }, emails: { e: { address: 'bob@x' } }, addressBookIds: { 'login-a::b1': true } },
      { id: 'login-a::c2', originalId: 'c2', localAccountId: 'login-a', name: { full: 'Alice' }, emails: {}, addressBookIds: {} },
      { id: 'login-b::c1', originalId: 'c1', localAccountId: 'login-b', name: { full: 'Bobby' }, emails: {}, addressBookIds: {} },
    ];
    contactState.addressBooks = [{ id: 'login-a::b1', originalId: 'b1', name: 'Personal' }];
    const hits = contactsProvider.local(parseSearchQuery('bob'), [account('login-a')], 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: 'c1', storeId: 'login-a::c1', localAccountId: 'login-a', title: 'Bob Miller', subtitle: 'Personal · bob@x' });
  });

  it('remote namespaces the store id under the login and keeps the raw id', async () => {
    const searchContacts = vi.fn(async () => [
      { id: 'c7', originalId: 'c7', accountId: 'jmap-a', name: { full: 'Bob' }, emails: {}, addressBookIds: {} },
      { id: 'owner:c8', originalId: 'c8', accountId: 'owner', isShared: true, name: { full: 'Bob Shared' }, emails: {}, addressBookIds: {} },
    ]);
    const result = await contactsProvider.remote(parseSearchQuery('bob'), account('login-a', { searchContacts }), { limit: 10, signal });
    expect(searchContacts).toHaveBeenCalledWith('bob');
    expect(result.hits[0]).toMatchObject({ id: 'c7', storeId: 'login-a::c7', jmapAccountId: 'jmap-a' });
    expect(result.hits[1]).toMatchObject({ id: 'c8', storeId: 'login-a::owner:c8', jmapAccountId: 'owner' });
  });
});

describe('calendar provider', () => {
  it('translates day bounds into instants for the server filter', () => {
    expect(calendarFilterFor(parseSearchQuery('sync after:2026-01-01 before:2026-02-01')))
      .toEqual({ text: 'sync', after: '2026-01-01T00:00:00Z', before: '2026-02-01T23:59:59Z' });
  });

  it('matches cached events on title/location and applies day bounds locally', () => {
    calendarState.events = [
      { id: 'login-a::e1', originalId: 'e1', localAccountId: 'login-a', accountId: 'jmap-a', title: 'Team sync', start: '2026-03-01T10:00:00', calendarIds: { k: true }, recurrenceRules: null, recurrenceId: null },
      { id: 'login-a::e2', originalId: 'e2', localAccountId: 'login-a', accountId: 'jmap-a', title: 'Sync later', start: '2026-06-01T10:00:00', calendarIds: {}, recurrenceRules: null, recurrenceId: null },
    ];
    const hits = calendarProvider.local(parseSearchQuery('sync before:2026-04-01'), [account('login-a')], 10);
    expect(hits.map((h) => h.id)).toEqual(['e1']);
  });

  it('lists a recurring series once even when several occurrences match', () => {
    calendarState.events = [
      { id: 'e1-o1', originalId: 'e1-o1', uid: 'series-1', localAccountId: 'login-a', accountId: 'jmap-a', title: 'Weekly sync', start: '2026-03-01T10:00:00', calendarIds: {}, recurrenceRules: null, recurrenceId: '2026-03-01T10:00:00' },
      { id: 'e1-o2', originalId: 'e1-o2', uid: 'series-1', localAccountId: 'login-a', accountId: 'jmap-a', title: 'Weekly sync', start: '2026-03-08T10:00:00', calendarIds: {}, recurrenceRules: null, recurrenceId: '2026-03-08T10:00:00' },
    ];
    const hits = calendarProvider.local(parseSearchQuery('sync'), [account('login-a')], 10);
    expect(hits).toHaveLength(1);
  });

  it('remote queries every JMAP account of the login and flags recurring masters', async () => {
    const queryAllCalendarEvents = vi.fn(async () => [
      { id: 'e9', title: 'Weekly sync', start: '2026-04-01T09:00:00', calendarIds: {}, accountId: 'jmap-a', recurrenceRules: [{}], recurrenceId: null },
    ]);
    const result = await calendarProvider.remote(parseSearchQuery('sync'), account('login-a', { queryAllCalendarEvents }), { limit: 10, signal });
    expect(queryAllCalendarEvents).toHaveBeenCalledWith({ text: 'sync' }, [{ property: 'start', isAscending: false }], 10);
    expect(result.hits[0]).toMatchObject({ id: 'e9', isRecurring: true, localAccountId: 'login-a' });
  });
});

describe('files provider', () => {
  const nodes = [
    { id: 'root1', parentId: null, name: 'Documents', type: 'd', blobId: null, size: 0, created: '', modified: '' },
    { id: 'f1', parentId: 'root1', name: 'zebra notes.txt', type: 'text/plain', blobId: 'b1', size: 3, created: '', modified: '2026-01-01T00:00:00Z' },
    { id: 'owner:s1', parentId: null, name: 'zebra shared.txt', type: 'text/plain', blobId: 'b2', size: 3, created: '', modified: '', accountId: 'owner', isShared: true },
  ];

  it('derives the folder path and the raw id', () => {
    expect(pathOfNode(nodes as never, nodes[1] as never)).toBe('/Documents');
    expect(pathOfNode(nodes as never, nodes[0] as never)).toBe('/');
    expect(rawFileNodeId(nodes[2] as never)).toBe('s1');
    expect(rawFileNodeId(nodes[1] as never)).toBe('f1');
  });

  it('filters the full listing by name substring and caches it per login', async () => {
    const listAllFileNodesAcrossAccounts = vi.fn(async () => nodes);
    const acc = account('login-a', { listAllFileNodesAcrossAccounts });
    const first = await filesProvider.remote(parseSearchQuery('zebra'), acc, { limit: 10, signal });
    expect(first.hits.map((h) => h.id)).toEqual(['f1', 's1']);
    expect(first.hits[0]).toMatchObject({ folderPath: '/Documents', isFolder: false, jmapAccountId: 'jmap-a' });
    expect(first.hits[1]).toMatchObject({ jmapAccountId: 'owner' });

    await filesProvider.remote(parseSearchQuery('zebra'), acc, { limit: 10, signal });
    expect(listAllFileNodesAcrossAccounts).toHaveBeenCalledTimes(1);

    // The synchronous pass serves the same listing without a round-trip.
    const local = filesProvider.local(parseSearchQuery('notes'), [acc], 10);
    expect(local.map((h) => h.id)).toEqual(['f1']);

    invalidateFileSearchCache('login-a');
    await filesProvider.remote(parseSearchQuery('zebra'), acc, { limit: 10, signal });
    expect(listAllFileNodesAcrossAccounts).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed listing', async () => {
    const listAllFileNodesAcrossAccounts = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(nodes);
    const acc = account('login-a', { listAllFileNodesAcrossAccounts });
    await expect(filesProvider.remote(parseSearchQuery('zebra'), acc, { limit: 10, signal })).rejects.toThrow('boom');
    const retry = await filesProvider.remote(parseSearchQuery('zebra'), acc, { limit: 10, signal });
    expect(retry.hits).toHaveLength(2);
  });
});
