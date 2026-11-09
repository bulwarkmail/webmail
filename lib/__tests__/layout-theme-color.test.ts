import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Children, isValidElement, type ReactNode } from 'react';

const edition = vi.hoisted(() => ({ lite: false }));
vi.mock('@/lib/lite', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/lite')>(),
  get IS_LITE() { return edition.lite; },
}));

// The root layout pulls in globals.css, next/font and client components purely
// for rendering; stub them so the test can import generateViewport in isolation.
// globals.css would otherwise drag Tailwind's PostCSS pipeline into vitest.
vi.mock('@/app/globals.css', () => ({}));
vi.mock('next/font/google', () => ({
  Geist: () => ({ variable: '--font-geist-sans' }),
  Geist_Mono: () => ({ variable: '--font-geist-mono' }),
  Hanken_Grotesk: () => ({ variable: '--font-hanken' }),
}));
vi.mock('@/components/service-worker-registration', () => ({ ServiceWorkerRegistration: () => null }));
vi.mock('@/components/favicon-badge', () => ({ FaviconBadge: () => null }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async () => (k: string) => k,
}));
vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}), get: vi.fn(),
    getAllWithSources: () => ({ pwaThemeColor: { source: 'default' } }),
  },
}));

import RootLayout, { generateMetadata, generateViewport } from '@/app/(main)/layout';
import { headers } from 'next/headers';
import { configManager } from '@/lib/admin/config-manager';

const mockHeaders = headers as unknown as Mock;
const mockGet = configManager.get as unknown as Mock;

/** Config values keyed by admin key; anything unset falls back to the caller's default. */
function withConfig(values: Record<string, unknown>) {
  mockGet.mockImplementation((key: string, fallback: unknown) =>
    key in values ? values[key] : fallback,
  );
}
function onHost(host: string) {
  mockHeaders.mockResolvedValue(new Headers({ host }));
}

beforeEach(() => {
  vi.clearAllMocks();
  edition.lite = false;
  onHost('mail.example.com');
  withConfig({});
});

describe('root layout generateViewport - theme color (#671)', () => {
  it('emits the admin-configured theme color, not a hardcoded white', async () => {
    withConfig({ pwaThemeColor: '#1a1b26' });
    expect((await generateViewport()).themeColor).toBe('#1a1b26');
  });

  it('prefers a per-domain branding override for the requesting host', async () => {
    withConfig({
      pwaThemeColor: '#1a1b26',
      domainBranding: [{ host: 'other.example.com', pwaThemeColor: '#7c3aed' }],
    });
    onHost('other.example.com');
    expect((await generateViewport()).themeColor).toBe('#7c3aed');

    onHost('mail.example.com');
    expect((await generateViewport()).themeColor).toBe('#1a1b26');
  });

  it('falls back to white when nothing is configured', async () => {
    withConfig({ pwaThemeColor: '' });
    expect((await generateViewport()).themeColor).toBe('#ffffff');
  });

  it('keeps the viewport sizing fields intact', async () => {
    const viewport = await generateViewport();
    expect(viewport.width).toBe('device-width');
    expect(viewport.initialScale).toBe(1);
    expect(viewport.viewportFit).toBe('cover');
  });

  it('lets iOS choose the status bar while retaining install metadata in both editions', async () => {
    withConfig({ appName: 'Test Mail' });
    for (const lite of [false, true]) {
      edition.lite = lite;
      const appName = lite ? process.env.NEXT_PUBLIC_APP_NAME || 'Webmail' : 'Test Mail';
      const layout = await RootLayout({ children: null });
      const head = Children.toArray(layout.props.children).find(
        (child) => isValidElement(child) && child.type === 'head',
      );
      expect(isValidElement(head)).toBe(true);
      const metas = Children.toArray((head as { props: { children: ReactNode } }).props.children)
        .filter((child) => isValidElement<{ name?: string; content?: string }>(child) && child.type === 'meta')
        .map((child) => (child as { props: { name?: string; content?: string } }).props);

      expect(metas.find((meta) => meta.name === 'apple-mobile-web-app-status-bar-style')).toBeUndefined();
      expect(metas.find((meta) => meta.name === 'mobile-web-app-capable')?.content).toBe('yes');
      expect(metas.find((meta) => meta.name === 'apple-mobile-web-app-capable')?.content).toBe('yes');
      expect(metas.find((meta) => meta.name === 'apple-mobile-web-app-title')?.content).toBe(appName);
      // An appleWebApp object makes Next emit status-bar-style=default even
      // when statusBarStyle itself is omitted.
      const metadata = await generateMetadata();
      expect(metadata.appleWebApp).toBeFalsy();
      expect(metadata.title).toBe(appName);
    }
  });
});
