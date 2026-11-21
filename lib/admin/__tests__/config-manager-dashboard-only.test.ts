// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configManager } from '../config-manager';
import { CONFIG_ENV_MAP } from '../types';

// A key without an environment variable (adminAccounts) is set only in the
// dashboard: it reads the admin value or the default, whatever is in the
// environment.

let dir: string;
const entry = { serverUrl: 'https://mail.example.com', account: 'alice@example.com' };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bw-config-no-env-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
  for (const name of ['ADMIN_ACCOUNTS', 'adminAccounts', 'undefined', 'BULWARK_ADMIN_ACCOUNTS']) {
    vi.stubEnv(name, JSON.stringify([{ serverUrl: 'https://evil.example.com', account: 'mallory' }]));
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('a config key without an environment variable', () => {
  it('has none in the map', () => {
    expect(CONFIG_ENV_MAP.adminAccounts).toBeDefined();
    expect(CONFIG_ENV_MAP.adminAccounts.envVar).toBeUndefined();
    expect(CONFIG_ENV_MAP.adminAccounts.defaultValue).toEqual([]);
  });

  it('reads the default when the admin has not set it', async () => {
    await writeFile(path.join(dir, 'config.json'), '{}', 'utf-8');
    await configManager.load();
    expect(configManager.get('adminAccounts')).toEqual([]);
    expect(configManager.getAllWithSources().adminAccounts).toEqual({ value: [], source: 'default' });
  });

  it('reads the admin value when set', async () => {
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ adminAccounts: [entry] }), 'utf-8');
    await configManager.load();
    expect(configManager.get('adminAccounts')).toEqual([entry]);
    expect(configManager.getAllWithSources().adminAccounts).toEqual({ value: [entry], source: 'admin' });
  });
});
