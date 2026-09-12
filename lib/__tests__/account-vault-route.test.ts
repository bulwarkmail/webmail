// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ enabled: true, oauthOnly: false, context: null as unknown,
  load: vi.fn(), save: vi.fn(), verify: vi.fn() }));
vi.mock('@/lib/admin/config-manager', () => ({ configManager: {
  ensureLoaded: async () => {}, get: (key: string, fallback: unknown) =>
    key === 'settingsSyncEnabled' ? mocks.enabled : key === 'oauthOnly' ? mocks.oauthOnly : fallback,
} }));
vi.mock('@/lib/auth/session-secret', () => ({ hasSessionSecret: () => true }));
vi.mock('next/headers', () => ({ cookies: async () => ({}) }));
vi.mock('@/lib/stalwart/auth-context', () => ({ readStalwartAuthContextFromStore: (_: unknown, slot: number) => slot === 2 ? mocks.context : null }));
vi.mock('@/lib/account-vault-storage', () => ({ loadVault: mocks.load, saveVault: mocks.save, VaultConflict: class extends Error {} }));
vi.mock('@/lib/auth/verify-jmap-auth', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/auth/verify-jmap-auth')>(), verifyJmapAuth: mocks.verify,
}));
import { GET, PUT } from '@/app/api/account-vault/route';
const owner = { username: 'owner@example.com', serverUrl: 'https://mail.example.com' };
const envelope = { version: 1, iterations: 600000, salt: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==' };
function request(method: string, body?: unknown, extra: Record<string, string> = {}) {
  return new NextRequest('https://webmail.example.com/api/account-vault', { method,
    headers: { 'x-vault-username': owner.username, 'x-vault-server': owner.serverUrl, 'Content-Type': 'application/json', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.enabled = true; mocks.oauthOnly = false; mocks.context = null;
  mocks.load.mockResolvedValue({ revision: 'a'.repeat(64), envelope });
  mocks.verify.mockResolvedValue(owner.serverUrl); mocks.save.mockResolvedValue({ revision: 'b'.repeat(64), envelope });
});
describe('account archive API', () => {
  it('allows fetching ciphertext before mail login, with no caching', async () => {
    const response = await GET(request('GET'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await response.json()).vault.envelope).toEqual(envelope);
    expect(mocks.verify).not.toHaveBeenCalled();
  });
  it('honors the feature gate and OAuth-only policy', async () => {
    mocks.enabled = false;
    expect((await GET(request('GET'))).status).toBe(404);
    mocks.enabled = true; mocks.oauthOnly = true;
    expect((await PUT(request('PUT', { envelope, revision: null }))).status).toBe(404);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('rejects writes without the owner session or with forged/stale credentials', async () => {
    expect((await PUT(request('PUT', { envelope, revision: null }))).status).toBe(403);
    mocks.context = { ...owner, authHeader: 'Basic ' + Buffer.from('someone-else:secret').toString('base64') };
    expect((await PUT(request('PUT', { envelope, revision: null }))).status).toBe(403);
    mocks.context = { ...owner, authHeader: 'Basic ' + Buffer.from(owner.username + ':secret').toString('base64') };
    mocks.verify.mockRejectedValue(new Error('401'));
    expect((await PUT(request('PUT', { envelope, revision: null }))).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('verifies the owner on any slot and strips fields outside the encrypted envelope', async () => {
    mocks.context = { ...owner, authHeader: 'Basic ' + Buffer.from(owner.username + ':secret').toString('base64') };
    const response = await PUT(request('PUT', { envelope: { ...envelope, password: 'forbidden' }, revision: null, password: 'forbidden' }));
    expect(response.status).toBe(200);
    expect(mocks.verify).toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalledWith(owner, envelope, null);
    expect((await PUT(request('PUT', { envelope, revision: null }, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    expect((await PUT(request('PUT', { envelope, revision: 'invalid' }))).status).toBe(400);
    expect((await PUT(request('PUT', { envelope, revision: null, padding: 'x'.repeat(270000) }))).status).toBe(413);
  });
});
