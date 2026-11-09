/**
 * @vitest-environment node
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Moving a single-instance install to a shared store (#1066): plugins and
// themes with their bundles, signatures and history, plugin config,
// approvals and their packages, the signing key, the keyring dates and the
// branding uploads come along; a second run writes nothing, and the local
// files stay as they were.

import { exportSteps, steps } from '../import/ext';
import { importLocalData } from '../import';
import { exportSharedData } from '../export';
import { getStore, setStoreForTests } from '../index';
import { resetLocalStoreForTests } from '../local';
import { separateFakeStore } from '@/lib/admin/__tests__/shared-store-fake';
import {
  brandingDocs,
  directoryKeyringDocs,
  pluginApprovalDocs,
  pluginConfigDocs,
  pluginDocs,
  themeDocs,
} from '@/lib/admin/extension-store';

let dir: string;
const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

const FILES: Record<string, string | Buffer> = {
  'config/plugins/registry.json': JSON.stringify({ plugins: [{ id: 'demo', version: '1.1.0' }] }, null, 2),
  'config/plugins/demo.js': 'v2()',
  'config/plugins/demo.sig': 'c2ln',
  'config/plugins/history/demo/1.0.0/entry.json': JSON.stringify({ version: '1.0.0' }),
  'config/plugins/history/demo/1.0.0/bundle.js': 'v1()',
  'config/themes/registry.json': JSON.stringify({ themes: [{ id: 'dark' }] }, null, 2),
  'config/themes/dark.css': ':root{}',
  'config/themes/dark.skin.css': '.skin{}',
  'config/plugin-config/demo.json': JSON.stringify({ apiKey: 'k' }, null, 2),
  'config/plugin-approvals.json': JSON.stringify({ entries: [] }, null, 2),
  [`config/plugin-approvals/upload-${'a'.repeat(64)}.zip`]: Buffer.from([0x50, 0x4b, 3, 4]),
  'config/branding/faviconUrl.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  'config/plugin-signing.key': pem,
  'config/config.json': JSON.stringify({ appName: 'not part of ext' }),
  'state/directory-keyrings.json': JSON.stringify({ 'https://extensions.bulwarkmail.org': '2026-10-20T00:00:00.000Z' }),
};

/** Every local file with its bytes and mtime, to show the import changed none. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = `${createHash('sha256').update(readFileSync(full)).digest('hex')} ${statSync(full).mtimeMs}`;
    }
  };
  walk(path.join(dir, 'config'));
  walk(path.join(dir, 'state'));
  return out;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-import-ext-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
  vi.stubEnv('PLUGIN_SIGNING_KEY_FILE', '');
  for (const [file, content] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  resetLocalStoreForTests();
  setStoreForTests(separateFakeStore(path.join(dir, 'store')));
});

afterEach(() => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const text = async (docs: { get(id: string): Promise<{ data: Buffer } | null> }, id: string) => (await docs.get(id))?.data.toString('utf-8');

describe('importing plugins, themes and branding into the shared store', () => {
  it('copies every item once and leaves the local files alone', async () => {
    const before = snapshot();
    const first = await importLocalData(steps);
    expect(first.imported).toEqual({
      plugins: 5,
      themes: 3,
      'plugin-config': 1,
      'plugin-approvals': 2,
      branding: 1,
      'directory-keyrings': 1,
      'plugin-signing-key': 1,
    });

    expect(await text(pluginDocs(), 'demo.js')).toBe('v2()');
    expect(await text(pluginDocs(), 'history/demo/1.0.0/bundle.js')).toBe('v1()');
    expect(await text(themeDocs(), 'dark.skin.css')).toBe('.skin{}');
    expect(JSON.parse((await text(pluginConfigDocs(), 'demo.json'))!)).toEqual({ apiKey: 'k' });
    expect((await pluginApprovalDocs().get(`plugin-approvals/upload-${'a'.repeat(64)}.zip`))?.data).toEqual(Buffer.from([0x50, 0x4b, 3, 4]));
    expect((await brandingDocs().get('faviconUrl.png'))?.data).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(await text(directoryKeyringDocs(), 'directory-keyrings.json')).toContain('2026-10-20');
    expect(await getStore().kv.get('plugin-signing-key')).toBe(pem);
    // Nothing outside this part came along.
    expect(await pluginApprovalDocs().get('config.json')).toBeNull();

    const second = await importLocalData(steps);
    expect(Object.values(second.imported).every((n) => n === 0)).toBe(true);
    expect(snapshot()).toEqual(before);
  });

  it('writes the same files back into an empty install on export', async () => {
    const before = snapshot();
    await importLocalData(steps);
    // A fresh volume for the instance that goes back to local mode.
    rmSync(path.join(dir, 'config'), { recursive: true, force: true });
    rmSync(path.join(dir, 'state'), { recursive: true, force: true });
    const written = await exportSharedData(exportSteps);
    expect(written).toMatchObject({ plugins: 5, themes: 3, branding: 1, 'plugin-signing-key': 1, 'directory-keyrings': 1 });

    const bytesOnly = (snap: Record<string, string>) =>
      Object.fromEntries(Object.entries(snap).filter(([f]) => !f.endsWith('config.json')).map(([f, v]) => [f, v.split(' ')[0]]));
    expect(bytesOnly(snapshot())).toEqual(bytesOnly(before));
    if (process.platform !== 'win32') {
      expect(statSync(path.join(dir, 'state', 'directory-keyrings.json')).mode & 0o777).toBe(0o600);
      expect(statSync(path.join(dir, 'config', 'plugin-signing.key')).mode & 0o777).toBe(0o600);
    }
  });

  it('removes on export the local files of this part the store no longer holds, and nothing else', async () => {
    await importLocalData(steps);
    // Left on the volume from before: an uninstalled plugin's config (may
    // hold secrets), a stale signature, a pruned kept version, an old package.
    const stale = [
      'config/plugin-config/gone-plugin.json',
      'config/plugins/gone-plugin.sig',
      'config/plugins/history/demo/0.9.0/entry.json',
      `config/plugin-approvals/gone-plugin-${'b'.repeat(64)}.zip`,
      'config/branding/appLogoDarkUrl.svg',
    ];
    for (const file of stale) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), 'old');
    }
    writeFileSync(path.join(dir, 'config', 'unrelated.txt'), 'mine');

    await exportSharedData(exportSteps);
    for (const file of stale) expect(existsSync(path.join(dir, file)), file).toBe(false);
    expect(readFileSync(path.join(dir, 'config', 'unrelated.txt'), 'utf-8')).toBe('mine');
    expect(readFileSync(path.join(dir, 'config', 'config.json'), 'utf-8')).toContain('not part of ext');
    expect(readFileSync(path.join(dir, 'config', 'plugins', 'demo.js'), 'utf-8')).toBe('v2()');
  });

  it('keeps what the store already holds', async () => {
    await pluginDocs().put('demo.js', 'already shared()');
    await getStore().kv.set('plugin-signing-key', 'stored key');
    await importLocalData(steps);
    expect(await text(pluginDocs(), 'demo.js')).toBe('already shared()');
    expect(await getStore().kv.get('plugin-signing-key')).toBe('stored key');
  });
});
