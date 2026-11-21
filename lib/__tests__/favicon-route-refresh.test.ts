// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// #960: the route caches a domain's favicon for two weeks. A sender who
// replaced their icon kept showing the old one; a ?v=<ms> refresh stamp newer
// than the cached copy must fetch it again.

// The session check /api/plugins uses: the mail view's requests are signed in.
vi.mock('@/lib/auth/instance-details', () => ({ canSeeInstanceDetails: vi.fn(async () => true) }));

const T0 = Date.UTC(2026, 9, 1);
let now = T0;
let icon = 1;
const fetchMock = vi.fn(async () =>
  new Response(new Uint8Array(64).fill(icon), { headers: { 'content-type': 'image/png' } }),
);

beforeEach(() => {
  now = T0;
  icon = 1;
  fetchMock.mockClear();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function get(query: string) {
  const { GET } = await import('@/app/api/favicon/route');
  const res = await GET(new NextRequest(`https://webmail.example/api/favicon?${query}`));
  return new Uint8Array(await res.arrayBuffer())[0];
}

describe('favicon route refresh', () => {
  it('serves the cached icon until a newer refresh stamp arrives', async () => {
    expect(await get('domain=example.cz')).toBe(1);

    icon = 2; // the sender replaces their favicon
    now = T0 + 60 * 60 * 1000;
    expect(await get('domain=example.cz')).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(await get(`domain=example.cz&v=${now}`)).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The fresh copy is cached again: same stamp, plain request, no refetch.
    expect(await get(`domain=example.cz&v=${now}`)).toBe(2);
    expect(await get('domain=example.cz')).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refetches a domain at most once a minute, even with future stamps', async () => {
    expect(await get('domain=example.cz')).toBe(1);
    icon = 2;
    now = T0 + 30 * 1000;
    expect(await get(`domain=example.cz&v=${now + 10 ** 9}`)).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the cached icon when the refresh cannot reach upstream', async () => {
    expect(await get('domain=example.cz')).toBe(1);
    now = T0 + 60 * 60 * 1000;
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(await get(`domain=example.cz&v=${now}`)).toBe(1);
  });
});
