// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { open } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { separateDiskStore, type SeparateDiskStore } from './helpers/separate-disk-store';

// Account archives with a shared store (#1066): one document per owner,
// replaced whole, the same on every replica.

const mocks = vi.hoisted(() => ({ contexts: new Map<number, unknown>(), verify: vi.fn() }));
vi.mock('@/lib/admin/config-manager', () => ({ configManager: {
  ensureLoaded: async () => {},
  get: (_key: string, fallback: unknown) => fallback,
  getPolicy: () => ({ features: { accountArchiveEnabled: true } }),
} }));
vi.mock('@/lib/auth/session-secret', () => ({ hasSessionSecret: () => true }));
vi.mock('next/headers', () => ({ cookies: async () => ({}) }));
vi.mock('@/lib/stalwart/auth-context', () => ({
  readStalwartAuthContextFromStore: (_: unknown, slot: number) => mocks.contexts.get(slot) ?? null,
}));
vi.mock('@/lib/auth/verify-jmap-auth', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/auth/verify-jmap-auth')>(), verifyJmapAuth: mocks.verify,
}));

import { deleteArchive, loadArchive, saveArchive } from '@/lib/account-archive-storage';
import { GET, PUT } from '@/app/api/account-archive/route';
import type { ArchiveEnvelope } from '@/lib/account-archive';

const owner = { username: 'owner@example.com', serverUrl: 'https://mail.example.com' };
const envelope: ArchiveEnvelope = { version: 1, iterations: 600000, salt: 'A'.repeat(22) + '==', iv: 'A'.repeat(16), ciphertext: 'A'.repeat(43) + '=' };
const other: ArchiveEnvelope = { ...envelope, ciphertext: 'B'.repeat(43) + '=' };

let disks: string;
let store: SeparateDiskStore;

beforeEach(() => {
  disks = mkdtempSync(path.join(tmpdir(), 'bw-archive-replicas-'));
  vi.stubEnv('SETTINGS_DATA_DIR', path.join(disks, 'a'));
  store = separateDiskStore();
  setStoreForTests(store);
  mocks.contexts.clear();
  mocks.contexts.set(0, { username: owner.username, serverUrl: owner.serverUrl, authHeader: 'Basic ' + Buffer.from(`${owner.username}:pw`).toString('base64') });
  mocks.verify.mockReset().mockResolvedValue(owner.serverUrl);
});

afterEach(() => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  store.cleanup();
  rmSync(disks, { recursive: true, force: true });
});

function request(method: string, body?: unknown) {
  return new NextRequest('https://webmail.example.com/api/account-archive', {
    method,
    headers: { 'x-archive-username': owner.username, 'x-archive-server': owner.serverUrl, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('account archives with a shared store', () => {
  it('returns on replica B what replica A stored, and the latest save wins', async () => {
    await saveArchive(owner, envelope);
    vi.stubEnv('SETTINGS_DATA_DIR', path.join(disks, 'b'));
    expect(await loadArchive(owner)).toEqual(envelope);

    await saveArchive(owner, other);
    vi.stubEnv('SETTINGS_DATA_DIR', path.join(disks, 'a'));
    expect(await loadArchive(owner)).toEqual(other);

    await deleteArchive(owner);
    expect(await loadArchive(owner)).toBeNull();
  });

  it('answers 503 while the store is down and keeps what is stored', async () => {
    await saveArchive(owner, envelope);
    store.down = true;
    expect((await PUT(request('PUT', { envelope: other }))).status).toBe(503);
    expect((await GET(request('GET'))).status).toBe(503);
    store.down = false;
    expect(await loadArchive(owner)).toEqual(envelope);
  });
});

describe('account archives on a single instance', () => {
  it('flush the new file to disk before it replaces the old one', async () => {
    setStoreForTests(null);
    const handle = await open(path.join(disks, 'probe'), 'w');
    const proto = Object.getPrototypeOf(handle) as { sync: () => Promise<void> };
    await handle.close();
    const sync = vi.spyOn(proto, 'sync');
    try {
      await saveArchive(owner, envelope);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(await loadArchive(owner)).toEqual(envelope);
    } finally {
      sync.mockRestore();
    }
  });

  it('keep today\'s file: <sha256 of the owner>.json under account-archives, mode 0600', async () => {
    setStoreForTests(null);
    await saveArchive(owner, envelope);
    const dir = path.join(disks, 'a', 'account-archives');
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(path.join(dir, files[0]), 'utf8'))).toEqual(envelope);
    if (process.platform !== 'win32') {
      expect(statSync(path.join(dir, files[0])).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
  });
});
