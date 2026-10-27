import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountArchiveRestorePrompt } from '../account-archive-prompt';
import { encryptArchive } from '@/lib/account-archive';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), stored: null as unknown }));

vi.mock('next-intl', () => {
  const t = (key: string, values?: Record<string, unknown>) => values ? `${key} ${JSON.stringify(values)}` : key;
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('@/lib/browser-navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/browser-navigation')>()),
  apiFetch: mocks.apiFetch,
}));

const owner = { username: 'owner@x.test', serverUrl: 'https://mail.x.test' };
const account = {
  id: 'owner@x.test@mail.x.test', label: 'Work', ...owner, authMode: 'basic' as const, rememberMe: true, cookieSlot: 0,
  displayName: 'Work', email: owner.username, isConnected: true, hasError: false, lastLoginAt: 1, avatarColor: '#2563eb', isDefault: true,
};
const other = { username: 'other@y.test', serverUrl: 'https://mail.y.test', label: 'Home', avatarColor: '#16a34a' };
const PASSWORD = 'a long backup password';

beforeEach(async () => {
  localStorage.clear();
  mocks.stored = await encryptArchive(owner, [{ ...owner, label: 'Work', avatarColor: '#2563eb' }, other], PASSWORD);
  // Only the archive answers; anything else the app asks for (the policy, say) is not there.
  mocks.apiFetch.mockReset().mockImplementation(async (url: string) => url === '/api/account-archive'
    ? new Response(JSON.stringify({ envelope: mocks.stored }), { status: 200 })
    : new Response('{}', { status: 404 }));
  usePolicyStore.setState(s => ({ policy: { ...s.policy, features: { ...s.policy.features, accountArchiveEnabled: true } } }));
  useAuthStore.setState({ ...owner, isAuthenticated: true, isDemoMode: false });
  useAccountStore.setState({ accounts: [account] as never, activeAccountId: account.id, defaultAccountId: account.id });
});

const archiveCalls = () => mocks.apiFetch.mock.calls.filter(([url]) => url === '/api/account-archive').length;
const fill = (value: string) => fireEvent.change(screen.getByLabelText('password'), { target: { value } });

describe('AccountArchiveRestorePrompt', () => {
  it('offers the saved list on a browser with only the signed-in account, and restores it', { timeout: 20_000 }, async () => {
    render(<AccountArchiveRestorePrompt />);
    expect(await screen.findByRole('dialog')).toHaveTextContent('prompt_title');
    fill('not the password');
    fireEvent.submit(screen.getByLabelText('password').closest('form')!);
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent('errors.unlock_failed');

    fill(PASSWORD);
    fireEvent.submit(screen.getByLabelText('password').closest('form')!);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('restored'), { timeout: 5000 });
    expect(useAccountStore.getState().accounts.map(a => a.username)).toEqual([owner.username, other.username]);

    fireEvent.click(screen.getByRole('button', { name: 'prompt_done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not ask again in this browser once declined', async () => {
    const { unmount } = render(<AccountArchiveRestorePrompt />);
    fireEvent.click(await screen.findByRole('button', { name: 'prompt_not_now' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();

    render(<AccountArchiveRestorePrompt />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(archiveCalls()).toBe(1);
  });

  it('stays quiet when this browser already holds other accounts', async () => {
    useAccountStore.setState({ accounts: [account, { ...account, id: 'b', username: 'b@x.test' }] as never });
    render(<AccountArchiveRestorePrompt />);
    await act(async () => { await Promise.resolve(); });
    expect(archiveCalls()).toBe(0);
  });

  it('stays quiet when nothing is saved or the feature is off', async () => {
    mocks.stored = null;
    const { unmount } = render(<AccountArchiveRestorePrompt />);
    await waitFor(() => expect(archiveCalls()).toBe(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();

    mocks.apiFetch.mockClear();
    usePolicyStore.setState(s => ({ policy: { ...s.policy, features: { ...s.policy.features, accountArchiveEnabled: false } } }));
    render(<AccountArchiveRestorePrompt />);
    await act(async () => { await Promise.resolve(); });
    expect(archiveCalls()).toBe(0);
  });
});
