// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// PATCH /api/admin/config checks `adminAccounts`: every entry names an
// account and one of the configured mail servers.

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: vi.fn(async () => ({ session: { sub: 'admin' } })),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn(async () => {}) }));

import { configManager } from '@/lib/admin/config-manager';
import { PATCH } from '@/app/api/admin/config/route';

const MAIL = 'https://mail.example.com';
const OTHER = 'https://other.example.com/jmap';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-admin-accounts-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    jmapServerUrl: MAIL,
    jmapServers: [{ id: 'other', label: 'Other', url: OTHER }],
  }));
  await configManager.load();
});

async function patch(body: Record<string, unknown>) {
  const res = await PATCH(new NextRequest('https://webmail.example.com/api/admin/config', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('saving adminAccounts', () => {
  it('stores trimmed entries with the server URL as configured, without duplicates', async () => {
    const res = await patch({
      adminAccounts: [
        { serverUrl: 'https://MAIL.example.com/', account: '  alice@example.com ' },
        { serverUrl: MAIL, account: 'ALICE@example.com' },
        { serverUrl: OTHER, account: 'alice@example.com' },
      ],
    });
    expect(res.status).toBe(200);
    expect(configManager.get('adminAccounts')).toEqual([
      { serverUrl: MAIL, account: 'alice@example.com' },
      { serverUrl: OTHER, account: 'alice@example.com' },
    ]);
  });

  it('refuses a value that is not a list', async () => {
    const res = await patch({ adminAccounts: { serverUrl: MAIL, account: 'alice' } });
    expect(res.status).toBe(400);
    expect(configManager.get('adminAccounts')).toEqual([]);
  });

  it.each([
    ['an empty account', { serverUrl: MAIL, account: '   ' }],
    ['a missing account', { serverUrl: MAIL }],
    ['an account that is too long', { serverUrl: MAIL, account: 'a'.repeat(257) }],
    ['a server that is not configured', { serverUrl: 'https://elsewhere.example.com', account: 'alice' }],
    ['no server', { account: 'alice' }],
    ['something that is not an entry', 'alice'],
  ])('refuses %s', async (_name, entry) => {
    const res = await patch({ adminAccounts: [{ serverUrl: MAIL, account: 'bob' }, entry] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Each admin account needs an account name and one of the configured mail servers.');
    expect(configManager.get('adminAccounts')).toEqual([]);
  });

  it('checks against the servers saved in the same request', async () => {
    const res = await patch({
      jmapServers: [{ id: 'new', label: 'New', url: 'https://new.example.com' }],
      adminAccounts: [{ serverUrl: 'https://new.example.com', account: 'alice' }],
    });
    expect(res.status).toBe(200);
    expect(configManager.get('adminAccounts')).toEqual([{ serverUrl: 'https://new.example.com', account: 'alice' }]);

    const removed = await patch({
      jmapServers: [],
      adminAccounts: [{ serverUrl: 'https://new.example.com', account: 'alice' }],
    });
    expect(removed.status).toBe(400);
  });
});
