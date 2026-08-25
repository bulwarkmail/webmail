import { describe, it, expect } from 'vitest';
import { resolveThreadRoute } from '../thread-routing';
import { makeEmail, makeMailbox } from './helpers/factories';

const ownInbox = makeMailbox({ id: 'inbox', role: 'inbox' });
const sharedInbox = makeMailbox({
  id: 'shared-acct-b__inbox',
  originalId: 'inbox',
  role: 'inbox',
  isShared: true,
  accountId: 'acct-b',
});
const mailboxes = [ownInbox, sharedInbox];

describe('resolveThreadRoute', () => {
  it('leaves the fetch unscoped for a folder in the user\'s own account', () => {
    expect(
      resolveThreadRoute({ isUnifiedView: false, ref: makeEmail(), mailboxes, selectedMailbox: 'inbox' })
    ).toEqual({ accountId: undefined });
  });

  // #814: thread ids are per-account, so a shared folder's thread id names a
  // different conversation in the user's own account. Without the owner the
  // fetch silently returns that unrelated thread.
  it('scopes the fetch to the owner when a shared folder is browsed directly', () => {
    expect(
      resolveThreadRoute({
        isUnifiedView: false,
        // Directly-browsed shared emails carry no source stamp.
        ref: makeEmail({ sourceClientAccountId: undefined, sourceAccountId: undefined }),
        mailboxes,
        selectedMailbox: 'shared-acct-b__inbox',
      })
    ).toEqual({ accountId: 'acct-b' });
  });

  it('prefers the email\'s own source stamp in aggregate views', () => {
    expect(
      resolveThreadRoute({
        isUnifiedView: true,
        ref: makeEmail({ sourceClientAccountId: 'login-a', sourceAccountId: 'acct-c' }),
        mailboxes,
        // Virtual in unified views, so it must not drive the routing.
        selectedMailbox: '__unified_inbox__',
      })
    ).toEqual({ clientAccountId: 'login-a', accountId: 'acct-c' });
  });

  it('falls back to the selected mailbox when an aggregate email is unstamped', () => {
    expect(
      resolveThreadRoute({
        isUnifiedView: true,
        ref: makeEmail({ sourceClientAccountId: 'login-a' }),
        mailboxes,
        selectedMailbox: 'shared-acct-b__inbox',
      })
    ).toEqual({ accountId: 'acct-b' });
  });

  it('tolerates a missing ref and an unknown mailbox', () => {
    expect(resolveThreadRoute({ isUnifiedView: false, mailboxes, selectedMailbox: null }))
      .toEqual({ accountId: undefined });
    expect(resolveThreadRoute({ isUnifiedView: true, ref: null, mailboxes, selectedMailbox: 'gone' }))
      .toEqual({ accountId: undefined });
  });
});
