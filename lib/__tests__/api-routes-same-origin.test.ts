/**
 * @vitest-environment node
 *
 * GHSA-9mvj-98f5-9q6g: the JMAP passthrough and the other cookie-authed API
 * routes acted on the session cookie with no origin check. SameSite=Lax
 * cookies still travel with a POST from a same-site sibling origin (and with
 * any cross-site POST when cookieSameSite=none), so a page there could drive
 * arbitrary JMAP calls as the victim. The proxy now gates every /api/ route,
 * on the decoded path, and each state-changing handler checks again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn((_key: string, fallback: unknown) => fallback),
    getPolicy: vi.fn(() => ({ features: { pluginsEnabled: false } })),
  },
}));
vi.mock('@/lib/setup/state', () => ({ detectSetupState: vi.fn(() => 'configured') }));
vi.mock('@/lib/admin/csp-frame-origins', () => ({ getEnabledPluginFrameOrigins: vi.fn(async () => []) }));
vi.mock('next-intl/middleware', async () => {
  const { NextResponse } = await import('next/server');
  return { default: () => () => NextResponse.next() };
});
vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

import { proxy, routePathOf } from '@/proxy';

const HOST = 'mail.victim.example';

/** A form POST from https://evil.victim.example, a same-site sibling. */
const SAME_SITE: Record<string, string> = {
  host: HOST,
  origin: 'https://evil.victim.example',
  'content-type': 'text/plain;charset=UTF-8',
  'sec-fetch-site': 'same-site',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
};

const SAME_ORIGIN: Record<string, string> = {
  host: HOST,
  origin: `https://${HOST}`,
  'content-type': 'application/json',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
};

function post(path: string, headers: Record<string, string>): NextRequest {
  return new NextRequest(`https://${HOST}${path}`, { method: 'POST', headers, body: '{}' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('routePathOf', () => {
  it('decodes percent-escapes the route matcher decodes', () => {
    expect(routePathOf('/api/%61uth/session')).toBe('/api/auth/session');
    expect(routePathOf('/api/account/stalwart/jmap')).toBe('/api/account/stalwart/jmap');
  });

  it('keeps a malformed escape as it is', () => {
    expect(routePathOf('/api/%E0%A4%A')).toBe('/api/%E0%A4%A');
  });
});

describe('proxy origin gate', () => {
  it.each([
    '/api/account/stalwart/jmap',
    '/api/settings',
    '/api/wopi/launch',
    '/api/plugin-approval-status',
    '/api/fetch-ical',
    '/api/translate',
    '/api/auth/session',
    '/api/%61ccount/stalwart/jmap',
    '/api/%61uth/session',
    '/api/%73ettings',
  ])('refuses a same-site POST to %s', async (path) => {
    const res = await proxy(post(path, SAME_SITE));
    expect(res.status).toBe(403);
  });

  it('lets the SPA through', async () => {
    const res = await proxy(post('/api/account/stalwart/jmap', SAME_ORIGIN));
    expect(res.status).toBe(200);
  });

  it('lets native clients without browser headers through', async () => {
    const res = await proxy(post('/api/account/stalwart/jmap', { host: HOST, 'content-type': 'application/json' }));
    expect(res.status).toBe(200);
  });

  it('leaves the WOPI file endpoints to their own token check', async () => {
    const res = await proxy(post('/api/wopi/files/abc/contents', SAME_SITE));
    expect(res.status).toBe(200);
  });

  it('never blocks a GET', async () => {
    const res = await proxy(new NextRequest(`https://${HOST}/api/settings`, { headers: SAME_SITE }));
    expect(res.status).toBe(200);
  });
});

describe('handler origin gate', () => {
  const HANDLERS: Array<[string, 'POST' | 'DELETE']> = [
    ['@/app/api/account/stalwart/jmap/route', 'POST'],
    ['@/app/api/settings/route', 'POST'],
    ['@/app/api/settings/route', 'DELETE'],
    ['@/app/api/wopi/launch/route', 'POST'],
    ['@/app/api/plugin-approval-status/route', 'POST'],
    ['@/app/api/fetch-ical/route', 'POST'],
    ['@/app/api/translate/route', 'POST'],
    ['@/app/api/caldav/discover/route', 'POST'],
    ['@/app/api/calendar-agenda/route', 'POST'],
    ['@/app/api/webdav/route', 'POST'],
  ];

  it.each(HANDLERS)('%s %s refuses a same-site request', async (modulePath, method) => {
    const mod = (await import(/* @vite-ignore */ modulePath)) as Record<string, (req: NextRequest) => Promise<Response>>;
    const req = new NextRequest(`https://${HOST}/api/x`, { method, headers: SAME_SITE, body: '{}' });
    const res = await mod[method](req);
    expect(res.status).toBe(403);
  });
});
