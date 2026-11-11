/**
 * @vitest-environment node
 *
 * What a rollback is asked about, kind by kind (same mocks as
 * rollback-restores-grants.test.ts, with the kept entry settable per case),
 * including a kept version whose credential reads its server from another
 * setting.
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
  sealPluginSecrets: vi.fn(async () => {}),
}));
vi.mock('@/lib/plugin-secrets/vault', () => ({ getUserCredential: vi.fn(async () => null) }));

const BASE = {
  id: 'pretty-dates', name: 'Pretty Dates', author: 'x', description: 'd', type: 'hook', entrypoint: 'index.js',
  enabled: true, installedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
};
let kept: Record<string, unknown> = {};
vi.mock('@/lib/admin/extension-history', () => ({
  HistoryError: class HistoryError extends Error { status = 404; },
  readHistoryEntry: vi.fn(async () => ({ kind: 'plugin', entry: { ...kept }, code: 'module.exports = {};' })),
}));

import { POST } from '../route';
import { resolveCredential } from '@/lib/plugin-secrets/proxy';

function rollback(body: Record<string, unknown>) {
  return POST(
    new NextRequest('http://localhost/api/admin/extensions/plugin/pretty-dates/rollback', {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ kind: 'plugin', id: 'pretty-dates' }) },
  );
}

const PERMS = ['email:read', 'http:fetch', 'http:post', 'http:proxy', 'crypto:full'];

beforeEach(() => { registry.clear(); savedConfig.clear(); });

describe('each kind a kept version brings back is asked about on its own', () => {
  const installed = { ...BASE, version: '1.1.0', permissions: PERMS };
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['the privileged tier', { tier: 'privileged' }, { privileged: true }],
    ['a POST path', { apiPostPaths: ['/api/devices'] }, { apiPostPaths: ['/api/devices'] }],
    ['a frame origin', { frameOrigins: ['https://frames.example'] }, { frameOrigins: ['https://frames.example'] }],
    ['a wildcard host', { httpOrigins: ['https://*.dates.example'] }, { httpOrigins: ['https://*.dates.example'] }],
    ['a credential server', {
      configSchema: { apiKey: { type: 'secret', label: 'Key' } },
      credentials: { svc: { label: 'S', scope: 'admin', inject: { type: 'bearer' }, secretKey: 'apiKey', origin: 'https://collector.example' } },
    }, { credentialOrigins: ['https://collector.example'] }],
  ];

  it.each(cases)('%s', async (_name, extra, expected) => {
    registry.set('pretty-dates', { ...installed, httpOrigins: ['https://api.dates.example'] });
    kept = { ...BASE, version: '1.0.0', permissions: PERMS, httpOrigins: ['https://api.dates.example'], ...extra };

    const asked = await rollback({ version: '1.0.0' });
    expect(asked.status).toBe(409);
    const body = await asked.json();
    expect(body.grantsAdded).toMatchObject(expected);

    // Every other kind accepted, this one not.
    const others = {
      permissions: PERMS, httpOrigins: ['https://other.example'], apiPostPaths: ['/api/other'], frameOrigins: ['https://other.example'],
      credentialOrigins: ['https://other.example'], privileged: true, skin: true,
      ...Object.fromEntries(Object.keys(expected).map((k) => [k, k === 'privileged' ? false : []])),
    };
    expect((await rollback({ version: '1.0.0', acceptGrants: others })).status).toBe(409);
    expect(registry.get('pretty-dates')!.version).toBe('1.1.0');

    expect((await rollback({ version: '1.0.0', acceptGrants: body.grantsAdded })).status).toBe(200);
    expect(registry.get('pretty-dates')!.version).toBe('1.0.0');
  });

  it('a kept copy that is not the one that was asked about is asked about again', async () => {
    registry.set('pretty-dates', { ...installed });
    kept = { ...BASE, version: '1.0.0', permissions: PERMS, httpOrigins: ['https://api.dates.example'] };
    const { grantsAdded } = await (await rollback({ version: '1.0.0' })).json();
    kept = { ...kept, httpOrigins: ['https://collector.example'] };
    expect((await rollback({ version: '1.0.0', acceptGrants: grantsAdded })).status).toBe(409);
  });

  it('accepting says nothing without the kinds named', async () => {
    registry.set('pretty-dates', { ...installed });
    kept = { ...BASE, version: '1.0.0', permissions: PERMS, tier: 'privileged', httpOrigins: ['https://api.dates.example'] };
    for (const accept of [{ acceptGrants: true }, { acceptGrants: '*' }, { acceptPermissions: ['*'] }, { force: true }, { acceptGrants: { privileged: 'yes', httpOrigins: '*' } }]) {
      expect((await rollback({ version: '1.0.0', ...accept })).status).toBe(409);
    }
  });
});

describe('a rollback that changes where a secret goes', () => {
  const user = { username: 'u', serverUrl: 'https://mail.example' };

  it('is asked about when the kept version read the credential server from another setting', async () => {
    const schema = {
      apiKey: { type: 'secret', label: 'Key' },
      baseUrl: { type: 'string', label: 'Server' },
      docsUrl: { type: 'string', label: 'Help page' },
    };
    const credential = { label: 'Service', scope: 'admin', inject: { type: 'bearer' }, secretKey: 'apiKey' };
    savedConfig.set('pretty-dates', { apiKey: 'fake-key-for-the-test', baseUrl: 'https://intranet.example', docsUrl: 'https://collector.example/help' });
    registry.set('pretty-dates', { ...BASE, version: '1.1.0', permissions: ['http:proxy'], configSchema: schema, credentials: { svc: { ...credential, originKey: 'baseUrl' } } });
    kept = { ...BASE, version: '1.0.0', permissions: ['http:proxy'], configSchema: schema, credentials: { svc: { ...credential, originKey: 'docsUrl' } } };
    expect((await resolveCredential(user, 'pretty-dates', 'svc'))!.origin).toBe('https://intranet.example');

    const res = await rollback({ version: '1.0.0' });
    const now = await resolveCredential(user, 'pretty-dates', 'svc');
    expect({ status: res.status, keyGoesTo: now!.origin }).toEqual({ status: 409, keyGoesTo: 'https://intranet.example' });
  });
});
