/**
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStoreForTests } from '../index';
import { resetLocalStoreForTests } from '../local';
import { separateDiskStore, type SeparateDiskStore } from '@/lib/__tests__/helpers/separate-disk-store';
import { steps } from '../import/data';
import { SETTINGS_COLLECTION } from '@/lib/settings-sync';
import { VAULT_COLLECTION } from '@/lib/plugin-secrets/vault';
import { ARCHIVE_COLLECTION } from '@/lib/account-archive-storage';
import { TELEMETRY_COLLECTION } from '@/lib/telemetry/state';
import { VERSION_CHECK_COLLECTION } from '@/lib/version-check/state';

// An existing single instance's settings, plugin credentials, archives,
// telemetry and update-check state go into an empty shared store once, as
// they are; the local files stay untouched.

let data: string;
let store: SeparateDiskStore;

const hash = (c: string) => c.repeat(64);

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[path.relative(dir, full)] = readFileSync(full).toString('base64');
    }
  };
  walk(dir);
  return out;
}

beforeEach(() => {
  data = mkdtempSync(path.join(tmpdir(), 'bw-import-data-'));
  vi.stubEnv('SETTINGS_DATA_DIR', path.join(data, 'settings'));
  vi.stubEnv('PLUGIN_SECRETS_DIR', path.join(data, 'plugin-secrets'));
  vi.stubEnv('TELEMETRY_DATA_DIR', path.join(data, 'telemetry'));
  vi.stubEnv('VERSION_CHECK_DATA_DIR', path.join(data, 'version-check'));
  for (const dir of ['settings/account-archives', 'plugin-secrets', 'telemetry', 'version-check']) {
    mkdirSync(path.join(data, dir), { recursive: true });
  }
  writeFileSync(path.join(data, 'settings', `${hash('a')}.enc`), Buffer.from([1, 2, 3, 4]));
  writeFileSync(path.join(data, 'settings', `${hash('b')}.enc`), Buffer.from([5, 6]));
  writeFileSync(path.join(data, 'settings', `${hash('c')}.enc.tmp`), 'half written');
  writeFileSync(path.join(data, 'settings', 'account-archives', `${hash('d')}.json`), '{"version":1}');
  writeFileSync(path.join(data, 'plugin-secrets', `${hash('e')}.enc`), 'c2VhbGVk');
  writeFileSync(path.join(data, 'telemetry', 'state.json'), '{"consent":"on"}');
  writeFileSync(path.join(data, 'telemetry', '.telemetry-id'), '0b9f1f3e-8b8e-4c4b-9a35-3c1b8a7a1e11');
  writeFileSync(path.join(data, 'telemetry', 'logins.json'), '{"records":[]}');
  writeFileSync(path.join(data, 'version-check', 'state.json'), '{"status":null}');
  store = separateDiskStore();
  setStoreForTests(store);
});

afterEach(() => {
  setStoreForTests(null);
  resetLocalStoreForTests();
  vi.unstubAllEnvs();
  store.cleanup();
  rmSync(data, { recursive: true, force: true });
});

async function runAll(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const step of steps) counts[step.name] = await step.run();
  return counts;
}

describe('importing part data', () => {
  it('copies every document once and leaves the local files alone', async () => {
    const before = snapshot(data);

    expect(await runAll()).toEqual({
      settings: 2, 'plugin-secrets': 1, 'account-archives': 1, telemetry: 3, 'version-check': 1,
    });
    expect(await runAll()).toEqual({
      settings: 0, 'plugin-secrets': 0, 'account-archives': 0, telemetry: 0, 'version-check': 0,
    });
    expect(snapshot(data)).toEqual(before);

    const settings = store.collection('settings', SETTINGS_COLLECTION);
    expect(await settings.list()).toEqual([hash('a'), hash('b')]);
    expect((await settings.get(hash('a')))?.data).toEqual(Buffer.from([1, 2, 3, 4]));
    expect((await store.collection('plugin-secrets', VAULT_COLLECTION).get(hash('e')))?.data.toString()).toBe('c2VhbGVk');
    expect((await store.collection('account-archives', ARCHIVE_COLLECTION).get(hash('d')))?.data.toString()).toBe('{"version":1}');
    expect((await store.collection('telemetry', TELEMETRY_COLLECTION).list()).sort()).toEqual(['.telemetry-id', 'logins.json', 'state.json']);
    expect((await store.collection('version-check', VERSION_CHECK_COLLECTION).get('state.json'))?.data.toString()).toBe('{"status":null}');
  });

  it('keeps what the store already holds', async () => {
    const settings = store.collection('settings', SETTINGS_COLLECTION);
    await settings.put(hash('a'), Buffer.from([9]));
    expect((await runAll()).settings).toBe(1);
    expect((await settings.get(hash('a')))?.data).toEqual(Buffer.from([9]));
  });
});
