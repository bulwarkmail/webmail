import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfig } from '@/lib/__tests__/fixtures/config';

// The browser's own SSO sign-in names the provider that answered: the SSO
// return passes the `iss` of its address to the auth store, and the store
// sends it with the code, for both the server-side and the page-driven flow.
// The server then refuses a code from another provider than the one asked.

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
vi.mock('@/lib/jmap/client', () => {
  class JMAPClient {
    static withBearer() { return new JMAPClient(); }
    async connect() { throw new Error('not in this test'); }
    disconnect() {}
  }
  class RateLimitError extends Error {}
  return { JMAPClient, RateLimitError };
});

const { default: OAuthCallbackPage } = await import('../page');
const { useAccountStore } = await import('@/stores/account-store');

/** What the store sent, by path. */
let sent: Array<{ path: string; body: Record<string, unknown> }>;

const ASKED = 'https://other.example';
const ANSWERED = 'https://honest.example';

beforeEach(() => {
  router.push.mockClear();
  router.replace.mockClear();
  sessionStorage.clear();
  localStorage.clear();
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  sent = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input).split('?')[0];
    if (path.includes('/api/config')) return new Response(JSON.stringify(createConfig()), { status: 200 });
    sent.push({ path, body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {} });
    // The server answers as it does for a code from another provider than the one asked.
    return new Response(JSON.stringify({ error: 'Issuer mismatch' }), { status: 400 });
  }));
});

function bodyTo(path: string): Record<string, unknown> {
  const request = sent.find((entry) => entry.path === path);
  expect(request, path).toBeDefined();
  return request!.body;
}

describe('the SSO return of the browser\'s own sign-in', () => {
  it('sends the provider that answered with the server-side code, and signs nobody in when it is refused', async () => {
    query = `code=CODE-FROM-HONEST&state=xyz&iss=${encodeURIComponent(ANSWERED)}`;
    render(<OAuthCallbackPage />);
    expect(await screen.findByText('oauth_error.title')).toBeInTheDocument();
    expect(bodyTo('/api/auth/sso/complete')).toMatchObject({ code: 'CODE-FROM-HONEST', state: 'xyz', iss: ANSWERED });
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('sends the provider that answered with the page-driven code exchange', async () => {
    query = `code=CODE-FROM-HONEST&state=xyz&iss=${encodeURIComponent(ANSWERED)}`;
    sessionStorage.setItem('oauth_state', 'xyz');
    sessionStorage.setItem('oauth_code_verifier', 'v'.repeat(43));
    sessionStorage.setItem('oauth_server_url', ASKED);
    sessionStorage.setItem('oauth_server_id', 'other');
    render(<OAuthCallbackPage />);
    expect(await screen.findByText('oauth_error.title')).toBeInTheDocument();
    expect(bodyTo('/api/auth/token')).toMatchObject({ code: 'CODE-FROM-HONEST', server_id: 'other', iss: ANSWERED });
  });

  it('sends none when the address has none', async () => {
    query = 'code=CODE&state=xyz';
    render(<OAuthCallbackPage />);
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(bodyTo('/api/auth/sso/complete')).not.toHaveProperty('iss');
  });
});
