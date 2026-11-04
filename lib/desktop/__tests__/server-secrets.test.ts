// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The desktop app's server gets its secrets by message, so they stay out of its
 * environment block. No other build looks there.
 */

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { get: (_key: string, fallback: unknown) => fallback },
}));
vi.mock('@/lib/shared-store', () => ({ isSharedMode: () => false, getStore: () => ({}) }));
vi.mock('@/lib/admin/paths', () => ({ ensureStateDir: async () => {}, getStatePath: () => 'C:/nowhere/.session-secret' }));

const KEY = Symbol.for('bulwark.desktop.serverSecrets');
const holder = globalThis as unknown as Record<symbol, unknown>;
const FROM_SHELL = 'from-the-shell-from-the-shell-from-the-shell';

async function sessionSecret() {
  vi.resetModules();
  return (await import('@/lib/auth/session-secret')).getSessionSecret();
}

beforeEach(() => {
  holder[KEY] = { sessionSecret: FROM_SHELL, adminPassword: 'admin-from-the-shell' };
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete holder[KEY];
});

describe('the session secret', () => {
  it('comes from the shell in the desktop build, with nothing in the environment', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    vi.stubEnv('SESSION_SECRET', '');
    expect(await sessionSecret()).toBe(FROM_SHELL);
  });

  it('never from there in a server build', async () => {
    vi.stubEnv('SESSION_SECRET', '');
    expect(await sessionSecret()).toBe('');
    vi.stubEnv('SESSION_SECRET', 'from-the-environment');
    expect(await sessionSecret()).toBe('from-the-environment');
  });
});

describe('the admin password', () => {
  it('is only readable from the shell in the desktop build', async () => {
    const { desktopServerSecret } = await import('../server-secrets');
    expect(desktopServerSecret('adminPassword')).toBe('');
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    expect(desktopServerSecret('adminPassword')).toBe('admin-from-the-shell');
    delete holder[KEY];
    expect(desktopServerSecret('adminPassword')).toBe('');
  });
});
