import { describe, expect, it } from 'vitest';
import { formatTabTitle, mailTitleContext, mailboxTitleLine } from '../tab-title';

describe('formatTabTitle', () => {
  it('puts the context first, the account next and the app name last', () => {
    expect(formatTabTitle('Inbox (3)', 'jane@example.com', 'Acme Mail')).toBe(
      'Inbox (3) - jane@example.com - Acme Mail',
    );
  });

  it('leaves out a missing account', () => {
    expect(formatTabTitle('Inbox', null, 'Acme Mail')).toBe('Inbox - Acme Mail');
    expect(formatTabTitle('Inbox', '', 'Acme Mail')).toBe('Inbox - Acme Mail');
  });

  it('leaves out a missing context', () => {
    expect(formatTabTitle(undefined, 'jane@example.com', 'Acme Mail')).toBe('jane@example.com - Acme Mail');
    expect(formatTabTitle('', 'jane@example.com', 'Acme Mail')).toBe('jane@example.com - Acme Mail');
  });

  it('falls back to the app name alone', () => {
    expect(formatTabTitle(null, null, 'Acme Mail')).toBe('Acme Mail');
  });
});

describe('mailTitleContext', () => {
  const view = { composer: 'Reply', subject: 'Quarterly report', mailbox: 'Inbox (3)' };

  // desktop-p2-5: the main window and a message window had the same title in the taskbar.
  it('names the desktop app main window by its folder, whatever is open in it', () => {
    expect(mailTitleContext(view, { desktopWindow: true })).toBe('Inbox (3)');
    expect(mailTitleContext({ ...view, composer: null }, { desktopWindow: true })).toBe('Inbox (3)');
  });

  it('names the composer while it is open', () => {
    expect(mailTitleContext(view)).toBe('Reply');
  });

  it('names the open message otherwise', () => {
    expect(mailTitleContext({ ...view, composer: null })).toBe('Quarterly report');
  });

  it('names the mailbox when no message is open', () => {
    expect(mailTitleContext({ mailbox: 'Inbox (3)' })).toBe('Inbox (3)');
  });

  it('has nothing to add before a mailbox is selected', () => {
    expect(mailTitleContext({})).toBeNull();
  });

  it('names the mailbox instead of the open message when the subject is kept out', () => {
    expect(mailTitleContext({ ...view, composer: null }, { showSubject: false })).toBe('Inbox (3)');
  });

  it('still names the composer when the subject is kept out', () => {
    expect(mailTitleContext(view, { showSubject: false })).toBe('Reply');
  });
});

describe('mailboxTitleLine', () => {
  const t = (key: string, values?: Record<string, string | number>) => `${key} ${JSON.stringify(values)}`;

  it('names the folder with its unread count', () => {
    expect(mailboxTitleLine({ name: 'Family', unread: 2 }, t)).toBe('Family (2)');
    expect(mailboxTitleLine({ name: 'Family', unread: 0 }, t)).toBe('Family');
  });

  // mail-6: the title said 10 while 30 were unread in all accounts.
  it('adds the other accounts on the Inbox', () => {
    expect(mailboxTitleLine({ name: 'Inbox', unread: 10, otherUnread: 20, ownInbox: true }, t))
      .toBe('mail_p2_folders.title_all_accounts {"name":"Inbox","count":10,"total":30}');
    expect(mailboxTitleLine({ name: 'Inbox', unread: 0, otherUnread: 20, ownInbox: true }, t))
      .toBe('mail_p2_folders.title_all_accounts_only {"name":"Inbox","total":20}');
  });

  it('leaves other folders and an Inbox with no other unread mail alone', () => {
    expect(mailboxTitleLine({ name: 'Family', unread: 1, otherUnread: 20 }, t)).toBe('Family (1)');
    expect(mailboxTitleLine({ name: 'Inbox', unread: 10, otherUnread: 0, ownInbox: true }, t)).toBe('Inbox (10)');
  });
});
