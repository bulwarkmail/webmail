import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccountPushSwitches } from '../multi-account-push';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import * as webPush from '@/lib/web-push';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}));

// Push state is stored under the JMAP account id the server assigned: only
// "jmap-a" has a registration here.
vi.mock('@/lib/web-push', () => ({
  isWebPushSupported: () => true,
  isWebPushEnabled: vi.fn(async (id: string) => id === 'jmap-a'),
  enableWebPushForAccounts: vi.fn(),
  disableWebPush: vi.fn(async () => undefined),
}));

const clients: Record<string, { getAccountId: () => string }> = {
  'a@mail.example.com': { getAccountId: () => 'jmap-a' },
  'b@mail.example.com': { getAccountId: () => 'jmap-b' },
};

beforeEach(() => {
  vi.clearAllMocks();
  useAccountStore.setState({
    accounts: [
      { id: 'a@mail.example.com', username: 'a', email: 'a@example.com', displayName: 'Alice', isConnected: true },
      { id: 'b@mail.example.com', username: 'b', email: 'b@example.com', displayName: 'Bob', isConnected: true },
    ] as never,
  });
  useAuthStore.setState({ getClientForAccount: ((id: string) => clients[id]) as never, isDemoMode: false });
});

const switchFor = (name: string) => screen.getByRole('switch', { name });

// settings-p2-17 (2026-11-04): a switch per account replaces the checklist
// with "Enable for selected" and "Disable for selected".
describe('AccountPushSwitches', () => {
  it('shows one switch per account, set the way push is for it on this device', async () => {
    render(<AccountPushSwitches />);
    await waitFor(() => expect(switchFor('Alice (a@example.com)').getAttribute('aria-checked')).toBe('true'));
    expect(switchFor('Bob (b@example.com)').getAttribute('aria-checked')).toBe('false');
    expect(webPush.isWebPushEnabled).toHaveBeenCalledWith('jmap-a');
    expect(webPush.isWebPushEnabled).not.toHaveBeenCalledWith('a@mail.example.com');
    expect(screen.queryByText('select_all')).toBeNull();
    expect(screen.queryByText('enable_selected')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('turns push on for the one account whose switch was flipped', async () => {
    vi.mocked(webPush.enableWebPushForAccounts).mockResolvedValueOnce({ enabled: ['b@mail.example.com'], failed: [] });
    const onChanged = vi.fn();
    render(<AccountPushSwitches onChanged={onChanged} />);
    await waitFor(() => expect(switchFor('Alice (a@example.com)').getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(switchFor('Bob (b@example.com)'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(webPush.enableWebPushForAccounts).toHaveBeenCalledTimes(1);
    const [targets] = vi.mocked(webPush.enableWebPushForAccounts).mock.calls[0];
    expect(targets.map((t) => t.accountId)).toEqual(['b@mail.example.com']);
  });

  it('turns it off for that account only', async () => {
    render(<AccountPushSwitches />);
    await waitFor(() => expect(switchFor('Alice (a@example.com)').getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(switchFor('Alice (a@example.com)'));
    await waitFor(() => expect(webPush.disableWebPush).toHaveBeenCalledTimes(1));
    expect(vi.mocked(webPush.disableWebPush).mock.calls[0][0].client).toBe(clients['a@mail.example.com']);
  });

  it('says why an account stayed off, under its switch', async () => {
    vi.mocked(webPush.enableWebPushForAccounts).mockResolvedValueOnce({
      enabled: [],
      failed: [{ accountId: 'b@mail.example.com', error: new Error('relay unreachable') }],
    });
    render(<AccountPushSwitches />);
    await waitFor(() => expect(switchFor('Bob (b@example.com)')).toBeTruthy());
    fireEvent.click(switchFor('Bob (b@example.com)'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('relay unreachable');
  });

  it('draws nothing with one account', () => {
    useAccountStore.setState({ accounts: [useAccountStore.getState().accounts[0]] });
    const { container } = render(<AccountPushSwitches />);
    expect(container.textContent).toBe('');
  });
});
