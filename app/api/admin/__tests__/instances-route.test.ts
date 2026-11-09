// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const auth = vi.hoisted(() => ({ ok: true }));
vi.mock('@/lib/admin/session', async () => {
  const { NextResponse } = await import('next/server');
  return {
    requireAdminAuth: async () => (auth.ok
      ? { payload: { role: 'admin' } }
      : { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }),
  };
});

import { GET } from '@/app/api/admin/instances/route';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { fakeSharedStore } from '@/lib/shared-store/__tests__/fake-shared';

const get = () => GET(new NextRequest('https://mail.example/api/admin/instances'));

afterEach(() => {
  auth.ok = true;
  setStoreForTests(null);
  resetLocalStoreForTests();
});

describe('GET /api/admin/instances', () => {
  it('says local files and one instance without a shared store', async () => {
    const body = await (await get()).json();
    expect(body).toMatchObject({ mode: 'local', location: 'local files', instances: 1 });
  });

  it('counts the instances that checked in during the last minute', async () => {
    const store = fakeSharedStore();
    setStoreForTests(store);
    await store.replicas.beat({ id: 'web-2', version: '1.20.0', startedAt: 1 });
    await store.replicas.beat({ id: 'web-1', version: '1.20.0', startedAt: 1 });
    await store.replicas.beat({ id: 'web-3', version: '1.20.0', startedAt: 1 });
    const body = await (await get()).json();
    expect(body.mode).toBe('redis');
    expect(body.location).toBe('redis://fake:6379/0');
    expect(body.instances).toBe(3);
    expect(body.replicas.map((r: { id: string }) => r.id)).toEqual(['web-1', 'web-2', 'web-3']);
  });

  it('leaves out instances that stopped checking in', async () => {
    const store = fakeSharedStore();
    setStoreForTests(store);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
      await store.replicas.beat({ id: 'gone', version: '1', startedAt: 1 });
      vi.setSystemTime(new Date('2026-11-01T10:02:00Z'));
      await store.replicas.beat({ id: 'alive', version: '1', startedAt: 1 });
      const body = await (await get()).json();
      expect(body.instances).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is for admins only', async () => {
    auth.ok = false;
    expect((await get()).status).toBe(401);
  });
});
