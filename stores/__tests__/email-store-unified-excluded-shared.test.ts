import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildUnifiedAccountClients, invalidateUnifiedMailboxes, useEmailStore } from '../email-store';
import { useAccountStore } from '../account-store';
import { useAuthStore } from '../auth-store';
import { useSettingsStore } from '../settings-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Mailbox } from '@/lib/jmap/types';

// #962: a shared mailbox read now and then (info@) can stay out of the
// unified mailbox while the others are merged in.

const mailbox = (id: string, extra: Partial<Mailbox> = {}): Mailbox =>
  ({ id, name: 'Inbox', role: 'inbox', unreadEmails: 0, totalEmails: 0, parentId: null, ...extra }) as unknown as Mailbox;

function connect() {
  const client = {
    getMailboxes: vi.fn(async () => [mailbox('own-inbox')]),
    getAllMailboxes: vi.fn(async () => [
      mailbox('own-inbox'),
      mailbox('info-inbox', { isShared: true, accountId: 'jmap-info', accountName: 'info@' }),
      mailbox('team-inbox', { isShared: true, accountId: 'jmap-team', accountName: 'team@' }),
    ]),
    getAccountId: () => 'jmap-me',
    getServerUrl: () => 'https://mail.example.org',
  };
  useAccountStore.setState({
    accounts: [{
      id: 'me', label: 'me', email: 'me@example.org', username: 'me', serverUrl: 'https://mail.example.org', displayName: 'me',
      cookieSlot: 0, avatarColor: '#123456', rememberMe: true, isConnected: true, hasError: false,
      isDefault: false, lastLoginAt: 0, authMode: 'basic',
    }] as never,
  });
  useAuthStore.setState({ getAllConnectedClients: () => new Map([['me', client as unknown as IJMAPClient]]) } as never);
}

describe('shared mailboxes left out of the unified mailbox', () => {
  beforeEach(() => {
    invalidateUnifiedMailboxes();
    useEmailStore.setState({ accountMailboxes: {} });
    useSettingsStore.setState({ unifiedExcludedSharedAccounts: {} });
    connect();
  });

  it('merges every shared mailbox by default', async () => {
    const built = await buildUnifiedAccountClients({ includeGroup: true });
    expect(built.map((b) => b.accountId)).toEqual(['me', 'jmap-info', 'jmap-team']);
  });

  it('leaves out the ones the login unticked', async () => {
    useSettingsStore.setState({ unifiedExcludedSharedAccounts: { me: ['jmap-info'] } });
    const built = await buildUnifiedAccountClients({ includeGroup: true });
    expect(built.map((b) => b.accountId)).toEqual(['me', 'jmap-team']);
  });

  it('keeps a choice of another login to that login', async () => {
    useSettingsStore.setState({ unifiedExcludedSharedAccounts: { other: ['jmap-info'] } });
    const built = await buildUnifiedAccountClients({ includeGroup: true });
    expect(built.map((b) => b.accountId)).toEqual(['me', 'jmap-info', 'jmap-team']);
  });
});
