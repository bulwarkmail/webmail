// @vitest-environment node
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStoreForTests, getStore } from '../index';
import { resetLocalStoreForTests } from '../local';
import { importLocalData } from '../import';
import { exportSharedData } from '../export';
import { separateFakeStore } from '@/lib/admin/__tests__/shared-store-fake';
import { SHARED_SECRET_KEY } from '@/lib/auth/session-secret';

/**
 * Moving a single-instance install onto the shared store and back (#1066):
 * the import copies every file, a second run writes nothing and touches no
 * file, and the export writes the same bytes into an empty install.
 */

let root: string;

function install(name: string) {
  const base = path.join(root, name);
  const dirs = {
    ADMIN_CONFIG_DIR: path.join(base, 'admin'),
    ADMIN_STATE_DIR: path.join(base, 'admin-state'),
    SETTINGS_DATA_DIR: path.join(base, 'settings'),
    PLUGIN_SECRETS_DIR: path.join(base, 'plugin-secrets'),
    TELEMETRY_DATA_DIR: path.join(base, 'telemetry'),
    VERSION_CHECK_DATA_DIR: path.join(base, 'version-check'),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  for (const [key, dir] of Object.entries(dirs)) vi.stubEnv(key, dir);
  return { base, ...dirs };
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out[path.relative(dir, full).split(path.sep).join('/')] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

const hex = () => randomBytes(32).toString('hex');

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bulwark-move-'));
  resetLocalStoreForTests();
  setStoreForTests(separateFakeStore(path.join(root, 'store')));
});

afterEach(() => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('moving an install onto the shared store and back', () => {
  it('imports every file once, changes no local file, and exports the same bytes', async () => {
    const a = install('a');
    writeFileSync(path.join(a.ADMIN_CONFIG_DIR, 'config.json'), JSON.stringify({ appName: 'Moved', setupComplete: true }, null, 2));
    writeFileSync(path.join(a.ADMIN_CONFIG_DIR, 'policy.json'), JSON.stringify({ restrictions: { density: { locked: true } } }, null, 2));
    writeFileSync(path.join(a.ADMIN_CONFIG_DIR, 'admin.json'), JSON.stringify({ passwordHash: '$scrypt$x' }, null, 2));
    writeFileSync(path.join(a.ADMIN_STATE_DIR, 'admin-state.json'), JSON.stringify({ sessionGeneration: 3 }, null, 2));
    writeFileSync(path.join(a.ADMIN_STATE_DIR, 'audit.log'), ['{"ts":"1","action":"one"}', '{"ts":"2","action":"two"}'].join('\n') + '\n');
    const settingsFile = `${hex()}.enc`;
    writeFileSync(path.join(a.SETTINGS_DATA_DIR, settingsFile), randomBytes(200));
    const vaultFile = `${hex()}.enc`;
    writeFileSync(path.join(a.PLUGIN_SECRETS_DIR, vaultFile), randomBytes(120).toString('base64'));
    writeFileSync(path.join(a.TELEMETRY_DATA_DIR, 'state.json'), JSON.stringify({ consent: 'on' }, null, 2));
    writeFileSync(path.join(a.VERSION_CHECK_DATA_DIR, 'state.json'), JSON.stringify({ lastCheckedAt: '2026-11-01' }, null, 2));
    mkdirSync(path.join(a.ADMIN_CONFIG_DIR, 'plugins'));
    writeFileSync(path.join(a.ADMIN_CONFIG_DIR, 'plugins', 'registry.json'), JSON.stringify({ plugins: [{ id: 'demo' }] }, null, 2));
    writeFileSync(path.join(a.ADMIN_CONFIG_DIR, 'plugins', 'demo.js'), 'module.exports = {}');
    mkdirSync(path.join(a.ADMIN_CONFIG_DIR, 'branding'));
    writeFileSync(path.join(a.ADMIN_CONFIG_DIR, 'branding', 'faviconUrl.png'), randomBytes(64));
    const signingKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    writeFileSync(path.join(a.ADMIN_CONFIG_DIR, 'plugin-signing.key'), signingKey);
    const before = snapshot(a.base);

    const first = await importLocalData();
    expect(first.imported).toMatchObject({
      'admin-config': 3,
      'admin-state': 1,
      audit: 2,
      settings: 1,
      'plugin-secrets': 1,
      telemetry: 1,
      'version-check': 1,
      plugins: 2,
      branding: 1,
      'plugin-signing-key': 1,
    });
    const second = await importLocalData();
    expect(Object.values(second.imported).every((n) => n === 0), JSON.stringify(second.imported)).toBe(true);
    expect(snapshot(a.base)).toEqual(before);

    // The generated secret travels through kv (the boot imports it).
    await getStore().kv.set(SHARED_SECRET_KEY, 'generated-secret-generated-secret-xx');

    const b = install('b');
    const written = await exportSharedData();
    expect(written['settings']).toBe(1);
    expect(written).toMatchObject({ plugins: 2, branding: 1, 'plugin-signing-key': 1 });
    const after = snapshot(b.base);
    for (const [file, digest] of Object.entries(before)) {
      expect(after[file], `${file} exported`).toBe(digest);
    }
    expect(readFileSync(path.join(b.ADMIN_STATE_DIR, '.session-secret'), 'utf8')).toBe('generated-secret-generated-secret-xx');
  });
});
