/**
 * @vitest-environment node
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Next bundles lib/admin/password.ts once per entry: the sign-in route and
// the change-password route each have their own copy in one process. Each
// copy used to keep its own cache of admin.json, so after a password change
// the sign-in route went on accepting the old password until a restart.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-admin-copies-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
  vi.stubEnv('ADMIN_STATE_DIR', path.join(dir, 'state'));
  // Every copy made below starts from nothing, as after a restart.
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('bulwark.admin.password')];
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** A module copy of its own, as another bundle entry has. */
async function moduleCopy() {
  vi.resetModules();
  return import('@/lib/admin/password');
}

describe('admin password across module copies', () => {
  it('refuses the old password in every copy after a change in one', async () => {
    const settings = await moduleCopy();
    expect(await settings.setInitialAdminPassword('old-password-1')).toBe(true);
    const signIn = await moduleCopy();
    expect(await signIn.verifyAdminPassword('old-password-1')).toBe(true);
    const generation = await signIn.getAdminSessionGeneration();

    expect(await settings.changeAdminPassword('old-password-1', 'new-password-2')).toBe(true);

    expect(await signIn.verifyAdminPassword('old-password-1')).toBe(false);
    expect(await signIn.verifyAdminPassword('new-password-2')).toBe(true);
    expect(await signIn.getAdminSessionGeneration()).toBe(generation + 1);
  });

  it('sees a sign-out made through another copy', async () => {
    const signIn = await moduleCopy();
    expect(await signIn.isAdminSessionRevoked('sid-1')).toBe(false);
    const signOut = await moduleCopy();
    await signOut.revokeAdminSession('sid-1', Math.floor(Date.now() / 1000) + 3600);
    expect(await signIn.isAdminSessionRevoked('sid-1')).toBe(true);
  });
});
