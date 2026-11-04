import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A server of one's own (ALLOW_CUSTOM_JMAP_ENDPOINT): the email address comes first,
// the server is looked up from it, and the field for it only opens when nothing is
// found. A host typed without https:// works.

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

const configOverrides = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/hooks/use-config', () => ({
  useConfig: () => ({
    appName: 'Webmail',
    isLoading: false,
    error: null,
    jmapServerUrl: '',
    jmapServers: [],
    oauthEnabled: false,
    oauthOnly: false,
    allowCustomJmapEndpoint: true,
    loginShowHeading: true,
    loginShowSubtitle: true,
    loginShowTotp: true,
    ...configOverrides.value,
  }),
}));

const { default: LoginPage } = await import('../page');
const { useAuthStore } = await import('@/stores/auth-store');

let found: Record<string, string | null>;
let lookups: string[];
const login = vi.fn(async (..._args: unknown[]) => false);

beforeEach(() => {
  configOverrides.value = {};
  found = {};
  lookups = [];
  login.mockClear();
  useAuthStore.setState({ login: login as never, error: null, isLoading: false });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/auth/discover-server')) {
      const email = JSON.parse(String(init?.body)).email as string;
      lookups.push(email);
      const domain = email.split('@')[1];
      return new Response(JSON.stringify({ serverUrl: found[domain] ?? null }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const email = () => document.getElementById('username') as HTMLInputElement;
const serverField = () => document.getElementById('jmap-endpoint') as HTMLInputElement | null;
const form = () => email().closest('form')!;

async function typeAddress(address: string) {
  await waitFor(() => expect(email()).not.toBeNull(), { timeout: 10000 });
  fireEvent.change(email(), { target: { value: address } });
  fireEvent.change(document.getElementById('password')!, { target: { value: 'secret' } });
}

describe('sign-in to a server of one\'s own', () => {
  it('asks for the email address first, with no server field and no CORS line', async () => {
    render(<LoginPage />);
    await waitFor(() => expect(email()).not.toBeNull(), { timeout: 10000 });
    expect(serverField()).toBeNull();
    expect(screen.queryByText('jmap_endpoint_cors_hint')).toBeNull();
    expect(document.activeElement).toBe(email());
  }, 30_000);

  it('finds the server from the address and signs in there', async () => {
    found['example.org'] = 'https://mail.example.org';
    render(<LoginPage />);
    await typeAddress('sam@example.org');
    expect(await screen.findByTestId('login-server-found', {}, { timeout: 5000 })).toHaveTextContent('server_found');
    expect(serverField()).toBeNull();
    fireEvent.submit(form());
    await waitFor(() => expect(login).toHaveBeenCalled());
    expect(login.mock.calls[0][0]).toBe('https://mail.example.org');
    expect(lookups).toEqual(['sam@example.org']);
  }, 30_000);

  it('opens the field when nothing is found, and takes a host without https://', async () => {
    render(<LoginPage />);
    await typeAddress('sam@example.net');
    await waitFor(() => expect(serverField()).not.toBeNull(), { timeout: 5000 });
    expect(serverField()!.type).toBe('text');
    expect(screen.getByTestId('login-server-not-found')).toBeInTheDocument();
    // The CORS hint waits behind "Having trouble?".
    expect(screen.getByTestId('login-server-trouble').tagName).toBe('DETAILS');
    fireEvent.change(serverField()!, { target: { value: 'mail.example.net' } });
    fireEvent.submit(form());
    await waitFor(() => expect(login).toHaveBeenCalled());
    expect(login.mock.calls[0][0]).toBe('https://mail.example.net');
  }, 30_000);

  it('signing in before the lookup ends waits for it', async () => {
    found['example.org'] = 'https://mail.example.org';
    render(<LoginPage />);
    await typeAddress('sam@example.org');
    fireEvent.submit(form());
    await waitFor(() => expect(login).toHaveBeenCalled());
    expect(login.mock.calls[0][0]).toBe('https://mail.example.org');
  }, 30_000);

  it('uses the admin\'s server when the lookup finds nothing', async () => {
    configOverrides.value = { jmapServerUrl: 'https://default.example.com' };
    render(<LoginPage />);
    await typeAddress('sam@example.net');
    expect(await screen.findByTestId('login-server-found', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(serverField()).toBeNull();
    fireEvent.submit(form());
    await waitFor(() => expect(login).toHaveBeenCalled());
    expect(login.mock.calls[0][0]).toBe('https://default.example.com');
  }, 30_000);

  it('marks the field and signs in nowhere when the server address is no address', async () => {
    render(<LoginPage />);
    await typeAddress('sam@example.net');
    await waitFor(() => expect(serverField()).not.toBeNull(), { timeout: 5000 });
    fireEvent.change(serverField()!, { target: { value: 'mail example' } });
    fireEvent.submit(form());
    expect(await screen.findByTestId('login-server-error')).toHaveTextContent('server_invalid');
    expect(serverField()).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(document.activeElement).toBe(serverField()));
    expect(login).not.toHaveBeenCalled();
  }, 30_000);

  it('says plainly that Gmail can\'t be reached, and asks nothing', async () => {
    render(<LoginPage />);
    await typeAddress('sam@gmail.com');
    expect(await screen.findByTestId('login-provider-unsupported')).toHaveTextContent('provider_unsupported');
    await act(async () => { await new Promise((r) => setTimeout(r, 800)); });
    expect(lookups).toEqual([]);
  }, 30_000);
});

describe('the page around the form', () => {
  it('the theme button is an icon named "Light or dark", with a tooltip', async () => {
    render(<LoginPage />);
    const button = await screen.findByTestId('login-theme-button', {}, { timeout: 10000 });
    expect(button).toHaveAttribute('title', 'theme_button');
    expect(button.getAttribute('aria-label')).toMatch(/^theme_button: /);
    expect(button.textContent).toBe('');
  }, 30_000);

  it('the heading says "Sign in" unless the admin named the app', async () => {
    render(<LoginPage />);
    expect(await screen.findByRole('heading', { level: 1 }, { timeout: 10000 })).toHaveTextContent('sign_in');
  }, 30_000);

  it('the heading is the app\'s name when the admin gave one', async () => {
    configOverrides.value = { appName: 'Example Mail' };
    render(<LoginPage />);
    expect(await screen.findByRole('heading', { level: 1 }, { timeout: 10000 })).toHaveTextContent('Example Mail');
  }, 30_000);
});
