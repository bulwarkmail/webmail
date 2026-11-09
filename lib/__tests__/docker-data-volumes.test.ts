import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfigDir, getStateDir } from '@/lib/admin/paths';
import { getSettingsDir } from '@/lib/settings-sync';
import { getDir as getTelemetryDir } from '@/lib/telemetry/state';
import { vaultDir } from '@/lib/plugin-secrets/vault';

// Every folder the server keeps state in by default must be a volume in the
// shipped docker-compose.yml, or it is lost when the container is recreated,
// and must exist in the image, or Docker creates the empty volume owned by
// root and the app can't write to it. Plugin secrets were missing from both.

const ROOT = path.resolve(__dirname, '..', '..');
const ENV_KEYS = [
  'ADMIN_CONFIG_DIR', 'ADMIN_DATA_DIR', 'ADMIN_STATE_DIR', 'SETTINGS_DATA_DIR',
  'TELEMETRY_DATA_DIR', 'PLUGIN_SECRETS_DIR',
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  vi.spyOn(process, 'cwd').mockReturnValue('/app');
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

/** The default state folders inside the container, as the server resolves them. */
function defaultStateDirs(): string[] {
  return [getConfigDir(), getStateDir(), getSettingsDir(), getTelemetryDir(), vaultDir()]
    .map((dir) => path.resolve(dir).replace(/\\/g, '/').replace(/^[A-Za-z]:/, ''));
}

describe('docker data volumes', () => {
  it('resolves the plugin secrets folder inside /app/data', () => {
    expect(defaultStateDirs()).toContain('/app/data/plugin-secrets');
  });

  it('mounts a volume on every default state folder in docker-compose.yml', () => {
    const compose = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
    const mounted = [...compose.matchAll(/^\s*-\s*[\w.-]+:(\/app\/[\w/.-]+?)(?::ro)?\s*$/gm)].map((m) => m[1]);
    for (const dir of defaultStateDirs()) expect(mounted).toContain(dir);
  });

  it('declares every named volume the service uses', () => {
    const compose = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
    const used = [...compose.matchAll(/^\s*-\s*([\w-]+):\/app\//gm)].map((m) => m[1]);
    const declared = compose.split(/^volumes:\s*$/m)[1] ?? '';
    for (const name of used) expect(declared).toMatch(new RegExp(`^\\s+${name}:`, 'm'));
  });

  it('creates every default state folder in the image', () => {
    // Join backslash-continued lines so a wrapped mkdir is read whole.
    const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8').replace(/\\\r?\n\s*/g, ' ');
    const created = dockerfile.match(/RUN mkdir -p ([^&\n]+)/)?.[1].trim().split(/\s+/) ?? [];
    for (const dir of defaultStateDirs()) expect(created).toContain(dir);
  });
});
