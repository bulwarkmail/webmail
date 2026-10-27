/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

// config.json carries the session secret and the OAuth client secrets,
// admin.json the admin password hash, .setup-token the token that lets
// anyone finish the setup wizard. With the default umask they came out
// world-readable, so on a bind mount or a bare-metal install every local
// user could read the key behind every session cookie. They are written
// owner-only now, like the generated .session-secret.

// Hoisted so the dirs are set before any admin module loads.
const dirs = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const config = mkdtempSync(join(tmpdir(), 'bulwark-modes-'));
  process.env.ADMIN_CONFIG_DIR = config;
  process.env.ADMIN_STATE_DIR = join(config, 'state');
  return { config, state: join(config, 'state') };
});

const writeFile = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  writeFile.mockImplementation(actual.writeFile);
  return { ...actual, default: { ...actual, writeFile }, writeFile };
});

/** The mode the file at `target` (or its temp file) was created with. */
function modeOf(target: string): unknown {
  const call = writeFile.mock.calls.find(([file]) => file === target || file === `${target}.tmp`);
  expect(call, target).toBeDefined();
  const options = call![2];
  return typeof options === 'object' && options !== null ? (options as { mode?: number }).mode : undefined;
}

describe('files holding secrets are owner-only', () => {
  beforeEach(() => {
    writeFile.mockClear();
  });

  it('writes config.json with mode 0600', async () => {
    const { configManager } = await import('@/lib/admin/config-manager');
    await configManager.ensureLoaded();
    await configManager.setAdminConfig({ oauthClientSecret: 'client-secret' });
    expect(modeOf(path.join(dirs.config, 'config.json'))).toBe(0o600);
  });

  it('writes admin.json with mode 0600', async () => {
    const { setInitialAdminPassword } = await import('@/lib/admin/password');
    expect(await setInitialAdminPassword('correct horse battery', { allowOverwrite: true })).toBe(true);
    expect(modeOf(path.join(dirs.config, 'admin.json'))).toBe(0o600);
  });

  it('writes the setup token with mode 0600', async () => {
    const { ensureSetupToken } = await import('@/lib/setup/token');
    await ensureSetupToken();
    expect(modeOf(path.join(dirs.state, '.setup-token'))).toBe(0o600);
  });
});
