import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// The login page in another language: the subtitle, the theme menu and the
// version details come from the translations, and the version details open
// from the keyboard, not only on hover.

vi.mock('next/navigation', () => ({
  useParams: () => ({ locale: 'de' }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/login',
}));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/login',
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

const configOverrides = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

vi.mock('@/hooks/use-config', () => ({
  useConfig: () => ({
    appName: 'Webmail',
    isLoading: false,
    error: null,
    jmapServerUrl: 'https://mail.example.org',
    jmapServers: [],
    loginShowHeading: true,
    loginShowSubtitle: true,
    loginShowVersion: true,
    loginShowTotp: true,
    loginShowRememberMe: true,
    ...configOverrides.value,
  }),
}));

const { default: LoginPage } = await import('../page');
const { useAuthStore } = await import('@/stores/auth-store');

describe('login page translations', () => {
  it('shows the translated subtitle whatever the app is called', async () => {
    // Under an app name the admin gave: with the default name the heading is
    // "Sign in" itself, and the subtitle would repeat it.
    configOverrides.value = { appName: 'Acme Mail' };
    try {
      render(<LoginPage />);
      expect(await screen.findByText('subtitle', {}, { timeout: 10000 })).toBeInTheDocument();
      expect(screen.queryByText('Sign in to your account')).toBeNull();
    } finally {
      configOverrides.value = {};
    }
  }, 30_000);

  it('labels the theme menu from the translations', async () => {
    render(<LoginPage />);
    const button = await screen.findByRole('button', { name: 'theme_button: system' }, { timeout: 10000 });
    fireEvent.click(button);
    expect(screen.getByRole('menu', { name: 'label' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'dark' })).toBeInTheDocument();
  }, 30_000);

  it('opens the version details from a button', async () => {
    render(<LoginPage />);
    const trigger = await screen.findByRole('button', { name: /^v\d/ }, { timeout: 10000 });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    act(() => { fireEvent.click(trigger); });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const details = screen.getByRole('group', { name: 'details' });
    expect(details).toHaveTextContent('version_line');
    expect(screen.getByRole('button', { name: 'copy' })).toBeInTheDocument();
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  }, 30_000);

  it('uses the translated email placeholder unless one is configured (#1423)', async () => {
    const { unmount } = render(<LoginPage />);
    expect(await screen.findByLabelText('username_label', {}, { timeout: 10000 }))
      .toHaveAttribute('placeholder', 'username_placeholder');
    unmount();

    configOverrides.value = { loginUsernamePlaceholder: 'max.mustermann@acme.example' };
    try {
      render(<LoginPage />);
      expect(await screen.findByLabelText('username_label', {}, { timeout: 10000 }))
        .toHaveAttribute('placeholder', 'max.mustermann@acme.example');
    } finally {
      configOverrides.value = {};
    }
  }, 30_000);

  it('swaps the OAuth-only card for the password form through the fallback link', async () => {
    configOverrides.value = { oauthOnly: true, oauthPasswordFallbackEnabled: true };
    try {
      render(<LoginPage />);
      // SSO-only card: no password fields, but the demoted toggle link.
      expect(await screen.findByRole('button', { name: /password_toggle/ }, { timeout: 10000 }))
        .toBeInTheDocument();
      expect(screen.queryByLabelText('username_label')).toBeNull();

      act(() => { fireEvent.click(screen.getByRole('button', { name: /password_toggle/ })); });
      expect(await screen.findByLabelText('username_label', {}, { timeout: 10000 })).toBeInTheDocument();
    } finally {
      configOverrides.value = {};
    }
  }, 30_000);

  it('keeps the OAuth-only card without the link when the fallback is off', async () => {
    configOverrides.value = { oauthOnly: true };
    try {
      render(<LoginPage />);
      await screen.findByRole('heading', { level: 1 }, { timeout: 10000 });
      // The SSO-only card replaces the password form once the config is in.
      await waitFor(() => expect(screen.queryByLabelText('username_label')).toBeNull(), { timeout: 10000 });
      expect(screen.queryByRole('button', { name: /password_toggle/ })).toBeNull();
    } finally {
      configOverrides.value = {};
    }
  }, 30_000);
});

describe('login page notices', () => {
  it('asks for the second factor as the next step, not as a failure (#1422)', async () => {
    render(<LoginPage />);
    await screen.findByRole('heading', { level: 1 }, { timeout: 10000 });
    // The page clears the error as it mounts; a sign-in attempt sets it after.
    act(() => { useAuthStore.setState({ error: 'totp_required' }); });
    const notice = await screen.findByTestId('login-error', {}, { timeout: 10000 });
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice.className).toContain('bg-info/5');
    expect(notice.className).not.toContain('destructive');
    expect(notice.className).not.toContain('animate-shake');
  }, 30_000);

  it('keeps a wrong password an error', async () => {
    render(<LoginPage />);
    await screen.findByRole('heading', { level: 1 }, { timeout: 10000 });
    // The page clears the error as it mounts; a sign-in attempt sets it after.
    act(() => { useAuthStore.setState({ error: 'invalid_credentials' }); });
    const notice = await screen.findByTestId('login-error', {}, { timeout: 10000 });
    // A failure interrupts the screen reader; the code prompt above is only a status.
    expect(notice).toHaveAttribute('role', 'alert');
    expect(notice.className).toContain('bg-destructive/5');
  }, 30_000);
});
