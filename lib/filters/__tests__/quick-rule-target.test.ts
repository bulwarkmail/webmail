import { describe, it, expect, beforeEach } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { knownListId, loadListIds, resolveQuickRuleTarget, sourceMailboxOf, type QuickRuleTarget } from '../quick-rule-target';

const client = {
  getAccountId: () => 'd',
  getSieveAccountId: () => 'd',
  supportsSieve: () => true,
};

// usera's own folders plus the Inbox of the group account `c` they belong to.
// Stalwart numbers each account's folders from `a`, so the group's Inbox has
// the same bare id as usera's; the store namespaces it as `c:a`.
const mailboxes = [
  { id: 'a', name: 'Inbox', role: 'inbox', parentId: null, myRights: { mayAddItems: true } },
  { id: 'h', name: 'Projects', role: null, parentId: null, myRights: { mayAddItems: true } },
  { id: 'c:a', originalId: 'a', name: 'Inbox', role: 'inbox', parentId: null, isShared: true, accountId: 'c', myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

function email(mailboxIds: Record<string, boolean>, stamps: Partial<Email> = {}): Email {
  return { id: 'e1', mailboxIds, from: [{ email: 'userb@example.org', name: '' }], keywords: {}, ...stamps } as unknown as Email;
}

describe('resolveQuickRuleTarget', () => {
  beforeEach(() => {
    useAuthStore.setState({ client, activeAccountId: 'login-a' } as never);
    useEmailStore.setState({ mailboxes, selectedMailbox: 'a', viewingAccountId: null, accountMailboxes: {} } as never);
  });

  it('treats a message in the own Inbox as own, although a group Inbox has the same bare id', () => {
    const target = resolveQuickRuleTarget(email({ a: true }));
    expect(target).toMatchObject({ shared: false, accountId: 'd', sieveAccountId: 'd', supportsSieve: true, clientAccountId: 'login-a' });
    expect(target!.mailboxes.map((m) => m.id)).toEqual(['a', 'h']);
  });

  it('treats a message in the group Inbox as shared', () => {
    useEmailStore.setState({ selectedMailbox: 'c:a' } as never);
    expect(resolveQuickRuleTarget(email({ 'c:a': true }))?.shared).toBe(true);
  });

  it('treats a stamped message of another account as shared', () => {
    expect(resolveQuickRuleTarget(email({ 'c:a': true }, { sourceAccountId: 'c', sourceClientAccountId: 'login-a' }))?.shared).toBe(true);
  });

  it('finds the folder the message is in', () => {
    const target = resolveQuickRuleTarget(email({ h: true }))!;
    expect(sourceMailboxOf(email({ h: true }), target)?.id).toBe('h');
    expect(sourceMailboxOf(email({ 'c:a': true }), target)).toBeUndefined();
  });
});

describe('List-Id of list rows', () => {
  it('uses the raw header when the server answers the text form with null', async () => {
    const getEmailFields = async (ids: string[]) => ids.map((id) => ({
      id,
      'header:List-Id:asText': null,
      'header:List-Id': id === 'list' ? ' Rules live list <rules-live.example.org>' : null,
    }));
    const target = { key: 'k-list', accountId: 'd', client: { getEmailFields } } as unknown as QuickRuleTarget;
    const rows = [email({ a: true }, { id: 'list' } as Partial<Email>), email({ a: true }, { id: 'plain' } as Partial<Email>)];
    expect(rows.map((e) => knownListId(target, e))).toEqual([undefined, undefined]);
    await loadListIds(target, rows);
    expect(rows.map((e) => knownListId(target, e))).toEqual(['rules-live.example.org', null]);
  });

  it('reads it from the headers an opened message carries, whatever their case', () => {
    const target = { key: 'k-open' } as unknown as QuickRuleTarget;
    const opened = email({ a: true }, { headers: { 'List-ID': ' News <news.example.org>', Subject: 'x' } } as Partial<Email>);
    expect(knownListId(target, opened)).toBe('news.example.org');
    const withoutList = email({ a: true }, { headers: { Subject: 'x' } } as Partial<Email>);
    expect(knownListId(target, withoutList)).toBeNull();
  });
});
