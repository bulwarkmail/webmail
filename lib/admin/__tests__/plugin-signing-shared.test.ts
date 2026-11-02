// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getStore, setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { separateFakeStore } from './shared-store-fake';

// Several replicas share one store (#1066). Each used to make its own
// signing key on first use, so a bundle signed on one replica failed to
// verify against the public key another replica handed out. Now they all
// use the one key in the store, even when they all start at once.

const GLOBAL_KEY = Symbol.for('bulwark.admin.pluginSigning');

let dir: string;
let store: ReturnType<typeof separateFakeStore>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-signing-shared-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  vi.stubEnv('PLUGIN_SIGNING_KEY_FILE', '');
  delete (globalThis as Record<symbol, unknown>)[GLOBAL_KEY];
  resetLocalStoreForTests();
  store = separateFakeStore(path.join(dir, 'store'));
  setStoreForTests(store);
});

afterEach(async () => {
  delete (globalThis as Record<symbol, unknown>)[GLOBAL_KEY];
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function moduleCopy() {
  vi.resetModules();
  return import('../plugin-signing');
}

const publicKeyOf = (pem: string) =>
  (createPublicKey(pem).export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');

describe('plugin signing key with a shared store', () => {
  it('gives every replica the same key when they all start at once', async () => {
    const replicas = [await moduleCopy(), await moduleCopy(), await moduleCopy()];
    const results = await Promise.all(replicas.map((replica, i) => {
      // Nothing shared in memory between them, like separate processes.
      delete (globalThis as Record<symbol, unknown>)[GLOBAL_KEY];
      return Promise.all([replica.signBytes(`payload ${i}`), replica.getPublicKeyBase64()]);
    }));

    const pem = await getStore().kv.get('plugin-signing-key');
    expect(pem).toContain('-----BEGIN PRIVATE KEY-----');
    for (const [i, [signature, publicKey]] of results.entries()) {
      expect(publicKey).toBe(publicKeyOf(pem!));
      expect(verify(null, Buffer.from(`payload ${i}`), createPublicKey(pem!), Buffer.from(signature, 'base64'))).toBe(true);
    }
    expect(existsSync(path.join(dir, 'config', 'plugin-signing.key'))).toBe(false);
  });

  it('still uses PLUGIN_SIGNING_KEY_FILE when it is set', async () => {
    const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const keyFile = path.join(dir, 'signing.pem');
    await writeFile(keyFile, pem);
    vi.stubEnv('PLUGIN_SIGNING_KEY_FILE', keyFile);
    const replica = await moduleCopy();
    expect(await replica.getPublicKeyBase64()).toBe(publicKeyOf(pem));
    expect(await getStore().kv.get('plugin-signing-key')).toBeNull();
  });

  it('refuses to sign on a replica whose key file differs from the others', async () => {
    // Replica A uses the key in the store.
    const a = await moduleCopy();
    const signature = await a.signBytes('payload');
    expect(signature).toBeTruthy();

    // Replica B was given a PLUGIN_SIGNING_KEY_FILE nobody else has.
    delete (globalThis as Record<symbol, unknown>)[GLOBAL_KEY];
    const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const keyFile = path.join(dir, 'other.pem');
    await writeFile(keyFile, other);
    vi.stubEnv('PLUGIN_SIGNING_KEY_FILE', keyFile);
    const b = await moduleCopy();
    const refused = await b.signBytes('payload').catch((e: unknown) => e as Error & { code?: string });
    expect(refused).toMatchObject({ name: 'StoreUnavailableError', code: 'plugin-signing-key-mismatch' });
    expect((refused as Error).message).toContain('PLUGIN_SIGNING_KEY_FILE');

    const { GET } = await import('@/app/api/plugin-signing-pubkey/route');
    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('different key');
  });

  it('fails while the store is down, and makes no key of its own', async () => {
    store.down = true;
    const replica = await moduleCopy();
    await expect(replica.signBytes('payload')).rejects.toMatchObject({ name: 'StoreUnavailableError' });
    expect(existsSync(path.join(dir, 'config', 'plugin-signing.key'))).toBe(false);

    store.down = false;
    await expect(replica.signBytes('payload')).resolves.toBeTruthy();
  });
});
