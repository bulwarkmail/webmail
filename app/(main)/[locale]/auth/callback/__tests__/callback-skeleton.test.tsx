import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// While the sign-in is completed, the callback draws the mail page's
// skeleton: that is where it lands, and the mail page's own gate draws the
// same, so nothing changes when it gets there.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ locale: 'en' }),
  useSearchParams: () => new URLSearchParams('code=abc&state=xyz'),
}));

const { default: OAuthCallbackPage } = await import('../page');

describe('OAuth callback while the sign-in completes', () => {
  it('server-renders the mail skeleton with the completing message, not a spinner', () => {
    const container = document.createElement('div');
    container.innerHTML = renderToString(<OAuthCallbackPage />);
    expect(container.querySelector('[data-boot-skeleton="mail"]')).not.toBeNull();
    expect(container.querySelector('[data-boot-skeleton="mail"] [role="status"]')?.textContent).toBe('oauth_completing');
    expect(container.querySelector('.animate-spin')).toBeNull();
  });
});
