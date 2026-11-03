import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulwarkDesktopBridge } from '@/lib/desktop/types';
import { EMPTY_POLICY_LAYERS, resolvePolicies } from '@/lib/desktop/policy-schema';

// The device's OS policy on the two ways into SSO: nothing starts towards a refused server.

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
    jmapServerUrl: 'https://mail.example.org',
    jmapServers: [],
    oauthEnabled: true,
    oauthOnly: true,
    oauthClientId: 'webmail',
    ...configOverrides.value,
  }),
}));

const { default: LoginPage } = await import('../page');

const METADATA = {
  issuer: 'https://mail.example.org',
  authorization_endpoint: 'https://mail.example.org/authorize',
  token_endpoint: 'https://mail.example.org/token',
};

function allowOnly(...servers: string[]) {
  const snapshot = resolvePolicies({ ...EMPTY_POLICY_LAYERS, forcedMachine: { AllowedJmapServers: servers } });
  window.bulwarkDesktop = {
    version: 1,
    platform: 'win32',
    mode: 'standalone',
    policy: { get: () => snapshot, onChange: () => () => {} },
  } as unknown as BulwarkDesktopBridge;
}

let fetched: string[];

beforeEach(() => {
  configOverrides.value = {};
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
  window.bulwarkDesktop = undefined;
});

const ssoButton = () => screen.findByRole('button', { name: /sign_in_sso/ }, { timeout: 10000 });
const startedPkce = () => sessionStorage.getItem('oauth_code_verifier');
const startedSso = () => fetched.some((url) => url.includes('/api/auth/sso/start'));

describe('the SSO button', () => {
  it('starts nothing towards a server off the list, and says why', async () => {
    allowOnly('https://other.example.org');
    render(<LoginPage />);
    fireEvent.click(await ssoButton());
    expect(await screen.findByText('server_refused')).toBeInTheDocument();
    expect(startedPkce()).toBeNull();
  }, 30_000);

  it('starts as usual towards a server on the list', async () => {
    allowOnly('https://mail.example.org');
    render(<LoginPage />);
    fireEvent.click(await ssoButton());
    await waitFor(() => expect(startedPkce()).not.toBeNull());
    expect(screen.queryByText('server_refused')).toBeNull();
  }, 30_000);
});

describe('automatic SSO', () => {
  it('asks the server for nothing when its server is off the list, and says why', async () => {
    configOverrides.value = { autoSsoEnabled: true };
    allowOnly('https://other.example.org');
    render(<LoginPage />);
    expect(await screen.findByText('server_refused', {}, { timeout: 10000 })).toBeInTheDocument();
    expect(startedSso()).toBe(false);
  }, 30_000);

  it('starts as usual when its server is on the list', async () => {
    configOverrides.value = { autoSsoEnabled: true };
    allowOnly('https://mail.example.org');
    render(<LoginPage />);
    await waitFor(() => expect(startedSso()).toBe(true), { timeout: 10000 });
  }, 30_000);
});
