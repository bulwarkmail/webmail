import { describe, it, expect } from 'vitest';
import { inboxUnread, totalInboxUnread } from '../account-inbox-unread';
import type { Mailbox } from '../jmap/types';

const makeMailbox = (overrides: Partial<Mailbox> = {}): Mailbox => ({
  id: 'mb-1',
  name: 'Inbox',
  role: 'inbox',
  sortOrder: 0,
  totalEmails: 10,
  unreadEmails: 3,
  totalThreads: 10,
  unreadThreads: 3,
  isSubscribed: true,
  myRights: {
    mayReadItems: true,
    mayAddItems: true,
    mayRemoveItems: true,
    maySetSeen: true,
    maySetKeywords: true,
    mayCreateChild: true,
    mayRename: true,
    mayDelete: true,
    maySubmit: true,
  },
  ...overrides,
});

describe('inboxUnread', () => {
  it('reads the unread count off the account\'s own inbox', () => {
    expect(inboxUnread([makeMailbox({ unreadEmails: 7 })])).toBe(7);
  });

  it('tells "not loaded yet" apart from a real zero', () => {
    expect(inboxUnread(undefined)).toBeUndefined();
    expect(inboxUnread([])).toBeUndefined();
    expect(inboxUnread([makeMailbox({ unreadEmails: 0 })])).toBe(0);
  });

  it('ignores a shared inbox, which belongs to somebody else', () => {
    const shared = makeMailbox({ id: 'mb-shared', isShared: true, unreadEmails: 99 });
    expect(inboxUnread([shared])).toBeUndefined();
    expect(inboxUnread([shared, makeMailbox({ unreadEmails: 2 })])).toBe(2);
  });

  it('has nothing to report for an account with no inbox role', () => {
    expect(inboxUnread([makeMailbox({ role: 'archive' })])).toBeUndefined();
  });
});

describe('totalInboxUnread', () => {
  it('adds up the accounts it was asked about, and only those', () => {
    const byAccount = {
      a: [makeMailbox({ unreadEmails: 4 })],
      b: [makeMailbox({ unreadEmails: 5 })],
      c: [makeMailbox({ unreadEmails: 100 })],
    };
    expect(totalInboxUnread(['a', 'b'], byAccount)).toBe(9);
  });

  it('counts an account whose folders have not arrived as nothing', () => {
    expect(totalInboxUnread(['a', 'b'], { a: [makeMailbox({ unreadEmails: 4 })] })).toBe(4);
  });
});
