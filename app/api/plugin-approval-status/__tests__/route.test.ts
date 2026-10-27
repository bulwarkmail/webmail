/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/lib/stalwart/auth-context', () => ({
  readStalwartAuthContextFromStore: (_store: unknown, slot: number) => (slot === 0 ? { username: currentUser } : null),
}));
vi.mock('@/lib/security/same-origin', () => ({ rejectCrossOriginRequest: () => null }));

let features: Record<string, boolean> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: async () => {}, getPolicy: () => ({ features }) },
}));

let currentUser = 'alice@example.org';
const entries: Array<Record<string, unknown>> = [];
const bundles = new Map<string, Uint8Array>();
vi.mock('@/lib/admin/plugin-approvals', async (orig) => {
  const real = await orig<typeof import('@/lib/admin/plugin-approvals')>();
  return {
    ...real,
    getApprovalStatus: vi.fn(async () => ({ status: 'not-requested' })),
    requestApproval: vi.fn(async (pluginId: string, bundleHash: string, manifest: unknown, requestedBy: string) => {
      const pending = entries.filter((e) => e.status === 'pending' && e.requestedBy === requestedBy).length;
      if (pending >= real.MAX_PENDING_PER_USER) throw new real.ApprovalLimitError('too many');
      const entry = { pluginId, bundleHash, manifest, requestedBy, status: 'pending', requestedAt: 'now' };
      entries.push(entry);
      return entry;
    }),
    saveApprovalBundle: vi.fn(async (id: string, hash: string, zip: Uint8Array) => { bundles.set(`${id}:${hash}`, zip); }),
  };
});

import { POST } from '../route';
import { packageHash, checkPluginManifest } from '@/lib/extension-package';

const MANIFEST = {
  id: 'my-plugin', name: 'Mine', version: '1.0.0', author: 'me', description: 'd',
  type: 'hook', permissions: ['email:read'], entrypoint: 'index.js',
};

async function zipOf(manifest: Record<string, unknown>, code = 'module.exports = {}') {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest));
  zip.file('index.js', code);
  return zip.generateAsync({ type: 'uint8array' });
}

async function submit(bytes: Uint8Array) {
  const form = new FormData();
  form.append('file', new File([bytes as BlobPart], 'p.zip'));
  return POST(new NextRequest('http://localhost/api/plugin-approval-status', { method: 'POST', body: form }));
}

beforeEach(() => {
  entries.length = 0;
  bundles.clear();
  currentUser = 'alice@example.org';
  features = { pluginsEnabled: true, pluginsUploadEnabled: true, requirePluginApproval: true };
});

describe('POST /api/plugin-approval-status', () => {
  it('pins the request to the hash of the code and manifest it read itself', async () => {
    const res = await submit(await zipOf(MANIFEST));
    const body = await res.json();

    const expected = await packageHash(checkPluginManifest(MANIFEST).manifest!, 'module.exports = {}');
    expect(res.status).toBe(200);
    expect(body.bundleHash).toBe(expected);
    expect(entries[0].manifest).toMatchObject({ name: 'Mine', permissions: ['email:read'] });
    expect(bundles.has(`my-plugin:${expected}`)).toBe(true);
  });

  it('gives the same code with wider permissions a different hash', async () => {
    const narrow = await (await submit(await zipOf(MANIFEST))).json();
    const wide = await (await submit(await zipOf({ ...MANIFEST, permissions: ['email:read', 'http:fetch'], httpOrigins: ['https://evil.example'] }))).json();

    expect(wide.bundleHash).not.toBe(narrow.bundleHash);
  });

  it('refuses the old form where the client named the hash and manifest', async () => {
    const res = await POST(new NextRequest('http://localhost/api/plugin-approval-status', {
      method: 'POST',
      body: JSON.stringify({ pluginId: 'my-plugin', bundleHash: 'a'.repeat(64), manifest: { permissions: [] } }),
      headers: { 'content-type': 'application/json' },
    }));

    expect(res.status).toBe(400);
    expect(entries).toHaveLength(0);
  });

  it.each([
    ['plugins are off', { pluginsEnabled: false }],
    ['user plugins are off', { pluginsUploadEnabled: false }],
    ['approval is not required', { requirePluginApproval: false }],
  ])('takes no package while %s', async (_label, off) => {
    features = { ...features, ...off };
    const res = await submit(await zipOf(MANIFEST));

    expect(res.status).toBe(403);
    expect(entries).toHaveLength(0);
    expect(bundles.size).toBe(0);
  });

  it('refuses an upload larger than a package may be before reading it', async () => {
    let read = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        read += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
        if (read >= 50) controller.close();
      },
    });
    const res = await POST(new NextRequest('http://localhost/api/plugin-approval-status', {
      method: 'POST',
      body,
      duplex: 'half',
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(50 * 1024 * 1024) },
    } as ConstructorParameters<typeof NextRequest>[1]));

    expect(res.status).toBe(413);
    expect(read).toBeLessThanOrEqual(1);
    expect(entries).toHaveLength(0);
  });

  it('limits how many requests one user can have open', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await submit(await zipOf({ ...MANIFEST, id: `p-${i}x` }))).status).toBe(200);
    }
    const res = await submit(await zipOf({ ...MANIFEST, id: 'one-more' }));

    expect(res.status).toBe(429);
  });
});
