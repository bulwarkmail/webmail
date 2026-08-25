import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// Same isolation shims as layout-theme-color.test.ts: the root layout imports
// globals.css, next/font and client components purely for rendering.
vi.mock('@/app/globals.css', () => ({}));
vi.mock('next/font/google', () => ({
  Geist: () => ({ variable: '--font-geist-sans' }),
  Geist_Mono: () => ({ variable: '--font-geist-mono' }),
}));
vi.mock('@/components/service-worker-registration', () => ({ ServiceWorkerRegistration: () => null }));
vi.mock('@/components/favicon-badge', () => ({ FaviconBadge: () => null }));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  // The real translator returns the localized string; echoing the key is enough
  // to assert that the localized default is what got used.
  getTranslations: async () => (k: string) => `t:${k}`,
}));
vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: vi.fn(async () => {}), get: vi.fn() },
}));

import { generateMetadata } from '@/app/(main)/layout';
import { headers } from 'next/headers';
import { configManager } from '@/lib/admin/config-manager';

const mockHeaders = headers as unknown as Mock;
const mockGet = configManager.get as unknown as Mock;

function withConfig(values: Record<string, unknown>) {
  mockGet.mockImplementation((key: string, fallback: unknown) =>
    key in values ? values[key] : fallback,
  );
}
function withHeaders(init: Record<string, string>) {
  mockHeaders.mockResolvedValue(new Headers(init));
}

beforeEach(() => {
  vi.clearAllMocks();
  withHeaders({ host: 'mail.example.com' });
  withConfig({});
});

describe('root layout generateMetadata - link preview', () => {
  it('points OpenGraph and Twitter at the branded 1200x630 card', async () => {
    const meta = await generateMetadata();
    const image = (meta.openGraph?.images as Array<Record<string, unknown>>)[0]!;

    expect(image.url).toBe('/api/og-image');
    expect(image.width).toBe(1200);
    expect(image.height).toBe(630);
    // Metadata['twitter'] is a union of card shapes; narrow to the fields asserted.
    const twitter = meta.twitter as { card?: string; images?: string[] };
    expect(twitter.card).toBe('summary_large_image');
    expect(twitter.images).toEqual(['/api/og-image']);
  });

  it('uses the configured app name and description for title, OG and Twitter', async () => {
    withConfig({ appName: 'Acme Mail', appDescription: 'Mail for Acme staff' });
    const meta = await generateMetadata();

    expect(meta.title).toBe('Acme Mail');
    expect(meta.description).toBe('Mail for Acme staff');
    expect(meta.openGraph?.siteName).toBe('Acme Mail');
    expect(meta.openGraph?.title).toBe('Acme Mail');
    expect(meta.openGraph?.description).toBe('Mail for Acme staff');
    expect(meta.twitter?.title).toBe('Acme Mail');
    expect(meta.twitter?.description).toBe('Mail for Acme staff');
  });

  it('falls back to the localized description when no admin description is set', async () => {
    withConfig({ appDescription: '' });
    const meta = await generateMetadata();
    expect(meta.description).toBe('t:meta_description');
    expect(meta.openGraph?.description).toBe('t:meta_description');
  });

  it('prefers the per-domain branding of the requesting host', async () => {
    withConfig({
      appName: 'Acme Mail',
      appDescription: 'Mail for Acme staff',
      domainBranding: [
        { host: 'partner.example.com', appName: 'Partner Mail', appDescription: 'Partner inbox' },
      ],
    });

    withHeaders({ host: 'partner.example.com' });
    const partner = await generateMetadata();
    expect(partner.openGraph?.siteName).toBe('Partner Mail');
    expect(partner.openGraph?.description).toBe('Partner inbox');

    withHeaders({ host: 'mail.example.com' });
    const main = await generateMetadata();
    expect(main.openGraph?.siteName).toBe('Acme Mail');
  });

  it('derives metadataBase from the request so crawlers get absolute URLs', async () => {
    withHeaders({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'mail.example.com' });
    expect((await generateMetadata()).metadataBase?.toString()).toBe('https://mail.example.com/');
  });

  it('keeps a non-default forwarded port, drops the default one', async () => {
    withHeaders({ 'x-forwarded-proto': 'http', 'x-forwarded-host': 'localhost', 'x-forwarded-port': '3000' });
    expect((await generateMetadata()).metadataBase?.toString()).toBe('http://localhost:3000/');

    withHeaders({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'mail.example.com', 'x-forwarded-port': '443' });
    expect((await generateMetadata()).metadataBase?.toString()).toBe('https://mail.example.com/');
  });

  it('omits metadataBase rather than guessing when no host header is usable', async () => {
    withHeaders({});
    expect((await generateMetadata()).metadataBase).toBeUndefined();
  });

  it('still emits previews under the default noindex, since unfurling is not indexing', async () => {
    const meta = await generateMetadata();
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(meta.openGraph?.images).toBeDefined();
  });
});
