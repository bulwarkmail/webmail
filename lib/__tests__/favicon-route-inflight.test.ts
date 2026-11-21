// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The favicon route is keyed by domain, so without a ceiling its callers
// could have this instance open one upstream connection per made-up domain
// name.

// The session check /api/plugins uses: the mail view's requests are signed in.
vi.mock('@/lib/auth/instance-details', () => ({ canSeeInstanceDetails: vi.fn(async () => true) }));

let pending: Array<() => void>;
const fetchMock = vi.fn(
  () => new Promise<Response>((resolve) => {
    pending.push(() => resolve(new Response(new Uint8Array(64).fill(1), { headers: { 'content-type': 'image/png' } })));
  }),
);

beforeEach(() => {
  pending = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('favicon route upstream concurrency', () => {
  it('stops opening upstream connections past the ceiling and answers with the blank icon', async () => {
    const { GET } = await import('@/app/api/favicon/route');
    const inFlight = Array.from({ length: 16 }, (_, i) =>
      GET(new NextRequest(`https://webmail.example/api/favicon?domain=site${i}.example`)),
    );
    // The route reads the no-third-party switch from config first (#903).
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(16));

    const over = await GET(new NextRequest('https://webmail.example/api/favicon?domain=site99.example'));
    expect(fetchMock).toHaveBeenCalledTimes(16);
    expect(over.status).toBe(200);
    expect(over.headers.get('content-type')).toBe('image/png');

    // Once the others finish, new domains are fetched again.
    for (const release of pending.splice(0)) release();
    await Promise.all(inFlight);
    const later = GET(new NextRequest('https://webmail.example/api/favicon?domain=site100.example'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(17));
    for (const release of pending.splice(0)) release();
    expect((await later).status).toBe(200);
  });
});
