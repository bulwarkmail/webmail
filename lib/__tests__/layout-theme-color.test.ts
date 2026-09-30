import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

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
  configManager: { ensureLoaded: vi.fn(async () => {}), get: vi.fn() },
}));

import { generateViewport } from '@/app/(main)/layout';
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
});
