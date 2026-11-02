// @vitest-environment node
// GET /api/admin/policy waits on the store for the identity checks. A
// change from another replica applied meanwhile must not pair the policy
// read before with the version read after: a page saving that body with
// that ETag would put the old policy back over the other replica's save.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

const hooks: { duringIdentity?: () => Promise<void> } = {};
vi.mock('@/lib/auth/instance-details', () => ({
  canSeeInstanceDetails: async () => true,
  signedInIdentity: async () => {
    // Stands in for the store round trip verifyCurrentAdminSession makes.
    await hooks.duringIdentity?.();
    return { admin: true };
  },
}));
vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: async () => ({ payload: { role: 'admin' } }),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: async () => {} }));

import { configManager } from '@/lib/admin/config-manager';
import { adminConfigDocs } from '@/lib/admin/admin-store';
import { setBootState, setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { INIT_EPOCH, markEpochsSeen, pollChanges, resetChangesForTests } from '@/lib/shared-store/changes';
import { GET, PUT } from '@/app/api/admin/policy/route';
import { separateFakeStore } from '@/lib/admin/__tests__/shared-store-fake';

let dir: string;
let store: ReturnType<typeof separateFakeStore>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-review-etag-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
  resetLocalStoreForTests();
  resetChangesForTests();
  store = separateFakeStore(path.join(dir, 'store'));
  setStoreForTests(store);
  await store.epochs.bump(INIT_EPOCH);
  await adminConfigDocs().put('policy.json', JSON.stringify({ features: { calendarEnabled: true } }));
  await markEpochsSeen();
  await configManager.load();
  setBootState('ready');
});

afterEach(async () => {
  hooks.duringIdentity = undefined;
  setStoreForTests(null);
  resetChangesForTests();
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

it('sends the version of the policy it sends, when a change lands during the request', async () => {
  hooks.duringIdentity = async () => {
    // Another replica saves calendarEnabled:false; the poll lands mid-GET.
    await adminConfigDocs().put('policy.json', JSON.stringify({ features: { calendarEnabled: false, filesEnabled: false } }));
    await store.epochs.bump('policy');
    await pollChanges();
  };
  const res = await GET(new NextRequest('https://mail.example/api/admin/policy'));
  hooks.duringIdentity = undefined;
  const body = await res.json();
  const etag = res.headers.get('ETag')!;
  // Old body...
  expect(body.features.calendarEnabled).toBe(true);
  // ...saved with the ETag it came with: refused, the other save stays.
  const put = await PUT(new NextRequest('https://mail.example/api/admin/policy', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'if-match': etag },
    body: JSON.stringify(body),
  }));
  expect(put.status).toBe(409);
  const stored = JSON.parse((await adminConfigDocs().get('policy.json'))!.data.toString('utf-8'));
  expect(stored.features).toEqual({ calendarEnabled: false, filesEnabled: false });
});
