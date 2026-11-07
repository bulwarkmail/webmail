/**
 * The root layout's inline script keeps the kept-accounts marker the server
 * reads (lib/signed-out-start.ts). Lite has no server to read it and no proxy
 * to redirect, so its pages leave the script out and start as before.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { ReactElement, ReactNode } from 'react';

const edition = vi.hoisted(() => ({ lite: false }));
vi.mock('@/lib/lite', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/lite')>(),
  get IS_LITE() { return edition.lite; },
}));
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
    get: vi.fn((_key: string, fallback: unknown) => fallback),
    getAllWithSources: vi.fn(() => ({})),
  },
}));

import RootLayout from '@/app/(main)/layout';
import { headers } from 'next/headers';
import { LOCAL_COOKIE, START_COOKIE } from '@/lib/signed-out-start';

/** Every inline script's text in the tree. */
function inlineScripts(node: ReactNode, out: string[] = []): string[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) inlineScripts(child, out);
    return out;
  }
  const el = node as ReactElement<{ dangerouslySetInnerHTML?: { __html: string }; children?: ReactNode }>;
  if (el.type === 'script' && el.props.dangerouslySetInnerHTML) out.push(el.props.dangerouslySetInnerHTML.__html);
  inlineScripts(el.props?.children, out);
  return out;
}

beforeEach(() => {
  edition.lite = false;
  (headers as unknown as Mock).mockResolvedValue(new Headers({ host: 'mail.example.com' }));
});

describe('root layout and the signed-out start', () => {
  it('keeps the kept-accounts marker on every page of the server build', async () => {
    const scripts = inlineScripts(await RootLayout({ children: null })).join('\n');
    expect(scripts).toContain(LOCAL_COOKIE);
    expect(scripts).toContain(START_COOKIE);
  });

  it('leaves it out of Lite, which has no proxy and starts the mail view as before', async () => {
    edition.lite = true;
    const scripts = inlineScripts(await RootLayout({ children: null })).join('\n');
    expect(scripts).not.toContain(LOCAL_COOKIE);
    expect(scripts).not.toContain(START_COOKIE);
  });
});
