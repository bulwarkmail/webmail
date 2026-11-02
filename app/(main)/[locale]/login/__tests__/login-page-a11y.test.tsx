import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The sign-in form from the keyboard and with a screen reader: password
// managers can pair the fields, the show-password toggle is reachable, an
// error is announced and tied to the field it is about, and the recent
// accounts are a listbox the arrow keys move through.

vi.mock('next/navigation', () => ({
  useParams: () => ({ locale: 'en' }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/login',
}));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/login',
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/hooks/use-config', () => ({
  useConfig: () => ({
    appName: 'Webmail',
    isLoading: false,
    error: null,
    jmapServerUrl: 'https://mail.example.org',
    jmapServers: [],
    loginShowHeading: true,
    loginShowSubtitle: true,
    loginShowVersion: false,
    loginShowTotp: true,
    loginShowRememberMe: true,
    accessibilityStatementUrl: 'https://example.org/accessibility',
    accessibilityFeedbackUrl: 'mailto:barriers@example.org',
  }),
}));

const { default: LoginPage } = await import('../page');
const { useAuthStore } = await import('@/stores/auth-store');

async function renderForm() {
  render(<LoginPage />);
  return (await screen.findByLabelText('username_label', {}, { timeout: 10000 })) as HTMLInputElement;
}

describe('login form accessibility', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.setState({ error: null, isLoading: false });
  });

  it('lets password managers fill the username and names the page', async () => {
    const username = await renderForm();
    expect(username).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('password_label')).toHaveAttribute('autocomplete', 'current-password');
    expect(document.title).toBe('sign_in - Webmail');
  }, 30_000);

  it('links the operator\'s accessibility statement and barrier report in the footer (OP-01)', async () => {
    await renderForm();
    const nav = screen.getByRole('navigation', { name: 'label' });
    expect(nav.querySelector('a[href="https://example.org/accessibility"]')).not.toBeNull();
    expect(nav.querySelector('a[href="mailto:barriers@example.org"]')).not.toBeNull();
  }, 30_000);

  it('puts the show-password toggle in the tab order with its state', async () => {
    await renderForm();
    const toggle = screen.getByRole('button', { name: 'show_password' });
    expect(toggle).not.toHaveAttribute('tabindex', '-1');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('password_label')).toHaveAttribute('type', 'text');
  }, 30_000);

  it('announces a sign-in error and ties it to the fields', async () => {
    const username = await renderForm();
    act(() => { useAuthStore.setState({ error: 'invalid_credentials' }); });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('error.invalid_credentials');
    const password = screen.getByLabelText('password_label');
    for (const field of [username, password]) {
      expect(field).toHaveAttribute('aria-invalid', 'true');
      expect(field).toHaveAccessibleDescription('error.invalid_credentials');
    }
  }, 30_000);

  it('blames no field for a network error', async () => {
    const username = await renderForm();
    act(() => { useAuthStore.setState({ error: 'connection_failed' }); });
    expect(screen.getByRole('alert')).toHaveTextContent('error.connection_failed');
    expect(username).not.toHaveAttribute('aria-invalid');
  }, 30_000);

  it('offers the recent accounts as a listbox the keyboard can use', async () => {
    localStorage.setItem('webmail_usernames', JSON.stringify(['ann@example.org', 'bob@example.org']));
    const username = await renderForm();
    expect(username).toHaveAttribute('role', 'combobox');
    act(() => { username.blur(); });
    expect(username).toHaveAttribute('aria-expanded', 'false');

    fireEvent.keyDown(username, { key: 'ArrowDown' });
    expect(username).toHaveAttribute('aria-expanded', 'true');
    const listbox = screen.getByRole('listbox', { name: 'recent_accounts' });
    expect(username).toHaveAttribute('aria-controls', listbox.id);
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-label'))).toEqual(['ann@example.org', 'bob@example.org']);
    expect(username).toHaveAttribute('aria-activedescendant', options[0].id);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(username, { key: 'ArrowDown' });
    expect(username).toHaveAttribute('aria-activedescendant', options[1].id);

    // Delete takes the highlighted account off the list and saves that.
    fireEvent.keyDown(username, { key: 'Delete' });
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['ann@example.org']);
    expect(JSON.parse(localStorage.getItem('webmail_usernames')!)).toEqual(['ann@example.org']);

    // The remove button says which account it removes.
    expect(screen.getByRole('button', { name: 'remove_account_from_list', hidden: true })).toBeInTheDocument();

    fireEvent.keyDown(username, { key: 'ArrowUp' });
    fireEvent.keyDown(username, { key: 'ArrowDown' });
    fireEvent.keyDown(username, { key: 'Enter' });
    expect(username.value).toBe('ann@example.org');
    expect(username).toHaveAttribute('aria-expanded', 'false');
  }, 30_000);

  // CO-07: an expired session tried to save the open messages; one failed.
  it('says when an expired session could not save a draft', async () => {
    sessionStorage.setItem('session_expired', 'true');
    sessionStorage.setItem('session_expired_drafts_unsaved', 'true');
    await renderForm();
    expect(screen.getByText('drafts_not_saved')).toBeInTheDocument();
    expect(sessionStorage.getItem('session_expired_drafts_unsaved')).toBeNull();
  }, 30_000);

  // Offline mode (#523): an automatic sign-out deleted unsent messages.
  it('names the offline outbox messages a sign-out deleted, once', async () => {
    sessionStorage.setItem('bulwark-offline-lost', JSON.stringify(['Quarterly numbers']));
    await renderForm();
    expect((await screen.findByTestId('session-outbox-lost')).textContent).toContain('signout.lost');
    expect(sessionStorage.getItem('bulwark-offline-lost')).toBeNull();
  }, 30_000);
});
