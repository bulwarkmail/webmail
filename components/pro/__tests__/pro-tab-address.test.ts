import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Email, Mailbox } from '@/lib/jmap/types';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { droppedEmailTabs, droppedFolderTab, emailTabPath, mailTabPath } from '../pro-tab-address';

// The Pro shell's address names a message with its login and account, so a
// reload opens that message and not one of another account or login with
// the same id. Here the team's Inbox (`ce`) is listed by login A, whose own
// account is `cf`, and login B (`bf`) has a message with the same id too.

const ID = 'eaaaaab';
const folders = [
  { id: 'a', name: 'Inbox', role: 'inbox', accountId: 'cf', isShared: false },
  { id: 'ce:a', originalId: 'a', name: 'Inbox', role: 'inbox', accountId: 'ce', isShared: true },
] as unknown as Mailbox[];
const row = (stamps: Partial<Email> = {}) => ({ id: ID, threadId: 't', subject: 'Order', receivedAt: '2026-11-11T10:00:00Z', keywords: {}, mailboxIds: { a: true }, ...stamps }) as Email;
const clientOf = (account: string) => ({ getAccountId: () => account });

const original = { auth: useAuthStore.getState(), email: useEmailStore.getState(), accounts: useAccountStore.getState().accounts };

beforeEach(() => {
  useAccountStore.setState({ accounts: [] });
  const a = clientOf('cf');
  useAuthStore.setState({
    activeAccountId: 'login-a', client: a as never,
    getClientForAccount: (id: string) => (id === 'login-a' ? a : id === 'login-b' ? clientOf('bf') : undefined) as never,
  } as never);
  useEmailStore.setState({
    mailboxes: folders, accountMailboxes: {}, viewingAccountId: null, selectedMailbox: 'ce:a',
    isUnifiedView: false, isScheduledView: false, searchQuery: '', searchMailboxId: '', emails: [],
  } as never);
});
afterEach(() => {
  useAuthStore.setState(original.auth);
  useEmailStore.setState(original.email);
  useAccountStore.setState({ accounts: original.accounts });
});

describe('the address of a Pro message tab', () => {
  it('names the login and the account of the tab', () => {
    expect(emailTabPath({ accountId: 'ce', clientAccountId: 'login-a', emailId: ID, mailboxId: null, title: '' }))
      .toBe(`/mail/message/${ID}?account=login-a&owner=ce`);
    expect(emailTabPath({ accountId: '', clientAccountId: 'login-b', emailId: ID, mailboxId: null, title: '' }))
      .toBe(`/mail/message/${ID}?account=login-b`);
  });

  it('names the only login for a tab that came without one', () => {
    expect(emailTabPath({ accountId: '', emailId: ID, mailboxId: null, title: '' })).toBe(`/mail/message/${ID}?account=login-a`);
  });

  it('names no login for such a tab while several logins are signed in', () => {
    useAccountStore.setState({ accounts: [{ id: 'login-a' }, { id: 'login-b' }] as never });
    expect(emailTabPath({ accountId: '', emailId: ID, mailboxId: null, title: '' })).toBe(`/mail/message/${ID}`);
    // A tab that names its login is not affected.
    expect(emailTabPath({ accountId: '', clientAccountId: 'login-b', emailId: ID, mailboxId: null, title: '' }))
      .toBe(`/mail/message/${ID}?account=login-b`);
  });
});

describe('a folder dragged from the sidebar onto the Pro shell', () => {
  it('opens a tab that names the active login for one of its own folders', () => {
    expect(droppedFolderTab({ mailboxId: 'a', name: 'Inbox', accountId: null }))
      .toEqual({ accountId: 'login-a', mailboxId: 'a', title: 'Inbox' });
  });

  it('keeps the login the sidebar named for another login\'s folder', () => {
    expect(droppedFolderTab({ mailboxId: 'a', name: 'Inbox', accountId: 'login-b' }))
      .toEqual({ accountId: 'login-b', mailboxId: 'a', title: 'Inbox' });
  });

  it('opens nothing while no login is active', () => {
    useAuthStore.setState({ activeAccountId: null } as never);
    expect(droppedFolderTab({ mailboxId: 'a', name: 'Inbox', accountId: null })).toBeNull();
  });
});

describe('the address of the Mail tab', () => {
  it('names the login and the team account of a message open from the team Inbox', () => {
    expect(mailTabPath('ce:a', row(), folders)).toBe(`/mail/message/${ID}?account=login-a&owner=ce`);
  });

  it('names the login of a message of another login in a list that mixes accounts', () => {
    expect(mailTabPath('__unified_inbox__', row({ sourceClientAccountId: 'login-b', sourceAccountId: 'bf' }), folders))
      .toBe(`/mail/message/${ID}?account=login-b`);
  });
});

describe('messages dragged onto the Pro shell', () => {
  it('open with the login and account of their row', () => {
    useEmailStore.setState({ emails: [row()] } as never);
    expect(droppedEmailTabs([ID], 'New')).toEqual([{ accountId: 'ce', clientAccountId: 'login-a', emailId: ID, mailboxId: null, title: 'Order' }]);
  });

  it('open nothing for an id that two rows have', () => {
    useEmailStore.setState({
      isUnifiedView: true, selectedMailbox: '__unified_inbox__',
      emails: [row({ sourceClientAccountId: 'login-a', sourceAccountId: 'cf' }), row({ sourceClientAccountId: 'login-b', sourceAccountId: 'bf' })],
    } as never);
    expect(droppedEmailTabs([ID], 'New')).toEqual([]);
  });
});
