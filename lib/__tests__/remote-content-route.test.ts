// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { encodeRemoteUrl } from '../remote-content-proxy';

// /api/remote-content/<token> (#1021): fetches one remote picture of a
// message for a signed-in reader while the admin gate is on. Every fetch
// goes through the rebinding-safe public fetch (redirects too), nothing of
// the reader goes along, and only raster pictures come back.

const state = vi.hoisted(() => ({
  gate: true,
  noThirdParty: false,
  signedIn: true,
  leaseOk: true,
  secret: true,
  upstream: [] as Array<Response | Error>,
  calls: [] as Array<{ url: string; init: { headers?: Record<string, string> } }>,
}));

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    getPolicy: () => ({ features: { remoteContentProxyEnabled: state.gate } }),
  },
}));
vi.mock('@/lib/admin/third-party-mode', () => ({
  isNoThirdPartyTrafficOn: async () => state.noThirdParty,
  thirdPartyRefusal: () => NextResponse.json({ code: 'no-third-party-traffic' }, { status: 403 }),
}));
vi.mock('@/lib/sender-icon-access', () => ({
  NO_STORE: { 'Cache-Control': 'no-store' },
  senderIconAccess: async () => (state.signedIn
    ? { caller: { owners: ['o'], sessionless: false } }
    : { refusal: new NextResponse(null, { status: 401 }) }),
  lookupLease: () => ({ take: async () => state.leaseOk, release: async () => {} }),
}));
vi.mock('@/lib/auth/session-secret', () => ({ hasSessionSecret: () => state.secret }));
vi.mock('@/lib/security/url-guard', () => ({
  fetchPublicUrl: async (url: string, init: { headers?: Record<string, string> }) => {
    state.calls.push({ url, init });
    const next = state.upstream.shift();
    if (!next) throw new Error('no upstream answer queued');
    if (next instanceof Error) throw next;
    return next;
  },
}));

const { GET } = await import('@/app/api/remote-content/[token]/route');

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const GIF_PLACEHOLDER = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

async function get(url: string, token = encodeRemoteUrl(url)) {
  const req = new NextRequest(`https://mail.example.com/api/remote-content/${token}`, {
    headers: { cookie: 'jmap_session=secret; other=1', 'sec-fetch-site': 'same-origin', 'user-agent': 'Reader Browser/1.0', referer: 'https://mail.example.com/en/mail' },
  });
  const res = await GET(req, { params: Promise.resolve({ token }) });
  const body = Buffer.from(await res.arrayBuffer());
  return { res, body };
}

beforeEach(() => {
  Object.assign(state, { gate: true, noThirdParty: false, signedIn: true, leaseOk: true, secret: true, upstream: [], calls: [] });
});
afterEach(() => vi.restoreAllMocks());

describe('GET /api/remote-content/<token>', () => {
  it('serves a remote PNG with headers that keep it a picture of this origin', async () => {
    state.upstream.push(new Response(PNG, { headers: { 'content-type': 'text/html', 'set-cookie': 'track=1', etag: '"u42"' } }));
    const { res, body } = await get('https://t.example/p.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(body.equals(Buffer.from(PNG))).toBe(true);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('etag')).toBeNull();
  });

  it('sends nothing of the reader to the sender', async () => {
    state.upstream.push(new Response(PNG));
    await get('https://t.example/p.png');
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].url).toBe('https://t.example/p.png');
    const headers = Object.fromEntries(Object.entries(state.calls[0].init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    expect(Object.keys(headers).sort()).toEqual(['accept', 'user-agent']);
    expect(headers['user-agent']).not.toContain('Reader Browser');
  });

  it('follows a redirect through the guarded fetch again', async () => {
    state.upstream.push(new Response(null, { status: 302, headers: { location: '/moved.png' } }), new Response(PNG));
    const { res } = await get('https://t.example/p.png');
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(state.calls.map((c) => c.url)).toEqual(['https://t.example/p.png', 'https://t.example/moved.png']);
  });

  it('stops after five redirects', async () => {
    for (let i = 0; i < 6; i++) state.upstream.push(new Response(null, { status: 302, headers: { location: `/r${i}` } }));
    const { body } = await get('https://t.example/p.png');
    expect(body.toString('base64')).toBe(GIF_PLACEHOLDER);
    expect(state.calls).toHaveLength(6);
  });

  it.each([
    ['an SVG, whatever its type says', new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', { headers: { 'content-type': 'image/png' } })],
    ['a page', new Response('<!doctype html><p>hi</p>', { headers: { 'content-type': 'text/html' } })],
    ['an error status', new Response(PNG, { status: 404 })],
    ['more than 10 MB', new Response(PNG, { headers: { 'content-length': String(11 * 1024 * 1024) } })],
    ['a private address the guard refused', new Error('URL is not allowed')],
  ])('answers the transparent pixel for %s', async (_what, upstream) => {
    state.upstream.push(upstream);
    const { res, body } = await get('https://t.example/p.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/gif');
    expect(body.toString('base64')).toBe(GIF_PLACEHOLDER);
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
  });

  it('is not there while the admin gate is off', async () => {
    state.gate = false;
    const { res } = await get('https://t.example/p.png');
    expect(res.status).toBe(404);
    expect(state.calls).toHaveLength(0);
  });

  it('is off without a session secret, where anyone would pass as signed in', async () => {
    state.secret = false;
    const { res } = await get('https://t.example/p.png');
    expect(res.status).toBe(404);
    expect(state.calls).toHaveLength(0);
  });

  it('refuses without a session', async () => {
    state.signedIn = false;
    const { res } = await get('https://t.example/p.png');
    expect(res.status).toBe(401);
    expect(state.calls).toHaveLength(0);
  });

  it('fetches nothing with no third-party traffic', async () => {
    state.noThirdParty = true;
    const { res } = await get('https://t.example/p.png');
    expect(res.status).toBe(403);
    expect(state.calls).toHaveLength(0);
  });

  it.each([
    ['not a token', '%%%'],
    ['a file address', encodeRemoteUrl('file:///etc/passwd')],
  ])('refuses %s', async (_what, token) => {
    const { res } = await get('https://t.example/p.png', token);
    expect(res.status).toBe(400);
    expect(state.calls).toHaveLength(0);
  });

  it('answers the pixel without fetching once the reader used up the minute', async () => {
    state.leaseOk = false;
    const { res, body } = await get('https://t.example/p.png');
    expect(body.toString('base64')).toBe(GIF_PLACEHOLDER);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(state.calls).toHaveLength(0);
  });
});
