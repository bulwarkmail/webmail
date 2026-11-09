import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

// Same stubs as layout-theme-color.test.ts: the root layout drags in CSS,
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

/** Content of <meta name="parent-origin"> in the rendered tree, or null. */
function findParentOriginMeta(node: ReactNode): string | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findParentOriginMeta(child);
      if (found !== null) return found;
    }
    return null;
  }
  const el = node as ReactElement<{ name?: string; content?: string; children?: ReactNode }>;
  if (el.type === 'meta' && el.props.name === 'parent-origin') return el.props.content ?? '';
  return findParentOriginMeta(el.props?.children);
}

beforeEach(() => {
  vi.clearAllMocks();
  (headers as unknown as Mock).mockResolvedValue(new Headers({ host: 'mail.example.com' }));
  withConfig({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('root layout parent-origin meta tag', () => {
  it('uses the origin saved in the admin console', async () => {
    withConfig({ parentOrigin: 'https://portal.example.com' });
    const tree = await RootLayout({ children: null });
    expect(findParentOriginMeta(tree)).toBe('https://portal.example.com');
    expect(mockGet).toHaveBeenCalledWith('parentOrigin', '');
  });

  it('prefers the admin value over NEXT_PUBLIC_PARENT_ORIGIN', async () => {
    vi.stubEnv('NEXT_PUBLIC_PARENT_ORIGIN', 'https://env.example.com');
    withConfig({ parentOrigin: 'https://admin.example.com' });
    const tree = await RootLayout({ children: null });
    expect(findParentOriginMeta(tree)).toBe('https://admin.example.com');
  });

  it('omits the tag when no parent origin is configured', async () => {
    const tree = await RootLayout({ children: null });
    expect(findParentOriginMeta(tree)).toBeNull();
  });
});
