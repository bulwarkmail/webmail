import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// The login page's layout and background come from the root layout, so the
// page and its skeleton draw them on the first paint. Same stubs as
// layout-brand-palette.test.ts.
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

function onHost(host: string, extra: Record<string, string> = {}) {
  (headers as unknown as Mock).mockResolvedValue(new Headers({ host, ...extra }));
}

type Props = { id?: string; nonce?: string; dangerouslySetInnerHTML?: { __html: string }; children?: ReactNode } & Record<string, unknown>;

function findStyle(node: ReactNode): ReactElement<Props> | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findStyle(child);
      if (found) return found;
    }
    return null;
  }
  const el = node as ReactElement<Props>;
  if (el.type === 'style' && el.props.id === 'login-backdrop') return el;
  return findStyle(el.props?.children);
}

async function render() {
  const html = (await RootLayout({ children: null })) as ReactElement<Props>;
  const style = findStyle(html);
  return {
    html: html.props,
    css: style ? style.props.dangerouslySetInnerHTML?.__html ?? '' : null,
    nonce: style?.props.nonce,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  onHost('mail.example.com');
  withConfig({});
});

describe('root layout login backdrop', () => {
  it('adds nothing when the admin set nothing', async () => {
    const { html, css } = await render();
    expect(css).toBeNull();
    expect(html['data-login-layout']).toBeUndefined();
    expect(html['data-login-bg']).toBeUndefined();
  });

  it('writes the default picture, dim and blur, and marks the split layout', async () => {
    withConfig({
      loginLayout: 'split',
      loginBackgroundLightUrl: '/api/admin/branding/loginBackgroundLightUrl.jpg?v=3',
      loginBackgroundDim: '30',
      loginBackgroundBlur: '4',
    });
    onHost('mail.example.com', { 'x-nonce': 'n0nce' });
    const { html, css, nonce } = await render();
    expect(css).toBe(':root{--login-bg-image:url("/api/admin/branding/loginBackgroundLightUrl.jpg?v=3");--login-bg-dim:0.3;--login-bg-blur:4px}');
    expect(nonce).toBe('n0nce');
    expect(html['data-login-layout']).toBe('split');
    expect(html['data-login-bg']).toBe('image');
  });

  it("lets a domain's branding override the default, key by key", async () => {
    withConfig({
      loginBackgroundLightUrl: '/default.jpg',
      loginBackgroundDim: '30',
      domainBranding: [
        { host: 'brand.example.com', loginBackgroundLightUrl: '/brand.jpg', loginLayout: 'split' },
      ],
    });
    onHost('brand.example.com');
    let result = await render();
    expect(result.css).toBe(':root{--login-bg-image:url("/brand.jpg");--login-bg-dim:0.3;--login-bg-blur:0px}');
    expect(result.html['data-login-layout']).toBe('split');

    onHost('mail.example.com');
    result = await render();
    expect(result.css).toBe(':root{--login-bg-image:url("/default.jpg");--login-bg-dim:0.3;--login-bg-blur:0px}');
    expect(result.html['data-login-layout']).toBeUndefined();
  });

  it('drops a picture URL that is not a path or http(s)', async () => {
    withConfig({ loginBackgroundLightUrl: 'javascript:alert(1)' });
    const { html, css } = await render();
    expect(css).toBeNull();
    expect(html['data-login-bg']).toBeUndefined();
  });
});
