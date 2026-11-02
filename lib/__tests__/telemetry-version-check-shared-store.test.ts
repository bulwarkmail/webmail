// @vitest-environment node
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import type { UpdateStatus } from '@/lib/version-check/types';
import { separateDiskStore, type SeparateDiskStore } from './helpers/separate-disk-store';

// Telemetry and the version check with a shared store (#1066): one instance
// id, one login list and one state for the deployment.

vi.mock('@/lib/admin/third-party-mode', () => ({ isNoThirdPartyTrafficOn: async () => false }));

let disks: string;
let store: SeparateDiskStore;

function onReplica(name: 'a' | 'b') {
  vi.stubEnv('TELEMETRY_DATA_DIR', path.join(disks, name, 'telemetry'));
  vi.stubEnv('VERSION_CHECK_DATA_DIR', path.join(disks, name, 'version-check'));
}

beforeEach(() => {
  disks = mkdtempSync(path.join(tmpdir(), 'bw-telemetry-replicas-'));
  store = separateDiskStore();
  setStoreForTests(store);
  vi.stubEnv('BULWARK_TELEMETRY', '');
  onReplica('a');
});

afterEach(() => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  store.cleanup();
  rmSync(disks, { recursive: true, force: true });
});

describe('telemetry with a shared store', () => {
  it('gives every replica one instance id, even when they ask at once', async () => {
    const { getInstanceId } = await import('@/lib/telemetry/state');
    const [first, second] = await Promise.all([getInstanceId(), getInstanceId()]);
    expect(second).toBe(first);
    onReplica('b');
    expect(await getInstanceId()).toBe(first);
  });

  it('counts logins on every replica together and reports the same numbers everywhere', async () => {
    // A fresh module copy per replica: nothing carried over in memory.
    const tracker = async () => {
      vi.resetModules();
      return import('@/lib/telemetry/login-tracker');
    };
    const a = await tracker();
    await Promise.all([
      a.recordLogin('alice@example.org', 'https://mail.example.org'),
      a.recordLogin('bob@example.org', 'https://mail.example.org'),
    ]);
    onReplica('b');
    const b = await tracker();
    await b.recordLogin('carol@example.org', 'https://mail.example.org');
    expect(await b.getLoginCounts()).toEqual({ total: 3, active7d: 3 });
    expect(await a.getLoginCounts()).toEqual({ total: 3, active7d: 3 });
  });

  it('does not report zero accounts while the store is down', async () => {
    const { recordLogin, getLoginCounts } = await import('@/lib/telemetry/login-tracker');
    await recordLogin('alice@example.org', 'https://mail.example.org');
    store.down = true;
    await expect(getLoginCounts()).rejects.toThrow('down (test)');
    store.down = false;
    expect(await getLoginCounts()).toEqual({ total: 1, active7d: 1 });
  });

  it('shows on replica B the consent set on replica A', async () => {
    const { updateState, effectiveConsent } = await import('@/lib/telemetry/state');
    await updateState((state) => { state.consent = 'on'; });
    onReplica('b');
    expect((await effectiveConsent()).consent).toBe('on');
  });
});

function status(current: string, latest: string): UpdateStatus {
  return {
    schema: 1, current, latest, updateAvailable: current !== latest, severity: current !== latest ? 'normal' : 'none',
    url: null, advisory: null, checkedAt: new Date().toISOString(),
  };
}

describe('version check with a shared store', () => {
  it('keeps each running version\'s status during a rolling update', async () => {
    vi.stubEnv('BULWARK_UPDATE_CHECK_URL', 'https://version.example/');
    const answer = (current: string) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(status(current, '1.21.0')))));
    const { checkOnce, loadState, freshStatus } = await import('@/lib/version-check');

    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '1.20.0');
    answer('1.20.0');
    expect((await checkOnce()).ok).toBe(true);

    onReplica('b');
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '1.21.0');
    answer('1.21.0');
    expect((await checkOnce()).ok).toBe(true);
    expect(freshStatus(await loadState())).toMatchObject({ current: '1.21.0', updateAvailable: false });

    // A replica still on the old version keeps showing its banner.
    onReplica('a');
    vi.stubEnv('NEXT_PUBLIC_APP_VERSION', '1.20.0');
    expect(freshStatus(await loadState())).toMatchObject({ current: '1.20.0', updateAvailable: true });
  });
});

describe('telemetry and version check on a single instance', () => {
  it('keep today\'s files', async () => {
    setStoreForTests(null);
    const { getInstanceId, loadState } = await import('@/lib/telemetry/state');
    const { recordLogin } = await import('@/lib/telemetry/login-tracker');
    const versionCheck = await import('@/lib/version-check');
    await getInstanceId();
    await loadState();
    await recordLogin('alice@example.org', 'https://mail.example.org');
    await versionCheck.saveState({ ...(await versionCheck.loadState()), lastCheckedAt: 'x' });
    expect(readdirSync(path.join(disks, 'a', 'telemetry')).sort()).toEqual(['.telemetry-id', 'logins.json', 'state.json']);
    expect(readdirSync(path.join(disks, 'a', 'version-check'))).toEqual(['state.json']);
  });
});
