import { describe, expect, it } from 'vitest';
import { resolveSearchScope, resolveUnstampedEmailAccountId } from '../email-store';
import type { Mailbox } from '@/lib/jmap/types';

// #923: the search panel's folder selector is independent of the open folder
// and defaults to "" ("All folders"). Resolving the account from that selector
// alone sent every unscoped search to the primary account, so searching from a
// shared folder queried the user's OWN mail — silently, and field filters
// (from / subject / hasAttachment) looked broken because they matched there.

// The client stamps `accountId` (and `originalId`) on EVERY mailbox, own ones
// included — only `isShared` tells them apart (lib/jmap/client.ts getMailboxes /
// getAllMailboxes). Own folders therefore carry `accountId: 'me'` here, so a
// resolver that forgot the `isShared` check would be caught rather than
// silently pass by returning a value that happens to be undefined.
const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', isShared: false, accountId: 'me', originalId: 'inbox' },
  { id: 'archive', name: 'Archive', role: 'archive', isShared: false, accountId: 'me', originalId: 'archive' },
  {
    id: 'owner-x:x-inbox',
    name: 'Shared Inbox',
    role: 'inbox',
    isShared: true,
    accountId: 'owner-x',
    originalId: 'x-inbox',
  },
] as unknown as Mailbox[];

describe('resolveSearchScope (#923)', () => {
  it('searches the shared owner when a shared folder is open and no folder is picked', () => {
    expect(
      resolveSearchScope({ mailboxes, selectedMailbox: 'owner-x:x-inbox', searchMailboxId: '' }),
    ).toEqual({ jmapMailboxId: '', accountId: 'owner-x' });
  });

  it('searches the own account when an own folder is open and no folder is picked', () => {
    expect(
      resolveSearchScope({ mailboxes, selectedMailbox: 'inbox', searchMailboxId: '' }),
    ).toEqual({ jmapMailboxId: '', accountId: undefined });
  });

  it('honours a picked shared folder, unwrapping its namespaced id', () => {
    expect(
      resolveSearchScope({ mailboxes, selectedMailbox: 'inbox', searchMailboxId: 'owner-x:x-inbox' }),
    ).toEqual({ jmapMailboxId: 'x-inbox', accountId: 'owner-x' });
  });

  it('honours a picked own folder while a shared folder is open', () => {
    expect(
      resolveSearchScope({ mailboxes, selectedMailbox: 'owner-x:x-inbox', searchMailboxId: 'archive' }),
    ).toEqual({ jmapMailboxId: 'archive', accountId: undefined });
  });

  it('falls back to the open folder when the picked one is gone', () => {
    // `clearSearchOnFolderChange` is off by default, so a search (and its
    // scope) survives navigation and the id can dangle.
    expect(
      resolveSearchScope({ mailboxes, selectedMailbox: 'owner-x:x-inbox', searchMailboxId: 'deleted-id' }),
    ).toEqual({ jmapMailboxId: '', accountId: 'owner-x' });
  });

  it('does not scope a tag-view search to the folder left open behind it', () => {
    // selectKeyword does NOT clear selectedMailbox, and a tag view spans every
    // account, so the shared folder open beforehand must not pin the search.
    expect(
      resolveSearchScope({
        mailboxes,
        selectedMailbox: 'owner-x:x-inbox',
        searchMailboxId: '',
        selectedKeyword: 'red',
      }),
    ).toEqual({ jmapMailboxId: '', accountId: undefined });
  });

  it('still honours an explicitly picked folder inside a tag view', () => {
    expect(
      resolveSearchScope({
        mailboxes,
        selectedMailbox: 'inbox',
        searchMailboxId: 'owner-x:x-inbox',
        selectedKeyword: 'red',
      }),
    ).toEqual({ jmapMailboxId: 'x-inbox', accountId: 'owner-x' });
  });

  it('is unscoped with no folder open at all', () => {
    expect(
      resolveSearchScope({ mailboxes, selectedMailbox: null, searchMailboxId: '' }),
    ).toEqual({ jmapMailboxId: '', accountId: undefined });
  });
});

describe('resolveUnstampedEmailAccountId (#923)', () => {
  // A search now runs against the account whose folder is open, so its hits
  // belong to that account: the selected folder decides here too, with no
  // special case for an unscoped search.
  it('opens a hit from a shared folder in the shared owner', () => {
    expect(
      resolveUnstampedEmailAccountId({ mailboxes, selectedMailbox: 'owner-x:x-inbox' }),
    ).toBe('owner-x');
  });

  it('opens a hit from an own folder in the own account', () => {
    expect(
      resolveUnstampedEmailAccountId({ mailboxes, selectedMailbox: 'inbox' }),
    ).toBeUndefined();
  });
});
