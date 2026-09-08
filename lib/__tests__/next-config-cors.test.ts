import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextConfig } from 'next';

async function loadConfig(basePath?: string): Promise<NextConfig> {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_BASE_PATH', basePath);

  const { default: config } = await import('../../next.config');
  return config;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('Next static asset CORS', () => {
  it.each([undefined, '/webmail'])('allows opaque plugin sandboxes with basePath %s', async (basePath) => {
    const config = await loadConfig(basePath);
    const rules = await config.headers?.();

    expect(config.basePath).toBe(basePath);
    expect(rules?.filter((rule) => rule.source.includes('_next/static'))).toEqual([
      {
        source: '/_next/static/:path*',
        headers: [{ key: 'Access-Control-Allow-Origin', value: '*' }],
      },
    ]);
  });

  it('does not add CORS headers to application or API routes', async () => {
    const config = await loadConfig('/webmail');
    const rules = await config.headers?.();
    const corsRules = rules?.filter((rule) =>
      rule.headers.some((header) => header.key.toLowerCase() === 'access-control-allow-origin')
    );

    expect(corsRules?.map((rule) => rule.source)).toEqual(['/_next/static/:path*']);
  });
});
