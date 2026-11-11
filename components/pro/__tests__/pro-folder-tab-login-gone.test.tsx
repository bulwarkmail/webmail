import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';

/**
 * A Pro folder tab of another login (restored after a reload, say) while that
 * login has no client. Folder ids repeat across logins (`a` is every
 * account's Inbox), so the tab must not list the active login's folder with
 * that id under the other login's tab: it shows that the login is not
 * connected and asks nothing of the active login.
 */

vi.mock('@/components/pro/pro-email-tab-body', () => ({ ProEmailView: () => null }));
vi.mock('@/components/email/email-viewer', () => ({ EmailViewer: () => null }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/hooks/use-media-query', () => ({ useDeviceDetection: () => ({ isMobile: false }) }));
vi.mock('@/hooks/use-pane-context', () => ({ usePaneId: () => 'main' }));
vi.mock('@/lib/utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/utils')>(),
  formatDate: () => 'today',
}));

function selectorStore<T extends object>(state: T) {
  const hook = (sel?: (s: T) => unknown) => (typeof sel === 'function' ? sel(state) : state);
  hook.getState = () => state;
  return hook;
}

const ownRow = { id: 'eaaaaab', threadId: 't', subject: 'A private note', receivedAt: '2026-11-11T10:00:00Z', keywords: {}, mailboxIds: { a: true } };
const makeClient = () => ({ getAccountId: () => 'ee', getEmails: vi.fn().mockResolvedValue({ emails: [ownRow], total: 1, hasMore: false }), markAsRead: vi.fn() });
const clients = vi.hoisted(() => ({ active: null as unknown }));

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: selectorStore({
    get client() { return clients.active; },
    activeAccountId: 'login-a',
    connectedAccountsRevision: 0,
    // login-b is registered, with its folder list cached, and has no client.
    getClientForAccount: (id: string) => (id === 'login-a' ? clients.active : undefined),
  }),
}));

const folders = vi.hoisted(() => {
  const inbox = (accountId: string) => ({ id: 'a', name: 'Inbox', role: 'inbox', totalEmails: 1, unreadEmails: 1, accountId });
  return { mailboxes: [inbox('ee')], accountMailboxes: { 'login-b': [inbox('ef')] } };
});
vi.mock('@/stores/email-store', () => ({ useEmailStore: selectorStore(folders) }));
vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: selectorStore({ emailsPerPage: 50 }),
  getMessageListOrderFor: () => [],
}));
const tabs = vi.hoisted(() => ({ openEmailTab: vi.fn(), updateTabTitle: vi.fn() }));
vi.mock('@/stores/pro-tab-store', () => ({ useProTabStore: selectorStore(tabs) }));

import { ProFolderTabBody } from '../pro-folder-tab-body';

describe('a Pro folder tab of a login that has no client', () => {
  beforeEach(() => {
    clients.active = makeClient();
  });

  it('does not list the active login\'s folder with the same id', async () => {
    render(<ProFolderTabBody tabId="tab-1" data={{ accountId: 'login-b', mailboxId: 'a', title: 'Inbox' }} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect((clients.active as ReturnType<typeof makeClient>).getEmails).not.toHaveBeenCalled();
    expect(screen.queryByText('A private note')).toBeNull();
  });

  it('still lists the active login\'s own folder tab', async () => {
    render(<ProFolderTabBody tabId="tab-2" data={{ accountId: null, mailboxId: 'a', title: 'Inbox' }} />);
    await waitFor(() => screen.getByText('A private note'));
  });
});
