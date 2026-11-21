/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: vi.fn(async () => ({ session: { sub: 'admin' } })),
  getClientIP: () => '127.0.0.1',
}));
const audit: Array<[string, Record<string, unknown>]> = [];
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn(async (a: string, d: Record<string, unknown>) => { audit.push([a, d]); }) }));
vi.mock('@/lib/admin/csp-frame-origins', async (orig) => ({
  ...(await orig<typeof import('@/lib/admin/csp-frame-origins')>()),
  invalidateFrameOriginsCache: vi.fn(),
}));

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-rollback-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
  vi.resetModules();
  audit.length = 0;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const PLUGIN = {
  id: 'demo', name: 'Demo', version: '1.0.0', author: 'a', description: '', type: 'hook',
  permissions: ['email:read'], entrypoint: 'index.js', enabled: true, installedAt: '2026-01-01T00:00:00.000Z', updatedAt: 'x',
};

const call = async (kind: string, id: string, body: unknown) => {
  const { POST } = await import('../[kind]/[id]/rollback/route');
  return POST(
    new NextRequest(`http://localhost/api/admin/extensions/${kind}/${id}/rollback`, {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ kind, id }) },
  );
};

describe('POST /api/admin/extensions/[kind]/[id]/rollback', () => {
  it('puts the previous version back and keeps the current enabled and forced flags', async () => {
    const registry = await import('@/lib/admin/plugin-registry');
    await registry.savePlugin(PLUGIN, 'v1()');
    await registry.savePlugin({ ...PLUGIN, version: '1.1.0', permissions: ['email:read', 'email:send'], enabled: false, forceEnabled: false }, 'v2()');

    const res = await call('plugin', 'demo', { version: '1.0.0' });
    expect(res.status).toBe(200);

    const now = (await registry.getPlugin('demo'))!;
    expect(now.version).toBe('1.0.0');
    expect(now.permissions).toEqual(['email:read']);
    expect(now.enabled).toBe(false);
    expect(now.forceEnabled).toBe(false);
    expect(now.installedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(await registry.getPluginBundle('demo')).toBe('v1()');
    expect(audit).toEqual([['plugin.rollback', { id: 'demo', from: '1.1.0', to: '1.0.0' }]]);

    // The version that was replaced is now the one that can be gone back to.
    const { GET } = await import('../[kind]/[id]/history/route');
    const history = await (await GET(new NextRequest('http://localhost/x'), { params: Promise.resolve({ kind: 'plugin', id: 'demo' }) })).json();
    expect(history.current.version).toBe('1.0.0');
    expect(history.history.map((e: { version: string }) => e.version)).toEqual(['1.1.0']);
  });

  it('answers 404 when no copy of that version is kept', async () => {
    const registry = await import('@/lib/admin/plugin-registry');
    await registry.savePlugin(PLUGIN, 'v1()');
    const res = await call('plugin', 'demo', { version: '0.9.0' });
    expect(res.status).toBe(404);
    expect((await registry.getPlugin('demo'))!.version).toBe('1.0.0');
  });

  it('answers 409 when that version is already installed', async () => {
    const registry = await import('@/lib/admin/plugin-registry');
    await registry.savePlugin(PLUGIN, 'v1()');
    expect((await call('plugin', 'demo', { version: '1.0.0' })).status).toBe(409);
  });

  it('refuses an unknown kind and a bad id', async () => {
    expect((await call('widget', 'demo', { version: '1.0.0' })).status).toBe(400);
    expect((await call('plugin', '../demo', { version: '1.0.0' })).status).toBe(400);
  });

  it('rolls a theme back with its skin, once the skin coming back was accepted', async () => {
    const registry = await import('@/lib/admin/plugin-registry');
    const THEME = { id: 'night', name: 'Night', version: '1.0.0', author: 'a', description: '', variants: ['dark'], enabled: true, installedAt: 'x', updatedAt: 'x' };
    await registry.saveTheme(THEME, 'body{}', ':root{--a:1}');
    await registry.saveTheme({ ...THEME, version: '2.0.0' }, 'body{color:red}', null);

    // 2.0.0 dropped the skin, so going back brings one back.
    const asked = await call('theme', 'night', { version: '1.0.0' });
    expect(asked.status).toBe(409);
    expect((await asked.json()).grantsAdded).toMatchObject({ skin: true });
    expect((await registry.getTheme('night'))!.version).toBe('2.0.0');

    const res = await call('theme', 'night', { version: '1.0.0', acceptGrants: { skin: true } });
    expect(res.status).toBe(200);
    expect((await registry.getTheme('night'))!.version).toBe('1.0.0');
    expect(await registry.getThemeCSS('night')).toBe('body{}');
    expect(await registry.getThemeSkin('night')).toBe(':root{--a:1}');
  });

  it('rolls a theme back without asking when both have a skin, or the kept one has none', async () => {
    const registry = await import('@/lib/admin/plugin-registry');
    const THEME = { id: 'night', name: 'Night', version: '1.0.0', author: 'a', description: '', variants: ['dark'], enabled: true, installedAt: 'x', updatedAt: 'x' };
    await registry.saveTheme(THEME, 'body{}', ':root{--a:1}');
    await registry.saveTheme({ ...THEME, version: '2.0.0' }, 'body{color:red}', ':root{--a:2}');
    expect((await call('theme', 'night', { version: '1.0.0' })).status).toBe(200);

    await registry.saveTheme({ ...THEME, version: '3.0.0' }, 'body{}', null);
    await registry.saveTheme({ ...THEME, version: '4.0.0' }, 'body{}', ':root{--a:4}');
    expect((await call('theme', 'night', { version: '3.0.0' })).status).toBe(200);
  });
});
