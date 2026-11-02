// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setStoreForTests } from '@/lib/shared-store';
import { resetLocalStoreForTests } from '@/lib/shared-store/local';
import { separateFakeStore } from './shared-store-fake';

// Shared mode (#1066) keeps served bundles and their signatures in a
// per-replica cache keyed by the bundle hash. A signature read while
// another replica was halfway through an install belongs to other bytes;
// it must not stick to the cached bundle, or this replica serves the bundle
// with a signature that never verifies again.

let dir: string;
const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const pub = createPublicKey(pem);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const verifies = (code: string, sig: string | null) => !!sig && verify(null, Buffer.from(code), pub, Buffer.from(sig, 'base64'));

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-sig-cache-'));
  writeFileSync(path.join(dir, 'key.pem'), pem);
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  vi.stubEnv('PLUGIN_SIGNING_KEY_FILE', path.join(dir, 'key.pem'));
  resetLocalStoreForTests();
  setStoreForTests(separateFakeStore(path.join(dir, 'store')));
  for (const name of ['bulwark.admin.pluginSigning', 'bulwark.admin.bundleCache', 'bulwark.admin.pluginRegistry']) {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for(name)];
  }
  vi.resetModules();
});

afterEach(() => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('signatures in the bundle cache', () => {
  it('keeps only a signature that verifies for the cached bundle', async () => {
    const { getPluginBundle, getPluginSignature } = await import('../plugin-registry');
    const { pluginDocs } = await import('../extension-store');
    const { signBytes } = await import('../plugin-signing');
    const [v1, v2] = ['v1()', 'v2()'];
    await pluginDocs().put('demo.js', v1);
    await pluginDocs().put('demo.sig', await signBytes(v1));
    expect(await getPluginBundle('demo', sha(v1))).toBe(v1);

    // Another replica is halfway through installing v2.
    await pluginDocs().put('demo.sig', await signBytes(v2));
    expect(verifies(v1, await getPluginSignature('demo', v1, sha(v1)))).toBe(false);

    // Back to v1's signature: this replica serves it again.
    await pluginDocs().put('demo.sig', await signBytes(v1));
    expect(verifies(v1, await getPluginSignature('demo', v1, sha(v1)))).toBe(true);
  });

});
