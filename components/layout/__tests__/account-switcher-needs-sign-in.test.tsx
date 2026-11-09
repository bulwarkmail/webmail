import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A refused account beside another that stays signed in: the switcher marks it,
// with the count and the date, and takes the user to its sign-in.

const push = vi.hoisted(() => vi.fn());
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => '/',
}));

const { AccountSwitcher } = await import('../account-switcher');
const { useAccountStore } = await import('@/stores/account-store');
const { useAuthStore } = await import('@/stores/auth-store');
const { useSettingsStore } = await import('@/stores/settings-store');
const { markLoginRefused, setRefusedCount, dropRefusedLogin } = await import('@/lib/devices/wipe-state');
const { useOfflineStore, markEvicted, clearEvicted } = await import('@/lib/offline/state');

const A = 'a@example.com';
const B = 'b@example.com';

function account(id: string) {
  return { id, label: id, email: id, username: id, displayName: id.toUpperCase(), serverUrl: 'https://mail.example.com', avatarColor: '#336699', cookieSlot: 0, isConnected: true, isDefault: id === A };
}

function open(): void {
  render(<AccountSwitcher variant="rail" />);
  fireEvent.click(screen.getByTestId('account-switcher'));
}

beforeEach(() => {
  push.mockClear();
  localStorage.clear();
  useAccountStore.setState({ accounts: [account(A)] } as never);
  useAuthStore.setState({ activeAccountId: A } as never);
  useSettingsStore.setState({ interfaceLayout: 'default' } as never);
  useOfflineStore.setState({ enabled: [A, B] });
  markLoginRefused(B, { certain: true, seenBy: [A], label: B, username: B });
  markEvicted(B);
});

describe('an account that needs signing in again', () => {
  it('is marked, with its count and the date its data goes', () => {
    setRefusedCount(B, 2);
    open();
    const row = screen.getByTestId('account-needs-sign-in');
    expect(row.textContent).toContain(B);
    expect(row.textContent).toContain('needs_sign_in');
    expect(row.textContent).toContain('switcher_waiting');
  });

  it('says only the date when it couldn\'t count, or there\'s nothing unsent', () => {
    setRefusedCount(B, 0);
    open();
    const row = screen.getByTestId('account-needs-sign-in');
    expect(row.textContent).toContain('switcher_kept');
    expect(row.textContent).not.toContain('switcher_waiting');
  });

  it('takes the user to its sign-in, with the name filled in', () => {
    setRefusedCount(B, 2);
    open();
    fireEvent.click(screen.getByTestId('account-needs-sign-in'));
    expect(push).toHaveBeenCalledWith(`/login?mode=add-account&username=${encodeURIComponent(B)}`);
  });

  it('shows the count as soon as it\'s known, with the menu open', () => {
    open();
    expect(screen.getByTestId('account-needs-sign-in').textContent).toContain('switcher_kept');
    act(() => setRefusedCount(B, 3));
    expect(screen.getByTestId('account-needs-sign-in').textContent).toContain('switcher_waiting');
  });

  it('isn\'t shown to an account that wasn\'t there', () => {
    useAuthStore.setState({ activeAccountId: 'stranger@example.com' } as never);
    useAccountStore.setState({ accounts: [account('stranger@example.com')] } as never);
    open();
    expect(screen.queryByTestId('account-needs-sign-in')).toBeNull();
  });

  it('is gone once it signed in again', () => {
    clearEvicted(B);
    open();
    expect(screen.queryByTestId('account-needs-sign-in')).toBeNull();
    dropRefusedLogin(B);
  });
});
