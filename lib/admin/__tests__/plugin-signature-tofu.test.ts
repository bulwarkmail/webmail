// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// A bundle installed before signatures were stored gets one on its first
// request. When that signature can't be written (read-only config with a
// mounted key, a full disk, a file the server may not write), the bundle
// must still be served, unsigned, as it was before: it answered 404 and the
// plugin disappeared for every user.

vi.mock('@/lib/auth/instance-details', () => ({ canSeeInstanceDetails: vi.fn(async () => true) }));
vi.mock('@/lib/admin/plugin-dev', () => ({ getDevPlugin: vi.fn(async () => null), readDevBundle: vi.fn() }));

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'bw-sig-tofu-'));
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  writeFileSync(path.join(dir, 'key.pem'), pem);
  vi.stubEnv('ADMIN_CONFIG_DIR', path.join(dir, 'config'));
  vi.stubEnv('PLUGIN_SIGNING_KEY_FILE', path.join(dir, 'key.pem'));
  mkdirSync(path.join(dir, 'config', 'plugins'), { recursive: true });
  writeFileSync(path.join(dir, 'config', 'plugins', 'registry.json'), JSON.stringify({
    plugins: [{ id: 'demo', name: 'Demo', version: '1.0.0', enabled: true, entrypoint: 'index.js', permissions: [] }],
  }));
  writeFileSync(path.join(dir, 'config', 'plugins', 'demo.js'), 'code()');
  // A signature that can't be written: a folder in its place.
  mkdirSync(path.join(dir, 'config', 'plugins', 'demo.sig'));
  vi.resetModules();
  (await import('../plugin-signing')).invalidatePluginSigningCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('a first-use signature that cannot be stored', () => {
  it('leaves the bundle served unsigned', async () => {
    const registry = await import('../plugin-registry');
    await expect(registry.getPluginSignature('demo', 'code()')).resolves.toBeNull();

    const { GET } = await import('@/app/api/admin/plugins/[id]/bundle/route');
    const res = await GET(new NextRequest('http://localhost/api/admin/plugins/demo/bundle'), { params: Promise.resolve({ id: 'demo' }) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('code()');
    expect(res.headers.get('x-bundle-signature')).toBeNull();
  });
});
