import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';

// A Pro compose tab acts on the message it answers, and on its draft, in the
// login and account they are in. Email ids repeat across accounts and
// servers, so the active login's client would act on its own namesake.

const { activeClient, otherClient, markEmailKeyword, toastError, sendResult } = vi.hoisted(() => {
  const makeClient = (label: string) => ({
    label,
    getAccountId: () => `jmap-${label}`,
    deleteEmail: vi.fn(async () => {}),
    getThreadEmails: async () => [],
  });
  return {
    activeClient: makeClient('account-1'),
    otherClient: makeClient('account-2'),
    markEmailKeyword: vi.fn(async () => {}),
    toastError: vi.fn(),
    sendResult: { scheduled: false },
  };
});

vi.mock('@/components/email/email-composer', () => ({
  EmailComposer: ({ onSend, onDiscardDraft }: {
    onSend?: (d: Record<string, unknown>) => Promise<unknown>;
    onDiscardDraft?: (id: string, draft?: { accountId?: string; localAccountId?: string }) => void;
  }) => React.createElement('div', null,
    React.createElement('button', { onClick: () => { void onSend?.({ to: ['c@example.org'], cc: [], bcc: [], subject: 'Re', body: 'x' }); } }, 'send'),
    React.createElement('button', { onClick: () => onDiscardDraft?.('maaaaad', { accountId: 'jmap-account-2', localAccountId: 'local-2' }) }, 'discard'),
  ),
}));
vi.mock('@/components/error', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  ComposerErrorFallback: () => null,
}));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/stores/toast-store', () => ({ toast: { error: toastError, success: () => {}, warning: () => {} } }));

const auth = vi.hoisted(() => ({ connected: new Set(['local-2']) }));
vi.mock('@/stores/auth-store', () => {
  const state = {
    client: activeClient,
    activeAccountId: 'local-1',
    getClientForAccount: (id: string) => (id === 'local-2' && auth.connected.has(id) ? otherClient : undefined),
  };
  const hook = (sel?: (s: typeof state) => unknown) => (typeof sel === 'function' ? sel(state) : state);
  hook.getState = () => state;
  return { useAuthStore: hook };
});
vi.mock('@/stores/email-store', () => {
  const state = {
    sendEmail: async () => ({ ...sendResult }),
    markEmailKeyword,
    refreshCurrentMailbox: async () => {},
    fetchScheduledEmails: async () => {},
    refreshScheduledMetadata: async () => {},
    isScheduledView: false,
    emails: [],
    expandedThreadIds: new Set<string>(),
    threadEmailsCache: new Map(),
  };
  const hook = (sel?: (s: typeof state) => unknown) => (typeof sel === 'function' ? sel(state) : state);
  hook.getState = () => state;
  hook.setState = () => {};
  return { useEmailStore: hook };
});
vi.mock('@/stores/pro-tab-store', () => {
  const state = { closeTab: () => {}, updateTabTitle: () => {}, updateComposeDraft: () => {} };
  const hook = (sel?: (s: typeof state) => unknown) => (typeof sel === 'function' ? sel(state) : state);
  hook.getState = () => state;
  return { useProTabStore: hook, registerProTabCloseInterceptor: () => () => {} };
});

import { ProComposeTabBody } from '../pro-compose-tab-body';

beforeEach(() => {
  markEmailKeyword.mockClear();
  sendResult.scheduled = false;
  toastError.mockClear();
  activeClient.deleteEmail.mockClear();
  otherClient.deleteEmail.mockClear();
  auth.connected = new Set(['local-2']);
});

describe('Pro compose tab', () => {
  it('flags the answered message in the login and account the reply started from', async () => {
    const source = { clientAccountId: 'local-2', accountId: 'jmap-group' };
    render(<ProComposeTabBody tabId="t" data={{ sessionId: 1, mode: 'reply', title: 'Re', sourceEmailId: 'eaaaaab', sourceEmailSource: source }} />);

    fireEvent.click(screen.getByText('send'));

    await waitFor(() => expect(markEmailKeyword).toHaveBeenCalled());
    expect(markEmailKeyword).toHaveBeenCalledWith(activeClient, 'eaaaaab', '$answered', source);
  });

  // A send delay (undo send) makes every send a held submission, so the
  // flag has to be set before the held send returns, as in the inline composer (#985).
  it.each([['reply', '$answered'], ['forward', '$forwarded']] as const)('flags the source of a held %s', async (mode, keyword) => {
    sendResult.scheduled = true;
    const source = { clientAccountId: 'local-2', accountId: 'jmap-group' };
    render(<ProComposeTabBody tabId="t" data={{ sessionId: 1, mode, title: 'Re', sourceEmailId: 'eaaaaab', sourceEmailSource: source }} />);

    fireEvent.click(screen.getByText('send'));

    await waitFor(() => expect(markEmailKeyword).toHaveBeenCalled());
    expect(markEmailKeyword).toHaveBeenCalledWith(activeClient, 'eaaaaab', keyword, source);
  });

  it('discards the draft through the login that saved it', async () => {
    render(<ProComposeTabBody tabId="t" data={{ sessionId: 1, mode: 'compose', title: 'New' }} />);

    fireEvent.click(screen.getByText('discard'));

    await waitFor(() => expect(otherClient.deleteEmail).toHaveBeenCalledWith('maaaaad', 'jmap-account-2'));
    expect(activeClient.deleteEmail).not.toHaveBeenCalled();
  });

  it('leaves the draft alone, and says so, when the login that saved it is gone', async () => {
    auth.connected = new Set();
    render(<ProComposeTabBody tabId="t" data={{ sessionId: 1, mode: 'compose', title: 'New' }} />);

    fireEvent.click(screen.getByText('discard'));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('email_composer.discard_signed_out'));
    expect(activeClient.deleteEmail).not.toHaveBeenCalled();
    expect(otherClient.deleteEmail).not.toHaveBeenCalled();
  });
});
