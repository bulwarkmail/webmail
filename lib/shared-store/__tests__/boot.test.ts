/**
 * @vitest-environment node
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { get: vi.fn((_key: string, fallback: unknown) => fallback) },
}));

import { bootState, getStore, setBootState, setStoreForTests } from '../index';
import { resetLocalStoreForTests } from '../local';
import {
  INIT_EPOCH,
  announceChange,
  markEpochsSeen,
  onSharedChange,
  pollChanges,
  resetChangesForTests,
} from '../changes';
import { bootSharedMode } from '../boot';
import {
  ensureSharedSessionSecret,
  getSessionSecret,
  resetSharedSessionSecretForTests,
  SHARED_SECRET_KEY,
} from '@/lib/auth/session-secret';
import { fakeSharedStore } from './fake-shared';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), 'bulwark-boot-'));
  vi.stubEnv('ADMIN_STATE_DIR', stateDir);
  vi.stubEnv('SESSION_SECRET', '');
  vi.stubEnv('SESSION_SECRET_FILE', '');
  resetLocalStoreForTests();
  resetChangesForTests();
  resetSharedSessionSecretForTests();
});

afterEach(() => {
  setStoreForTests(null);
  resetChangesForTests();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

const noImport = async () => ({ imported: {} });

describe('change notices', () => {
  it('runs this process\'s listeners at once in local mode', async () => {
    const seen: string[] = [];
    onSharedChange('config', (origin) => void seen.push(origin));
    await announceChange('config');
    expect(seen).toEqual(['local']);
  });

  it('runs listeners for another replica\'s change on the next poll, once', async () => {
    const store = fakeSharedStore();
    setStoreForTests(store);
    await store.epochs.bump(INIT_EPOCH);
    await markEpochsSeen();
    const seen: string[] = [];
    onSharedChange('policy', (origin) => void seen.push(origin));
    await store.epochs.bump('policy'); // another replica saved
    await pollChanges();
    await pollChanges();
    expect(seen).toEqual(['remote']);
  });

  it('does not reload its own change, but does when another landed in between', async () => {
    const store = fakeSharedStore();
    setStoreForTests(store);
    await store.epochs.bump(INIT_EPOCH);
    await markEpochsSeen();
    const seen: string[] = [];
    onSharedChange('config', (origin) => void seen.push(origin));
    await announceChange('config');
    await pollChanges();
    expect(seen).toEqual(['local']);
    await store.epochs.bump('config'); // other replica
    await announceChange('config'); // ours right after
    await pollChanges();
    expect(seen).toEqual(['local', 'local', 'remote']);
  });

  it('sends a change notice again when the store was unreachable right after the write', async () => {
    const store = fakeSharedStore();
    setStoreForTests(store);
    await store.epochs.bump(INIT_EPOCH);
    await markEpochsSeen();
    const bump = store.epochs.bump.bind(store.epochs);
    let fail = true;
    store.epochs.bump = async (area: string) => {
      if (fail) throw new Error('connection dropped');
      return bump(area);
    };
    await announceChange('config');
    expect((await store.epochs.all()).config).toBeUndefined();
    await pollChanges(); // still down
    expect((await store.epochs.all()).config).toBeUndefined();
    fail = false;
    await pollChanges();
    expect((await store.epochs.all()).config).toBe(1);
    await pollChanges();
    expect((await store.epochs.all()).config).toBe(1); // sent once, not every poll
  });

  it('retries a listener that failed on the next poll', async () => {
    const store = fakeSharedStore();
    setStoreForTests(store);
    await store.epochs.bump(INIT_EPOCH);
    await markEpochsSeen();
    let calls = 0;
    onSharedChange('plugins', () => {
      calls++;
      if (calls === 1) throw new Error('store hiccup');
    });
    await store.epochs.bump('plugins');
    await pollChanges();
    await pollChanges();
    await pollChanges();
    expect(calls).toBe(2);
  });

  it('goes to store-lost when the store forgets the deployment, and back when it returns', async () => {
    const store = fakeSharedStore();
    setStoreForTests(store);
    setBootState('ready');
    await pollChanges(); // no _init epoch: an emptied store
    expect(bootState()).toBe('store-lost');
    const reloaded: string[] = [];
    onSharedChange('config', (origin) => void reloaded.push(origin));
    await store.epochs.bump(INIT_EPOCH); // restored
    await pollChanges();
    expect(bootState()).toBe('ready');
    expect(reloaded).toEqual(['remote']);
  });
});

describe('session secret with a shared store', () => {
  it('gives every replica the same generated secret', async () => {
    setStoreForTests(fakeSharedStore());
    const created = await Promise.all([ensureSharedSessionSecret(), ensureSharedSessionSecret(), ensureSharedSessionSecret()]);
    expect(created.filter(Boolean)).toHaveLength(1);
    const stored = await getStore().kv.get(SHARED_SECRET_KEY);
    expect(stored).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(getSessionSecret()).toBe(stored);
  });

  it('ignores the state dir file in shared mode and lets SESSION_SECRET win', async () => {
    writeFileSync(path.join(stateDir, '.session-secret'), 'local-file-secret-local-file-secret-xx');
    setStoreForTests(fakeSharedStore());
    await ensureSharedSessionSecret();
    expect(getSessionSecret()).not.toBe('local-file-secret-local-file-secret-xx');
    vi.stubEnv('SESSION_SECRET', 'from-env-from-env-from-env-from-env-xx');
    expect(getSessionSecret()).toBe('from-env-from-env-from-env-from-env-xx');
  });
});

describe('bootSharedMode', () => {
  it('initialises an empty store: secret, marker, then loads and becomes ready', async () => {
    const store = fakeSharedStore();
    setStoreForTests(store);
    const order: string[] = [];
    await bootSharedMode({
      version: '9.9.9',
      importLocal: async () => { order.push('import'); return { imported: { settings: 2 } }; },
      load: async () => { order.push('load'); },
    });
    expect(order).toEqual(['import', 'load']);
    expect(bootState()).toBe('ready');
    expect((await store.epochs.all())[INIT_EPOCH]).toBe(1);
    expect(JSON.parse((await store.kv.get('meta:initialized'))!)).toMatchObject({ imported: { settings: 2 } });
    expect(getSessionSecret()).toBe(await store.kv.get(SHARED_SECRET_KEY));
    expect((await store.replicas.recent(60_000)).map((r) => r.version)).toEqual(['9.9.9']);
  });

  it('imports this install\'s generated secret before creating one', async () => {
    writeFileSync(path.join(stateDir, '.session-secret'), 'old-install-secret-old-install-secret');
    const store = fakeSharedStore();
    setStoreForTests(store);
    await bootSharedMode({ version: '1', importLocal: noImport, load: async () => {} });
    expect(await store.kv.get(SHARED_SECRET_KEY)).toBe('old-install-secret-old-install-secret');
    expect(getSessionSecret()).toBe('old-install-secret-old-install-secret');
  });

  it('joins an initialised store without importing again', async () => {
    const store = fakeSharedStore();
    setStoreForTests(store);
    await bootSharedMode({ version: '1', importLocal: noImport, load: async () => {} });
    const importLocal = vi.fn(noImport);
    resetSharedSessionSecretForTests();
    await bootSharedMode({ version: '1', importLocal, load: async () => {} });
    expect(importLocal).not.toHaveBeenCalled();
    expect(bootState()).toBe('ready');
    expect((await store.epochs.all())[INIT_EPOCH]).toBe(1);
  });

  it('refuses to serve when its own local data was encrypted with another secret', async () => {
    const store = fakeSharedStore();
    setStoreForTests(store);
    await bootSharedMode({ version: '1', importLocal: noImport, load: async () => {} });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, '.session-secret'), 'a-different-install-secret-a-different');
    const load = vi.fn(async () => {});
    await bootSharedMode({ version: '1', importLocal: noImport, load });
    expect(bootState()).toBe('blocked');
    expect(load).not.toHaveBeenCalled();
  });

  it('waits for a store that is down at start', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    try {
      const store = fakeSharedStore();
      store.down = true;
      setStoreForTests(store);
      const done = bootSharedMode({ version: '1', importLocal: noImport, load: async () => {} });
      await vi.advanceTimersByTimeAsync(5000);
      expect(bootState()).toBe('starting');
      store.down = false;
      await vi.advanceTimersByTimeAsync(5000);
      await done;
      expect(bootState()).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });
});
