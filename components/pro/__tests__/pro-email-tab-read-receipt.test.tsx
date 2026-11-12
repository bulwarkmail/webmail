import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';

/**
 * The read receipt banner of a message shown in a Pro message tab. "Ignore"
 * and "Send receipt" both end in a $mdnsent flag on the message, and "Send
 * receipt" sends a mail. Both belong to the login and account the tab read
 * the message from, whatever the Mail tab lists and whichever login is the
 * active one: ids repeat across accounts and logins.
 *
 * Rendered with the real reader (the banner and its handlers live in
 * components/email/email-viewer.tsx); the tab hands it the message and where
 * it was read.
 *
 * Belongs in components/pro/__tests__/.
 */

vi.mock('@/components/email/rules-menu', () => ({
  RulesPanel: () => null,
  useRulesAvailability: () => ({ availability: 'hidden', target: null }),
}));
vi.mock('@/hooks/use-media-query', () => ({
  useDeviceDetection: () => ({ isMobile: false, isTablet: false, isDesktop: true }),
  useMediaQuery: () => false,
  useIsDesktop: () => true,
}));
vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ activeTour: null, startTour: vi.fn(), endTour: vi.fn(), registerStep: vi.fn() }),
}));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/hooks/use-plugin-slot-offers', () => ({ usePluginSlotOffers: () => [] }));
vi.mock('@/components/error', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  EmailViewerErrorFallback: () => null,
}));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
const { ProEmailTabBody } = await import('../pro-email-tab-body');

const OWN = 'ee';
const GROUP = 'ed';
const OTHER = 'ef';
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
function message(subject: string, to: string): Email {
  return {
    id: ID, blobId: `blob-${subject}`, threadId: `t-${subject}`, subject, receivedAt: '2026-11-11T10:00:00Z',
    keywords: { $seen: true }, mailboxIds: { a: true },
    from: [{ email: 'sam@example.org', name: 'Sam' }], to: [{ email: to }],
    headers: { 'Disposition-Notification-To': 'Sam <sam@example.org>' },
    preview: subject, hasAttachment: false, size: 10,
    bodyValues: { '1': { value: subject, isTruncated: false } }, textBody: [{ partId: '1', type: 'text/plain' }],
    htmlBody: [], attachments: [],
  } as unknown as Email;
}

type Client = Record<string, ReturnType<typeof vi.fn>> & { getAccountId: () => string };
function makeClient(own: string, user: string, messages: Record<string, Email>): Client {
  return {
    getAccountId: () => own,
    getUsername: vi.fn(() => user),
    getServerUrl: vi.fn(() => 'https://work.example'),
    getEmail: vi.fn(async (_id: string, accountId?: string) => messages[accountId ?? own] ?? null),
    getMailboxes: vi.fn(async () => []),
    markAsRead: vi.fn(async () => {}),
    setKeyword: vi.fn(async () => {}),
    sendReadReceipt: vi.fn(async () => {}),
    getThreadEmails: vi.fn(async () => []), getThread: vi.fn(async () => null),
    supportsFiles: vi.fn(() => false),
  } as never;
}

const original = { auth: useAuthStore.getState(), email: useEmailStore.getState(), settings: useSettingsStore.getState() };

afterEach(() => {
  cleanup();
  useAuthStore.setState(original.auth);
  useEmailStore.setState(original.email);
  useSettingsStore.setState(original.settings);
  vi.restoreAllMocks();
});

describe('the read receipt banner in a Pro message tab while the Mail tab lists another account\'s folder', () => {
  let active: Client;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    active = makeClient(OWN, 'a@example.org', {
      [OWN]: message('OWN private note', 'a@example.org'),
      [GROUP]: message('TEAM customer order', 'team@example.org'),
    });
    useSettingsStore.setState({ readReceiptResponse: 'ask', deleteAction: 'trash' } as never);
    useAuthStore.setState({
      activeAccountId: 'login-a',
      client: active as never,
      identities: [{ id: 'b', email: 'a@example.org', name: 'A', mayDelete: false }] as never,
      getClientForAccount: ((id: string) => (id === 'login-a' ? active : undefined)) as never,
    } as never);
    // The Mail tab lists the team's Inbox, rows unstamped: the same id is the team's message there.
    useEmailStore.setState({
      isUnifiedView: false, viewingAccountId: null, selectedKeyword: null, searchQuery: '',
      mailboxes: FOLDERS, accountMailboxes: {},
      selectedMailbox: `${GROUP}:a`,
      emails: [message('TEAM customer order', 'team@example.org')], selectedEmail: null, selectedEmailKeys: new Set(),
      processingReadStatus: new Set(), threadEmailsCache: new Map(), expandedThreadIds: new Set(),
    } as never);
  });

  it('Ignore flags the tab\'s own message, not the team message with the same id', async () => {
    render(<ProEmailTabBody tabId="t1" data={{ accountId: '', clientAccountId: 'login-a', emailId: ID, mailboxId: 'a', title: 'OWN private note' }} />);
    const ignore = await screen.findByText('ignore');
    await act(async () => { fireEvent.click(ignore); });
    await waitFor(() => expect(active.setKeyword).toHaveBeenCalled());
    const accounts = active.setKeyword.mock.calls.map((call: unknown[]) => call[2] ?? OWN);
    expect(accounts).toEqual([OWN]);
  });

  it('Send receipt flags the tab\'s own message afterwards, not the team message', async () => {
    render(<ProEmailTabBody tabId="t1" data={{ accountId: '', clientAccountId: 'login-a', emailId: ID, mailboxId: 'a', title: 'OWN private note' }} />);
    await screen.findByText('ignore');
    const send = screen.getAllByText('send').find((el) => el.closest('button')?.parentElement?.textContent?.includes('ignore'))!;
    await act(async () => { fireEvent.click(send); });
    await waitFor(() => expect(active.setKeyword).toHaveBeenCalled());
    expect(active.sendReadReceipt).toHaveBeenCalledTimes(1);
    const accounts = active.setKeyword.mock.calls.map((call: unknown[]) => call[2] ?? OWN);
    expect(accounts).toEqual([OWN]);
  });
});

describe('the read receipt banner in a Pro message tab of another login than the active one', () => {
  let active: Client;
  let other: Client;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    active = makeClient(OWN, 'a@example.org', { [OWN]: message('OWN private note', 'a@example.org') });
    other = makeClient(OTHER, 'b@example.org', { [OTHER]: message('B payroll', 'b@example.org') });
    useSettingsStore.setState({ readReceiptResponse: 'ask', deleteAction: 'trash' } as never);
    useAuthStore.setState({
      activeAccountId: 'login-a',
      client: active as never,
      // The auth store holds the active login's identities.
      identities: [{ id: 'b', email: 'a@example.org', name: 'A', mayDelete: false }] as never,
      getClientForAccount: ((id: string) => (id === 'login-a' ? active : id === 'login-b' ? other : undefined)) as never,
    } as never);
    // The Mail tab lists the active login's own Inbox.
    useEmailStore.setState({
      isUnifiedView: false, viewingAccountId: null, selectedKeyword: null, searchQuery: '',
      mailboxes: FOLDERS.slice(0, 2), accountMailboxes: {},
      selectedMailbox: 'a',
      emails: [message('OWN private note', 'a@example.org')], selectedEmail: null, selectedEmailKeys: new Set(),
      processingReadStatus: new Set(), threadEmailsCache: new Map(), expandedThreadIds: new Set(),
    } as never);
  });

  const openTab = async () => {
    render(<ProEmailTabBody tabId="t1" data={{ accountId: '', clientAccountId: 'login-b', emailId: ID, mailboxId: 'a', title: 'B payroll' }} />);
    await waitFor(() => expect(other.getEmail).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByText('B payroll').length).toBeGreaterThan(0));
  };

  it('Ignore does not flag the active login\'s message with the same id', async () => {
    await openTab();
    const ignore = screen.queryByText('ignore');
    if (ignore) await act(async () => { fireEvent.click(ignore); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(active.setKeyword).not.toHaveBeenCalled();
  });

  it('Send receipt sends nothing through the active login and does not flag its message', async () => {
    await openTab();
    const ignore = screen.queryByText('ignore');
    const send = ignore
      ? screen.getAllByText('send').find((el) => el.closest('button')?.parentElement?.textContent?.includes('ignore'))
      : undefined;
    if (send) await act(async () => { fireEvent.click(send); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(active.sendReadReceipt).not.toHaveBeenCalled();
    expect(active.setKeyword).not.toHaveBeenCalled();
  });

  it('with receipts set to "always", opening the tab sends none through the active login', async () => {
    useSettingsStore.setState({ readReceiptResponse: 'always' } as never);
    await openTab();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(active.sendReadReceipt).not.toHaveBeenCalled();
    expect(active.setKeyword).not.toHaveBeenCalled();
  });

  it('Ignore flags the message of the tab\'s login, through that login', async () => {
    await openTab();
    const ignore = await screen.findByText('ignore');
    await act(async () => { fireEvent.click(ignore); });
    await waitFor(() => expect(other.setKeyword).toHaveBeenCalledWith(ID, '$mdnsent', OTHER));
    expect(active.setKeyword).not.toHaveBeenCalled();
  });

  it('Send receipt goes out through the tab\'s login, from that login\'s address, and flags its message', async () => {
    other.getIdentities = vi.fn(async () => [{ id: 'c', email: 'b@example.org', name: 'B' }]);
    await openTab();
    await screen.findByText('ignore');
    const send = screen.getAllByText('send').find((el) => el.closest('button')?.parentElement?.textContent?.includes('ignore'))!;
    await act(async () => { fireEvent.click(send); });
    await waitFor(() => expect(other.sendReadReceipt).toHaveBeenCalledTimes(1));
    expect(other.sendReadReceipt.mock.calls[0][0]).toMatchObject({ fromEmail: 'b@example.org', identityId: 'c', automatic: false });
    await waitFor(() => expect(other.setKeyword).toHaveBeenCalledWith(ID, '$mdnsent', OTHER));
    expect(active.sendReadReceipt).not.toHaveBeenCalled();
    expect(active.setKeyword).not.toHaveBeenCalled();
  });

  it('with receipts set to "always", a message of another login asks instead of sending by itself', async () => {
    useSettingsStore.setState({ readReceiptResponse: 'always' } as never);
    other.getIdentities = vi.fn(async () => [{ id: 'c', email: 'b@example.org', name: 'B' }]);
    await openTab();
    expect(await screen.findByText('ignore')).toBeTruthy();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(other.sendReadReceipt).not.toHaveBeenCalled();
    expect(active.sendReadReceipt).not.toHaveBeenCalled();
  });
});

describe('the read receipt of the active login\'s own message', () => {
  let active: Client;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    active = makeClient(OWN, 'a@example.org', { [OWN]: message('OWN private note', 'a@example.org') });
    useAuthStore.setState({
      activeAccountId: 'login-a',
      client: active as never,
      identities: [{ id: 'b', email: 'a@example.org', name: 'A', mayDelete: false }] as never,
      getClientForAccount: ((id: string) => (id === 'login-a' ? active : undefined)) as never,
    } as never);
    useEmailStore.setState({
      isUnifiedView: false, viewingAccountId: null, selectedKeyword: null, searchQuery: '',
      mailboxes: FOLDERS.slice(0, 2), accountMailboxes: {},
      selectedMailbox: 'a',
      emails: [message('OWN private note', 'a@example.org')], selectedEmail: null, selectedEmailKeys: new Set(),
      processingReadStatus: new Set(), threadEmailsCache: new Map(), expandedThreadIds: new Set(),
    } as never);
  });

  it('with receipts set to "always", is still sent by itself on opening, once', async () => {
    useSettingsStore.setState({ readReceiptResponse: 'always', deleteAction: 'trash' } as never);
    render(<ProEmailTabBody tabId="t1" data={{ accountId: '', clientAccountId: 'login-a', emailId: ID, mailboxId: 'a', title: 'OWN private note' }} />);
    await waitFor(() => expect(active.sendReadReceipt).toHaveBeenCalledTimes(1));
    expect(active.sendReadReceipt.mock.calls[0][0]).toMatchObject({ fromEmail: 'a@example.org', identityId: 'b', automatic: true });
    await waitFor(() => expect(active.setKeyword).toHaveBeenCalledTimes(1));
    // The login's own account, named or left out.
    const [id, keyword, account] = active.setKeyword.mock.calls[0];
    expect([id, keyword, account ?? OWN]).toEqual([ID, '$mdnsent', OWN]);
    expect(screen.queryByText('ignore')).toBeNull();
  });
});
