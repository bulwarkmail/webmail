// @vitest-environment node
/**
 * The lookup budget of /api/bimi and /api/favicon, with the real session check:
 *  1. it is counted per signed-in mailbox for every kind of session the routes serve, never per
 *     a header the caller sets;
 *  2. it keeps one user from taking every lookup the server runs at once, so another user's
 *     logo is still looked up;
 *  3. a lookup that found the drawing busy is "no logo for now": nothing a cache may keep.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const notFound = () => Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
const resolveTxt = vi.hoisted(() => vi.fn(async (_name: string): Promise<string[][]> => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); }));
vi.mock('node:dns/promises', () => ({ resolveTxt, lookup: vi.fn(), default: { resolveTxt, lookup: vi.fn() } }));
vi.mock('@/lib/admin/third-party-mode', () => ({
  isNoThirdPartyTrafficOn: vi.fn(async () => false),
  thirdPartyRefusal: () => new Response(null, { status: 403 }),
}));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: vi.fn(async () => {}), get: vi.fn((_k: string, fallback: unknown) => fallback), getPolicy: () => ({ features: {} }) },
}));
vi.mock('@/lib/auth/session-secret', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session-secret')>()),
  hasSessionSecret: () => true,
  getSessionSecret: () => 's'.repeat(64),
}));
// next/headers reads the cookies of the request being handled.
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined), getAll: () => [] }),
}));
// The logo host: every address answers the same honest logo.
const LOGO = '<svg version="1.2" baseProfile="tiny-ps" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Brand</title><rect width="10" height="10" fill="#c00"/></svg>';
vi.mock('@/lib/security/url-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/url-guard')>()),
  fetchPublicUrl: vi.fn(async () => new Response(LOGO, { status: 200 })),
}));
// The drawing, held by hand where a test wants it busy.
const drawing = vi.hoisted(() => ({ hold: false, pending: [] as Array<() => void> }));
vi.mock('@/lib/bimi/svg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bimi/svg')>();
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  return {
    ...actual,
    rasterize: vi.fn((_svg: string, options?: { onStopped?: () => void }) => new Promise<Buffer>((resolve) => {
      const finish = () => { options?.onStopped?.(); resolve(png); };
      if (drawing.hold) drawing.pending.push(finish);
      else finish();
    })),
  };
});

import { encryptPayload, encryptSession } from '@/lib/auth/crypto';
import { sessionCookieName } from '@/lib/auth/session-cookie';
import { stalwartAuthContextCookieName } from '@/lib/stalwart/auth-context';
import { LOOKUPS_PER_MINUTE } from '@/lib/sender-icon-access';
import { GET as bimi } from '@/app/api/bimi/route';

type Headers = Record<string, string>;
/** A same-origin request of the mail view carrying `cookies`. */
function request(path: string, cookies: Record<string, string>, headers: Headers = {}) {
  jar.clear();
  for (const [name, value] of Object.entries(cookies)) jar.set(name, value);
  const cookie = Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; ');
  return new NextRequest(`https://webmail.example${path}`, { headers: { cookie, 'sec-fetch-site': 'same-origin', ...headers } });
}
/** The session of a mail view that is open: the per-slot context cookie. */
const context = (username: string, slot = 0) => ({
  [stalwartAuthContextCookieName(slot)]: encryptPayload({ serverUrl: 'https://mail.example', username, authHeader: 'Basic eDp4' }, 'session-context'),
});
/** The session of a browser that was closed and reopened: only the remembered cookie. */
const remembered = (username: string) => ({ [sessionCookieName(0)]: encryptSession('https://mail.example', username, 'not-a-real-password') });

const lookedUp = (domain: string) => resolveTxt.mock.calls.some(([name]) => name === `_dmarc.${domain}`);
const withLogo = async (name: string) => (name.startsWith('_dmarc.') ? [['v=DMARC1; p=reject']] : [[`v=BIMI1; l=https://cdn.example/${name}.svg`]]);

beforeEach(() => {
  resolveTxt.mockReset();
  resolveTxt.mockImplementation(async () => { throw notFound(); });
  drawing.hold = false;
  drawing.pending.length = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe('the lookup budget', () => {
  // Control: the same mailbox has one budget whichever slot its session sits in.
  it('is one per mailbox, whichever account slot the session is in', async () => {
    for (let i = 0; i < LOOKUPS_PER_MINUTE; i++) await bimi(request(`/api/bimi?domain=slot${i}.example`, context('gus@mail.example', 0)));
    const res = await bimi(request('/api/bimi?domain=slot-over.example', context('gus@mail.example', 1)));
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(lookedUp('slot-over.example')).toBe(false);
  });

  it('is one per mailbox for a remembered session too, whatever address headers the request carries', async () => {
    const cookies = remembered('hana@mail.example');
    for (let i = 0; i < LOOKUPS_PER_MINUTE; i++) {
      const res = await bimi(request(`/api/bimi?domain=rem${i}.example`, cookies, { 'x-forwarded-for': `198.51.100.${i}` }));
      expect(res.status).toBe(200);
    }
    const res = await bimi(request('/api/bimi?domain=rem-over.example', cookies, { 'x-forwarded-for': '203.0.113.77' }));
    expect(lookedUp('rem-over.example')).toBe(false);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('leaves lookups for other users while one user has many running', async () => {
    // Sixteen domains of one user whose DNS takes its time: well inside 60 a minute.
    const held: Array<() => void> = [];
    resolveTxt.mockImplementation((name: string) => (name.includes('.slow')
      ? new Promise((_resolve, reject) => { held.push(() => reject(notFound())); })
      : Promise.reject(notFound())));
    const slow = Array.from({ length: 16 }, (_, i) => bimi(request(`/api/bimi?domain=slow${i}.example`, context('ivo@mail.example'))));
    await vi.waitFor(() => expect(held.length).toBeGreaterThanOrEqual(16));

    const res = await bimi(request('/api/bimi?domain=other-user.example', context('jana@mail.example')));
    for (const release of held) release();
    await Promise.all(slow);
    expect(lookedUp('other-user.example')).toBe(true);
    expect(res.headers.get('cache-control')).not.toBe('no-store');
  });
});

describe('a lookup that finds the drawing busy', () => {
  it('answers "no logo for now" uncached, and the logo is there once the drawing is free', async () => {
    vi.useFakeTimers();
    resolveTxt.mockImplementation(withLogo);
    drawing.hold = true;
    // Two logos take the two drawing slots and stay there.
    const first = [0, 1].map((i) => bimi(request(`/api/bimi?domain=held${i}.example`, context('kai@mail.example'))));
    await vi.waitFor(() => expect(drawing.pending).toHaveLength(2));

    // A third domain, with an ordinary logo, waits for a slot and gives up.
    const waiting = bimi(request('/api/bimi?domain=waiting-brand.example', context('lea@mail.example')));
    await vi.advanceTimersByTimeAsync(16_000);
    const res = await waiting;
    expect(res.headers.get('x-bulwark-bimi')).toBe('missing');
    expect(res.headers.get('cache-control')).toBe('no-store');

    // The drawing is free again: the next request, a minute later, gets the logo.
    drawing.hold = false;
    for (const finish of drawing.pending.splice(0)) finish();
    await Promise.all(first);
    await vi.advanceTimersByTimeAsync(60_000);
    const later = await bimi(request('/api/bimi?domain=waiting-brand.example', context('mia@mail.example')));
    expect(later.headers.get('x-bulwark-bimi')).toBe('self-asserted');
  });
});
