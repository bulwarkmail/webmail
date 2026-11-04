import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccountSecuritySettings } from '../account-security-settings';
import { useAccountStore, type AccountEntry } from '@/stores/account-store';
import { useAccountSecurityStore } from '@/stores/account-security-store';
import { useAuthStore } from '@/stores/auth-store';

const mocks = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('next-intl', () => {
  const t = Object.assign((key: string) => key, { raw: (key: string) => key });
  return { useTranslations: () => t, useLocale: () => 'en' };
});

vi.mock('@/hooks/use-config', () => ({
  useConfig: () => ({ oauthEnabled: false }),
}));

vi.mock('@/stores/toast-store', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, info: vi.fn() },
}));

function signIn(authMode: AccountEntry['authMode'], providerSession: boolean | undefined) {
  const entry = {
    id: 'me@example.com@mail.example.com',
    label: 'me@example.com',
    serverUrl: 'https://mail.example.com',
    username: 'me@example.com',
    authMode,
    cookieSlot: 0,
    rememberMe: false,
    providerSession,
    displayName: '',
    email: 'me@example.com',
    avatarColor: '#000000',
    lastLoginAt: 0,
    isConnected: true,
    hasError: false,
    isDefault: true,
  } as AccountEntry;
  useAccountStore.setState({ accounts: [entry], activeAccountId: entry.id });
  // No client keeps the probe effect quiet; the verdict is set directly.
  useAuthStore.setState({ isAuthenticated: false, authMode, client: null, activeAccountId: entry.id });
}

beforeEach(() => {
  vi.clearAllMocks();
  useAccountSecurityStore.setState({ isStalwart: true, isProbing: false, otpEnabled: false, isSaving: false });
});

describe('AccountSecuritySettings sign-in section', () => {
  // settings-p2-18: the heading is "Two-step sign-in", the row's own name, not "Two-factor authentication".
  it('heads two-step sign-in with the name of its row', () => {
    signIn('basic', false);
    render(<AccountSecuritySettings />);
    expect(screen.queryByText('totp.section_title')).toBeNull();
    expect(screen.getByRole('heading', { name: 'totp.label' })).toBeInTheDocument();
  });

  it('shows password and two-factor to a password sign-in', () => {
    signIn('basic', false);
    render(<AccountSecuritySettings />);
    expect(screen.getByText('password.title')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'totp.label' })).toBeInTheDocument();
  });

  it('shows them to a password plus TOTP sign-in, which runs on OAuth tokens (#1432)', () => {
    signIn('oauth', false);
    render(<AccountSecuritySettings />);
    expect(screen.getByText('password.title')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'totp.label' })).toBeInTheDocument();
  });

  it.each([
    ['an identity-provider sign-in', 'oauth', true],
    ['a session from before providerSession was recorded', 'oauth', undefined],
    ['an access-token sign-in', 'token', false],
  ] as const)('hides them for %s', (_name, authMode, providerSession) => {
    signIn(authMode, providerSession);
    render(<AccountSecuritySettings />);
    expect(screen.queryByText('password.title')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'totp.label' })).toBeNull();
    expect(screen.getByText('email_client.title')).toBeInTheDocument();
  });
});

describe('AccountSecuritySettings password change', () => {
  function changePassword(container: HTMLElement) {
    const [current, ...fresh] = [
      container.querySelector('input[autocomplete="current-password"]'),
      ...container.querySelectorAll('input[autocomplete="new-password"]'),
    ] as HTMLInputElement[];
    fireEvent.change(current, { target: { value: 'old-password' } });
    for (const input of fresh) fireEvent.change(input, { target: { value: 'new-password-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'password.submit' }));
  }

  it('signs a token session out, since Stalwart revokes its tokens with the old password', async () => {
    signIn('oauth', false);
    const change = vi.fn(async () => {});
    const logout = vi.fn(async () => {});
    useAccountSecurityStore.setState({ changePassword: change });
    useAuthStore.setState({ logout });
    const { container } = render(<AccountSecuritySettings />);
    changePassword(container);
    await waitFor(() => expect(logout).toHaveBeenCalledWith({ endProviderSession: false }));
    expect(change).toHaveBeenCalledWith('old-password', 'new-password-1', undefined);
    expect(mocks.toastSuccess).toHaveBeenCalledWith('password.success', 'password.sign_in_again');
  });

  it('keeps a password session signed in', async () => {
    signIn('basic', false);
    const change = vi.fn(async () => {});
    const logout = vi.fn(async () => {});
    useAccountSecurityStore.setState({ changePassword: change });
    useAuthStore.setState({ logout });
    const { container } = render(<AccountSecuritySettings />);
    changePassword(container);
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('password.success'));
    expect(logout).not.toHaveBeenCalled();
  });
});
