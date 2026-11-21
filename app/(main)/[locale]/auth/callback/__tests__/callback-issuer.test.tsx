import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The SSO return passes the `iss` of its address (RFC 9207) on to the route
// that completes the sign-in, so the server can refuse a code from another
// issuer than the one the sign-in was sent to.

const router = { push: vi.fn(), replace: vi.fn() };
let query = '';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useParams: () => ({ locale: 'en' }),
  useSearchParams: () => new URLSearchParams(query),
}));
vi.mock('next-intl', () => {
  const t = (key: string) => key;
  return { useTranslations: () => t, useLocale: () => 'en' };
});

const apiFetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({}), { status: 200 }));
vi.mock('@/lib/browser-navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/browser-navigation')>()),
  apiFetch: (url: string, init?: RequestInit) => apiFetch(url, init),
}));

const loginWithOAuth = vi.fn(async () => true);
const loginWithServerSso = vi.fn(async () => true);
const authState = { isAuthenticated: false, loginWithOAuth, loginWithServerSso };
vi.mock('@/stores/auth-store', () => {
  const useAuthStore = Object.assign(() => authState, { getState: () => authState });
  return { useAuthStore };
});

const { default: OAuthCallbackPage } = await import('../page');

const ISSUER = 'https://idp.example';

function sentBody(path: string): Record<string, unknown> {
  const call = apiFetch.mock.calls.find(([url]) => url === path);
  expect(call).toBeDefined();
  return JSON.parse(String(call![1]?.body)) as Record<string, unknown>;
}

beforeEach(() => {
  router.push.mockClear();
  router.replace.mockClear();
  apiFetch.mockClear();
  loginWithOAuth.mockClear();
  loginWithServerSso.mockClear();
  sessionStorage.clear();
});

describe('the SSO return and the issuer that answered', () => {
  it('passes iss on when it completes a pairing step-up', async () => {
    query = `code=abc&state=xyz&iss=${encodeURIComponent(ISSUER)}`;
    sessionStorage.setItem('pair_reauth_resume', 'xyz');
    render(<OAuthCallbackPage />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(sentBody('/api/auth/reauth/sso/complete')).toEqual({ code: 'abc', state: 'xyz', iss: ISSUER });
  });

  it('passes iss on when it completes a hand-off to the app', async () => {
    query = `code=abc&state=xyz&iss=${encodeURIComponent(ISSUER)}`;
    sessionStorage.setItem('mobile_redirect_uri', 'bulwarkmobile://auth/callback');
    sessionStorage.setItem('mobile_state', 'app-state');
    render(<OAuthCallbackPage />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(sentBody('/api/auth/sso/complete')).toEqual({ code: 'abc', state: 'xyz', iss: ISSUER });
  });

  it('sends none when the address has none', async () => {
    query = 'code=abc&state=xyz';
    sessionStorage.setItem('pair_reauth_resume', 'xyz');
    render(<OAuthCallbackPage />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(sentBody('/api/auth/reauth/sso/complete')).toEqual({ code: 'abc', state: 'xyz' });
  });

  it('sends nothing anywhere for an error answer, whoever names itself in it', async () => {
    query = `error=access_denied&state=xyz&iss=${encodeURIComponent('https://foreign.example')}`;
    sessionStorage.setItem('pair_reauth_resume', 'xyz');
    render(<OAuthCallbackPage />);
    expect(await screen.findByText('oauth_error.title')).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(loginWithServerSso).not.toHaveBeenCalled();
    expect(loginWithOAuth).not.toHaveBeenCalled();
  });
});
