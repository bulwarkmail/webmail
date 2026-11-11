// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import type { BimiIndicator } from '@/lib/bimi/lookup';

const resolve = vi.hoisted(() => vi.fn(async (_domain: string): Promise<BimiIndicator | null> => null));
// `deferred`: the resolver could not start a lookup now (busy, or the user's budget is spent).
const lookup = vi.hoisted(() => ({ deferred: false }));
vi.mock('@/lib/bimi/lookup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bimi/lookup')>()),
  bimiResolver: () => ({
    resolve,
    answer: async (domain: string) => (lookup.deferred ? { indicator: null, deferred: true } : { indicator: await resolve(domain), deferred: false }),
    clear: () => {},
  }),
}));
// The session check /api/plugins uses: the mail view's requests are signed in.
const session = vi.hoisted(() => ({ signedIn: true }));
vi.mock('@/lib/auth/instance-details', () => ({ canSeeInstanceDetails: vi.fn(async () => session.signedIn) }));

import { configManager } from '@/lib/admin/config-manager';
import { GET } from '@/app/api/bimi/route';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000c0000000c0', 'hex');
const verified: BimiIndicator = { status: 'verified', png: PNG, markType: 'verified', organization: 'Brand Ltd', issuer: 'DigiCert, Inc.' };
const selfAsserted: BimiIndicator = { status: 'self-asserted', png: PNG };

let dir: string;
async function setConfig(config: Record<string, unknown>) {
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  await configManager.load();
}
/** The avatar <img> of the mail view: same-origin, with the session cookie. */
const get = (query: string, site: string | null = 'same-origin') => GET(new NextRequest(`https://webmail.example/api/bimi?${query}`, {
  headers: site === null ? {} : { 'sec-fetch-site': site, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
}));

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'bulwark-bimi-'));
  process.env.ADMIN_CONFIG_DIR = dir;
  delete process.env.NO_THIRD_PARTY_TRAFFIC;
  delete process.env.BIMI_REQUIRE_CERTIFICATE;
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ADMIN_CONFIG_DIR;
});
beforeEach(async () => {
  resolve.mockReset();
  lookup.deferred = false;
  session.signedIn = true;
  await setConfig({});
});

describe('/api/bimi', () => {
  it('answers the logo as a PNG that cannot run anything', async () => {
    resolve.mockResolvedValue(selfAsserted);
    const res = await get('domain=brand.org');
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-bulwark-bimi')).toBe('self-asserted');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('cache-control')).toBe('private, max-age=21600');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
    expect(resolve).toHaveBeenCalledWith('brand.org');
  });

  it('answers the 1x1 placeholder when there is no logo', async () => {
    resolve.mockResolvedValue(null);
    const res = await get('domain=brand.org');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-bulwark-bimi')).toBe('missing');
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
    const bytes = Buffer.from(await res.arrayBuffer());
    // PNG width and height from the IHDR chunk.
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1, 1]);
  });

  it('answers "no logo for now" uncached when no lookup could start', async () => {
    lookup.deferred = true;
    const res = await get('domain=brand.org');
    expect(res.headers.get('x-bulwark-bimi')).toBe('missing');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await get('domain=brand.org&format=json')).headers.get('cache-control')).toBe('no-store');
  });

  it('refuses a request without a session before any lookup, uncached', async () => {
    session.signedIn = false;
    for (const query of ['domain=brand.org', 'domain=brand.org&format=json']) {
      const res = await get(query);
      expect(res.status).toBe(401);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses a request from anywhere but the webmail\'s own pages', async () => {
    for (const site of ['cross-site', 'same-site', 'none']) {
      const res = await get('domain=brand.org', site);
      expect(res.status).toBe(403);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it('serves a signed-in browser that sends no Sec-Fetch-Site', async () => {
    resolve.mockResolvedValue(selfAsserted);
    const res = await get('domain=brand.org', null);
    expect(res.headers.get('x-bulwark-bimi')).toBe('self-asserted');
  });

  // The mobile app loads logos with its native HTTP client and no webmail session.
  it('serves the logo, and only the logo, to a client without a session that sends no browser headers', async () => {
    session.signedIn = false;
    resolve.mockResolvedValue(selfAsserted);
    const res = await get('domain=brand.org', null);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-bulwark-bimi')).toBe('self-asserted');
    expect(res.headers.get('cache-control')).toBe('private, max-age=21600');
    expect((await get('domain=brand.org&format=json', null)).status).toBe(401);
  });

  it('drops self-published logos when the admin requires a mark certificate', async () => {
    await setConfig({ bimiRequireCertificate: true });
    resolve.mockResolvedValue(selfAsserted);
    expect((await get('domain=brand.org')).headers.get('x-bulwark-bimi')).toBe('missing');
    expect(await (await get('domain=brand.org&format=json')).json()).toEqual({ status: 'none' });

    resolve.mockResolvedValue(verified);
    expect((await get('domain=brand.org')).headers.get('x-bulwark-bimi')).toBe('verified');
  });

  it('describes what backs the logo in JSON', async () => {
    resolve.mockResolvedValue(verified);
    const res = await get('domain=brand.org&format=json');
    expect(res.headers.get('cache-control')).toBe('private, max-age=21600');
    expect(await res.json()).toEqual({
      status: 'verified', markType: 'verified', organization: 'Brand Ltd', issuer: 'DigiCert, Inc.',
    });
  });

  it('refuses a missing or local domain without a lookup', async () => {
    expect((await get('')).status).toBe(400);
    expect((await get('domain=localhost')).status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });
});
