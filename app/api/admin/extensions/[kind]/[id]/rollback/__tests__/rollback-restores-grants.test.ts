/**
 * @vitest-environment node
 *
 * A rollback puts the kept registry entry back: its permissions, hosts, POST
 * paths, frame origins and tier. A kept version that may do more than the
 * installed one is asked about first, the same question an update asks
 * (`grantsAdded`, 409), and goes back once that was accepted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: vi.fn(async () => ({ session: { sub: 'admin' } })),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn(async () => {}) }));
vi.mock('@/lib/admin/csp-frame-origins', () => ({ invalidateFrameOriginsCache: vi.fn() }));
vi.mock('@/lib/desktop/server-policy', () => ({ devicePolicyPluginRefusal: () => null }));

const registry = new Map<string, Record<string, unknown>>();
vi.mock('@/lib/admin/plugin-registry', () => ({
  savePlugin: vi.fn(async (p: Record<string, unknown>) => { registry.set(p.id as string, p); }),
  saveTheme: vi.fn(async () => {}),
  getPlugin: vi.fn(async (id: string) => registry.get(id) ?? null),
  getTheme: vi.fn(async () => null),
}));

const KEPT = {
  id: 'pretty-dates', name: 'Pretty Dates', version: '1.0.0', author: 'x', description: 'd', type: 'hook', entrypoint: 'index.js',
  permissions: ['email:read', 'email:send', 'http:fetch'],
  httpOrigins: ['https://old-collector.example'],
  enabled: true, installedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
};
vi.mock('@/lib/admin/extension-history', () => ({
  HistoryError: class HistoryError extends Error { status = 404; },
  readHistoryEntry: vi.fn(async () => ({ kind: 'plugin', entry: { ...KEPT }, code: 'module.exports = {};' })),
}));

import { POST } from '../route';

function rollback(body: Record<string, unknown>) {
  return POST(
    new NextRequest('http://localhost/api/admin/extensions/plugin/pretty-dates/rollback', {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ kind: 'plugin', id: 'pretty-dates' }) },
  );
}

beforeEach(() => {
  registry.clear();
  // Installed now: 1.1.0, which reads mail and nothing else.
  registry.set('pretty-dates', { ...KEPT, version: '1.1.0', permissions: ['email:read'], httpOrigins: undefined });
});

describe('rollback to a version that may do more than the installed one', () => {
  it('is refused until someone has seen what comes back', async () => {
    const res = await rollback({ version: '1.0.0' });
    expect(res.status).toBe(409);
    expect(registry.get('pretty-dates')!.version).toBe('1.1.0');
    expect(registry.get('pretty-dates')!.permissions).toEqual(['email:read']);
  });

  it('goes through once that was accepted', async () => {
    // The host comes back with the permissions, so it is accepted too.
    const res = await rollback({
      version: '1.0.0', acceptPermissions: ['email:send', 'http:fetch'], acceptGrants: { httpOrigins: ['https://old-collector.example'] },
    });
    expect(res.status).toBe(200);
    expect(registry.get('pretty-dates')!.version).toBe('1.0.0');
  });

  it('names what comes back, and stays refused while part of it is not accepted', async () => {
    const refused = await rollback({ version: '1.0.0' });
    const body = await refused.json();
    expect(body.compared).toBe('rollback');
    expect(body.grantsAdded).toMatchObject({ permissions: ['email:send', 'http:fetch'], httpOrigins: ['https://old-collector.example'] });
    expect(body.error).toMatch(/May now contact https:\/\/old-collector\.example/);

    expect((await rollback({ version: '1.0.0', acceptPermissions: ['email:send', 'http:fetch'] })).status).toBe(409);
    expect(registry.get('pretty-dates')!.version).toBe('1.1.0');
  });

  it('records what was accepted', async () => {
    const { auditLog } = await import('@/lib/admin/audit');
    vi.mocked(auditLog).mockClear();
    await rollback({ version: '1.0.0', acceptGrants: { permissions: ['email:send', 'http:fetch'], httpOrigins: ['https://old-collector.example'] } });
    expect(vi.mocked(auditLog).mock.calls[0]).toEqual(['plugin.rollback', {
      id: 'pretty-dates', from: '1.1.0', to: '1.0.0',
      accepted: { permissions: ['email:send', 'http:fetch'], httpOrigins: ['https://old-collector.example'] },
    }, '127.0.0.1']);
  });

  it('asks nothing when the kept version may do less', async () => {
    registry.set('pretty-dates', { ...KEPT, version: '1.1.0', permissions: [...KEPT.permissions, 'calendar:read'], tier: undefined });
    expect((await rollback({ version: '1.0.0' })).status).toBe(200);
  });
});
