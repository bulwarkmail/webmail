import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

/**
 * A reply, forward or forward-as-attachment from a Pro message view names the
 * login holding the message. The composer defaults its From to that account and
 * copies the original's parts from it; without the login it takes the message
 * for the active account's, so the reply goes out from the wrong account, or
 * fails on a blobId that account doesn't have (#1511).
 */

const viewerProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: (props: Record<string, unknown>) => {
    viewerProps.current = props;
    return null;
  },
}));
vi.mock('@/components/error', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  EmailViewerErrorFallback: () => null,
}));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/stores/toast-store', () => ({ toast: { error: () => {}, success: () => {} } }));
vi.mock('@/hooks/use-pro-multi-account-identities', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/hooks/use-pro-multi-account-identities')>(),
  useProMultiAccountIdentities: () => ({ enabled: true, groups: [], allIdentities: [] }),
}));

const { openComposeTab } = vi.hoisted(() => ({ openComposeTab: vi.fn() }));

function selectorStore<T extends object>(state: T) {
  const hook = (sel?: (s: T) => unknown) => (typeof sel === 'function' ? sel(state) : state);
  hook.getState = () => state;
  return hook;
}

const auth = vi.hoisted(() => ({
  state: { client: null as unknown, activeAccountId: 'login-a', getClientForAccount: () => undefined },
}));
vi.mock('@/stores/auth-store', () => ({ useAuthStore: selectorStore(auth.state) }));

const MESSAGE = vi.hoisted(() => ({
  id: 'eaaaaab',
  blobId: 'blob-of-message',
  threadId: 't1',
  mailboxIds: { inbox: true },
  keywords: { $seen: true },
  from: [{ email: 'sender@example.com', name: 'Sender' }],
  to: [{ email: 'b@example.org' }],
  subject: 'Hello',
  receivedAt: '2026-01-01T00:00:00Z',
  bodyValues: { '1': { value: '<img src="cid:logo">' } },
  textBody: [],
  htmlBody: [{ partId: '1', type: 'text/html' }],
  attachments: [{ blobId: 'blob-of-logo', name: 'logo.png', type: 'image/png', size: 10, cid: 'logo', disposition: 'inline' }],
}));

vi.mock('@/stores/email-store', () => ({
  resolveEmailBlobContext: (_email: unknown, client: unknown) => ({ client, clientAccountId: auth.state.activeAccountId }),
  useEmailStore: selectorStore({
    fetchEmailContent: async () => MESSAGE,
    deleteEmail: async () => {},
    markAsRead: async () => {},
    toggleStar: async () => {},
    moveToMailbox: async () => {},
    setEmailKeywordsLocal: () => {},
    mailboxes: [],
    emails: [],
    selectedEmail: null,
  }),
}));
vi.mock('@/stores/identity-store', () => ({ useIdentityStore: selectorStore({ identities: [] }) }));
vi.mock('@/stores/settings-store', () => ({ useSettingsStore: selectorStore({ emailDownloadTemplate: '' }) }));
vi.mock('@/stores/pro-tab-store', () => ({
  useProTabStore: selectorStore({ openComposeTab, closeTab: () => {}, updateTabTitle: () => {} }),
}));

import { ProEmailView } from '../pro-email-tab-body';

const ACTIONS = ['onReply', 'onReplyAll', 'onForward', 'onForwardAsAttachment'] as const;

async function open(props: { clientAccountId?: string; accountId?: string; override?: boolean }) {
  const client = { getEmail: vi.fn().mockResolvedValue(MESSAGE), getUsername: () => 'b@example.org', getAccountId: () => 'jmap-b' };
  const { override = true, ...rest } = props;
  if (!override) auth.state.client = client;
  const view = render(<ProEmailView emailId="eaaaaab" client={override ? client as never : undefined} {...rest} onClose={vi.fn()} />);
  await waitFor(() => expect(viewerProps.current?.email).toBeTruthy());
  return { ...view, client };
}

function composeFrom(action: typeof ACTIONS[number]) {
  openComposeTab.mockClear();
  (viewerProps.current![action] as () => void)();
  expect(openComposeTab).toHaveBeenCalledTimes(1);
  return openComposeTab.mock.calls[0][0].replyTo as Record<string, unknown>;
}

describe('compose actions of a Pro message view', () => {
  beforeEach(() => {
    viewerProps.current = null;
    openComposeTab.mockClear();
    auth.state.activeAccountId = 'login-a';
    auth.state.client = null;
  });

  it.each(ACTIONS)('%s of another login names that login', async (action) => {
    await open({ clientAccountId: 'login-b' });

    expect(composeFrom(action).accountId).toBe('login-b');
  });

  it.each(ACTIONS)('%s of a shared folder of another login names the login, not the owner', async (action) => {
    await open({ clientAccountId: 'login-b', accountId: 'jmap-team' });

    expect(composeFrom(action).accountId).toBe('login-b');
  });

  it.each(ACTIONS)('%s of the active login names the active login', async (action) => {
    await open({ override: false });

    expect(composeFrom(action).accountId).toBe('login-a');
  });

  it('keeps naming the login the message was read in after the active account changes', async () => {
    // A message of b isn't foreign while b is active, so it carries no stamp.
    auth.state.activeAccountId = 'login-b';
    const { rerender, client } = await open({ clientAccountId: 'login-b' });

    auth.state.activeAccountId = 'login-a';
    rerender(<ProEmailView emailId="eaaaaab" client={client as never} clientAccountId="login-b" onClose={vi.fn()} />);

    expect(composeFrom('onReply').accountId).toBe('login-b');
  });
});
