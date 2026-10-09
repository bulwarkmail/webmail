// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  enabled: true, contexts: new Map<number, unknown>(), verify: vi.fn(),
}));
vi.mock('@/lib/admin/config-manager', () => ({ configManager: {
  ensureLoaded: async () => {},
  get: (_key: string, fallback: unknown) => fallback,
  getPolicy: () => ({ features: { accountArchiveEnabled: mocks.enabled } }),
} }));
vi.mock('@/lib/auth/session-secret', () => ({ hasSessionSecret: () => true }));
vi.mock('next/headers', () => ({ cookies: async () => ({}) }));
vi.mock('@/lib/stalwart/auth-context', () => ({
  readStalwartAuthContextFromStore: (_: unknown, slot: number) => mocks.contexts.get(slot) ?? null,
}));
vi.mock('@/lib/auth/verify-jmap-auth', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/auth/verify-jmap-auth')>(), verifyJmapAuth: mocks.verify,
}));

const dataDir = mkdtempSync(path.join(tmpdir(), 'bw-account-archive-'));
process.env.SETTINGS_DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

import { DELETE, GET, PUT } from '@/app/api/account-archive/route';

const owner = { username: 'owner@example.com', serverUrl: 'https://mail.example.com' };
const envelope = { version: 1, iterations: 600000, salt: 'A'.repeat(22) + '==', iv: 'A'.repeat(16), ciphertext: 'A'.repeat(43) + '=' };
const basic = (user: string) => 'Basic ' + Buffer.from(`${user}:secret`).toString('base64');

function request(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('https://webmail.example.com/api/account-archive', {
    method,
    headers: { 'x-archive-username': owner.username, 'x-archive-server': owner.serverUrl, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const signIn = (username = owner.username, slot = 3) => {
  mocks.contexts.set(slot, { username, serverUrl: owner.serverUrl, authHeader: basic(username) });
};

beforeEach(() => {
  mocks.enabled = true;
  mocks.contexts.clear();
  mocks.verify.mockReset().mockResolvedValue(owner.serverUrl);
});

describe('account archive API', () => {
  it('is off unless the admin enables it', async () => {
    mocks.enabled = false;
    signIn();
    expect((await GET(request('GET'))).status).toBe(404);
    expect((await PUT(request('PUT', { envelope }))).status).toBe(404);
    expect((await DELETE(request('DELETE'))).status).toBe(404);
  });

  it('refuses every method without a verified session of the owner', async () => {
    for (const call of [() => GET(request('GET')), () => PUT(request('PUT', { envelope })), () => DELETE(request('DELETE'))]) {
      expect((await call()).status).toBe(403);
    }
    // Another user's session, or a credential that does not match its cookie.
    mocks.contexts.set(0, { ...owner, username: 'someone@example.com', authHeader: basic('someone@example.com') });
    mocks.contexts.set(1, { ...owner, authHeader: basic('someone@example.com') });
    expect((await GET(request('GET'))).status).toBe(403);
    // The owner's cookie whose credential the mail server no longer accepts.
    mocks.contexts.clear();
    signIn();
    mocks.verify.mockRejectedValue(new Error('401'));
    expect((await GET(request('GET'))).status).toBe(403);
    expect((await PUT(request('PUT', { envelope }))).status).toBe(403);
  });

  it('stores, returns and deletes the envelope for the verified owner, in any case', async () => {
    signIn('Owner@Example.com');
    let res = await GET(request('GET'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect((await res.json()).envelope).toBeNull();

    res = await PUT(request('PUT', { envelope: { ...envelope, password: 'forbidden' }, accounts: ['forbidden'] }));
    expect(res.status).toBe(200);
    expect(mocks.verify).toHaveBeenCalledWith(owner.serverUrl, basic('Owner@Example.com'), { trusted: false });
    expect((await (await GET(request('GET'))).json()).envelope).toEqual(envelope);

    expect((await DELETE(request('DELETE'))).status).toBe(200);
    expect((await (await GET(request('GET'))).json()).envelope).toBeNull();
  });

  it('rejects cross-site writes, malformed envelopes and oversized bodies', async () => {
    signIn();
    expect((await PUT(request('PUT', { envelope }, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    expect((await DELETE(request('DELETE', undefined, { 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    expect((await PUT(request('PUT', { envelope: { ...envelope, iterations: 1 } }))).status).toBe(400);
    expect((await PUT(request('PUT', { envelope: { ...envelope, ciphertext: 'A'.repeat(70000) } }))).status).toBe(413);
  });
});
