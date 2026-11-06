import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// Same stubs as layout-parent-origin.test.ts: the root layout drags in CSS,
// fonts and client components that the test never renders.
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
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn(),
    getAllWithSources: vi.fn(() => ({})),
  },
}));

import RootLayout from '@/app/(main)/layout';
import { headers } from 'next/headers';
import { configManager } from '@/lib/admin/config-manager';

const mockGet = configManager.get as unknown as Mock;

function withConfig(values: Record<string, unknown>) {
  mockGet.mockImplementation((key: string, fallback: unknown) =>
    key in values ? values[key] : fallback,
  );
}

function onHost(host: string) {
  (headers as unknown as Mock).mockResolvedValue(new Headers({ host }));
}

type StyleProps = { id?: string; nonce?: string; dangerouslySetInnerHTML?: { __html: string }; children?: ReactNode };

/** The <style id="brand-palette"> element in the rendered tree, or null. */
function findPaletteStyle(node: ReactNode): ReactElement<StyleProps> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findPaletteStyle(child);
      if (found) return found;
    }
    return null;
  }
  const el = node as ReactElement<StyleProps>;
  if (el.type === 'style' && el.props.id === 'brand-palette') return el;
  return findPaletteStyle(el.props?.children);
}

async function paletteCss(): Promise<string | null> {
  const style = findPaletteStyle(await RootLayout({ children: null }));
  return style ? style.props.dangerouslySetInnerHTML?.__html ?? '' : null;
}

const branding = [
  { host: 'one.example.com', palette: { light: { primary: '#0b3d91' }, dark: { primary: '#7cc4ff' } } },
  { host: 'two.example.com', palette: { light: { primary: '#7c2d12', accent: 'url(x)' } } },
  { host: 'plain.example.com', loginCompanyName: 'Plain' },
];

beforeEach(() => {
  vi.clearAllMocks();
  onHost('mail.example.com');
  withConfig({});
});

describe('root layout brand palette', () => {
  it("renders the requesting host's palette in <head>", async () => {
    withConfig({ domainBranding: branding });
    onHost('one.example.com');
    expect(await paletteCss()).toBe(':root{--brand-primary:#0b3d91;--brand-dark-primary:#7cc4ff}');
    onHost('two.example.com');
    expect(await paletteCss()).toBe(':root{--brand-primary:#7c2d12}');
  });

  it('reads the host from X-Forwarded-Host like the rest of the branding', async () => {
    withConfig({ domainBranding: JSON.stringify(branding) });
    (headers as unknown as Mock).mockResolvedValue(
      new Headers({ host: 'internal:3000', 'x-forwarded-host': 'two.example.com' }),
    );
    expect(await paletteCss()).toBe(':root{--brand-primary:#7c2d12}');
  });

  it("carries the request's CSP nonce", async () => {
    withConfig({ domainBranding: branding });
    (headers as unknown as Mock).mockResolvedValue(new Headers({ host: 'one.example.com', 'x-nonce': 'abc123' }));
    expect(findPaletteStyle(await RootLayout({ children: null }))?.props.nonce).toBe('abc123');
  });

  it('renders no style element for a host without a palette', async () => {
    withConfig({ domainBranding: branding });
    onHost('plain.example.com');
    expect(await paletteCss()).toBeNull();
    onHost('other.example.com');
    expect(await paletteCss()).toBeNull();
  });

  it('renders no style element without DOMAIN_BRANDING', async () => {
    expect(await paletteCss()).toBeNull();
  });

  it('renders no style element when every value was invalid', async () => {
    withConfig({
      domainBranding: [{ host: 'mail.example.com', palette: { light: { primary: '#fff;}</style><script>' } } }],
    });
    expect(await paletteCss()).toBeNull();
  });
});
