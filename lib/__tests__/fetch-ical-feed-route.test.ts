// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Company calendars by id (POST /api/fetch-ical { feedId }): the address
// comes from the caller's own scoped policy, their groups read from their
// JMAP session on the server, the admin's host may be on the intranet, and
// a feed is fetched once per refresh interval for everyone.

vi.mock('next/server', () => {
  class NextResponse {
    status: number;
    headers: Headers;
    body: unknown;
    constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers);
    }
    static json(data: unknown, init?: { status?: number }) {
      return Object.assign(new NextResponse(data, init), { json: async () => data });
    }
  }
  return { NextResponse, NextRequest: class {} };
});

const creds = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: async () => creds.value }));

const guardedFetch = vi.fn();
vi.mock('@/lib/security/url-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/security/url-guard')>()),
  fetchPublicUrl: (...args: unknown[]) => guardedFetch(...args),
}));

// The caller's JMAP session: alice is in the group ent-team and has bob's
// mailbox shared with her (a person, not a group).
const session = vi.hoisted(() => ({
  accounts: {} as Record<string, { name: string; isPersonal: boolean }>,
  types: {} as Record<string, string>,
}));
vi.mock('@/lib/stalwart/jmap-api', () => ({
  fetchJmapSession: async () => ({
    apiUrl: 'https://mail.example.org/jmap/',
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'alice' },
    accounts: session.accounts,
  }),
  rebaseApiUrl: () => 'https://mail.example.org/jmap/',
  postJmap: async () => new Response(JSON.stringify({
    methodResponses: [['Principal/get', { list: Object.entries(session.types).map(([id, type]) => ({ id, type })) }, '0']],
  })),
}));

const POLICY = {
  restrictions: {}, features: {}, defaults: {}, themePolicy: {},
  organisation: { calendars: { feeds: [{ id: 'hol', name: 'Holidays', url: 'https://cal.example.org/h.ics?token=t', color: '#2563eb', refreshMinutes: 60 }] } },
  scopes: [
    { id: 'team', label: 'Team', match: { groups: ['ent-team@example.org'] }, policy: { organisation: { calendars: { feeds: [{ id: 'team', name: 'Team', url: 'http://calendar.corp.internal/team.ics', refreshMinutes: 120 }] } } } },
    { id: 'bob', label: 'Bob', match: { groups: ['ent-bob@example.org'] }, policy: { organisation: { calendars: { feeds: [{ id: 'bobs', name: 'Bob', url: 'https://cal.example.org/b.ics' }] } } } },
  ],
};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: async () => {}, getPolicy: () => POLICY },
}));

import { POST } from '@/app/api/fetch-ical/route';
import { companyFeedCache } from '@/lib/admin/company-feed-cache';
import { clearServerPolicySubjects } from '@/lib/admin/server-policy-subject';

type RouteResponse = { status: number; body: unknown };
const post = async (body: unknown) => (await POST({ method: 'POST', headers: new Headers(), json: async () => body } as never)) as unknown as RouteResponse;
const ics = (status = 200, headers: Record<string, string> = {}) => new Response(status === 304 ? null : 'BEGIN:VCALENDAR\nEND:VCALENDAR\n', { status, headers: { 'content-type': 'text/calendar', ...headers } });

beforeEach(() => {
  creds.value = { serverUrl: 'https://mail.example.org', authHeader: 'Basic alice', username: 'ent-alice@example.org', accountName: 'ent-alice@example.org', trusted: true };
  session.accounts = {
    alice: { name: 'ent-alice@example.org', isPersonal: true },
    team: { name: 'ent-team@example.org', isPersonal: false },
    bob: { name: 'ent-bob@example.org', isPersonal: false },
  };
  session.types = { team: 'group', bob: 'individual' };
  guardedFetch.mockReset();
  companyFeedCache.clear();
  clearServerPolicySubjects();
});
afterEach(() => vi.useRealTimers());

describe('POST /api/fetch-ical { feedId }', () => {
  it('fetches a feed of Everyone and one of a group the session shows the user is in, from the policy on the server', async () => {
    guardedFetch.mockImplementation(async () => ics());
    expect((await post({ feedId: 'hol' })).status).toBe(200);
    expect(guardedFetch.mock.calls[0][0]).toBe('https://cal.example.org/h.ics?token=t');
    expect((await post({ feedId: 'team' })).status).toBe(200);
    // The admin's own intranet host may be private, and only it; a public
    // host gets no exception.
    expect(guardedFetch.mock.calls[0]).toHaveLength(2);
    expect(guardedFetch.mock.calls[1][0]).toBe('http://calendar.corp.internal/team.ics');
    expect(guardedFetch.mock.calls[1][2]).toEqual({ allowPrivateHost: 'calendar.corp.internal' });
  });

  it('refuses a feed of a scope the user is not in, without fetching anything', async () => {
    session.accounts = { alice: { name: 'ent-alice@example.org', isPersonal: true } };
    expect((await post({ feedId: 'team' })).status).toBe(404);
    // A person's shared mailbox is no group, whatever it is called.
    expect((await post({ feedId: 'bobs' })).status).toBe(404);
    expect((await post({ feedId: 'nope' })).status).toBe(404);
    expect((await post({ feedId: 42 })).status).toBe(404);
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it('answers from what it fetched within the refresh interval, and asks again with the validators after it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T08:00:00Z'));
    guardedFetch.mockResolvedValueOnce(ics(200, { etag: '"v1"', 'last-modified': 'Mon, 02 Nov 2026 07:00:00 GMT' }));
    await post({ feedId: 'hol' });
    await post({ feedId: 'hol' });
    expect(guardedFetch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-11-02T09:01:00Z'));
    guardedFetch.mockResolvedValueOnce(ics(304));
    const res = await post({ feedId: 'hol' });
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body as ArrayBuffer).toString()).toContain('BEGIN:VCALENDAR');
    expect(guardedFetch).toHaveBeenCalledTimes(2);
    expect(guardedFetch.mock.calls[1][1].headers).toMatchObject({ 'If-None-Match': '"v1"', 'If-Modified-Since': 'Mon, 02 Nov 2026 07:00:00 GMT' });
  });

  it('keeps the intranet exception off a redirect to another port', async () => {
    guardedFetch
      .mockImplementationOnce(async () => new Response(null, { status: 302, headers: { location: 'http://calendar.corp.internal:8443/x' } }))
      .mockImplementationOnce(async () => ics());
    expect((await post({ feedId: 'team' })).status).toBe(200);
    expect(guardedFetch.mock.calls[0][2]).toEqual({ allowPrivateHost: 'calendar.corp.internal' });
    expect(guardedFetch.mock.calls[1]).toHaveLength(2);
  });

  it('refuses an answer that is not a calendar', async () => {
    guardedFetch.mockImplementation(async () => new Response('{"secret":1}', { status: 200, headers: { 'content-type': 'application/json' } }));
    expect((await post({ feedId: 'team' })).status).toBe(502);
  });

  it('fetches a feed once for requests that arrive together', async () => {
    let release: () => void = () => {};
    guardedFetch.mockImplementation(() => new Promise((resolve) => { release = () => resolve(ics()); }));
    const both = Promise.all([post({ feedId: 'hol' }), post({ feedId: 'hol' })]);
    await vi.waitFor(() => expect(guardedFetch).toHaveBeenCalledTimes(1));
    release();
    expect((await both).map((r) => r.status)).toEqual([200, 200]);
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it('answers a feed that just failed with its error for a minute without asking again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T08:00:00Z'));
    guardedFetch.mockImplementation(async () => new Response('down', { status: 500 }));
    expect((await post({ feedId: 'hol' })).status).toBe(502);
    expect((await post({ feedId: 'hol' })).status).toBe(502);
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-11-02T08:01:01Z'));
    guardedFetch.mockImplementation(async () => ics());
    expect((await post({ feedId: 'hol' })).status).toBe(200);
    expect(guardedFetch).toHaveBeenCalledTimes(2);
  });

  it('needs a signed-in user', async () => {
    creds.value = null;
    expect((await post({ feedId: 'hol' })).status).toBe(401);
  });
});
