/**
 * @vitest-environment node
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { NextRequest } from 'next/server';

// In the server the instrumentation creates the config manager, so a write
// it refuses for ADMIN_CONFIG_READONLY throws the instrumentation's copy of
// ConfigReadOnlyError, not the route's. The route has to answer 409 anyway
// (#1249), not 500.

const dir = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const config = mkdtempSync(join(tmpdir(), 'bw-readonly-copies-'));
  process.env.ADMIN_CONFIG_DIR = config;
  process.env.ADMIN_STATE_DIR = join(config, 'state');
  process.env.ADMIN_CONFIG_READONLY = 'true';
  return config;
});

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: async () => ({ payload: { role: 'admin' } }),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: async () => {} }));

afterAll(() => {
  delete process.env.ADMIN_CONFIG_READONLY;
  rmSync(dir, { recursive: true, force: true });
});

describe('read-only config across module copies', () => {
  it('answers 409 when the config manager came from another bundle', async () => {
    const KEY = Symbol.for('bulwark.admin.configManager');
    const g = globalThis as Record<symbol, unknown>;
    delete g[KEY];
    // The instrumentation's copy makes the config manager.
    await (await import('@/lib/admin/config-manager')).configManager.load();
    // The route's own copy.
    vi.resetModules();
    const { PATCH } = await import('@/app/api/admin/config/route');
    const res = await PATCH(new NextRequest('http://localhost/api/admin/config', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appName: 'Nope' }),
    }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/read-only/);
  });
});
