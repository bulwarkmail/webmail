import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The desktop app's first screen already asked for the email address. The sign-in page
// it opens gets it as ?login_hint=, fills it in, looks the server up at once and puts
// the caret in the password field: nobody types the address twice.

const query = vi.hoisted(() => ({ value: '' }));
const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ locale: 'en' }),
  useSearchParams: () => new URLSearchParams(query.value),
  useRouter: () => nav,
  usePathname: () => '/login',
}));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => nav,
  usePathname: () => '/login',
  Link: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/hooks/use-config', () => ({
  useConfig: () => ({
    appName: 'Webmail',
    isLoading: false,
    error: null,
    jmapServerUrl: '',
    jmapServers: [],
    oauthEnabled: false,
    oauthOnly: false,
    rememberMeEnabled: false,
    allowCustomJmapEndpoint: true,
    loginShowHeading: true,
    loginShowSubtitle: true,
    loginShowTotp: true,
  }),
}));

const { default: LoginPage } = await import('../page');
const { useAuthStore } = await import('@/stores/auth-store');
const { useAccountStore } = await import('@/stores/account-store');

let lookups: string[];

beforeEach(() => {
  lookups = [];
  query.value = '';
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/auth/discover-server')) {
      lookups.push(JSON.parse(String(init?.body)).email as string);
      return new Response(JSON.stringify({ serverUrl: 'https://mail.example.org' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  nav.push.mockClear();
  nav.replace.mockClear();
  useAuthStore.setState({ isAuthenticated: false } as never);
  useAccountStore.setState({ accounts: [] } as never);
  delete (window as { bulwarkDesktop?: unknown }).bulwarkDesktop;
});

const entry = (id: string, email: string) => ({ id, label: email, serverUrl: 'https://mail.example.org', username: email, email, authMode: 'basic', cookieSlot: 0, rememberMe: true, displayName: '', avatarColor: '#000', lastLoginAt: 0, isConnected: true, hasError: false, isDefault: false });

const email = () => document.getElementById('username') as HTMLInputElement;
const password = () => document.getElementById('password') as HTMLInputElement;

describe('the address handed over in login_hint', () => {
  it('offers expired accounts and signs in to the selected full server URL without discovery', async () => {
    const saved = { ...entry('sam@example.org@mail.example.org', 'sam@example.org'), serverUrl: 'https://mail.example.org:8443/jmap', awaitingSignIn: true, isConnected: false };
    useAccountStore.setState({ accounts: [saved] } as never);
    const login = vi.fn(async () => false);
    useAuthStore.setState({ login, isAuthenticated: false });
    render(<LoginPage />);
    const list = await screen.findByTestId('pending-accounts');
    fireEvent.click(list.querySelector('[data-testid="pending-account-sign-in"]')!);
    expect(email().value).toBe('sam@example.org');
    fireEvent.change(password(), { target: { value: 'new-password' } });
    fireEvent.submit(password().closest('form')!);
    await waitFor(() => expect(login).toHaveBeenCalledWith(saved.serverUrl, saved.username, 'new-password', undefined, false, saved.id));
    expect(lookups).toEqual([]);
  });

  it('can forget a pending account before any account signs in', async () => {
    const saved = { ...entry('sam@example.org@mail.example.org', 'sam@example.org'), awaitingSignIn: true, isConnected: false };
    useAccountStore.setState({ accounts: [saved] } as never);
    useAuthStore.setState({ isAuthenticated: false, activeAccountId: null });
    render(<LoginPage />);
    const list = await screen.findByTestId('pending-accounts');
    fireEvent.click(list.querySelector('[data-testid="pending-account-remove"]')!);
    await waitFor(() => expect(useAccountStore.getState().accounts).toEqual([]));
    expect(screen.queryByTestId('pending-accounts')).not.toBeInTheDocument();
  });

  it('is filled in, its server is looked up at once, and the password field has the caret', async () => {
    query.value = 'login_hint=sam%2Bnews%40example.org';
    render(<LoginPage />);
    await waitFor(() => expect(email()).not.toBeNull(), { timeout: 10000 });
    expect(email().value).toBe('sam+news@example.org');
    expect(document.activeElement).toBe(password());
    // No 600 ms wait for typing to stop: the lookup is under way straight away.
    await waitFor(() => expect(lookups).toEqual(['sam+news@example.org']), { timeout: 400 });
    expect(await screen.findByTestId('login-server-found')).toBeInTheDocument();
  }, 30_000);

  it('is ignored when it is no address, and the address field keeps the caret', async () => {
    query.value = 'login_hint=%3Cscript%3E';
    render(<LoginPage />);
    await waitFor(() => expect(email()).not.toBeNull(), { timeout: 10000 });
    expect(email().value).toBe('');
    expect(document.activeElement).toBe(email());
  }, 30_000);
});

// After File > Change connection… the first screen asks for an address again. Signed in
// already, the app uses it: that account, or the form to add it (desktop-p3-2).
describe('the address handed over while signed in', () => {
  it('opens the form to add it when no account here has it', async () => {
    query.value = 'login_hint=kim%40example.org';
    useAccountStore.setState({ accounts: [entry('a', 'sam@example.org')] } as never);
    useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'a' } as never);
    render(<LoginPage />);
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/login?mode=add-account&login_hint=kim%40example.org'));
    expect(nav.push).not.toHaveBeenCalledWith('/');
  }, 30_000);

  it('switches to the account that has it', async () => {
    query.value = 'login_hint=Kim%40example.org';
    const switchAccount = vi.fn(async () => {});
    useAccountStore.setState({ accounts: [entry('a', 'sam@example.org'), entry('b', 'kim@example.org')] } as never);
    useAuthStore.setState({ isAuthenticated: true, activeAccountId: 'a', switchAccount } as never);
    render(<LoginPage />);
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/'));
    expect(switchAccount).toHaveBeenCalledWith('b');
    expect(nav.replace).not.toHaveBeenCalled();
  }, 30_000);
});
