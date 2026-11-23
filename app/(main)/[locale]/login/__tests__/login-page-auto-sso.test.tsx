import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #1819: automatic SSO went quiet in a tab for good after one round trip, and
// after a sign-out that left through an outside page.

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
    oauthEnabled: true,
    oauthOnly: true,
    oauthClientId: 'webmail',
    autoSsoEnabled: true,
  }),
}));

const { default: LoginPage } = await import('../page');

const METADATA = {
  issuer: 'https://mail.example.org',
  authorization_endpoint: 'https://mail.example.org/authorize',
  token_endpoint: 'https://mail.example.org/token',
};

let fetched: string[];

beforeEach(() => {
  fetched = [];
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    if (url.includes('/api/auth/oauth/metadata')) return new Response(JSON.stringify(METADATA), { status: 200 });
    if (url.includes('/api/auth/sso/start')) return new Response(JSON.stringify({ authorize_url: 'about:blank#sso' }), { status: 200 });
    return new Response('{}', { status: 200 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const startedSso = () => fetched.some((url) => url.includes('/api/auth/sso/start'));
const ssoButton = () => screen.findByRole('button', { name: /sign_in_sso/ }, { timeout: 10000 });

/** The page has its provider's metadata, and had time to redirect if it would. */
async function settled() {
  await ssoButton();
  await waitFor(() => expect(fetched.some((url) => url.includes('/api/auth/oauth/metadata'))).toBe(true), { timeout: 10000 });
  await new Promise((resolve) => setTimeout(resolve, 500));
}

describe('automatic SSO in a tab that used it before', () => {
  it('starts again after an earlier round trip in the same tab', async () => {
    sessionStorage.setItem('sso_attempted', String(Date.now() - 60_000));
    render(<LoginPage />);
    await waitFor(() => expect(startedSso()).toBe(true), { timeout: 10000 });
  }, 30_000);

  it('stays on the page when the last attempt was a moment ago, so it cannot loop', async () => {
    sessionStorage.setItem('sso_attempted', String(Date.now() - 1_000));
    render(<LoginPage />);
    await settled();
    expect(startedSso()).toBe(false);
  }, 30_000);

  it('stays on the page right after a sign-out', async () => {
    sessionStorage.setItem('signed_out', String(Date.now() - 5_000));
    render(<LoginPage />);
    await settled();
    expect(startedSso()).toBe(false);
  }, 30_000);

  it('starts on a visit long after a sign-out that left through another site', async () => {
    sessionStorage.setItem('signed_out', String(Date.now() - 30 * 60_000));
    render(<LoginPage />);
    await waitFor(() => expect(startedSso()).toBe(true), { timeout: 10000 });
  }, 30_000);
});
