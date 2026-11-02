import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-plugin-registry-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
  vi.resetModules();
  // The signing key is cached on globalThis (one per process, not per module copy).
  (await import('../plugin-signing')).invalidatePluginSigningCache();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function verifies(code: string, signature: string): Promise<boolean> {
  const pem = await readFile(path.join(dir, 'plugin-signing.key'), 'utf-8');
  const publicKey = createPublicKey(pem);
  return verify(null, Buffer.from(code, 'utf-8'), publicKey, Buffer.from(signature, 'base64'));
}

const PLUGIN = {
  id: 'signed-demo', name: 'S', version: '1.0.0', author: 'a', description: '', type: 'hook',
  permissions: [], entrypoint: 'index.js', enabled: true, installedAt: 'x', updatedAt: 'x',
};

describe('plugin bundle signatures', () => {
  it('signs the bundle when it is installed', async () => {
    const registry = await import('../plugin-registry');
    await registry.savePlugin(PLUGIN, 'module.exports = {}');

    const signature = await registry.getPluginSignature('signed-demo', 'module.exports = {}');

    expect(signature).toBeTruthy();
    expect(await verifies('module.exports = {}', signature!)).toBe(true);
  });

  it('keeps the install-time signature when the file on disk changes', async () => {
    // Signing at serve time signed whatever was on disk, so a swapped
    // bundle still came with a valid signature.
    const registry = await import('../plugin-registry');
    await registry.savePlugin(PLUGIN, 'module.exports = {}');
    await writeFile(path.join(dir, 'plugins', 'signed-demo.js'), 'stealEverything()', 'utf-8');

    const swapped = (await registry.getPluginBundle('signed-demo'))!;
    const signature = await registry.getPluginSignature('signed-demo', swapped);

    expect(await verifies(swapped, signature!)).toBe(false);
  });
});

describe('registry writes at the same time', () => {
  it('keeps every plugin when several are installed and switched at once', async () => {
    // Concurrent installs shared one .tmp file and read the same old list:
    // some answered 500, others were silently dropped from the registry.
    const registry = await import('../plugin-registry');
    const ids = Array.from({ length: 8 }, (_, i) => `concurrent-${i}`);

    await Promise.all(ids.flatMap((id) => [
      registry.savePlugin({ ...PLUGIN, id }, `module.exports = { id: "${id}" }`),
      registry.updatePluginMeta(id, { forceEnabled: true }),
    ]));

    const saved = (await registry.getPluginRegistry()).plugins;
    expect(saved.map((p) => p.id).sort()).toEqual([...ids].sort());
    expect(saved.every((p) => p.forceEnabled === true)).toBe(true);
  });
});
