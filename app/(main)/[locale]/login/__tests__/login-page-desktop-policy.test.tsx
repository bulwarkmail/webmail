import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulwarkDesktopBridge } from '@/lib/desktop/types';
import { EMPTY_POLICY_LAYERS, resolvePolicies } from '@/lib/desktop/policy-schema';

// The device's OS policy on the two ways into SSO: nothing starts towards a refused server.

const params = vi.hoisted(() => ({ value: null as URLSearchParams | null }));

vi.mock('next/navigation', () => ({
  useParams: () => ({ locale: 'en' }),
  useSearchParams: () => params.value ?? new URLSearchParams(),
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
  params.value = null;
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

describe('sign-in with the browser, in the app', () => {
  const REDIRECT = 'http://127.0.0.1:51234/bulwark-desktop/callback';

  function appBridge(options: { servers?: string[]; browserSignIn?: boolean; complete?: () => unknown } = {}) {
    const forced: Record<string, unknown> = {};
    if (options.servers) forced.AllowedJmapServers = options.servers;
    if (options.browserSignIn !== undefined) forced.BrowserSignIn = options.browserSignIn;
    const snapshot = resolvePolicies({ ...EMPTY_POLICY_LAYERS, forcedMachine: forced });
    const controls = {
      begin: vi.fn(async () => ({ ok: true, flowId: 'f1', redirectUri: REDIRECT, state: 'main-state' })),
      complete: vi.fn(async () => (options.complete ? options.complete() : { ok: false, error: 'cancelled' })),
      cancel: vi.fn(),
    };
    window.bulwarkDesktop = {
      version: 1,
      platform: 'win32',
      mode: 'instance',
      auth: { claim: () => controls },
      policy: { get: () => snapshot, onChange: () => () => {} },
    } as unknown as BulwarkDesktopBridge;
    return controls;
  }

  const browserButton = () => screen.findByTestId('desktop-browser-sign-in', {}, { timeout: 10000 });

  it('stays the other choice next to the form', async () => {
    configOverrides.value = { oauthEnabled: false, oauthOnly: false };
    appBridge();
    render(<LoginPage />);
    expect((await browserButton()).textContent).toContain('button');
    expect(document.getElementById('username')).not.toBeNull();
    expect(document.getElementById('password')).not.toBeNull();
  }, 30_000);

  it('is the main way in on an OAuth-only instance, with no form', async () => {
    appBridge();
    render(<LoginPage />);
    await browserButton();
    expect(document.getElementById('password')).toBeNull();
    expect(await ssoButton()).toBeInTheDocument();
  }, 30_000);

  it('is gone when a policy says so, and the form stays', async () => {
    configOverrides.value = { oauthEnabled: false, oauthOnly: false };
    appBridge({ browserSignIn: false });
    render(<LoginPage />);
    await waitFor(() => expect(document.getElementById('password')).not.toBeNull(), { timeout: 10000 });
    expect(screen.queryByTestId('desktop-browser-sign-in')).toBeNull();
  }, 30_000);

  it('is not there in a browser', async () => {
    configOverrides.value = { oauthEnabled: false, oauthOnly: false };
    render(<LoginPage />);
    await waitFor(() => expect(document.getElementById('password')).not.toBeNull(), { timeout: 10000 });
    expect(screen.queryByTestId('desktop-browser-sign-in')).toBeNull();
  }, 30_000);

  it('starts nothing towards a server off the list, and says why', async () => {
    const controls = appBridge({ servers: ['https://other.example.org'] });
    render(<LoginPage />);
    fireEvent.click(await browserButton());
    expect(await screen.findByText('server_refused')).toBeInTheDocument();
    expect(controls.begin).not.toHaveBeenCalled();
  }, 30_000);

  it('a flow that ran out says so, and the button comes back', async () => {
    const controls = appBridge({ complete: () => ({ ok: false, error: 'timeout' }) });
    render(<LoginPage />);
    fireEvent.click(await browserButton());
    expect(await screen.findByText('timed_out')).toBeInTheDocument();
    expect(controls.complete).toHaveBeenCalledOnce();
    expect(await browserButton()).not.toBeDisabled();
  }, 30_000);

  it('asks the instance with the device\'s list, and a refusal is the policy\'s notice', async () => {
    appBridge({ servers: ['https://mail.example.org'], complete: () => ({ ok: true, code: 'c'.repeat(64), state: 'main-state' }) });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetched.push(url);
      if (url.includes('/api/auth/oauth/metadata')) return new Response(JSON.stringify(METADATA), { status: 200 });
      if (url.includes('/api/auth/desktop-handoff/redeem')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ allowed_servers: ['https://mail.example.org'] });
        return new Response(JSON.stringify({ error: 'blocked_by_policy' }), { status: 403 });
      }
      return new Response('{}', { status: 200 });
    }));
    render(<LoginPage />);
    fireEvent.click(await browserButton());
    expect(await screen.findByText('server_refused')).toBeInTheDocument();
    expect(fetched.some((url) => url.includes('/api/auth/desktop-handoff/redeem'))).toBe(true);
  }, 30_000);
});

describe('the page the app opens in the browser', () => {
  const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  const search = (entries: Record<string, string>) => new URLSearchParams(entries);

  it('parks the password and leaves this browser signed out, after asking', async () => {
    configOverrides.value = { oauthEnabled: false, oauthOnly: false };
    params.value = search({ mobile_redirect_uri: 'http://127.0.0.1:51234/bulwark-desktop/callback', mobile_state: 's', mobile_code_challenge: CHALLENGE });
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetched.push(url);
      if (url.includes('/api/auth/desktop-handoff/park')) {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ code: 'a'.repeat(64) }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));
    render(<LoginPage />);
    await screen.findByTestId('desktop-handoff-banner', {}, { timeout: 10000 });
    fireEvent.change(document.getElementById('username')!, { target: { value: 'a@example.org' } });
    fireEvent.change(document.getElementById('password')!, { target: { value: 'secret' } });
    fireEvent.submit(document.getElementById('password')!.closest('form')!);
    expect(await screen.findByText('consent_title')).toBeInTheDocument();
    expect(bodies[0]).toMatchObject({ code_challenge: CHALLENGE, state: 's', username: 'a@example.org', password: 'secret' });
    // No session anywhere: nothing went to the routes a browser sign-in writes cookies from.
    expect(fetched.some((url) => /api\/auth\/(session|verify|token)/.test(url))).toBe(false);
  }, 30_000);

  it('ignores a loopback target with no challenge, and is the ordinary page', async () => {
    configOverrides.value = { oauthEnabled: false, oauthOnly: false };
    params.value = search({ mobile_redirect_uri: 'http://127.0.0.1:51234/bulwark-desktop/callback', mobile_state: 's' });
    render(<LoginPage />);
    await waitFor(() => expect(document.getElementById('password')).not.toBeNull(), { timeout: 10000 });
    expect(screen.queryByTestId('desktop-handoff-banner')).toBeNull();
  }, 30_000);

  it('ignores a target that is not this computer', async () => {
    configOverrides.value = { oauthEnabled: false, oauthOnly: false };
    params.value = search({ mobile_redirect_uri: 'http://evil.example:51234/bulwark-desktop/callback', mobile_state: 's', mobile_code_challenge: CHALLENGE });
    render(<LoginPage />);
    await waitFor(() => expect(document.getElementById('password')).not.toBeNull(), { timeout: 10000 });
    expect(screen.queryByTestId('desktop-handoff-banner')).toBeNull();
  }, 30_000);
});
