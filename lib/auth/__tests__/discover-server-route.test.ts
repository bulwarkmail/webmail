// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The sign-in form's lookup of a mail server: only where people may name a
// server of their own, and budgeted per client.

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } }));
const config = vi.hoisted(() => ({ custom: true }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: async () => {}, get: (key: string, fallback: unknown) => (key === 'allowCustomJmapEndpoint' ? config.custom : fallback) },
}));
const discoverMailServer = vi.hoisted(() => vi.fn(async (_email: string) => 'https://mail.example.org' as string | null));
vi.mock('@/lib/auth/discover-mail-server', () => ({ discoverMailServer }));

function post(body: unknown, client = '203.0.113.7') {
  return new NextRequest('https://webmail.example/api/auth/discover-server', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-forwarded-for': client },
    body: JSON.stringify(body),
  });
}

async function route() {
  vi.resetModules();
  return (await import('@/app/api/auth/discover-server/route')).POST;
}

beforeEach(() => {
  config.custom = true;
  discoverMailServer.mockClear();
});

describe('POST /api/auth/discover-server', () => {
  it('answers the server found for the address', async () => {
    const POST = await route();
    const res = await POST(post({ email: 'sam@example.org' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ serverUrl: 'https://mail.example.org' });
    expect(discoverMailServer).toHaveBeenCalledWith('sam@example.org');
  });

  it("isn't there when people can't name a server of their own", async () => {
    config.custom = false;
    const POST = await route();
    const res = await POST(post({ email: 'sam@example.org' }));
    expect(res.status).toBe(404);
    expect(discoverMailServer).not.toHaveBeenCalled();
  });

  it('stops one client after a budget of lookups', async () => {
    const POST = await route();
    for (let i = 0; i < 30; i++) expect((await POST(post({ email: `u${i}@example.org` }))).status).toBe(200);
    const res = await POST(post({ email: 'one-more@example.org' }));
    expect(res.status).toBe(429);
    expect(discoverMailServer).toHaveBeenCalledTimes(30);
    // Another client still gets an answer.
    expect((await POST(post({ email: 'x@example.org' }, '198.51.100.9'))).status).toBe(200);
  });

  it('refuses a request from another site', async () => {
    const POST = await route();
    const req = new NextRequest('https://webmail.example/api/auth/discover-server', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'sam@example.org' }),
    });
    expect((await POST(req)).status).toBe(403);
    expect(discoverMailServer).not.toHaveBeenCalled();
  });
});
