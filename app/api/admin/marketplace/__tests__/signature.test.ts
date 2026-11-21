/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJson } from '@/lib/extension-package';
import { clearKeyringCache, keyIdOf } from '@/lib/admin/directory-keys';

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const raw = spki.subarray(spki.length - 32);
  return { privateKey, raw: raw.toString('base64'), keyId: keyIdOf(raw) };
}
const root = keypair();
const online = keypair();

vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: vi.fn(async () => ({ session: { sub: 'admin' } })),
  getClientIP: () => '127.0.0.1',
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn(async () => {}) }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn((key: string) => (key === 'extensionDirectoryUrl' ? 'https://extensions.test' : key === 'extensionDirectoryRootKeys' ? root.raw : undefined)),
  },
}));
const saved: string[] = [];
vi.mock('@/lib/admin/plugin-registry', () => ({
  savePlugin: vi.fn(async (p: { id: string }) => { saved.push(p.id); }),
  saveTheme: vi.fn(async () => {}),
  getPlugin: vi.fn(async () => null),
  getTheme: vi.fn(async () => null),
  getPluginRegistry: vi.fn(async () => ({ plugins: [] })),
  getThemeRegistry: vi.fn(async () => ({ themes: [] })),
}));
vi.mock('@/lib/admin/csp-frame-origins', async (orig) => ({
  ...(await orig<typeof import('@/lib/admin/csp-frame-origins')>()),
  invalidateFrameOriginsCache: vi.fn(),
}));

import { POST } from '../route';

const MANIFEST = { id: 'pretty-dates', name: 'Pretty Dates', version: '1.0.0', author: 'x', description: 'd', type: 'hook', permissions: ['email:read'], entrypoint: 'index.js' };

async function zip(code = 'module.exports = {};'): Promise<Uint8Array> {
  const z = new JSZip();
  z.file('manifest.json', JSON.stringify(MANIFEST));
  z.file('index.js', code);
  return z.generateAsync({ type: 'uint8array' });
}

function signed(bytes: Uint8Array, over: Record<string, unknown> = {}) {
  const statement = canonicalJson({
    _type: 'https://extensions.bulwarkmail.org/release/v1', slug: 'pretty-dates', version: '1.0.0', kind: 'plugin',
    bundle: { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength },
    source: { host: 'github.com', repo: 'o/r', commit: null, subpath: '' }, approvedAt: '2026-10-14T00:00:00.000Z', ...over,
  });
  return {
    'x-bundle-statement': Buffer.from(statement).toString('base64'),
    'x-bundle-signature': sign(null, Buffer.from(statement), online.privateKey).toString('base64'),
    'x-bundle-signature-key': online.keyId,
  };
}

function serve(bytes: Uint8Array, headers: Record<string, string>) {
  const ringBody = { _type: 'https://extensions.bulwarkmail.org/keyring/v1', rootKeyId: root.keyId, issuedAt: '2026-10-14T00:00:00.000Z', keys: [{ keyId: online.keyId, publicKey: online.raw, status: 'active', notBefore: '2026-10-14T00:00:00.000Z', notAfter: null }] };
  const ring = { ...ringBody, signature: sign(null, Buffer.from(canonicalJson(ringBody)), root.privateKey).toString('base64') };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.endsWith('/api/v2/keys')) return Response.json(ring);
    // The version lookup before the download; the listing names the hash of
    // the bytes that are then served, so only the signature decides here.
    if (u.includes('/versions/') && !u.endsWith('/bundle')) {
      return Response.json({ data: { version: '1.0.0', channel: 'stable', yanked: null, minAppVersion: null, maxAppVersion: null, permissions: MANIFEST.permissions, sha256: createHash('sha256').update(bytes).digest('hex') } });
    }
    return new Response(bytes.slice().buffer as ArrayBuffer, { headers });
  }));
}

const install = () => POST(new NextRequest('http://localhost/api/admin/marketplace', {
  method: 'POST', body: JSON.stringify({ slug: 'pretty-dates', version: '1.0.0', type: 'plugin' }), headers: { 'content-type': 'application/json' },
}));

beforeEach(() => {
  saved.length = 0;
  clearKeyringCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('marketplace install with directory signatures', () => {
  it('installs a bundle the directory signed', async () => {
    const bytes = await zip();
    serve(bytes, signed(bytes));
    const res = await install();
    expect(res.status).toBe(200);
    expect((await res.json()).signature).toBe('verified');
    expect(saved).toEqual(['pretty-dates']);
  });

  it('refuses an unsigned bundle', async () => {
    serve(await zip(), {});
    const res = await install();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not signed/);
    expect(saved).toEqual([]);
  });

  it('refuses a bundle swapped after signing', async () => {
    const bytes = await zip();
    // A working bundle with other code, served with the real one's signature.
    const other = await zip('module.exports = { steal: true };');
    serve(other, signed(bytes));
    const res = await install();
    expect(res.status).toBe(400);
    expect(saved).toEqual([]);
  });
});
