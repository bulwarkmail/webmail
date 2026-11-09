import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCopyToAccount } from '@/hooks/use-message-file-actions';
import { DEFAULT_POLICY, type SettingsPolicy } from '@/lib/admin/types';
import { DOWNLOAD_BLOCKED_EVENT } from '@/lib/download-guard';
import { resetAccountSubjects, useAccountSubjects } from '@/lib/org/account-subjects';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import type { Email } from '@/lib/jmap/types';

// "Copy to" another signed-in account must not take mail out of an account
// under a device policy into one that lets it out (Organisation > Devices).

const ALICE = { email: 'alice@example.org', groups: ['team@example.org'] };
const CAROL = { email: 'carol@example.org', groups: [] };
const clientA = { getUsername: () => ALICE.email };
const clientC = { getUsername: () => CAROL.email };
const RAW: SettingsPolicy = {
  ...DEFAULT_POLICY,
  scopes: [{ id: 'team', label: 'Team', match: { groups: ['team@example.org'] }, policy: { organisation: { devices: { noDownloads: true } } } }],
};
const account = (id: string, email: string) => ({
  id, label: email, serverUrl: 'https://mail.example.org', username: email, authMode: 'basic' as const, rememberMe: true, cookieSlot: 0,
  displayName: email, email, isConnected: true, hasError: false, lastLoginAt: 1, avatarColor: '#000000', isDefault: id === 'acc-c',
});

const initial = { auth: useAuthStore.getState(), accounts: useAccountStore.getState(), email: useEmailStore.getState(), policy: usePolicyStore.getState() };
beforeEach(() => {
  resetAccountSubjects();
  useAuthStore.setState({
    activeAccountId: 'acc-c',
    client: clientC as never,
    getClientForAccount: ((id: string) => (id === 'acc-a' ? clientA : id === 'acc-c' ? clientC : undefined)) as never,
    getAllConnectedClients: (() => new Map<string, unknown>([['acc-a', clientA], ['acc-c', clientC]])) as never,
  });
  useAccountStore.setState({ accounts: [account('acc-a', ALICE.email), account('acc-c', CAROL.email)] });
  useEmailStore.setState({ accountMailboxes: { 'acc-a': [{ id: 'ia', name: 'Inbox' }], 'acc-c': [{ id: 'ic', name: 'Inbox' }] } as never });
  usePolicyStore.setState({ rawPolicy: RAW, loaded: true });
  usePolicyStore.getState().setPolicySubject(CAROL);
  useAccountSubjects.setState({ subjects: { 'acc-a': ALICE }, settled: { 'acc-a': true } });
});
afterEach(() => {
  useAuthStore.setState(initial.auth, true);
  useAccountStore.setState(initial.accounts, true);
  useEmailStore.setState(initial.email, true);
  usePolicyStore.setState(initial.policy, true);
  resetAccountSubjects();
});

describe('Copy to another account under the device policies', () => {
  it('offers no target for mail of the restricted account, and copies nothing', async () => {
    const restricted = { id: 'm1', sourceClientAccountId: 'acc-a' } as Email;
    const copy = vi.fn(async () => {});
    useEmailStore.setState({ copyEmailsToAccount: copy } as never);
    const { result } = renderHook(() => useCopyToAccount(restricted, true));
    expect(result.current.copyTargets).toEqual([]);
    const blocked = vi.fn();
    window.addEventListener(DOWNLOAD_BLOCKED_EVENT, blocked);
    await act(async () => { await result.current.copyToAccount([restricted], 'acc-c', 'ic'); });
    window.removeEventListener(DOWNLOAD_BLOCKED_EVENT, blocked);
    expect(copy).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenCalledTimes(1);
  });

  it('still copies into the stricter account', () => {
    const open = { id: 'm2', sourceClientAccountId: 'acc-c' } as Email;
    const { result } = renderHook(() => useCopyToAccount(open, true));
    expect(result.current.copyTargets.map((t) => t.accountId)).toEqual(['acc-a']);
  });
});
