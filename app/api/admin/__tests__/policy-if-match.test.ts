// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// The admin pages save the whole policy from a draft they loaded earlier.
// A save from a page opened before someone else's save (another tab,
// another admin) used to put the old policy back over theirs.

vi.mock('@/lib/auth/instance-details', () => ({
  canSeeInstanceDetails: async () => true,
  signedInIdentity: async () => ({ admin: true }),
}));
vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: async () => ({ payload: { role: 'admin' } }),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: async () => {} }));

import { GET, PUT } from '@/app/api/admin/policy/route';
import { forgetExtensionInPolicy } from '@/lib/admin/extension-cleanup';
import { configManager } from '@/lib/admin/config-manager';

let dir: string;
const URL = 'https://mail.example/api/admin/policy';
const stored = async () => JSON.parse(await readFile(path.join(dir, 'policy.json'), 'utf-8'));

async function load(): Promise<{ policy: Record<string, unknown>; etag: string }> {
  const res = await GET(new NextRequest(URL));
  expect(res.status).toBe(200);
  const etag = res.headers.get('ETag');
  expect(etag).toMatch(/^".+"$/);
  return { policy: await res.json(), etag: etag! };
}

function save(policy: Record<string, unknown>, etag?: string) {
  return PUT(new NextRequest(URL, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(etag ? { 'if-match': etag } : {}) },
    body: JSON.stringify(policy),
  }));
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-policy-if-match-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify({ features: { calendarEnabled: true }, forceEnabledPlugins: ['demo'] }));
  await configManager.reload();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('policy save with If-Match', () => {
  it('refuses a save based on an older policy and keeps the newer one', async () => {
    const tabA = await load();
    const tabB = await load();

    const first = await save({ ...tabA.policy, features: { ...(tabA.policy.features as object), calendarEnabled: false } }, tabA.etag);
    expect(first.status).toBe(200);
    expect(first.headers.get('ETag')).not.toBe(tabA.etag);

    const stale = await save({ ...tabB.policy, features: { ...(tabB.policy.features as object), filesEnabled: false } }, tabB.etag);
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe(
      'Someone else changed the policy after you opened this page. Reload to see their change; your edits stay here until you reload.',
    );
    expect((await stored()).features.calendarEnabled).toBe(false);
    expect((await stored()).features.filesEnabled).not.toBe(false);
    expect(configManager.getPolicy().features.calendarEnabled).toBe(false);

    // Saving again with the version the first save answered works.
    const again = await save({ ...tabA.policy, features: { ...(tabA.policy.features as object), calendarEnabled: true } }, first.headers.get('ETag')!);
    expect(again.status).toBe(200);
  });

  it('sees a change saved to policy.json by another replica on the same volume', async () => {
    const page = await load();
    await writeFile(path.join(dir, 'policy.json'), JSON.stringify({ features: { calendarEnabled: false } }));
    const res = await save({ ...page.policy, features: { ...(page.policy.features as object), filesEnabled: false } }, page.etag);
    expect(res.status).toBe(409);
    expect((await stored()).features).toEqual({ calendarEnabled: false });
  });

  it('refuses a page loaded before a plugin was dropped from the policy', async () => {
    const page = await load();
    await forgetExtensionInPolicy('plugin', 'demo');
    expect((await stored()).forceEnabledPlugins).toEqual([]);
    expect((await save(page.policy, page.etag)).status).toBe(409);
    expect((await stored()).forceEnabledPlugins).toEqual([]);
  });

  it('drops a deleted plugin without undoing a save another replica made on the same volume', async () => {
    await load();
    await writeFile(path.join(dir, 'policy.json'), JSON.stringify({ features: { calendarEnabled: false }, forceEnabledPlugins: ['demo', 'other'] }));
    await forgetExtensionInPolicy('plugin', 'demo');
    expect((await stored()).forceEnabledPlugins).toEqual(['other']);
    expect((await stored()).features.calendarEnabled).toBe(false);
  });

  it('answers a save with what it stored', async () => {
    const page = await load();
    const res = await save({ ...page.policy, features: { ...(page.policy.features as object), calendarEnabled: false } }, page.etag);
    const body = await res.json();
    expect(body.policy.features.calendarEnabled).toBe(false);
    expect(res.headers.get('ETag')).toBe((await load()).etag);
  });

  it('replaces the policy without If-Match, as before', async () => {
    await load();
    await configManager.setPolicy({ ...configManager.getPolicy(), forceEnabledPlugins: [] });
    const res = await save({ features: { calendarEnabled: false } });
    expect(res.status).toBe(200);
    expect((await stored()).features.calendarEnabled).toBe(false);
  });

  it('answers 409 when the config manager was made by another bundle\'s copy of the module', async () => {
    // In the server the instrumentation creates the config manager, so its
    // errors are of the instrumentation's classes, not the route's.
    const KEY = Symbol.for('bulwark.admin.configManager');
    const g = globalThis as Record<symbol, unknown>;
    const mine = g[KEY];
    try {
      delete g[KEY];
      vi.resetModules();
      await (await import('@/lib/admin/config-manager')).configManager.load();
      vi.resetModules();
      const route = await import('@/app/api/admin/policy/route');
      const res = await route.GET(new NextRequest(URL));
      const etag = res.headers.get('ETag')!;
      await writeFile(path.join(dir, 'policy.json'), JSON.stringify({ features: { calendarEnabled: false } }));
      const stale = await route.PUT(new NextRequest(URL, { method: 'PUT', headers: { 'if-match': etag }, body: JSON.stringify(await res.json()) }));
      expect(stale.status).toBe(409);
    } finally {
      g[KEY] = mine;
    }
  });
});
