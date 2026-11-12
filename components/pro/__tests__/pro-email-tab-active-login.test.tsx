import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';

/**
 * A Pro message tab that names the active login, at a moment when the login
 * table has no entry for it (the auth store's `client` is all there is: the
 * device-only clients were just dropped for a reconnect). The tab names its
 * login, so it reads its message through that login from the login's own
 * account, whatever the Mail tab lists, and writes there.
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
vi.mock('next-intl', () => ({ useTranslations: (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key), useLocale: () => 'en' }));
vi.mock('@/lib/mail-removal-confirm', () => ({ confirmMailRemoval: async () => true }));
vi.mock('@/hooks/use-confirm-dialog', () => ({ useConfirmDialog: () => ({ dialogProps: {}, confirm: async () => true }) }));
vi.mock('@/components/ui/confirm-dialog', () => ({ ConfirmDialog: () => null }));
vi.mock('@/lib/popout/moved-undo', () => ({ offerMoveUndo: async () => {} }));

import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { ProEmailTabBody } from '../pro-email-tab-body';

const OWN = 'ee';
const GROUP = 'ed';
const ID = 'eaaaaab';

function folder(id: string, role: string | null, accountId: string, shared: boolean): Mailbox {
  return {
    id: shared ? `${accountId}:${id}` : id, originalId: id, name: role ?? id, role, accountId,
    accountName: shared ? 'Team' : undefined, isShared: shared, sortOrder: 0,
    totalEmails: 1, unreadEmails: 1, totalThreads: 1, unreadThreads: 1, isSubscribed: true,
    myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true },
  } as unknown as Mailbox;
}
const FOLDERS = [
  folder('a', 'inbox', OWN, false), folder('b', 'trash', OWN, false),
  folder('a', 'inbox', GROUP, true), folder('b', 'trash', GROUP, true),
];
function message(subject: string): Email {
  return {
    id: ID, threadId: `t-${subject}`, subject, receivedAt: '2026-11-11T10:00:00Z', keywords: {},
    mailboxIds: { a: true }, from: [{ email: 'sam@example.org', name: 'Sam' }], to: [{ email: 'me@example.org' }],
    bodyValues: { '1': { value: subject } }, textBody: [{ partId: '1', type: 'text/plain' }],
    htmlBody: [{ partId: '1', type: 'text/plain' }], attachments: [], size: 10,
  } as unknown as Email;
}

const original = { auth: useAuthStore.getState(), email: useEmailStore.getState(), settings: useSettingsStore.getState() };

describe('a Pro message tab of the active login while the login table has no entry for it', () => {
  const messages: Record<string, Email> = { [OWN]: message('OWN private note'), [GROUP]: message('TEAM customer order') };
  let active: Record<string, ReturnType<typeof vi.fn>> & { getAccountId: () => string };

  beforeEach(() => {
    viewerProps.current = null;
    active = {
      getAccountId: () => OWN,
      getUsername: vi.fn(() => 'a@example.org'),
      getServerUrl: vi.fn(() => 'https://work.example'),
      getEmail: vi.fn(async (_id: string, accountId?: string) => messages[accountId ?? OWN] ?? null),
      moveToTrash: vi.fn(async () => {}), markAsRead: vi.fn(async () => {}), toggleStar: vi.fn(async () => {}),
      getThreadEmails: vi.fn(async () => []), getThread: vi.fn(async () => null),
    } as never;
    useAuthStore.setState({
      activeAccountId: 'login-a',
      client: active as never,
      // No entry for the active login just now.
      getClientForAccount: () => undefined as never,
    } as never);
    useSettingsStore.setState({ deleteAction: 'trash' } as never);
    // The Mail tab lists the team's Inbox, rows unstamped.
    useEmailStore.setState({
      isUnifiedView: false, viewingAccountId: null, selectedKeyword: null, searchQuery: '',
      mailboxes: FOLDERS, accountMailboxes: {},
      selectedMailbox: `${GROUP}:a`,
      emails: [message('TEAM customer order')], selectedEmail: null, selectedEmailKeys: new Set(),
      processingReadStatus: new Set(), threadEmailsCache: new Map(), expandedThreadIds: new Set(),
    } as never);
  });

  afterEach(() => {
    cleanup();
    useAuthStore.setState(original.auth);
    useEmailStore.setState(original.email);
    useSettingsStore.setState(original.settings);
  });

  it('shows the login\'s own message, not the team message listed in the Mail tab', async () => {
    // As a row double-clicked in the own Inbox opens it (and as it is restored after a reload).
    render(<ProEmailTabBody tabId="t1" data={{ accountId: '', clientAccountId: 'login-a', emailId: ID, mailboxId: 'a', title: 'OWN private note' }} />);
    await waitFor(() => expect(viewerProps.current?.email).toBeTruthy());
    expect((viewerProps.current!.email as Email).subject).toBe('OWN private note');
  });

  it('Delete in it goes to the own account', async () => {
    render(<ProEmailTabBody tabId="t1" data={{ accountId: '', clientAccountId: 'login-a', emailId: ID, mailboxId: 'a', title: 'OWN private note' }} />);
    await waitFor(() => expect(viewerProps.current?.email).toBeTruthy());
    await act(async () => { await (viewerProps.current as { onDelete: () => Promise<void> }).onDelete(); });
    const accounts = active.moveToTrash.mock.calls.map((call: unknown[]) => call[2] ?? OWN);
    expect(accounts).not.toContain(GROUP);
  });
});
