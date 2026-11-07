// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const session = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
vi.mock('@/lib/stalwart/jmap-api', () => ({ fetchJmapSession: vi.fn(async () => session.value) }));
vi.mock('@/lib/impersonation/app-password', () => ({
  createAppPassword: vi.fn(async () => ({ id: 'ap1', secret: 'made' })),
  deleteAppPassword: vi.fn(async () => { throw new Error('not found'); }),
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { createAppPassword, deleteAppPassword } from '@/lib/impersonation/app-password';
import { makePluginAppPassword, revokePluginAppPassword } from '../plugin-secrets/app-password';

const SIGNED_IN = { serverUrl: 'https://mail.example.org', authHeader: 'Bearer token', accountName: 'alice@b.example', trusted: true };

beforeEach(() => {
  session.value = null;
  vi.mocked(createAppPassword).mockClear();
});

describe('plugin app passwords', () => {
  it("are made with the user's own session and stored with the account's login name", async () => {
    session.value = { username: 'alice@example.org' };

    expect(await makePluginAppPassword(SIGNED_IN, 'Plugin: Team')).toEqual({ id: 'ap1', secret: 'made', username: 'alice@example.org' });
    expect(createAppPassword).toHaveBeenCalledWith({
      serverUrl: 'https://mail.example.org', authHeader: 'Bearer token', description: 'Plugin: Team', trusted: true,
    });
  });

  it('fall back to the account the sign-in resolved to when the session names none', async () => {
    expect((await makePluginAppPassword(SIGNED_IN, 'Plugin: Team')).username).toBe('alice@b.example');
  });

  it('are revoked on a best-effort basis', async () => {
    await expect(revokePluginAppPassword(SIGNED_IN, 'ap1')).resolves.toBeUndefined();
    expect(deleteAppPassword).toHaveBeenCalledWith({ serverUrl: 'https://mail.example.org', authHeader: 'Bearer token', id: 'ap1', trusted: true });
  });
});
