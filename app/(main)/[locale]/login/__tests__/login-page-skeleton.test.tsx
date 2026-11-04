import React, { act } from 'react';
import { render } from '@testing-library/react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Until /api/config answers (and in the server HTML, where it never has),
// the login page draws its card's skeleton instead of a spinner, the same
// one signed-out visitors of the app pages see first.

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

const config = vi.hoisted(() => ({ loading: true, oauthOnly: false }));

vi.mock('@/hooks/use-config', () => ({
  useConfig: () => ({
    appName: 'Webmail',
    isLoading: config.loading,
    error: null,
    jmapServerUrl: 'https://mail.example.org',
    jmapServers: [],
    loginShowHeading: true,
    loginShowSubtitle: true,
    loginShowVersion: true,
    loginShowTotp: true,
    oauthEnabled: config.oauthOnly,
    oauthOnly: config.oauthOnly,
  }),
}));

// The provider's metadata never arrives in these tests.
vi.mock('@/lib/browser-navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/browser-navigation')>()),
  apiFetch: vi.fn(() => new Promise(() => {})),
}));

const { default: LoginPage } = await import('../page');

describe('login page while the config loads', () => {
  it('server-renders the card skeleton, not a spinner', () => {
    config.loading = true;
    const html = renderToString(<LoginPage />);
    expect(html).toContain('data-boot-skeleton="login"');
    expect(html).not.toContain('animate-spin');
  });

  it('keeps the skeleton on the client until the config is there', () => {
    config.loading = true;
    const { container } = render(<LoginPage />);
    const region = container.querySelector('[data-boot-skeleton="login"]');
    expect(region).not.toBeNull();
    expect(region!.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('loading');
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('hydrates the server\'s skeleton when the config arrived first, and then draws the form', async () => {
    // The page's Suspense boundary hydrates after the app around it, which fetches the config.
    config.loading = true;
    const html = renderToString(<LoginPage />);
    config.loading = false;
    const box = document.createElement('div');
    box.innerHTML = html;
    document.body.appendChild(box);
    const fromServer = box.querySelector('[data-boot-skeleton="login"]');
    expect(fromServer).not.toBeNull();
    const recoverable: unknown[] = [];
    const root = hydrateRoot(box, <LoginPage />, { onRecoverableError: (error) => { recoverable.push(error); } });
    try {
      await act(async () => {});
      expect(recoverable).toEqual([]);
      expect(box.querySelector('[data-boot-skeleton="login"]')).toBeNull();
      expect(box.querySelector('#username')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      box.remove();
    }
  });

  it('draws the sign-in button\'s place while the provider is looked up, not a spinner', () => {
    config.loading = false;
    config.oauthOnly = true;
    try {
      const { container } = render(<LoginPage />);
      expect(container.querySelector('[data-boot-skeleton]')).toBeNull();
      expect(container.querySelector('.animate-spin')).toBeNull();
      expect(container.querySelector('.sk-shape.h-11')).not.toBeNull();
    } finally {
      config.oauthOnly = false;
    }
  });
});
