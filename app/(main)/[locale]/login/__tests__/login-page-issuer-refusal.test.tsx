import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// When the server refuses a provider for naming another issuer than it was
// discovered at (more than one sign-in server), the login page says the
// provider is not set up correctly and that the administrator has to set its
// issuer address. A provider that really can't be reached keeps the notice
// that says so.

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
    oauthClientId: 'webmail',
    loginShowHeading: true,
    loginShowSubtitle: true,
    ...configOverrides.value,
  }),
}));

/** What the server's discovery answer for the login page says. */
let metadataAnswer: () => Response;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/api/auth/oauth/metadata')) return metadataAnswer();
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  configOverrides.value = {};
});

const { default: LoginPage } = await import('../page');

const refused = () => Response.json({ error: 'issuer_mismatch' }, { status: 502 });
const unreachable = () => Response.json({ error: 'OAuth discovery failed' }, { status: 502 });

describe('the login page when the provider can not be used', () => {
  it.each([
    ['the sign-in form with SSO', {}],
    ['the SSO-only card', { oauthOnly: true }],
  ])('names the issuer setting in %s when the server refused the provider for it', async (_where, overrides) => {
    configOverrides.value = overrides;
    metadataAnswer = refused;
    render(<LoginPage />);
    expect(await screen.findByText(/oauth_issuer_mismatch/, {}, { timeout: 10000 })).toBeInTheDocument();
    expect(screen.queryByText(/oauth_discovery_failed/)).toBeNull();
  }, 30_000);

  it.each([
    ['the sign-in form with SSO', {}],
    ['the SSO-only card', { oauthOnly: true }],
  ])('says the provider could not be reached in %s when it really could not', async (_where, overrides) => {
    configOverrides.value = overrides;
    metadataAnswer = unreachable;
    render(<LoginPage />);
    expect(await screen.findByText(/oauth_discovery_failed/, {}, { timeout: 10000 })).toBeInTheDocument();
    expect(screen.queryByText(/oauth_issuer_mismatch/)).toBeNull();
  }, 30_000);
});
