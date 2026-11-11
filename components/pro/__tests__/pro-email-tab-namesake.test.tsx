import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { Email, Mailbox } from '@/lib/jmap/types';

/**
 * A message open in its own Pro tab (or the global search preview) is written
 * to the login and account the tab read it from. Message ids repeat across
 * accounts (Stalwart numbers them eaaaaab, eaaaaac, ... in every account), so
 * the Mail tab may list a team mailbox, or another login's folder, with a
 * message of the same id: Delete, Archive, Move, Star, Mark read and tags in
 * the tab leave that message alone.
 *
 * Two fake logins and a group account whose ids collide. Each test names the
 * message the tab shows and asserts that the write reaches that message's
 * account and no other.
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
import { ProEmailTabBody, ProEmailView } from '../pro-email-tab-body';

const OWN = 'ee'; // the active login's own JMAP account
const GROUP = 'ed'; // a team mailbox the same login reaches
const ID = 'eaaaaab'; // the first message of every Stalwart account

function folder(id: string, role: string | null, accountId: string, shared: boolean): Mailbox {
  return {
    id: shared ? `${accountId}:${id}` : id, originalId: id, name: role ?? id, role, accountId,
    accountName: shared ? 'Team' : undefined, isShared: shared, sortOrder: 0,
    totalEmails: 1, unreadEmails: 1, totalThreads: 1, unreadThreads: 1, isSubscribed: true,
    myRights: { mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetSeen: true, maySetKeywords: true, mayCreateChild: true, mayRename: true, mayDelete: true, maySubmit: true },
  } as unknown as Mailbox;
}

const FOLDERS = [
  folder('a', 'inbox', OWN, false), folder('b', 'trash', OWN, false), folder('f', 'archive', OWN, false),
  folder('a', 'inbox', GROUP, true), folder('b', 'trash', GROUP, true), folder('f', 'archive', GROUP, true),
];

function message(subject: string, extra: Partial<Email> = {}): Email {
  return {
    id: ID, threadId: `t-${subject}`, subject, receivedAt: '2026-11-11T10:00:00Z', keywords: {},
    mailboxIds: { a: true }, from: [{ email: 'sam@example.org', name: 'Sam' }], to: [{ email: 'me@example.org' }],
    bodyValues: { '1': { value: subject } }, textBody: [{ partId: '1', type: 'text/plain' }],
    htmlBody: [{ partId: '1', type: 'text/plain' }], attachments: [], size: 10,
    ...extra,
  } as unknown as Email;
}

/** One login's client. `messages` maps a JMAP account to its message with the colliding id. */
function makeClient(ownAccount: string, messages: Record<string, Email>) {
  const client = {
    getAccountId: () => ownAccount,
    getUsername: () => `${ownAccount}@example.org`,
    getServerUrl: () => `https://${ownAccount}.example.org`,
    getEmail: vi.fn(async (_id: string, accountId?: string) => messages[accountId ?? ownAccount] ?? null),
    moveToTrash: vi.fn(async () => {}),
    deleteEmail: vi.fn(async () => {}),
    moveEmail: vi.fn(async () => {}),
    markAsRead: vi.fn(async () => {}),
    toggleStar: vi.fn(async () => {}),
    batchUpdateKeywords: vi.fn(async () => {}),
    setKeyword: vi.fn(async () => {}),
    removeKeyword: vi.fn(async () => {}),
    getThreadEmails: vi.fn(async () => []),
    getThread: vi.fn(async () => null),
  };
  return client;
}

/** The account a write went to: undefined and the login's own id both mean its own account. */
function accountsWritten(client: ReturnType<typeof makeClient>, own: string): string[] {
  const calls: Array<[string, unknown]> = [
    ...client.moveToTrash.mock.calls.map((c: unknown[]) => ['moveToTrash', c[2]] as [string, unknown]),
    ...client.deleteEmail.mock.calls.map((c: unknown[]) => ['deleteEmail', c[1]] as [string, unknown]),
    ...client.moveEmail.mock.calls.map((c: unknown[]) => ['moveEmail', c[2]] as [string, unknown]),
    ...client.markAsRead.mock.calls.map((c: unknown[]) => ['markAsRead', c[2]] as [string, unknown]),
    ...client.toggleStar.mock.calls.map((c: unknown[]) => ['toggleStar', c[2]] as [string, unknown]),
  ];
  return calls.map(([method, account]) => `${method}:${(account as string | undefined) ?? own}`);
}

const original = { auth: useAuthStore.getState(), email: useEmailStore.getState(), settings: useSettingsStore.getState() };

async function openTab(props: { client: unknown; clientAccountId: string; accountId?: string }) {
  const onClose = vi.fn();
  render(<ProEmailView emailId={ID} client={props.client as never} clientAccountId={props.clientAccountId} accountId={props.accountId} onClose={onClose} noAutomaticActions />);
  await waitFor(() => expect(viewerProps.current?.email).toBeTruthy());
  return { onClose };
}

const viewer = () => viewerProps.current as {
  email: Email;
  onDelete: () => Promise<void>;
  onArchive?: () => Promise<void>;
  onToggleStar: () => Promise<void>;
  onMarkAsRead: (id: string, read: boolean) => Promise<void>;
};

beforeEach(() => {
  viewerProps.current = null;
  useSettingsStore.setState({ deleteAction: 'trash' } as never);
});

afterEach(() => {
  cleanup();
  useAuthStore.setState(original.auth);
  useEmailStore.setState(original.email);
  useSettingsStore.setState(original.settings);
});

describe('own message in a Pro tab while the Mail tab shows a team mailbox with the same id', () => {
  let active: ReturnType<typeof makeClient>;

  beforeEach(() => {
    active = makeClient(OWN, {
      [OWN]: message('OWN private note'),
      [GROUP]: message('TEAM customer order'),
    });
    useAuthStore.setState({
      activeAccountId: 'login-a',
      client: active as never,
      getClientForAccount: (id: string) => (id === 'login-a' ? active : undefined) as never,
    } as never);
    // The Mail tab behind the email tab: the team's Inbox, rows unstamped as
    // a plain folder view lists them.
    useEmailStore.setState({
      isUnifiedView: false, viewingAccountId: null, selectedKeyword: null, searchQuery: '',
      mailboxes: FOLDERS, accountMailboxes: {},
      selectedMailbox: `${GROUP}:a`,
      emails: [message('TEAM customer order')], selectedEmail: null, selectedEmailKeys: new Set(),
      processingReadStatus: new Set(), threadEmailsCache: new Map(), expandedThreadIds: new Set(),
    } as never);
  });

  it('shows the own message', async () => {
    await openTab({ client: active, clientAccountId: 'login-a' });
    expect(viewer().email.subject).toBe('OWN private note');
  });

  it('Delete moves the own message to the own Trash, not the team message', async () => {
    await openTab({ client: active, clientAccountId: 'login-a' });
    await act(async () => { await viewer().onDelete(); });
    const written = accountsWritten(active, OWN);
    expect(written.filter((w) => w.endsWith(`:${GROUP}`))).toEqual([]);
    // The team's row is still listed in the Mail tab.
    expect(useEmailStore.getState().emails.map((e) => e.subject)).toEqual(['TEAM customer order']);
  });

  it('Star flags the own message, not the team message', async () => {
    await openTab({ client: active, clientAccountId: 'login-a' });
    await act(async () => { await viewer().onToggleStar(); });
    expect(accountsWritten(active, OWN).filter((w) => w.endsWith(`:${GROUP}`))).toEqual([]);
    expect(useEmailStore.getState().emails[0].keywords?.$flagged).toBeFalsy();
  });

  it('Mark read marks the own message, not the team message', async () => {
    await openTab({ client: active, clientAccountId: 'login-a' });
    await act(async () => { await viewer().onMarkAsRead(ID, true); });
    expect(accountsWritten(active, OWN).filter((w) => w.endsWith(`:${GROUP}`))).toEqual([]);
    expect(useEmailStore.getState().emails[0].keywords?.$seen).toBeFalsy();
  });
});

describe('own message in a Pro tab while the Mail tab shows another login\'s folder with the same id', () => {
  let active: ReturnType<typeof makeClient>;
  let other: ReturnType<typeof makeClient>;

  beforeEach(() => {
    active = makeClient(OWN, { [OWN]: message('A private note') });
    other = makeClient('ef', { ef: message('B payroll') });
    useAuthStore.setState({
      activeAccountId: 'login-a',
      client: active as never,
      getClientForAccount: (id: string) => (id === 'login-a' ? active : id === 'login-b' ? other : undefined) as never,
    } as never);
    // The Pro sidebar's second account group: login B's Inbox is open in the Mail tab.
    const otherFolders = [folder('a', 'inbox', 'ef', false), folder('b', 'trash', 'ef', false)];
    useEmailStore.setState({
      isUnifiedView: false, viewingAccountId: 'login-b', selectedKeyword: null, searchQuery: '',
      mailboxes: FOLDERS, accountMailboxes: { 'login-b': otherFolders },
      selectedMailbox: 'a',
      emails: [message('B payroll')], selectedEmail: null, selectedEmailKeys: new Set(),
      processingReadStatus: new Set(), threadEmailsCache: new Map(), expandedThreadIds: new Set(),
    } as never);
  });

  it('Delete does not touch the other login', async () => {
    await openTab({ client: active, clientAccountId: 'login-a' });
    expect(viewer().email.subject).toBe('A private note');
    await act(async () => { await viewer().onDelete(); });
    expect(accountsWritten(other, 'ef')).toEqual([]);
    expect(useEmailStore.getState().emails.map((e) => e.subject)).toEqual(['B payroll']);
  });

  it('Mark read does not touch the other login', async () => {
    await openTab({ client: active, clientAccountId: 'login-a' });
    await act(async () => { await viewer().onMarkAsRead(ID, true); });
    expect(accountsWritten(other, 'ef')).toEqual([]);
  });
});

describe('team message in a Pro tab while the Mail tab shows the own Inbox with the same id', () => {
  let active: ReturnType<typeof makeClient>;

  beforeEach(() => {
    active = makeClient(OWN, {
      [OWN]: message('OWN private note'),
      [GROUP]: message('TEAM customer order'),
    });
    useAuthStore.setState({
      activeAccountId: 'login-a',
      client: active as never,
      getClientForAccount: (id: string) => (id === 'login-a' ? active : undefined) as never,
    } as never);
    useEmailStore.setState({
      isUnifiedView: false, viewingAccountId: null, selectedKeyword: null, searchQuery: '',
      mailboxes: FOLDERS, accountMailboxes: {},
      selectedMailbox: 'a',
      emails: [message('OWN private note')], selectedEmail: null, selectedEmailKeys: new Set(),
      processingReadStatus: new Set(), threadEmailsCache: new Map(), expandedThreadIds: new Set(),
    } as never);
  });

  it('Mark read marks the team message, not the own one', async () => {
    await openTab({ client: active, clientAccountId: 'login-a', accountId: GROUP });
    expect(viewer().email.subject).toBe('TEAM customer order');
    await act(async () => { await viewer().onMarkAsRead(ID, true); });
    expect(accountsWritten(active, OWN).filter((w) => w.endsWith(`:${OWN}`))).toEqual([]);
    expect(useEmailStore.getState().emails[0].keywords?.$seen).toBeFalsy();
  });

  it('Delete moves the team message to the team\'s Trash', async () => {
    await openTab({ client: active, clientAccountId: 'login-a', accountId: GROUP });
    await act(async () => { await viewer().onDelete(); });
    expect(accountsWritten(active, OWN)).toEqual([`moveToTrash:${GROUP}`]);
    expect((active.moveToTrash.mock.calls[0] as unknown[])[1]).toBe('b');
    expect(useEmailStore.getState().emails.map((e) => e.subject)).toEqual(['OWN private note']);
  });

  it('offers only the team account\'s folders to move to', async () => {
    await openTab({ client: active, clientAccountId: 'login-a', accountId: GROUP });
    const offered = (viewerProps.current?.mailboxes as Mailbox[]).map((m) => m.id);
    expect(offered.sort()).toEqual([`${GROUP}:a`, `${GROUP}:b`, `${GROUP}:f`]);
  });
});

describe('the other actions of a Pro tab while the Mail tab lists a namesake', () => {
  let active: ReturnType<typeof makeClient>;

  beforeEach(() => {
    active = makeClient(OWN, {
      [OWN]: message('OWN private note'),
      [GROUP]: message('TEAM customer order'),
    });
    useAuthStore.setState({
      activeAccountId: 'login-a',
      client: active as never,
      getClientForAccount: (id: string) => (id === 'login-a' ? active : undefined) as never,
    } as never);
    useEmailStore.setState({
      isUnifiedView: false, viewingAccountId: null, selectedKeyword: null, searchQuery: '',
      mailboxes: FOLDERS, accountMailboxes: {},
      selectedMailbox: `${GROUP}:a`,
      emails: [message('TEAM customer order')], selectedEmail: null, selectedEmailKeys: new Set(),
      processingReadStatus: new Set(), threadEmailsCache: new Map(), expandedThreadIds: new Set(),
    } as never);
  });

  it('Archive files the own message in the own Archive', async () => {
    await openTab({ client: active, clientAccountId: 'login-a' });
    await act(async () => { await viewer().onArchive?.(); });
    expect(accountsWritten(active, OWN)).toEqual([`moveEmail:${OWN}`]);
    expect((active.moveEmail.mock.calls[0] as unknown[])[1]).toBe('f');
    expect(useEmailStore.getState().emails.map((e) => e.subject)).toEqual(['TEAM customer order']);
  });

  it('Move to a folder goes to the own message', async () => {
    await openTab({ client: active, clientAccountId: 'login-a' });
    const move = viewerProps.current?.onMoveToMailbox as (id: string) => Promise<void>;
    await act(async () => { await move('f'); });
    expect(accountsWritten(active, OWN)).toEqual([`moveEmail:${OWN}`]);
  });

  it('Delete forever in the own Trash destroys the own message only', async () => {
    active.getEmail.mockImplementation(async (_id: string, accountId?: string) =>
      accountId === GROUP ? message('TEAM customer order') : message('OWN old note', { mailboxIds: { b: true } }));
    await openTab({ client: active, clientAccountId: 'login-a' });
    await act(async () => { await viewer().onDelete(); });
    expect(accountsWritten(active, OWN)).toEqual([`deleteEmail:${OWN}`]);
    expect(useEmailStore.getState().emails.map((e) => e.subject)).toEqual(['TEAM customer order']);
  });

  it('a tag set in the tab is written to the own message and leaves the listed team row alone', async () => {
    await openTab({ client: active, clientAccountId: 'login-a' });
    const setTag = viewerProps.current?.onSetTag as (id: string, tag: string | null) => void;
    await act(async () => { setTag(ID, 'red'); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(active.batchUpdateKeywords).toHaveBeenCalledTimes(1);
    expect((active.batchUpdateKeywords.mock.calls[0] as unknown[])[2] ?? OWN).toBe(OWN);
    expect(Object.keys(useEmailStore.getState().emails[0].keywords ?? {})).toEqual([]);
    await waitFor(() => expect(Object.keys(viewer().email.keywords ?? {}).some((k) => k.endsWith('red'))).toBe(true));
  });

  it('the mark read the reader sends on opening goes to the own message', async () => {
    await openTab({ client: active, clientAccountId: 'login-a' });
    const markRead = viewerProps.current?.onMarkAsRead as (id: string, read: boolean, opts?: { automatic?: boolean }) => Promise<void>;
    await act(async () => { await markRead(ID, true, { automatic: true }); });
    expect(accountsWritten(active, OWN)).toEqual([`markAsRead:${OWN}`]);
    expect(useEmailStore.getState().emails[0].keywords?.$seen).toBeFalsy();
  });

  it('Mark unread goes to the own message', async () => {
    active.getEmail.mockImplementation(async (_id: string, accountId?: string) =>
      accountId === GROUP ? message('TEAM customer order') : message('OWN private note', { keywords: { $seen: true } }));
    await openTab({ client: active, clientAccountId: 'login-a' });
    await act(async () => { await viewer().onMarkAsRead(ID, false); });
    expect(accountsWritten(active, OWN)).toEqual([`markAsRead:${OWN}`]);
    expect((active.markAsRead.mock.calls[0] as unknown[])[1]).toBe(false);
  });
});

describe('a Pro message tab of a login without a client', () => {
  it('reads nothing through the active login and says the login is not connected', async () => {
    const active = makeClient(OWN, { [OWN]: message('OWN private note') });
    useAuthStore.setState({
      activeAccountId: 'login-a',
      client: active as never,
      getClientForAccount: (id: string) => (id === 'login-a' ? active : undefined) as never,
    } as never);
    const view = render(<ProEmailTabBody tabId="t1" data={{ accountId: '', clientAccountId: 'login-b', emailId: ID, mailboxId: null, title: 'B payroll' }} />);
    await act(async () => {});
    expect(active.getEmail).not.toHaveBeenCalled();
    expect(viewerProps.current).toBeNull();
    expect(view.getByText('notifications.not_connected')).toBeTruthy();
  });
});
