// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// PATCH /api/admin/config refuses trusted mail servers that aren't
// hostnames: they are matched exactly, so a wildcard would trust nothing.

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: vi.fn(async () => ({ session: { sub: 'admin' } })),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn(async () => {}) }));

import { configManager } from '@/lib/admin/config-manager';
import { PATCH } from '@/app/api/admin/config/route';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-trusted-authserv-'));
  vi.stubEnv('ADMIN_CONFIG_DIR', dir);
  vi.stubEnv('TRUSTED_AUTHSERV_IDS', undefined);
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({}));
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

describe('saving trusted mail servers', () => {
  it('stores a list of hostnames', async () => {
    const res = await patch({ trustedAuthservIds: 'mx.google.com, gateway.example.com' });
    expect(res.status).toBe(200);
    expect(configManager.get('trustedAuthservIds')).toBe('mx.google.com, gateway.example.com');
  });

  it('refuses a wildcard or anything else that is not a hostname, naming it', async () => {
    const res = await patch({ trustedAuthservIds: 'mx.google.com, *.example.com, mail example' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('*.example.com');
    expect(configManager.get('trustedAuthservIds', '')).toBe('');
  });

  it('refuses a value that is not a string', async () => {
    expect((await patch({ trustedAuthservIds: ['mx.google.com'] })).status).toBe(400);
  });
});
