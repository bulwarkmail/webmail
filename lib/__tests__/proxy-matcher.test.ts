/**
 * @vitest-environment node
 *
 * Next copies the body of every request proxy.ts runs for, up to
 * proxyClientMaxBodySize, before the route sees it. That limit stays at the
 * 10 MB default; the upload routes that need more are left out of the
 * proxy's matcher. The matcher is read from proxy.ts the way `next build`
 * reads it (static extraction), and a path counts as proxied the way Next's
 * router decides it: when the raw or the decoded path matches.
 */
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { NextConfig } from 'next';
import { loadBindings } from 'next/dist/build/swc';
import { getPagesPageStaticInfo } from 'next/dist/build/analysis/get-page-static-info';
import { getMiddlewareRouteMatcher } from 'next/dist/shared/lib/router/utils/middleware-route-matcher';
import type { PAGE_TYPES } from 'next/dist/lib/page-types';

async function proxied(basePath = '') {
  await loadBindings();
  const info = await getPagesPageStaticInfo({
    pageFilePath: path.resolve(__dirname, '../../proxy.ts'),
    nextConfig: { basePath },
    isDev: false,
    page: '/proxy',
    pageType: 'pages' as PAGE_TYPES,
  });
  const matchers = info.middleware?.matchers;
  expect(matchers?.length).toBeGreaterThan(0);
  const match = getMiddlewareRouteMatcher(matchers!);
  const req = { headers: {} } as Parameters<typeof match>[1];
  return (p: string) => {
    let decoded = p;
    try { decoded = decodeURIComponent(p); } catch { /* as Next: keep it */ }
    return match(p, req, {}) || match(decoded, req, {});
  };
}

describe('proxy matcher', () => {
  it('leaves out exactly the upload routes', async () => {
    const runs = await proxied();
    for (const p of ['/api/webdav', '/api/plugin-proxy', '/api/wopi/files/f123/contents', '/api/wopi/files/a%20b/contents']) {
      expect(runs(p), p).toBe(false);
    }
  });

  it('runs for every other path, including near misses and other spellings', async () => {
    const runs = await proxied();
    for (const p of [
      '/', '/en/mail', '/admin', '/setup', '/api/settings', '/api/auth/session', '/api/account/stalwart/jmap',
      '/api/webdav/', '/api/webdav/x', '/api/webdavx', '/api/plugin-proxy/x', '/api/plugin-proxy2',
      '/api/wopi/files/f123', '/api/wopi/files/f123/contents/x', '/api/wopi/launch', '/api/wopi/files//contents',
      '/api/%77ebdav', '/api/wopi/files/a%2Fb/contents', '/x/api/webdav', '/_next/static/chunk.js',
    ]) expect(runs(p), p).toBe(true);
  });

  it('applies under a base path', async () => {
    const runs = await proxied('/webmail');
    expect(runs('/webmail/api/webdav')).toBe(false);
    expect(runs('/webmail/api/settings')).toBe(true);
  });

  it('runs for the bare base path, so it can redirect to a locale (#1455)', async () => {
    const runs = await proxied('/webmail');
    expect(runs('/webmail')).toBe(true);
    expect(runs('/webmail/')).toBe(true);
    expect(runs('/webmail/en/login')).toBe(true);
  });

  it('keeps the body limit at the default and gives the left-out routes the proxy\'s API headers', async () => {
    vi.resetModules();
    const { default: nextConfig } = (await import('../../next.config')) as { default: NextConfig };
    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBeUndefined();
    const rules = (await nextConfig.headers?.()) ?? [];
    for (const source of ['/api/webdav', '/api/plugin-proxy', '/api/wopi/files/:fileId/contents']) {
      const headers = rules.find((rule) => rule.source === source)?.headers ?? [];
      expect(headers, source).toEqual(expect.arrayContaining([
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
      ]));
    }
  });
});
