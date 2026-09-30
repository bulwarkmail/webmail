import { describe, expect, it } from 'vitest';
import { resolveUnstampedEmailAccountId } from '../email-store';
import type { Mailbox } from '@/lib/jmap/types';
import { SEARCH_SCOPE_ALL_FOLDERS } from '@/lib/search-scope-folders';

// #923: with an unscoped ("All folders") search active while a shared folder
// is selected, the hit belongs to the primary account. Deriving the owner
// from the selected shared folder made getEmail() look in the wrong account.

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', isShared: false },
  { id: 'owner-x:x-inbox', name: 'Shared Inbox', role: 'inbox', isShared: true, accountId: 'owner-x' },
] as unknown as Mailbox[];

describe('resolveUnstampedEmailAccountId (#923)', () => {
  it.each(['', SEARCH_SCOPE_ALL_FOLDERS])('uses the primary account for an unscoped search (%j) even with a shared folder selected', (scope) => {
    expect(
      resolveUnstampedEmailAccountId({
        mailboxes,
        selectedMailbox: 'owner-x:x-inbox',
        searchActive: true,
        searchMailboxId: scope,
      }),
    ).toBeUndefined();
  });

  it('keeps the shared owner when browsing the shared folder without a search', () => {
    expect(
      resolveUnstampedEmailAccountId({
        mailboxes,
        selectedMailbox: 'owner-x:x-inbox',
        searchActive: false,
        searchMailboxId: '',
      }),
    ).toBe('owner-x');
  });

  it('keeps the shared owner for a search scoped to the shared folder', () => {
    expect(
      resolveUnstampedEmailAccountId({
        mailboxes,
        selectedMailbox: 'owner-x:x-inbox',
        searchActive: true,
        searchMailboxId: 'owner-x:x-inbox',
      }),
    ).toBe('owner-x');
  });

  it('is undefined for an own folder', () => {
    expect(
      resolveUnstampedEmailAccountId({ mailboxes, selectedMailbox: 'inbox', searchActive: false, searchMailboxId: '' }),
    ).toBeUndefined();
  });
});
