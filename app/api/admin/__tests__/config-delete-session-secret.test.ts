/**
 * @vitest-environment node
 */
// The dashboard must not change the key behind every session. PATCH
// /api/admin/config refuses `sessionSecret`; DELETE (revert to the
// environment or the default) refuses it the same way, since removing the
// secret the setup wizard stored changes the key just as well: sessions stop
// opening, the admin can't sign in, and everything sealed with it is
// orphaned. Both take only the settings map's own keys.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const WIZARD_SECRET = 'w'.repeat(64);

const configDir = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'bulwark-config-delete-secret-'));
  process.env.ADMIN_CONFIG_DIR = dir;
  process.env.ADMIN_STATE_DIR = join(dir, 'state');
  delete process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET_FILE;
  return dir;
});

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: async () => ({ payload: { role: 'admin' } }),
  getClientIP: () => '127.0.0.1',
}));

import { DELETE as deleteConfig, PATCH as patchConfig } from '../config/route';
import { configManager } from '@/lib/admin/config-manager';
import { getSessionSecret } from '@/lib/auth/session-secret';

function request(method: 'DELETE' | 'PATCH', body: string) {
  return new NextRequest('http://localhost/api/admin/config', {
    method,
    body,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
  });
}
const del = (body: unknown) => request('DELETE', JSON.stringify(body));

const storedConfig = () => JSON.parse(readFileSync(path.join(configDir, 'config.json'), 'utf-8')) as Record<string, unknown>;

// Before every case, so no case depends on what another one did.
beforeEach(async () => {
  // What the setup wizard's Security step leaves behind.
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ setupComplete: true, appName: 'Webmail', sessionSecret: WIZARD_SECRET }));
  await configManager.reload();
});

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('DELETE /api/admin/config and the session secret', () => {
  it('refuses to remove the session secret, with the message PATCH gives', async () => {
    expect(getSessionSecret()).toBe(WIZARD_SECRET);
    const res = await deleteConfig(del({ key: 'sessionSecret' }));
    expect(res.status).toBe(400);
    expect(getSessionSecret()).toBe(WIZARD_SECRET);
    expect(storedConfig().sessionSecret).toBe(WIZARD_SECRET);

    const patched = await patchConfig(request('PATCH', JSON.stringify({ sessionSecret: 'x'.repeat(64) })));
    expect(patched.status).toBe(400);
    expect((await res.json()).error).toBe((await patched.json()).error);
  });

  it('still reverts an ordinary setting', async () => {
    await configManager.setAdminConfig({ appName: 'Changed' });
    const res = await deleteConfig(del({ key: 'appName' }));
    expect(res.status).toBe(200);
    expect(storedConfig().appName).toBeUndefined();
    expect(storedConfig().sessionSecret).toBe(WIZARD_SECRET);
  });

  it('refuses a key that is not a setting of its own', async () => {
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const res = await deleteConfig(del({ key }));
      expect(res.status, key).toBe(400);
    }
    expect(storedConfig().sessionSecret).toBe(WIZARD_SECRET);
  });

  it('refuses such keys in PATCH too', async () => {
    for (const key of ['constructor', '__proto__', 'toString']) {
      const res = await patchConfig(request('PATCH', `{"${key}": "x"}`));
      expect(res.status, key).toBe(400);
    }
    expect(storedConfig()).toEqual({ setupComplete: true, appName: 'Webmail', sessionSecret: WIZARD_SECRET });
  });
});
