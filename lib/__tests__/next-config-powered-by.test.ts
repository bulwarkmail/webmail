import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextConfig } from 'next';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';

async function loadConfig(): Promise<NextConfig> {
  vi.resetModules();
  const { default: config } = await import('../../next.config');
  return config;
}

afterEach(() => {
  vi.resetModules();
});

describe('X-Powered-By header', () => {
  it('names Bulwark instead of Next.js, without a version', async () => {
    const config = await loadConfig();
    const rules = (await config.headers?.()) ?? [];
    const poweredBy = rules.flatMap((rule) =>
      rule.headers
        .filter((header) => header.key.toLowerCase() === 'x-powered-by')
        .map((header) => ({ source: rule.source, value: header.value }))
    );

    expect(config.poweredByHeader).toBe(false);
    expect(poweredBy).toEqual([{ source: '/:path*', value: 'bulwarkmail.org' }]);
  });

  it('matches the root, pages, API routes and static files', () => {
    const match = getPathMatch('/:path*');
    for (const path of ['/', '/en/mail', '/api/config', '/_next/static/chunks/main.js']) {
      expect(match(path), path).not.toBe(false);
    }
  });
});
