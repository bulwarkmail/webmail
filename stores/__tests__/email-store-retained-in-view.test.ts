import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * When an unread or starred cross view is open, reading a mail (unread view) or
 * removing its star (starred view) must NOT drop it out of the list on the next
 * push refresh - the row stays put with its status + counters updated, until the
 * view is re-opened. The row only drops if it genuinely left (deleted/moved) or
 * left the filter due to a change the user did NOT make in this view (e.g. read
 * on another device).
 */

const { buildMock, fetchCrossViewMock } = vi.hoisted(() => ({
  buildMock: vi.fn(async () => [] as unknown[]),
  fetchCrossViewMock: vi.fn(),
}));

vi.mock('@/lib/unified-mailbox', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/unified-mailbox')>();
  return {
    ...actual,
    buildUnifiedAccountClients: buildMock,
    fetchCrossViewEmails: fetchCrossViewMock,
  };
});

import { useEmailStore } from '../email-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '../settings-store';
import { CROSS_UNREAD, CROSS_STARRED } from '@/lib/jmap/types';
import type { Email, Mailbox } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

function makeMailbox(): Mailbox {
  return {
    id: 'inbox', name: 'Inbox', sortOrder: 0, role: 'inbox',
    totalEmails: 0, unreadEmails: 5, totalThreads: 0, unreadThreads: 5,
    isSubscribed: true, isShared: false,
  } as unknown as Mailbox;
}

const makeEmail = (id: string, keywords: Record<string, boolean>): Email =>
  ({
    id,
    threadId: `t-${id}`,
    subject: `mail ${id}`,
    receivedAt: '2026-08-07T10:00:00Z',
    keywords,
    mailboxIds: { inbox: true },
    accountId: 'account-a',
    sourceClientAccountId: 'account-a',
    sourceAccountId: 'account-a',
  }) as unknown as Email;

function makeClient() {
  return {
    markAsRead: vi.fn().mockResolvedValue(undefined),
    toggleStar: vi.fn().mockResolvedValue(undefined),
  } as unknown as IJMAPClient;
}

// A single-account client whose getEmails would return an empty page for the
// virtual cross id - it must never be consulted for a cross view.
const client = makeClient();

function seedView(id: typeof CROSS_UNREAD | typeof CROSS_STARRED, view: 'unread' | 'starred', emails: Email[]) {
  useSettingsStore.setState({ emailsPerPage: 25 });
  useAuthStore.setState({
    activeAccountId: 'account-a',
    getClientForAccount: (a: string) => (a === 'account-a' ? client : undefined) as never,
  } as never);
  useEmailStore.setState({
    isUnifiedView: true,
    unifiedRole: null,
    crossView: view,
    selectedMailbox: id,
    selectedKeyword: null,
    searchQuery: '',
    mailboxes: [makeMailbox()],
    accountMailboxes: { 'account-a': [makeMailbox()] },
    processingReadStatus: new Set(),
    selectedEmailIds: new Set(),
    retainedInViewIds: new Set(),
    emails,
    totalEmails: emails.length,
  });
}

describe('retained-in-view: unread cross view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildMock.mockResolvedValue([]);
  });

  it('keeps a mail the user just read; the fresh unread page no longer lists it', async () => {
    const a = makeEmail('a', {});
    const b = makeEmail('b', {});
    seedView(CROSS_UNREAD, 'unread', [a, b]);

    await useEmailStore.getState().markAsRead(client, 'a', true);
    expect(useEmailStore.getState().retainedInViewIds.has('a')).toBe(true);

    // Push refresh: the unread filter drops 'a' (now $seen); only 'b' comes back.
    fetchCrossViewMock.mockResolvedValue({ emails: [makeEmail('b', {})], hasMore: false, total: 1, errors: new Map() });
    await useEmailStore.getState().refreshCurrentMailbox(client);

    const emails = useEmailStore.getState().emails;
    expect(emails.map(e => e.id)).toEqual(['a', 'b']); // 'a' retained in place
    expect(emails.find(e => e.id === 'a')?.keywords?.$seen).toBe(true);
    // Counter reflects the two visible rows, not just the server's unread total.
    expect(useEmailStore.getState().totalEmails).toBe(2);
  });

  it('does NOT retain a mail read elsewhere (retain set empty): it drops on refresh', async () => {
    const a = makeEmail('a', {});
    const b = makeEmail('b', {});
    seedView(CROSS_UNREAD, 'unread', [a, b]);

    // No local action -> retain set stays empty. 'a' left the unread filter
    // (e.g. read on another device); the refresh should drop it.
    fetchCrossViewMock.mockResolvedValue({ emails: [makeEmail('b', {})], hasMore: false, total: 1, errors: new Map() });
    await useEmailStore.getState().refreshCurrentMailbox(client);

    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['b']);
  });

  it('marking the mail unread again drops the retention', async () => {
    const a = makeEmail('a', { $seen: true });
    seedView(CROSS_UNREAD, 'unread', [a]);
    useEmailStore.setState({ retainedInViewIds: new Set(['a']) });

    await useEmailStore.getState().markAsRead(client, 'a', false);
    expect(useEmailStore.getState().retainedInViewIds.has('a')).toBe(false);
  });

  it('clears retention when navigating away to a real mailbox', async () => {
    const a = makeEmail('a', {});
    seedView(CROSS_UNREAD, 'unread', [a]);
    await useEmailStore.getState().markAsRead(client, 'a', true);
    expect(useEmailStore.getState().retainedInViewIds.size).toBe(1);

    // Navigating to a real folder is a fresh load; retention must reset.
    await useEmailStore.getState().fetchEmails(client, 'inbox').catch(() => {});
    expect(useEmailStore.getState().retainedInViewIds.size).toBe(0);
  });
});

describe('retained-in-view: starred cross view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildMock.mockResolvedValue([]);
  });

  it('keeps a mail the user just un-starred; the fresh starred page omits it', async () => {
    const a = makeEmail('a', { $flagged: true });
    const b = makeEmail('b', { $flagged: true });
    seedView(CROSS_STARRED, 'starred', [a, b]);

    await useEmailStore.getState().toggleStar(client, 'a'); // removes the star
    expect(useEmailStore.getState().retainedInViewIds.has('a')).toBe(true);

    fetchCrossViewMock.mockResolvedValue({ emails: [makeEmail('b', { $flagged: true })], hasMore: false, total: 1, errors: new Map() });
    await useEmailStore.getState().refreshCurrentMailbox(client);

    const emails = useEmailStore.getState().emails;
    expect(emails.map(e => e.id)).toEqual(['a', 'b']);
    expect(emails.find(e => e.id === 'a')?.keywords?.$flagged).toBe(false);
  });

  it('re-starring drops the retention', async () => {
    const a = makeEmail('a', {}); // currently unflagged
    seedView(CROSS_STARRED, 'starred', [a]);
    useEmailStore.setState({ retainedInViewIds: new Set(['a']) });

    await useEmailStore.getState().toggleStar(client, 'a'); // adds the star back
    expect(useEmailStore.getState().retainedInViewIds.has('a')).toBe(false);
  });
});

describe('retained-in-view: scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildMock.mockResolvedValue([]);
  });

  it('does not retain on read in the "all" cross view (no keyword filter to fall out of)', async () => {
    const a = makeEmail('a', {});
    // 'all' view: reading never removes the row, so nothing to retain.
    useSettingsStore.setState({ emailsPerPage: 25 });
    useAuthStore.setState({
      activeAccountId: 'account-a',
      getClientForAccount: (acc: string) => (acc === 'account-a' ? client : undefined) as never,
    } as never);
    useEmailStore.setState({
      isUnifiedView: true, unifiedRole: null, crossView: 'all', selectedMailbox: '__cross_all__',
      selectedKeyword: null, searchQuery: '', mailboxes: [makeMailbox()],
      accountMailboxes: { 'account-a': [makeMailbox()] },
      processingReadStatus: new Set(), selectedEmailIds: new Set(), retainedInViewIds: new Set(),
      emails: [a], totalEmails: 1,
    });

    await useEmailStore.getState().markAsRead(client, 'a', true);
    expect(useEmailStore.getState().retainedInViewIds.size).toBe(0);
  });
});
