import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => data }),
  },
  NextRequest: class {},
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: () => {}, error: () => {} } }));
vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: vi.fn() }));

import { POST } from '@/app/api/caldav/discover/route';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';

const mockCreds = getStalwartCredentials as unknown as Mock;
const CREDS = { serverUrl: 'https://mail.example.com', username: 'u', authHeader: 'Basic abc' };

let fetchSpy: Mock;

function makeReq(body: unknown): Parameters<typeof POST>[0] {
  return { headers: { get: () => null }, json: async () => body } as unknown as Parameters<typeof POST>[0];
}
function read(res: unknown) {
  return res as { status: number; json: () => Promise<{ wellKnownUrl: string; accounts: Record<string, { url: string | null; resolvedAccount: string | null }> }> };
}
const target = (c: string) => `https://mail.example.com/dav/cal/${c}`;

beforeEach(() => {
  mockCreds.mockResolvedValue(CREDS);
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('POST /api/caldav/discover', () => {
  it('401 without credentials', async () => {
    mockCreds.mockResolvedValue(null);
    const res = read(await POST(makeReq({ accounts: [] })));
    expect(res.status).toBe(401);
  });

  it('returns the .well-known url and resolves the first 207 candidate, skipping the rest', async () => {
    fetchSpy.mockResolvedValue({ status: 207, headers: new Headers() });
    const res = read(await POST(makeReq({ accounts: [{ key: 'A', candidates: ['c1', 'c2'] }] })));
    const data = await res.json();

    expect(data.wellKnownUrl).toBe('https://mail.example.com/.well-known/caldav');
    expect(data.accounts.A).toEqual({ url: target('c1'), resolvedAccount: 'c1' });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // c2 never probed
    expect(fetchSpy).toHaveBeenCalledWith(target('c1'), expect.objectContaining({ method: 'PROPFIND' }));
  });

  it('resolves a redirect Location relative to the probe URL', async () => {
    fetchSpy.mockResolvedValue({ status: 302, headers: new Headers({ Location: '/dav/cal/real-home' }) });
    const res = read(await POST(makeReq({ accounts: [{ key: 'A', candidates: ['c1'] }] })));
    const data = await res.json();
    expect(data.accounts.A).toEqual({ url: 'https://mail.example.com/dav/cal/real-home', resolvedAccount: 'c1' });
  });

  it('returns null url when every candidate fails, but still 200', async () => {
    fetchSpy.mockResolvedValue({ status: 404, headers: new Headers() });
    const res = read(await POST(makeReq({ accounts: [{ key: 'A', candidates: ['c1', 'c2'] }] })));
    expect(res.status).toBe(200);
    expect((await res.json()).accounts.A).toEqual({ url: null, resolvedAccount: null });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('catches a probe error and continues to the next candidate', async () => {
    fetchSpy
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ status: 207, headers: new Headers() });
    const res = read(await POST(makeReq({ accounts: [{ key: 'A', candidates: ['c1', 'c2'] }] })));
    expect((await res.json()).accounts.A).toEqual({ url: target('c2'), resolvedAccount: 'c2' });
  });

  it('de-duplicates and trims candidates before probing', async () => {
    fetchSpy.mockResolvedValue({ status: 404, headers: new Headers() });
    await POST(makeReq({ accounts: [{ key: 'A', candidates: ['  c1 ', 'c1', '', 'c1'] }] }));
    expect(fetchSpy).toHaveBeenCalledTimes(1); // collapsed to a single "c1"
    expect(fetchSpy).toHaveBeenCalledWith(target('c1'), expect.anything());
  });
});
