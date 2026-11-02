// @vitest-environment node
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { separateDiskStore, type SeparateDiskStore } from './helpers/separate-disk-store';

// Users' plugin credentials with a shared store (#1066). The vault used to
// serialise writes with a queue in its own module, which no other process
// (and no other module copy) sees: two writes on two replicas lost one.

vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
vi.mock('@/lib/logger', () => ({
  logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
}));

const user = { username: 'alice@example.org', serverUrl: 'https://mail.example.org' };
const input = (secret: string) => ({ origin: 'https://cloud.example.org', inject: { type: 'basic' } as const, label: 'Cloud', secret });

type Vault = typeof import('@/lib/plugin-secrets/vault');

/** A fresh copy of the vault module, as another process (or bundle) has. */
async function replica(): Promise<Vault> {
  vi.resetModules();
  return import('@/lib/plugin-secrets/vault');
}

let disks: string;
let store: SeparateDiskStore;

beforeEach(() => {
  disks = mkdtempSync(path.join(tmpdir(), 'bw-vault-replicas-'));
  vi.stubEnv('PLUGIN_SECRETS_DIR', path.join(disks, 'a'));
  store = separateDiskStore();
  setStoreForTests(store);
});

afterEach(() => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  store.cleanup();
  rmSync(disks, { recursive: true, force: true });
});

describe('plugin credentials with a shared store', () => {
  it('reads on replica B what replica A stored', async () => {
    const a = await replica();
    await a.putUserCredential(user, 'nextcloud', 'cloud', input('pw'));

    vi.stubEnv('PLUGIN_SECRETS_DIR', path.join(disks, 'b'));
    const b = await replica();
    expect(await b.getUserCredential(user, 'nextcloud', 'cloud')).toMatchObject({ secret: 'pw' });
  });

  it('keeps both of two credentials saved at once through two replicas', async () => {
    const a = await replica();
    const b = await replica();
    await Promise.all([
      a.putUserCredential(user, 'nextcloud', 'cloud', input('one')),
      b.putUserCredential(user, 'paperless', 'docs', input('two')),
      a.putUserCredential(user, 'radicale', 'dav', input('three')),
      b.putUserCredential(user, 'immich', 'photos', input('four')),
    ]);

    const ids = (await a.listUserCredentials(user)).map((c) => c.pluginId).sort();
    expect(ids).toEqual(['immich', 'nextcloud', 'paperless', 'radicale']);
  });

  it('answers with StoreUnavailableError while the store is down and writes nothing', async () => {
    const vault = await replica();
    await vault.putUserCredential(user, 'nextcloud', 'cloud', input('pw'));
    store.down = true;
    await expect(vault.putUserCredential(user, 'paperless', 'docs', input('x'))).rejects.toThrow('down (test)');
    await expect(vault.listUserCredentials(user)).rejects.toThrow('down (test)');
    store.down = false;
    expect((await vault.listUserCredentials(user)).map((c) => c.pluginId)).toEqual(['nextcloud']);
  });
});

describe('plugin credentials on a single instance', () => {
  it('keep today\'s file: <sha256>.enc in the vault dir, mode 0600, gone when the last one goes', async () => {
    setStoreForTests(null);
    const vault = await replica();
    await vault.putUserCredential(user, 'nextcloud', 'cloud', input('pw'));
    const dir = path.join(disks, 'a');
    const files = readdirSync(dir);
    expect(files).toEqual([`${vault.userKey(user)}.enc`]);
    if (process.platform !== 'win32') expect(statSync(path.join(dir, files[0])).mode & 0o777).toBe(0o600);

    await vault.deleteUserCredentials(user, 'nextcloud');
    expect(readdirSync(dir)).toEqual([]);
  });
});
