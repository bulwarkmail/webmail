// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// While the shared store can't be reached (#1066) nothing can be saved. The
// admin and setup routes say so with a 503 and Retry-After, so the panel
// and the wizard can tell "try again" from a bug, instead of a bare 500.

const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
  }),
}));
vi.mock('@/lib/admin/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/admin/session')>()),
  requireAdminAuth: async () => ({ payload: { role: 'admin' } }),
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: async () => {} }));

import { PATCH as patchConfig, DELETE as deleteConfig } from '../config/route';
import { PUT as putPolicy } from '../policy/route';
import { POST as importPolicy } from '../policy/file/route';
import { POST as changePassword } from '../change-password/route';
import { POST as setupStep } from '@/app/api/setup/step/route';
import { POST as setupToken } from '@/app/api/setup/token/route';
import { GET as setupStatus } from '@/app/api/setup/status/route';
import { configManager } from '@/lib/admin/config-manager';
import { adminConfigDocs } from '@/lib/admin/admin-store';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { INIT_EPOCH, markEpochsSeen, resetChangesForTests } from '@/lib/shared-store/changes';
import { ensureSetupToken } from '@/lib/setup/token';
import { separateFakeStore } from '@/lib/admin/__tests__/shared-store-fake';

let dir: string;
let store: ReturnType<typeof separateFakeStore>;

const json = (url: string, method: string, body: unknown) => new NextRequest(`https://mail.example${url}`, {
  method,
  headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
  body: JSON.stringify(body),
});

async function expect503(res: Response) {
  expect(res.status).toBe(503);
  expect(res.headers.get('Retry-After')).toBe('10');
  expect((await res.json()).error).toMatch(/try again/i);
}

beforeEach(async () => {
  jar.clear();
  dir = await mkdtemp(path.join(tmpdir(), 'bw-store-down-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
  vi.stubEnv('JMAP_SERVER_URL', '');
  vi.stubEnv('SESSION_SECRET', 'a'.repeat(64));
  resetLocalStoreForTests();
  resetChangesForTests();
  store = separateFakeStore(path.join(dir, 'store'));
  setStoreForTests(store);
  await store.epochs.bump(INIT_EPOCH);
  await markEpochsSeen();
});

afterEach(async () => {
  setStoreForTests(null);
  resetChangesForTests();
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('admin saves while the shared store is down', () => {
  beforeEach(async () => {
    await adminConfigDocs().put('config.json', JSON.stringify({ setupComplete: true }));
    await configManager.load();
    store.down = true;
  });

  it('answers 503 for config changes', async () => {
    await expect503(await patchConfig(json('/api/admin/config', 'PATCH', { appName: 'Nope' })));
    await expect503(await deleteConfig(json('/api/admin/config', 'DELETE', { key: 'appName' })));
  });

  it('answers 503 for policy saves and imports', async () => {
    await expect503(await putPolicy(json('/api/admin/policy', 'PUT', { features: {} })));
    await expect503(await importPolicy(json('/api/admin/policy/file', 'POST', { features: {} })));
  });

  it('answers 503 for a password change', async () => {
    await expect503(await changePassword(json('/api/admin/change-password', 'POST', { currentPassword: 'old-password-1', newPassword: 'new-password-2' })));
  });
});

describe('the setup wizard while the shared store is down', () => {
  beforeEach(async () => {
    await configManager.load();
    jar.set('bulwark_setup_token', await ensureSetupToken());
    store.down = true;
  });

  it('answers 503 instead of failing on the token check', async () => {
    await expect503(await setupStep(json('/api/setup/step', 'POST', { step: 'branding', data: { appName: 'Nope' } })));
    await expect503(await setupToken(json('/api/setup/token', 'POST', { token: jar.get('bulwark_setup_token') })));
    await expect503(await setupStatus());
  });
});
