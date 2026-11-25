import { describe, expect, it } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';
import { parseSharedSentFoldersKey, sharedSentFoldersKey } from '../shared-sent-folders';

const box = (fields: Partial<Mailbox>) => ({ name: 'x', ...fields }) as Mailbox;

describe('sharedSentFoldersKey', () => {
  const mailboxes = [
    box({ id: 'sent', role: 'sent', accountId: 'me', isShared: false }),
    box({ id: 'B:s', originalId: 's', role: 'sent', accountId: 'B', isShared: true }),
    box({ id: 'A:inbox', originalId: 'inbox', role: 'inbox', accountId: 'A', isShared: true }),
    box({ id: 'A:sent', originalId: 'sent-a', role: 'sent', accountId: 'A', isShared: true, totalEmails: 3 }),
  ];

  it("collects the shared accounts' Sent folders with their raw ids, leaving out the own one", () => {
    expect(parseSharedSentFoldersKey(sharedSentFoldersKey(mailboxes))).toEqual([
      { accountId: 'A', mailboxId: 'sent-a' },
      { accountId: 'B', mailboxId: 's' },
    ]);
  });

  it('stays the same when only counts or the order change', () => {
    const recounted = [...mailboxes].reverse().map((m) => ({ ...m, totalEmails: (m.totalEmails ?? 0) + 1 }));
    expect(sharedSentFoldersKey(recounted)).toBe(sharedSentFoldersKey(mailboxes));
  });

  it('is empty without shared Sent folders', () => {
    expect(sharedSentFoldersKey([mailboxes[0], mailboxes[2]])).toBe('');
    expect(parseSharedSentFoldersKey('')).toEqual([]);
  });
});
