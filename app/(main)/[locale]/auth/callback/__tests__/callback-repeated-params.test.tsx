import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// An authorization answer carries each parameter once (RFC 6749 section
// 4.1.2). A callback address that repeats `code`, `state` or `iss` (a
// redirect URI the provider let through with a query of its own, then its own
// parameters appended) is not taken: no first or last one is handed on.

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

beforeEach(() => {
  router.push.mockClear();
  router.replace.mockClear();
  apiFetch.mockClear();
  loginWithOAuth.mockClear();
  loginWithServerSso.mockClear();
  sessionStorage.clear();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

describe('a callback address that repeats a parameter', () => {
  it('signs nobody in when it names the issuer twice', async () => {
    query = `iss=${encodeURIComponent('https://other.example')}&code=abc&state=xyz&iss=${encodeURIComponent(ISSUER)}`;
    render(<OAuthCallbackPage />);
    await settle();
    expect(loginWithServerSso).not.toHaveBeenCalled();
    expect(loginWithOAuth).not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('signs nobody in when it names the code or the state twice', async () => {
    query = `code=first&state=xyz&code=second&iss=${encodeURIComponent(ISSUER)}`;
    render(<OAuthCallbackPage />);
    await settle();
    expect(loginWithServerSso).not.toHaveBeenCalled();

    query = `code=abc&state=one&state=two&iss=${encodeURIComponent(ISSUER)}`;
    render(<OAuthCallbackPage />);
    await settle();
    expect(loginWithServerSso).not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('still takes an address with each parameter once (control)', async () => {
    query = `code=abc&state=xyz&iss=${encodeURIComponent(ISSUER)}`;
    render(<OAuthCallbackPage />);
    await settle();
    expect(loginWithServerSso).toHaveBeenCalledWith('abc', 'xyz', ISSUER);
  });
});
