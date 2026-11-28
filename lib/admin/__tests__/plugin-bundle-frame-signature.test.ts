// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// A privileged frame on the plugin origin runs a bundle only with a signature
// the server makes for privileged plugins (lib/plugin-sandbox/protocol.ts).
// The bundle route hands it out, and for no other plugin: with it, a bundle
// the admin installed for the untrusted tier would run with a privileged
// frame's origin.

const mocks = vi.hoisted(() => ({
  plugin: null as Record<string, unknown> | null,
  dev: null as { plugin: Record<string, unknown> } | null,
  signForFrame: vi.fn(async (code: string) => `FRAME(${code})`),
}));
vi.mock('@/lib/admin/plugin-registry', () => ({
  getPlugin: vi.fn(async () => mocks.plugin),
  getPluginBundle: vi.fn(async () => 'CODE'),
  getPluginSignature: vi.fn(async () => 'INSTALL-SIG'),
  isBundleMismatch: () => false,
}));
vi.mock('@/lib/admin/plugin-dev', () => ({
  getDevPlugin: vi.fn(async () => mocks.dev),
  readDevBundle: vi.fn(async () => 'DEV CODE'),
}));
vi.mock('@/lib/admin/plugin-signing', () => ({
  signBytes: vi.fn(async () => 'INSTALL-SIG'),
  signPrivilegedFrameBundle: (code: string) => mocks.signForFrame(code),
}));
vi.mock('@/lib/auth/instance-details', () => ({ canSeeInstanceDetails: vi.fn(async () => true) }));
vi.mock('@/lib/desktop/server-policy', () => ({ devicePolicyPluginRefusal: () => null }));

import { GET } from '@/app/api/admin/plugins/[id]/bundle/route';

const PLUGIN = {
  id: 'pp', name: 'P', version: '1.0.0', author: 'a', description: '', type: 'hook',
  permissions: [], entrypoint: 'index.js', enabled: true, bundleHash: 'h1',
};

function bundle(headers: Record<string, string> = {}): Promise<Response> {
  return GET(new NextRequest('http://localhost:3000/api/admin/plugins/pp/bundle', { headers }), { params: Promise.resolve({ id: 'pp' }) });
}

beforeEach(() => {
  mocks.plugin = null;
  mocks.dev = null;
  mocks.signForFrame.mockClear();
  mocks.signForFrame.mockImplementation(async (code: string) => `FRAME(${code})`);
});

describe('the frame signature on the bundle route', () => {
  it('comes with a privileged plugin, next to the signature of the install', async () => {
    mocks.plugin = { ...PLUGIN, tier: 'privileged', permissions: ['crypto:full'] };
    const response = await bundle();

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Bundle-Frame-Signature')).toBe('FRAME(CODE)');
    expect(response.headers.get('X-Bundle-Signature')).toBe('INSTALL-SIG');
  });

  it('comes with an unchanged bundle too (304), which is what a HEAD for it may get', async () => {
    mocks.plugin = { ...PLUGIN, tier: 'privileged', permissions: ['crypto:full'] };
    const response = await bundle({ 'if-none-match': '"h1"' });

    expect(response.status).toBe(304);
    expect(response.headers.get('X-Bundle-Frame-Signature')).toBe('FRAME(CODE)');
  });

  it('is not made for a plugin of the untrusted tier', async () => {
    mocks.plugin = { ...PLUGIN };
    const response = await bundle();

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Bundle-Frame-Signature')).toBeNull();
    expect(mocks.signForFrame).not.toHaveBeenCalled();
  });

  it('is not made for a privileged plugin the browser refuses to run privileged (no crypto:full)', async () => {
    mocks.plugin = { ...PLUGIN, tier: 'privileged', permissions: ['email:read'] };
    const response = await bundle();

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Bundle-Frame-Signature')).toBeNull();
    expect(mocks.signForFrame).not.toHaveBeenCalled();

    mocks.plugin = null;
    mocks.dev = { plugin: { ...PLUGIN, tier: 'privileged' } };
    expect((await bundle()).headers.get('X-Bundle-Frame-Signature')).toBeNull();
  });

  it('is left out when signing fails; the bundle is still served', async () => {
    mocks.plugin = { ...PLUGIN, tier: 'privileged', permissions: ['crypto:full'] };
    mocks.signForFrame.mockRejectedValue(new Error('no key'));
    const response = await bundle();

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Bundle-Frame-Signature')).toBeNull();
  });

  it('comes with a privileged plugin from PLUGIN_DEV_DIR, and with no other', async () => {
    mocks.dev = { plugin: { ...PLUGIN, tier: 'privileged', permissions: ['crypto:full'] } };
    expect((await bundle()).headers.get('X-Bundle-Frame-Signature')).toBe('FRAME(DEV CODE)');

    mocks.dev = { plugin: { ...PLUGIN } };
    expect((await bundle()).headers.get('X-Bundle-Frame-Signature')).toBeNull();
  });
});
