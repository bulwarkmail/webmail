import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  getPublicKeyBase64,
  invalidatePluginSigningCache,
  signBytes,
} from '../plugin-signing';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-plugin-signing-'));
  invalidatePluginSigningCache();
});

afterEach(async () => {
  invalidatePluginSigningCache();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

function privateKeyPem(type: 'ed25519' | 'rsa' = 'ed25519'): string {
  const privateKey = type === 'rsa'
    ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    : generateKeyPairSync('ed25519').privateKey;
  return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
}

describe('plugin signing key storage', () => {
  it('loads an external Ed25519 PKCS#8 key without touching it or the config directory', async () => {
    const keyPath = path.join(dir, 'secrets', 'plugin-signing.pem');
    const configDir = path.join(dir, 'immutable-config');
    await mkdir(path.dirname(keyPath));
    const pem = privateKeyPem();
    await writeFile(keyPath, pem, { mode: 0o400 });
    const before = await stat(keyPath);
    vi.stubEnv('PLUGIN_SIGNING_KEY_FILE', keyPath);
    vi.stubEnv('ADMIN_CONFIG_DIR', configDir);
    vi.stubEnv('ADMIN_CONFIG_READONLY', 'true');

    const payload = Buffer.from('external signing key');
    const signature = Buffer.from(await signBytes(payload), 'base64');
    const publicKey = createPublicKey(pem);

    expect(verify(null, payload, publicKey, signature)).toBe(true);
    expect(await readFile(keyPath, 'utf8')).toBe(pem);
    const after = await stat(keyPath);
    expect(after.mode).toBe(before.mode);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    await expect(access(configDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps loading an existing key from ADMIN_CONFIG_DIR when external path is unset', async () => {
    const configDir = path.join(dir, 'config');
    const pem = privateKeyPem();
    await mkdir(configDir);
    await writeFile(path.join(configDir, 'plugin-signing.key'), pem);
    vi.stubEnv('ADMIN_CONFIG_DIR', configDir);

    const expected = createPublicKey(pem).export({ type: 'spki', format: 'der' }) as Buffer;
    await expect(getPublicKeyBase64()).resolves.toBe(expected.subarray(-32).toString('base64'));
  });

  it('keeps generating plugin-signing.key when external path is unset', async () => {
    const configDir = path.join(dir, 'config');
    vi.stubEnv('ADMIN_CONFIG_DIR', configDir);

    await expect(signBytes('generated key')).resolves.toMatch(/^[A-Za-z0-9+/]{86}==$/);
    const generated = await readFile(path.join(configDir, 'plugin-signing.key'), 'utf8');
    expect(generated).toContain('-----BEGIN PRIVATE KEY-----');
  });

  it('reports a missing external key without falling back to generation', async () => {
    const keyPath = path.join(dir, 'missing.pem');
    const configDir = path.join(dir, 'config');
    vi.stubEnv('PLUGIN_SIGNING_KEY_FILE', keyPath);
    vi.stubEnv('ADMIN_CONFIG_DIR', configDir);

    await expect(signBytes('payload')).rejects.toThrow(
      'Cannot read plugin signing key from PLUGIN_SIGNING_KEY_FILE',
    );
    await expect(access(configDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports malformed external key data without exposing its contents', async () => {
    const keyPath = path.join(dir, 'malformed.pem');
    const secret = 'not-a-private-key-secret';
    await writeFile(keyPath, secret);
    vi.stubEnv('PLUGIN_SIGNING_KEY_FILE', keyPath);

    const error = await signBytes('payload').then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error).not.toBeNull();
    expect(error!.message).toContain('valid PEM PKCS#8 private key');
    expect(error!.message).not.toContain(secret);
  });

  it('reports an external private key of the wrong asymmetric type', async () => {
    const keyPath = path.join(dir, 'rsa.pem');
    await writeFile(keyPath, privateKeyPem('rsa'));
    vi.stubEnv('PLUGIN_SIGNING_KEY_FILE', keyPath);

    await expect(signBytes('payload')).rejects.toThrow(
      'PLUGIN_SIGNING_KEY_FILE has wrong key type (rsa); expected ed25519',
    );
  });
});
