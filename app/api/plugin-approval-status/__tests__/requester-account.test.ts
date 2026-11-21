/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';

// Who asks for a plugin approval, when the slot has no sign-in context (a
// remembered session restored without one): the account the sign-in
// resolved, sealed in the remembered session. A token login with a bare name
// (`john`) and no account names nobody, so two users called john on different
// domains never share one requester or one limit of open requests.

vi.mock('@/lib/auth/session-secret', () => ({
  getSessionSecret: () => 's'.repeat(64),
  hasSessionSecret: () => true,
}));
let jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined) }),
}));
vi.mock('@/lib/stalwart/auth-context', () => ({
  readCurrentStalwartAuthContext: async () => null,
  rememberedSessionPastMaxAge: async () => false,
}));
vi.mock('@/lib/security/same-origin', () => ({ rejectCrossOriginRequest: () => null }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    getPolicy: () => ({ features: { pluginsEnabled: true, pluginsUploadEnabled: true, requirePluginApproval: true } }),
  },
}));
const requesters: string[] = [];
vi.mock('@/lib/admin/plugin-approvals', async (orig) => {
  const real = await orig<typeof import('@/lib/admin/plugin-approvals')>();
  return {
    ...real,
    getApprovalStatus: vi.fn(async () => ({ status: 'not-requested' })),
    requestApproval: vi.fn(async (pluginId: string, bundleHash: string, manifest: unknown, requestedBy: string) => {
      requesters.push(requestedBy);
      return { pluginId, bundleHash, manifest, requestedBy, status: 'pending', requestedAt: 'now' };
    }),
    saveApprovalBundle: vi.fn(async () => {}),
  };
});

import { GET, POST } from '../route';
import { encryptSession } from '@/lib/auth/crypto';

const SERVER = 'https://mail.example.org';
const MANIFEST = {
  id: 'my-plugin', name: 'Mine', version: '1.0.0', author: 'me', description: 'd',
  type: 'hook', permissions: ['email:read'], entrypoint: 'index.js',
};

async function submit() {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(MANIFEST));
  zip.file('index.js', 'module.exports = {}');
  const form = new FormData();
  form.append('file', new File([(await zip.generateAsync({ type: 'uint8array' })) as BlobPart], 'p.zip'));
  return POST(new NextRequest('http://localhost/api/plugin-approval-status', { method: 'POST', body: form }));
}

function status() {
  return GET(new NextRequest(`http://localhost/api/plugin-approval-status?pluginId=my-plugin&bundleHash=${'a'.repeat(64)}`));
}

beforeEach(() => {
  jar = new Map();
  requesters.length = 0;
});

describe('the requester of a plugin approval from a remembered session', () => {
  it('is the account a bare-name token login resolved to', async () => {
    jar.set('jmap_session', encryptSession(SERVER, 'john', { token: 'token-of-john-at-a' }, Date.now(), 'john@a.example', true));
    expect((await submit()).status).toBe(200);
    expect(requesters).toEqual(['john@a.example']);
  });

  it('is nobody for a bare-name token login whose account is not known', async () => {
    jar.set('jmap_session', encryptSession(SERVER, 'john', { token: 'token-of-some-john' }));
    expect((await submit()).status).toBe(401);
    expect((await status()).status).toBe(401);
    expect(requesters).toEqual([]);
  });

  it('is the sign-in name of a password login (control)', async () => {
    jar.set('jmap_session', encryptSession(SERVER, 'alice@example.org', 'alices-password'));
    expect((await submit()).status).toBe(200);
    expect(requesters).toEqual(['alice@example.org']);
  });

  it('is the full address of a token login that signed in with one (control)', async () => {
    jar.set('jmap_session', encryptSession(SERVER, 'bob@example.org', { token: 'token-of-bob' }));
    expect((await status()).status).toBe(200);
  });
});
