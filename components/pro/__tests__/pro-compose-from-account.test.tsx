import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

/**
 * The Pro shell hoists every "show composer" intent - including `mailto:`
 * links - into a compose tab, and that tab rendered `<EmailComposer />`
 * without `composeFromAccountEmail`. Only the standard shell in
 * `components/mail/mail-app.tsx` passed it, so in Pro `mode === 'compose'`
 * resolved `findComposeIdentityId(identities, undefined)` to null and every
 * new message defaulted to the account owner - even with a shared folder open.
 */

const composerProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

// Stub the composer down to a prop recorder: what reaches it is the contract
// under test.
vi.mock('@/components/email/email-composer', () => ({
  EmailComposer: (props: Record<string, unknown>) => {
    composerProps.current = props;
    return React.createElement('div', { 'data-testid': 'composer' });
  },
}));

vi.mock('@/components/error', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  ComposerErrorFallback: () => null,
}));

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
const { toastWarning } = vi.hoisted(() => ({ toastWarning: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast: { error: () => {}, success: () => {}, warning: toastWarning } }));

const { emailState, authState } = vi.hoisted(() => ({
  emailState: {
    sendEmail: async () => ({ scheduled: false }),
    refreshCurrentMailbox: async () => {},
    fetchScheduledEmails: async () => {},
    refreshScheduledMetadata: async () => {},
    isScheduledView: false,
    emails: [],
    expandedThreadIds: new Set<string>(),
    threadEmailsCache: new Map(),
    mailboxes: [] as Array<{ id: string; isShared?: boolean; accountName?: string }>,
    selectedMailbox: null as string | null,
    viewingAccountId: null as string | null,
  },
  authState: {
    client: { getAccountId: () => 'jmap-1' },
    activeAccountId: 'local-1',
    getClientForAccount: () => undefined,
  },
}));

vi.mock('@/stores/email-store', () => {
  const hook = (sel?: (s: typeof emailState) => unknown) =>
    typeof sel === 'function' ? sel(emailState) : emailState;
  hook.getState = () => emailState;
  hook.setState = () => {};
  return { useEmailStore: hook };
});

vi.mock('@/stores/auth-store', () => {
  const hook = (sel?: (s: typeof authState) => unknown) =>
    typeof sel === 'function' ? sel(authState) : authState;
  hook.getState = () => authState;
  return { useAuthStore: hook };
});

vi.mock('@/stores/account-store', () => {
  const state = {
    getAccountById: (id: string) =>
      id === 'local-1' ? { id: 'local-1', email: 'owner@example.com' } : undefined,
  };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  return { useAccountStore: hook };
});

vi.mock('@/stores/pro-tab-store', () => {
  const state = { closeTab: () => {}, updateTabTitle: () => {}, updateComposeDraft: () => {} };
  const hook = (sel?: (s: typeof state) => unknown) =>
    typeof sel === 'function' ? sel(state) : state;
  hook.getState = () => state;
  return { useProTabStore: hook, registerProTabCloseInterceptor: () => () => {} };
});

import { ProComposeTabBody } from '../pro-compose-tab-body';

const TAB_DATA = { sessionId: 1, mode: 'compose' as const, title: 'New message' };

describe('Pro compose tab - From defaults to the open mailbox', () => {
  beforeEach(() => {
    composerProps.current = null;
    emailState.mailboxes = [];
    emailState.selectedMailbox = null;
    emailState.viewingAccountId = null;
  });

  it('passes the shared folder owner as the compose account', () => {
    emailState.mailboxes = [{ id: 'mb-shared', isShared: true, accountName: 'info@example.com' }];
    emailState.selectedMailbox = 'mb-shared';

    render(<ProComposeTabBody tabId="tab-1" data={TAB_DATA} />);

    expect(composerProps.current?.composeFromAccountEmail).toBe('info@example.com');
  });

  // Control: on the user's own folder the prop must still resolve to the
  // active account, so the test above is proving the shared-folder path and
  // not just "some address gets passed".
  it('passes the active account on an own folder', () => {
    emailState.mailboxes = [{ id: 'mb-inbox' }];
    emailState.selectedMailbox = 'mb-inbox';

    render(<ProComposeTabBody tabId="tab-1" data={TAB_DATA} />);

    expect(composerProps.current?.composeFromAccountEmail).toBe('owner@example.com');
  });
});

/**
 * A send undone from a group identity is back in the group account's Drafts,
 * and email ids repeat across accounts (Stalwart 1.0 and 0.16.23). The tab
 * removes the draft where it lives, through the login it was saved with.
 */
describe('Pro compose tab - a draft that lives in a group account', () => {
  const saved = { client: authState.client, getClientForAccount: authState.getClientForAccount, sendEmail: emailState.sendEmail };
  const activeClient = { getAccountId: () => 'jmap-1', deleteEmail: vi.fn().mockResolvedValue(undefined) };
  const secondLogin = { getAccountId: () => 'e', deleteEmail: vi.fn().mockResolvedValue(undefined) };

  beforeEach(() => {
    composerProps.current = null;
    activeClient.deleteEmail.mockClear();
    secondLogin.deleteEmail.mockClear();
    Object.assign(authState, {
      client: activeClient,
      getClientForAccount: (id: string) => (id === 'local-2' ? secondLogin : undefined),
    });
  });

  afterEach(() => {
    Object.assign(authState, { client: saved.client, getClientForAccount: saved.getClientForAccount });
    emailState.sendEmail = saved.sendEmail;
  });

  it('discards the draft in its account, through the login it was saved with', async () => {
    render(<ProComposeTabBody tabId="tab-1" data={TAB_DATA} />);
    const onDiscardDraft = composerProps.current?.onDiscardDraft as (id: string, draft?: { accountId?: string; localAccountId?: string }) => Promise<void>;

    await onDiscardDraft('eaaaaab', { accountId: 'c', localAccountId: 'local-2' });
    expect(secondLogin.deleteEmail).toHaveBeenCalledWith('eaaaaab', 'c');
    expect(activeClient.deleteEmail).not.toHaveBeenCalled();

    // An own draft of the active login, as before.
    await onDiscardDraft('draft-1');
    expect(activeClient.deleteEmail).toHaveBeenCalledWith('draft-1', undefined);
  });

  it('passes the draft account on to the send', async () => {
    const sendEmail = vi.fn().mockResolvedValue({ scheduled: false });
    emailState.sendEmail = sendEmail;
    render(<ProComposeTabBody tabId="tab-1" data={TAB_DATA} />);
    const onSend = composerProps.current?.onSend as (data: Record<string, unknown>) => Promise<void>;

    await onSend({ to: ['bob@example.com'], cc: [], bcc: [], subject: 'Hi', body: 'Hi', draftId: 'eaaaaab', draftAccountId: 'c' });

    // (client, to, subject, body, cc, bcc, identityId, fromEmail, draftId, ..., options)
    expect(sendEmail.mock.calls[0][8]).toBe('eaaaaab');
    // The options are composerSendOptions, the same object the mail page sends
    // (read receipt, DSN, priority, headers, outbox for offline mode #523).
    expect(sendEmail.mock.calls[0][16]).toMatchObject({ localAccountId: undefined, draftAccountId: 'c', outbox: true });
  });
});

// Stalwart 0.16 and 1.0 refuse a recipient at RCPT (relay not allowed, a
// used-up throttle) while the send goes to the others.
describe('Pro compose tab - recipients the server refused', () => {
  const saved = emailState.sendEmail;

  afterEach(() => {
    emailState.sendEmail = saved;
    toastWarning.mockClear();
  });

  it('says which recipients never get the message', async () => {
    emailState.sendEmail = vi.fn().mockResolvedValue({
      scheduled: false,
      rejectedRecipients: [{ email: 'nobody@example.net', smtpReply: '550 5.1.2 Relay not allowed.' }],
    });
    render(<ProComposeTabBody tabId="tab-1" data={TAB_DATA} />);
    const onSend = composerProps.current?.onSend as (data: Record<string, unknown>) => Promise<void>;

    await onSend({ to: ['bob@example.org', 'nobody@example.net'], cc: [], bcc: [], subject: 'Hi', body: 'Hi' });

    expect(toastWarning).toHaveBeenCalledWith('email_composer.recipients_partly_refused');
  });
});
