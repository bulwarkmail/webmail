// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { separateDiskStore, type SeparateDiskStore } from './helpers/separate-disk-store';

// With the shared store down, the update banner's routes answered 500. They
// answer 503 with Retry-After now, like the other routes that need the store.

vi.mock('@/lib/admin/session', () => ({ requireAdminAuth: async () => ({ session: { sub: 'admin' } }) }));
vi.mock('@/lib/admin/third-party-mode', () => ({ isNoThirdPartyTrafficOn: async () => false }));
vi.mock('@/lib/auth/instance-details', () => ({ canSeeInstanceDetails: async () => true }));
vi.mock('@/lib/logger', () => ({ logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } }));

import { GET as updateStatus } from '@/app/api/system/update-status/route';
import { GET as adminVersion, POST as adminCheck } from '@/app/api/admin/version/route';

let store: SeparateDiskStore;

beforeEach(() => {
  store = separateDiskStore();
  setStoreForTests(store);
  vi.stubEnv('BULWARK_UPDATE_CHECK_URL', 'https://version.example/');
  vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '1.20.0');
});

afterEach(() => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  store.cleanup();
});

const req = (url: string, init?: RequestInit) => new NextRequest(`http://localhost${url}`, init as never);

describe('update status routes while the shared store is down', () => {
  it('answer 503 with Retry-After, and 200 again once it is back', async () => {
    store.down = true;
    const responses = [
      await updateStatus(req('/api/system/update-status')),
      await adminVersion(req('/api/admin/version')),
      await adminCheck(req('/api/admin/version', { method: 'POST', body: JSON.stringify({ action: 'check-now' }) })),
    ];
    for (const res of responses) {
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('10');
    }

    store.down = false;
    expect((await updateStatus(req('/api/system/update-status'))).status).toBe(200);
    expect((await adminVersion(req('/api/admin/version'))).status).toBe(200);
  });
});
