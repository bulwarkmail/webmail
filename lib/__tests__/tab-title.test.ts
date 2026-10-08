import { describe, expect, it } from 'vitest';
import { formatTabTitle, mailTitleContext } from '../tab-title';

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
