import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';

/**
 * A Pro folder tab lists one folder through the client of the login it
 * belongs to. The message is read again through that client - in its
 * reading pane or in an email tab - and a draft reopened there is saved
 * over and removed through that login: userb is account `e` on the 0.16.23
 * and the 1.0 test server alike, and message ids repeat across both.
 */

const viewProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('@/components/pro/pro-email-tab-body', () => ({
  ProEmailView: (props: Record<string, unknown>) => {
    viewProps.current = props;
    return null;
  },
}));
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

const row = { id: 'eaaaaab', threadId: 't', subject: 'Draft', receivedAt: '2026-09-26T10:00:00Z', keywords: { $draft: true, $seen: true }, mailboxIds: { d: true } };
const makeClient = () => ({ getAccountId: () => 'e', getEmails: vi.fn().mockResolvedValue({ emails: [row], total: 1, hasMore: false }), markAsRead: vi.fn() });
const clients = vi.hoisted(() => ({ v016: null as unknown, v10: null as unknown }));

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: selectorStore({
    get client() { return clients.v016; },
    activeAccountId: 'userb@v016',
    getClientForAccount: (id: string) => (id === 'userb@v016' ? clients.v016 : id === 'userb@v10' ? clients.v10 : undefined),
  }),
}));

// The active login's list holds its own Drafts `d` and the team's `c:d`; the
// 1.0 login's list its own Drafts, under the same id.
const folders = vi.hoisted(() => {
  const drafts = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: 'Drafts', role: 'drafts', totalEmails: 1, unreadEmails: 0, ...extra });
  return {
    mailboxes: [drafts('d', { accountId: 'e' }), drafts('c:d', { originalId: 'd', accountId: 'c', isShared: true })],
    accountMailboxes: { 'userb@v10': [drafts('d', { accountId: 'e' })] },
  };
});
vi.mock('@/stores/email-store', () => ({ useEmailStore: selectorStore(folders) }));
vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: selectorStore({ emailsPerPage: 50 }),
  getMessageListOrderFor: () => [],
}));
const tabs = vi.hoisted(() => ({ openEmailTab: vi.fn(), updateTabTitle: vi.fn() }));
vi.mock('@/stores/pro-tab-store', () => ({ useProTabStore: selectorStore(tabs) }));

import { ProFolderTabBody } from '../pro-folder-tab-body';

describe('Pro folder tab - the login a message is read and edited through', () => {
  beforeEach(() => {
    viewProps.current = null;
    tabs.openEmailTab.mockClear();
    clients.v016 = makeClient();
    clients.v10 = makeClient();
  });

  async function openTab(accountId: string | null, mailboxId: string) {
    render(<ProFolderTabBody tabId="tab-1" data={{ accountId, mailboxId, title: 'Drafts' }} />);
    return waitFor(() => screen.getByText('Draft'));
  }

  it('names the active login for a message of its own folder in the reading pane', async () => {
    fireEvent.click(await openTab(null, 'd'));

    expect(viewProps.current).toMatchObject({ emailId: 'eaaaaab', client: clients.v016, clientAccountId: 'userb@v016', accountId: undefined });
  });

  it('opens a message of another login\'s folder in an email tab with that login', async () => {
    fireEvent.doubleClick(await openTab('userb@v10', 'd'));

    expect((clients.v10 as ReturnType<typeof makeClient>).getEmails).toHaveBeenCalled();
    expect(tabs.openEmailTab).toHaveBeenCalledWith(
      expect.objectContaining({ emailId: 'eaaaaab', clientAccountId: 'userb@v10', accountId: '' }),
      expect.anything(),
    );
  });

  it('opens a message of the active login\'s group folder in an email tab with the group account', async () => {
    fireEvent.doubleClick(await openTab(null, 'c:d'));

    expect(tabs.openEmailTab).toHaveBeenCalledWith(
      expect.objectContaining({ emailId: 'eaaaaab', clientAccountId: 'userb@v016', accountId: 'c' }),
      expect.anything(),
    );
  });
});
