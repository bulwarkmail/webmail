/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn((_key: string, fallback: unknown) => fallback),
    getPolicy: vi.fn(() => ({ features: { pluginsEnabled: false } })),
  },
}));
vi.mock('@/lib/setup/state', () => ({ detectSetupState: vi.fn(() => 'configured') }));
vi.mock('@/lib/admin/csp-frame-origins', () => ({ getEnabledPluginFrameOrigins: vi.fn(async () => []) }));
vi.mock('next-intl/middleware', async () => {
  const { NextResponse } = await import('next/server');
  return { default: () => () => NextResponse.next() };
});

import { proxy } from '@/proxy';
import { GET as ready } from '@/app/api/ready/route';
import { configManager } from '@/lib/admin/config-manager';
import { setBootState, setStoreForTests } from '../index';
import { fakeSharedStore } from './fake-shared';

afterEach(() => {
  setStoreForTests(null);
  vi.clearAllMocks();
});

function request(path: string): NextRequest {
  return new NextRequest('http://localhost:3000' + path, {
    headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' },
  });
}

describe('/api/ready', () => {
  it('is ready with local files, as a single instance always was', async () => {
    const res = await ready();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ready: true, store: 'local' });
  });

  it('is not ready while a shared-store replica is starting', async () => {
    setStoreForTests(fakeSharedStore());
    const res = await ready();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ready: false, state: 'starting' });
  });

  it('follows the store once booted', async () => {
    const store = fakeSharedStore();
    setStoreForTests(store);
    setBootState('ready');
    expect((await ready()).status).toBe(200);
    store.down = true;
    await new Promise((r) => setTimeout(r, 1100)); // past the 1 s ping cache
    const down = await ready();
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ state: 'store-down' });
  });
});

describe('proxy boot gate', () => {
  it('serves nothing but the probes while a shared-store replica is starting', async () => {
    setStoreForTests(fakeSharedStore());
    const page = await proxy(request('/en/mail'));
    expect(page.status).toBe(503);
    expect(page.headers.get('retry-after')).toBe('5');
    const api = await proxy(request('/api/settings'));
    expect(api.status).toBe(503);
    expect(await api.json()).toMatchObject({ error: 'not_ready', state: 'starting' });
    // The probes pass through to their routes, without touching config.
    for (const probe of ['/api/health', '/api/ready']) {
      const res = await proxy(request(probe));
      expect(res.status).toBe(200);
      expect(res.headers.get('x-middleware-next')).toBe('1');
    }
    expect(configManager.ensureLoaded).not.toHaveBeenCalled();
  });

  it('lets everything through once booted, and always in local mode', async () => {
    const page = await proxy(request('/en/mail'));
    expect(page.status).not.toBe(503);
    setStoreForTests(fakeSharedStore());
    setBootState('ready');
    expect((await proxy(request('/en/mail'))).status).not.toBe(503);
    setBootState('store-lost');
    expect((await proxy(request('/en/mail'))).status).toBe(503);
  });
});
