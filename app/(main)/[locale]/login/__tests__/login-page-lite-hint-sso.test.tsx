import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #1860: Lite on Stalwart, opened with ?login_hint= for an account whose
// domain signs in at an outside provider, showed "Sign in with SSO" and
// waited for a click. It now starts that sign-in once.

vi.stubEnv('NEXT_PUBLIC_BULWARK_LITE', '1');
vi.stubEnv('NEXT_PUBLIC_LITE_TARGET', 'stalwart');

const hint = { value: 'alice@example.com' };

vi.mock('next/navigation', () => ({
  useParams: () => ({ locale: 'en' }),
  useSearchParams: () => new URLSearchParams(hint.value ? { login_hint: hint.value } : {}),
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
    jmapServerUrl: 'https://mail.example.com',
    jmapServers: [],
    oauthEnabled: false,
    oauthOnly: false,
    autoSsoEnabled: false,
  }),
}));

const { default: LoginPage } = await import('../page');

/** What Stalwart relays for a domain whose directory is an outside OpenID provider. */
const PROVIDER = {
  issuer: 'https://id.example.org',
  authorization_endpoint: 'https://id.example.org/authorize',
  token_endpoint: 'https://id.example.org/token',
  scopes_supported: ['openid', 'offline_access'],
};
/** What it answers for a domain it signs in itself. */
const OWN = {
  issuer: 'https://mail.example.com',
  authorization_endpoint: 'https://mail.example.com/login',
  token_endpoint: 'https://mail.example.com/auth/token',
  scopes_supported: ['openid', 'offline_access'],
};

let discovered: string[];
// Discovery answers are cached per address for the page's lifetime
// (lib/auth/lite-oauth.ts), so each test signs in a different one.
let next = 0;
const address = () => `user${++next}@example.com`;

function serve(document: object) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/discover/')) {
      discovered.push(url);
      return new Response(JSON.stringify(document), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  }));
}

beforeEach(() => {
  discovered = [];
  hint.value = address();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const started = () => sessionStorage.getItem('oauth_state') !== null;

/** The page asked Stalwart who signs the account in, and had time to act on it. */
async function settled() {
  await vi.waitFor(() => expect(discovered.length).toBeGreaterThan(0), { timeout: 10000 });
  await new Promise((resolve) => setTimeout(resolve, 500));
}

describe('Lite: a login_hint for an account at an outside provider', () => {
  it('starts the provider sign-in without a click', async () => {
    serve(PROVIDER);
    render(<LoginPage />);
    await vi.waitFor(() => expect(started()).toBe(true), { timeout: 10000 });
    expect(discovered[0]).toBe(`https://mail.example.com/api/discover/${encodeURIComponent(hint.value)}`);
  }, 30_000);

  it('keeps the password form for an account Stalwart signs in itself', async () => {
    serve(OWN);
    render(<LoginPage />);
    await settled();
    expect(started()).toBe(false);
  }, 30_000);

  it('waits for a click after a sign-out on purpose', async () => {
    sessionStorage.setItem('signed_out', String(Date.now() - 5_000));
    serve(PROVIDER);
    render(<LoginPage />);
    await settled();
    expect(started()).toBe(false);
  }, 30_000);

  it('waits for a click right after the last attempt, so a failed one cannot loop', async () => {
    sessionStorage.setItem('sso_attempted', String(Date.now() - 1_000));
    serve(PROVIDER);
    render(<LoginPage />);
    await settled();
    expect(started()).toBe(false);
  }, 30_000);

  it('waits for a click when the address was typed, not handed over', async () => {
    hint.value = '';
    serve(PROVIDER);
    render(<LoginPage />);
    const email = await waitFor(() => {
      const input = document.getElementById('username');
      if (!input) throw new Error('no address field yet');
      return input;
    }, { timeout: 10000 });
    fireEvent.change(email, { target: { value: address() } });
    await vi.waitFor(() => expect(discovered.length).toBeGreaterThan(0), { timeout: 10000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(started()).toBe(false);
  }, 30_000);
});
