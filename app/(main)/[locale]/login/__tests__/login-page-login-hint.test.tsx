import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The desktop app's first screen already asked for the email address. The sign-in page
// it opens gets it as ?login_hint=, fills it in, looks the server up at once and puts
// the caret in the password field: nobody types the address twice.

const query = vi.hoisted(() => ({ value: '' }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ locale: 'en' }),
  useSearchParams: () => new URLSearchParams(query.value),
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
    jmapServerUrl: '',
    jmapServers: [],
    oauthEnabled: false,
    oauthOnly: false,
    allowCustomJmapEndpoint: true,
    loginShowHeading: true,
    loginShowSubtitle: true,
    loginShowTotp: true,
  }),
}));

const { default: LoginPage } = await import('../page');

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
});

const email = () => document.getElementById('username') as HTMLInputElement;
const password = () => document.getElementById('password') as HTMLInputElement;

describe('the address handed over in login_hint', () => {
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
