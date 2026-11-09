import { describe, expect, it } from 'vitest';
import { trashRestoreTarget } from '../trash-restore-target';
import type { Email, Mailbox } from '@/lib/jmap/types';

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox' },
  { id: 'sent', name: 'Sent', role: 'sent' },
  { id: 'drafts', name: 'Drafts', role: 'drafts' },
  { id: 'trash', name: 'Trash', role: 'trash' },
  { id: 'b:inbox', name: 'Inbox', role: 'inbox', accountId: 'b', isShared: true },
] as unknown as Mailbox[];
const identities = [{ email: 'Robin@example.org' }];
const mail = (from: string, keywords: Record<string, boolean> = {}) =>
  ({ from: [{ email: from }], keywords }) as unknown as Email;

describe('trashRestoreTarget', () => {
  it('puts received mail back in the Inbox', () => {
    expect(trashRestoreTarget(mail('dave@example.net'), mailboxes, identities)?.id).toBe('inbox');
  });

  it('puts your own mail back in Sent and drafts back in Drafts', () => {
    expect(trashRestoreTarget(mail('robin@example.org'), mailboxes, identities)?.id).toBe('sent');
    expect(trashRestoreTarget(mail('robin@example.org', { $draft: true }), mailboxes, identities)?.id).toBe('drafts');
  });

  it("uses the message's own account", () => {
    expect(trashRestoreTarget(mail('dave@example.net'), mailboxes, identities, 'b')?.id).toBe('b:inbox');
  });

  it('falls back to the Inbox when the folder is missing', () => {
    const noSent = mailboxes.filter((m) => m.role !== 'sent');
    expect(trashRestoreTarget(mail('robin@example.org'), noSent, identities)?.id).toBe('inbox');
  });
});
