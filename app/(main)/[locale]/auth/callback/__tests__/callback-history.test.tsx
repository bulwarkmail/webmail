import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// After an SSO sign-in in Lite, Back returned to the callback address with the
// spent code and the page said the sign-in did not work, although it had.

const router = { push: vi.fn(), replace: vi.fn() };
let query = 'code=abc&state=xyz';

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useParams: () => ({ locale: 'en' }),
  useSearchParams: () => new URLSearchParams(query),
}));
vi.mock('next-intl', () => {
  const t = (key: string) => key;
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('@/lib/lite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/lite')>()),
  IS_LITE: true,
}));

const loginWithOAuth = vi.fn(async () => true);
const loginWithServerSso = vi.fn(async () => false);
const authState = { isAuthenticated: false, loginWithOAuth, loginWithServerSso };
vi.mock('@/stores/auth-store', () => {
  const useAuthStore = Object.assign(() => authState, { getState: () => authState });
  return { useAuthStore };
});

const { default: OAuthCallbackPage } = await import('../page');

beforeEach(() => {
  router.push.mockClear();
  router.replace.mockClear();
  loginWithOAuth.mockClear();
  loginWithServerSso.mockClear();
  authState.isAuthenticated = false;
  query = 'code=abc&state=xyz';
  sessionStorage.clear();
});

describe('the SSO return in Lite', () => {
  it('replaces its own history entry once the code is spent', async () => {
    sessionStorage.setItem('oauth_state', 'xyz');
    sessionStorage.setItem('oauth_code_verifier', 'verifier');
    sessionStorage.setItem('oauth_server_url', 'https://mail.example.com');
    render(<OAuthCallbackPage />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/en'));
    expect(loginWithOAuth).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('goes on to the app when Back brings it here again with the spent code', async () => {
    // The sign-in that spent the code is on; its state left with it.
    authState.isAuthenticated = true;
    render(<OAuthCallbackPage />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/en'));
    expect(screen.queryByText('oauth_error.title')).toBeNull();
    expect(loginWithOAuth).not.toHaveBeenCalled();
    expect(loginWithServerSso).not.toHaveBeenCalled();
  });

  it('still says so when nobody is signed in', async () => {
    render(<OAuthCallbackPage />);
    expect(await screen.findByText('oauth_error.title')).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
