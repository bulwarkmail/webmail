import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';

// After a reply from a Pro compose tab, the answered message's conversation
// is read again when the Mail tab shows it expanded. The Mail tab may list
// another account's message with the same id and thread id (the team's
// Inbox while the reply answered the own message): that conversation is not
// the answered one, and the active login's thread must not be put in its
// place.

vi.mock('@/components/email/email-composer', () => ({
  EmailComposer: ({ onSend }: { onSend?: (d: Record<string, unknown>) => Promise<unknown> }) => (
    <button onClick={() => { void onSend?.({ to: ['c@example.org'], cc: [], bcc: [], subject: 'Re', body: 'x' }); }}>send</button>
  ),
}));
vi.mock('@/components/error', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  ComposerErrorFallback: () => null,
}));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

import { threadKeyFor } from '@/lib/thread-utils';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { ProComposeTabBody } from '../pro-compose-tab-body';

const ID = 'eaaaaab';
const THREAD = 'c';
const row = (stamps: Partial<Email> = {}): Email => ({
  id: ID, threadId: THREAD, subject: 'Hello', receivedAt: '2026-11-11T10:00:00Z', keywords: {}, mailboxIds: { a: true }, ...stamps,
}) as Email;
const folder = (id: string, accountId: string, shared = false): Mailbox => ({
  id: shared ? `${accountId}:${id}` : id, originalId: id, name: 'Inbox', role: 'inbox', accountId, isShared: shared,
}) as Mailbox;

const original = { auth: useAuthStore.getState(), email: useEmailStore.getState() };
let client: { getAccountId: () => string; getThreadEmails: ReturnType<typeof vi.fn> };
let markEmailKeyword: ReturnType<typeof vi.fn>;

beforeEach(() => {
  client = {
    getAccountId: () => 'ee',
    getThreadEmails: vi.fn(async (_threadId: string, accountId?: string) => [{ ...row(), subject: `thread of ${accountId}` } as Email]),
  };
  markEmailKeyword = vi.fn(async () => {});
  useAuthStore.setState({
    activeAccountId: 'login-a', client: client as never,
    getClientForAccount: ((id: string) => (id === 'login-a' ? client : undefined)) as never,
  } as never);
  useEmailStore.setState({
    sendEmail: vi.fn(async () => ({ scheduled: false })) as never,
    markEmailKeyword: markEmailKeyword as never,
    refreshCurrentMailbox: vi.fn(async () => {}) as never,
    isScheduledView: false, isUnifiedView: false, viewingAccountId: null, searchQuery: '',
    mailboxes: [folder('a', 'ee'), folder('a', 'ed', true)], accountMailboxes: {},
    threadEmailsCache: new Map(),
  } as never);
});
afterEach(() => {
  cleanup();
  useAuthStore.setState(original.auth);
  useEmailStore.setState(original.email);
});

const reply = async () => {
  render(<ProComposeTabBody tabId="t" data={{ sessionId: 1, mode: 'reply', title: 'Re', sourceEmailId: ID, sourceEmailSource: { clientAccountId: 'login-a', accountId: 'ee' } }} />);
  fireEvent.click(screen.getByText('send'));
  await waitFor(() => expect(markEmailKeyword).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 20));
};

describe('the conversation refreshed after a reply from a Pro compose tab', () => {
  it('is not the team conversation the Mail tab lists under the same ids', async () => {
    const teamRow = row();
    useEmailStore.setState({ selectedMailbox: 'ed:a', emails: [teamRow], expandedThreadIds: new Set([threadKeyFor(teamRow)]) } as never);

    await reply();

    expect(client.getThreadEmails).not.toHaveBeenCalled();
    expect(useEmailStore.getState().threadEmailsCache.size).toBe(0);
  });

  it('is the own conversation when the Mail tab lists the answered message itself', async () => {
    const ownRow = row();
    useEmailStore.setState({ selectedMailbox: 'a', emails: [ownRow], expandedThreadIds: new Set([threadKeyFor(ownRow)]) } as never);

    await reply();

    expect(client.getThreadEmails).toHaveBeenCalledWith(THREAD, 'ee');
    expect(useEmailStore.getState().threadEmailsCache.get(threadKeyFor(ownRow))?.[0]?.subject).toBe('thread of ee');
  });
});
