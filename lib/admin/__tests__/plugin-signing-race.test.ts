// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Next evaluates plugin-signing.ts once per bundle entry (three copies in
// the build), and a second process can share the config dir. Whoever makes
// the key first must be the only one: before, each writer generated its
// own key and the last write won, so the signatures made with the other
// key stopped verifying.

const GLOBAL_KEY = Symbol.for('bulwark.admin.pluginSigning');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-signing-race-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
  vi.stubEnv('PLUGIN_SIGNING_KEY_FILE', '');
  delete (globalThis as Record<symbol, unknown>)[GLOBAL_KEY];
});

afterEach(async () => {
  delete (globalThis as Record<symbol, unknown>)[GLOBAL_KEY];
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

/** A fresh copy of the module, as another bundle entry has. */
async function moduleCopy() {
  vi.resetModules();
  return import('../plugin-signing');
}

async function verifiesWithStoredKey(payload: string, signature: string): Promise<boolean> {
  const pem = await readFile(path.join(dir, 'plugin-signing.key'), 'utf-8');
  return verify(null, Buffer.from(payload), createPublicKey(pem), Buffer.from(signature, 'base64'));
}

describe('plugin signing key created by several writers at once', () => {
  it('keeps one key that every module copy signs with, also after a rotation', async () => {
    const copies = [await moduleCopy(), await moduleCopy(), await moduleCopy()];
    const signatures = await Promise.all(copies.map((copy, i) => copy.signBytes(`payload ${i}`)));
    for (const [i, signature] of signatures.entries()) {
      expect(await verifiesWithStoredKey(`payload ${i}`, signature)).toBe(true);
    }

    // The operator replaces the key; one copy is told, all of them use it.
    const { generateKeyPairSync } = await import('node:crypto');
    const { writeFile } = await import('node:fs/promises');
    const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    await writeFile(path.join(dir, 'plugin-signing.key'), pem);
    copies[0].invalidatePluginSigningCache();
    for (const [i, copy] of copies.entries()) {
      expect(await verifiesWithStoredKey(`rotated ${i}`, await copy.signBytes(`rotated ${i}`))).toBe(true);
    }
  });

  it('keeps the first key when another writer (another process) creates it at the same moment', async () => {
    const copies = [await moduleCopy(), await moduleCopy(), await moduleCopy(), await moduleCopy()];
    for (let round = 0; round < 5; round++) {
      await rm(path.join(dir, 'plugin-signing.key'), { force: true });
      const writers = copies.map((copy, i) => {
        // Each writer starts with nothing loaded and shares nothing in
        // memory with the others, like a separate process.
        delete (globalThis as Record<symbol, unknown>)[GLOBAL_KEY];
        copy.invalidatePluginSigningCache();
        return copy.signBytes(`round ${round} writer ${i}`);
      });
      delete (globalThis as Record<symbol, unknown>)[GLOBAL_KEY];
      const signatures = await Promise.all(writers);
      for (const [i, signature] of signatures.entries()) {
        expect(await verifiesWithStoredKey(`round ${round} writer ${i}`, signature)).toBe(true);
      }
    }
  });
});
