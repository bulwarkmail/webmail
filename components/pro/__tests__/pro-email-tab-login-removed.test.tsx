import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Email } from '@/lib/jmap/types';

/**
 * A Pro message tab of login B while login A is active. Login B is signed
 * out: the tab shows nothing of B's message any more, and its actions can't
 * reach anything, since A holds a message with the same id.
 */

const viewerProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('@/components/email/email-viewer', () => ({
  EmailViewer: (props: Record<string, unknown>) => {
    viewerProps.current = props;
    return <div>{(props.email as Email | null)?.subject}</div>;
  },
}));
vi.mock('@/components/error', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  EmailViewerErrorFallback: () => null,
}));
vi.mock('next-intl', () => ({ useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key), useLocale: () => 'en' }));

import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { useEmailStore } from '@/stores/email-store';
import { ProEmailTabBody } from '../pro-email-tab-body';

const ID = 'eaaaaab';
const message = (subject: string) => ({
  id: ID, threadId: 't', subject, receivedAt: '2026-11-11T10:00:00Z', keywords: {}, mailboxIds: { a: true },
  from: [{ email: 'sam@example.org' }], to: [{ email: 'me@example.org' }],
  bodyValues: {}, textBody: [], htmlBody: [], attachments: [], size: 10,
}) as unknown as Email;
const entry = (username: string, isDefault: boolean) => ({
  label: username, serverUrl: 'https://mail.example.org', username, authMode: 'basic' as const,
  rememberMe: false, displayName: username, email: username, lastLoginAt: 0,
  isConnected: true, hasError: false, isDefault,
});
const client = (account: string, subject: string) => ({
  getAccountId: () => account, getUsername: () => `${account}@example.org`, getServerUrl: () => 'https://mail.example.org',
  getEmail: vi.fn(async () => message(subject)), getThreadEmails: vi.fn(async () => []), getThread: vi.fn(async () => null),
  getIdentities: vi.fn(async () => []),
  moveToTrash: vi.fn(async () => {}), toggleStar: vi.fn(async () => {}), markAsRead: vi.fn(async () => {}),
});

const original = { auth: useAuthStore.getState(), email: useEmailStore.getState(), accounts: useAccountStore.getState() };

describe('a Pro message tab of a login that is signed out', () => {
  let a: string;
  let b: string;
  let active: ReturnType<typeof client>;
  let connected: Map<string, ReturnType<typeof client>>;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    viewerProps.current = null;
    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
    a = useAccountStore.getState().addAccount(entry('a@example.org', true));
    b = useAccountStore.getState().addAccount(entry('b@example.org', false));
    useAccountStore.getState().setActiveAccount(a);
    active = client('ee', 'A note');
    connected = new Map([[a, active], [b, client('ef', 'B payroll')]]);
    // One lookup for the whole test, as the store's own: only the table behind it changes.
    const lookup = (id: string) => connected.get(id) as never;
    useAuthStore.setState({ isAuthenticated: true, activeAccountId: a, client: active as never, getClientForAccount: lookup } as never);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useAuthStore.setState(original.auth);
    useEmailStore.setState(original.email);
    useAccountStore.setState(original.accounts);
  });

  it('shows nothing of its message once the login is gone', async () => {
    render(<ProEmailTabBody tabId="t1" data={{ accountId: 'ef', clientAccountId: b, emailId: ID, mailboxId: 'a', title: 'B payroll' }} />);
    await waitFor(() => expect(screen.getByText('B payroll')).toBeTruthy());

    act(() => {
      connected.delete(b);
      useAuthStore.getState().removeAccount(b);
    });

    expect(screen.queryByText('B payroll')).toBeNull();
    expect(screen.queryByText('A note')).toBeNull();
    expect(screen.getByText('notifications.not_connected')).toBeTruthy();
    expect(active.getEmail).not.toHaveBeenCalled();
  });
});
