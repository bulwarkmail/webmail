// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ enabled: true, oauthOnly: false, context: null as unknown,
  list: vi.fn(), save: vi.fn(), remove: vi.fn(), verify: vi.fn(),
  Conflict: class extends Error {}, Limit: class extends Error {} }));
vi.mock('@/lib/admin/config-manager', () => ({ configManager: {
  ensureLoaded: async () => {}, get: (key: string, fallback: unknown) =>
    key === 'settingsSyncEnabled' ? mocks.enabled : key === 'oauthOnly' ? mocks.oauthOnly : fallback,
} }));
vi.mock('@/lib/auth/session-secret', () => ({ hasSessionSecret: () => true }));
vi.mock('next/headers', () => ({ cookies: async () => ({}) }));
vi.mock('@/lib/stalwart/auth-context', () => ({ readStalwartAuthContextFromStore: (_: unknown, slot: number) => slot === 2 ? mocks.context : null }));
vi.mock('@/lib/account-vault-storage', () => ({ listVaults: mocks.list, saveVault: mocks.save, deleteVault: mocks.remove,
  VaultConflict: mocks.Conflict, VaultLimit: mocks.Limit }));
vi.mock('@/lib/auth/verify-jmap-auth', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/auth/verify-jmap-auth')>(), verifyJmapAuth: mocks.verify,
}));
import { DELETE, GET, PUT } from '@/app/api/account-vault/route';
const owner = { username: 'owner@example.com', serverUrl: 'https://mail.example.com' };
const envelope = { version: 1, iterations: 600000, salt: 'AAAAAAAAAAAAAAAAAAAAAA==', iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAAAAAAAAAAAAAAAAAAAA==' };
const id = 'c'.repeat(32);
const record = { id, name: 'Laptop', revision: 'a'.repeat(64), envelope };
const create = { id: null, name: 'Laptop', envelope, revision: null };
function request(method: string, body?: unknown, extra: Record<string, string> = {}) {
  return new NextRequest('https://webmail.example.com/api/account-vault', { method,
    headers: { 'x-vault-username': owner.username, 'x-vault-server': owner.serverUrl, 'Content-Type': 'application/json', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const signIn = () => { mocks.context = { ...owner, authHeader: 'Basic ' + Buffer.from(owner.username + ':secret').toString('base64') }; };
beforeEach(() => {
  vi.clearAllMocks(); mocks.enabled = true; mocks.oauthOnly = false; mocks.context = null;
  mocks.list.mockResolvedValue([record]); mocks.remove.mockResolvedValue(undefined);
  mocks.verify.mockResolvedValue(owner.serverUrl); mocks.save.mockResolvedValue({ ...record, revision: 'b'.repeat(64) });
});
describe('account archive API', () => {
  it('allows listing named ciphertext before mail login, with no caching', async () => {
    const response = await GET(request('GET'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await response.json()).vaults).toEqual([record]);
    expect(mocks.list).toHaveBeenCalledWith(owner);
    expect(mocks.verify).not.toHaveBeenCalled();
  });
  it('honors the feature gate and OAuth-only policy', async () => {
    mocks.enabled = false;
    expect((await GET(request('GET'))).status).toBe(404);
    mocks.enabled = true; mocks.oauthOnly = true;
    expect((await PUT(request('PUT', create))).status).toBe(404);
    expect((await DELETE(request('DELETE', { id, revision: record.revision }))).status).toBe(404);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('rejects writes and deletes without the owner session or with forged/stale credentials', async () => {
    expect((await PUT(request('PUT', create))).status).toBe(403);
    expect((await DELETE(request('DELETE', { id, revision: record.revision }))).status).toBe(403);
    mocks.context = { ...owner, authHeader: 'Basic ' + Buffer.from('someone-else:secret').toString('base64') };
    expect((await PUT(request('PUT', create))).status).toBe(403);
    signIn();
    mocks.verify.mockRejectedValue(new Error('401'));
    expect((await PUT(request('PUT', create))).status).toBe(403);
    expect((await DELETE(request('DELETE', { id, revision: record.revision }))).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('verifies the owner on any slot and strips fields outside the encrypted envelope', async () => {
    signIn();
    const response = await PUT(request('PUT', { ...create, envelope: { ...envelope, password: 'forbidden' }, password: 'forbidden' }));
    expect(response.status).toBe(200);
    expect(mocks.verify).toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalledWith(owner, null, 'Laptop', envelope, null);
    expect((await PUT(request('PUT', create, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    expect((await PUT(request('PUT', { ...create, revision: 'invalid' }))).status).toBe(400);
    expect((await PUT(request('PUT', { ...create, id: '../escape' }))).status).toBe(400);
    expect((await PUT(request('PUT', { ...create, padding: 'x'.repeat(1024 * 1024 + 4096) }))).status).toBe(413);
  });
  it('replaces an archive by id and reports invalid names, conflicts and the per-owner limit', async () => {
    signIn();
    expect((await PUT(request('PUT', { ...create, id, name: 'Renamed', revision: record.revision }))).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(owner, id, 'Renamed', envelope, record.revision);
    const invalidName = await PUT(request('PUT', { ...create, name: ' ' }));
    expect(invalidName.status).toBe(400);
    expect((await invalidName.json()).error).toBe('invalid_name');
    mocks.save.mockRejectedValueOnce(new mocks.Conflict());
    expect(await (await PUT(request('PUT', create))).json()).toEqual({ error: 'conflict' });
    mocks.save.mockRejectedValueOnce(new mocks.Limit());
    const limited = await PUT(request('PUT', create));
    expect(limited.status).toBe(409);
    expect((await limited.json()).error).toBe('archive_limit');
  });
  it('deletes one archive by id and revision for the verified owner', async () => {
    signIn();
    const response = await DELETE(request('DELETE', { id, revision: record.revision }));
    expect(response.status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith(owner, id, record.revision);
    expect((await DELETE(request('DELETE', { id, revision: null }))).status).toBe(400);
    expect((await DELETE(request('DELETE', { id, revision: record.revision }, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    mocks.remove.mockRejectedValueOnce(new mocks.Conflict());
    expect((await DELETE(request('DELETE', { id, revision: record.revision }))).status).toBe(409);
  });
});
