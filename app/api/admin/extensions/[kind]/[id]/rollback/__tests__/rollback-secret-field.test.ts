/**
 * @vitest-environment node
 *
 * A setting that stops being a secret on a rollback: the rollback side of
 * marketplace-update-secret-field.test.ts (same mocks as
 * rollback-grants-variants.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: vi.fn(async () => ({ session: { sub: 'admin' } })),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn(async () => {}) }));
vi.mock('@/lib/admin/csp-frame-origins', () => ({ invalidateFrameOriginsCache: vi.fn() }));
vi.mock('@/lib/desktop/server-policy', () => ({ devicePolicyPluginRefusal: () => null }));

const registry = new Map<string, Record<string, unknown>>();
vi.mock('@/lib/admin/plugin-registry', () => ({
  savePlugin: vi.fn(async (p: Record<string, unknown>) => { registry.set(p.id as string, p); }),
  saveTheme: vi.fn(async () => {}),
  getPlugin: vi.fn(async (id: string) => registry.get(id) ?? null),
  getTheme: vi.fn(async () => null),
}));

const savedConfig = new Map<string, Record<string, unknown>>();
vi.mock('@/lib/admin/plugin-config', () => ({
  getPluginConfig: vi.fn(async (id: string) => savedConfig.get(id) ?? {}),
  setPluginConfig: vi.fn(async () => {}),
  deletePluginConfigKey: vi.fn(async () => {}),
  sealPluginSecrets: vi.fn(async () => {}),
}));
vi.mock('@/lib/plugin-secrets/vault', () => ({ getUserCredential: vi.fn(async () => null) }));
vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: vi.fn(async () => ({ accountName: 'alice@example.org', serverUrl: 'https://mail.example.org' })),
}));
vi.mock('@/lib/admin/plugin-dev', () => ({ getDevPlugin: vi.fn(async () => null) }));

const BASE = {
  id: 'pretty-dates', name: 'Pretty Dates', author: 'x', description: 'd', type: 'hook', entrypoint: 'index.js',
  enabled: true, installedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  permissions: ['email:read', 'http:proxy'],
};
let kept: Record<string, unknown> = {};
vi.mock('@/lib/admin/extension-history', () => ({
  HistoryError: class HistoryError extends Error { status = 404; },
  readHistoryEntry: vi.fn(async () => ({ kind: 'plugin', entry: { ...kept }, code: 'module.exports = {};' })),
}));

import { POST } from '../route';
import { GET as readConfig } from '../../../../../plugins/[id]/config/route';

function rollback(body: Record<string, unknown>) {
  return POST(
    new NextRequest('http://localhost/api/admin/extensions/plugin/pretty-dates/rollback', {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ kind: 'plugin', id: 'pretty-dates' }) },
  );
}

/** What a plugin gets when it reads its settings (the host asks exactly this for it). */
async function pluginReadsItsSettings(id: string): Promise<Record<string, unknown>> {
  const res = await readConfig(
    new NextRequest(`http://localhost/api/admin/plugins/${id}/config?public=1`),
    { params: Promise.resolve({ id }) },
  );
  return res.json();
}

beforeEach(() => { registry.clear(); savedConfig.clear(); });

const FAKE = 'fake-key-for-the-test';
// 1.1.0, installed: the key is a secret used through a credential.
const installed = {
  ...BASE, version: '1.1.0',
  configSchema: { apiKey: { type: 'secret', label: 'Key' } },
  credentials: { svc: { label: 'Service', scope: 'admin', inject: { type: 'bearer' }, secretKey: 'apiKey', origin: 'https://api.dates.example' } },
};

describe('a rollback to a version that declared the secret\'s field as plain text', () => {
  it('is asked about, and the stored key does not become readable without it', async () => {
    registry.set('pretty-dates', installed);
    savedConfig.set('pretty-dates', { apiKey: FAKE });
    expect(await pluginReadsItsSettings('pretty-dates')).toEqual({});

    // 1.0.0, kept: the same field was plain text and the plugin read it itself.
    kept = { ...BASE, version: '1.0.0', configSchema: { apiKey: { type: 'string', label: 'Key' } } };
    const res = await rollback({ version: '1.0.0' });
    const got = await pluginReadsItsSettings('pretty-dates');
    expect({ status: res.status, pluginReads: got.apiKey }).toEqual({ status: 409, pluginReads: undefined });
  });
});

describe('control', () => {
  it('a rollback that keeps the field a secret asks nothing and releases nothing', async () => {
    registry.set('pretty-dates', installed);
    savedConfig.set('pretty-dates', { apiKey: FAKE });
    kept = { ...installed, version: '1.0.0', description: 'older' };
    const res = await rollback({ version: '1.0.0' });
    expect(res.status).toBe(200);
    expect(await pluginReadsItsSettings('pretty-dates')).toEqual({});
  });
});
