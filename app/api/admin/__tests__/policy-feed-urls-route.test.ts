// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Company calendar addresses can hold a token: users get the feeds without
// them (the browser fetches a feed by id), the admin pages with them.

const who = vi.hoisted(() => ({
  identity: null as null | { admin: true } | { admin: false; addresses: string[] },
  adminCookie: false,
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'admin_session' && who.adminCookie ? { value: 'token' } : undefined) }),
}));
vi.mock('@/lib/auth/instance-details', () => ({
  canSeeInstanceDetails: async () => true,
  signedInIdentity: async () => who.identity,
}));
vi.mock('@/lib/auth/bearer-identity', () => ({ bearerIdentity: async () => null }));

const FEED = { id: 'hol', name: 'Holidays', url: 'https://cal.example.org/h.ics?token=secret', color: '#2563eb', refreshMinutes: 60 };
const TEAM_FEED = { id: 'team', name: 'Team', url: 'https://intranet.example.org/team.ics?key=k', color: '#16a34a', refreshMinutes: 120 };
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    getPolicy: () => ({
      restrictions: {}, features: {}, defaults: {}, themePolicy: {},
      forceEnabledPlugins: [], approvedPlugins: [], forceEnabledThemes: [],
      organisation: { calendars: { feeds: [FEED], freeBusyGroup: '' } },
      scopes: [{ id: 'team', label: 'Team', match: { domains: ['example.org'] }, policy: { organisation: { calendars: { feeds: [TEAM_FEED] } } } }],
    }),
    getPolicyWithVersion() { return { policy: this.getPolicy(), version: 'v1' }; },
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/admin/session', () => ({
  requireAdminAuth: vi.fn(),
  getClientIP: () => '0.0.0.0',
  verifyCurrentAdminSession: async (token: string) => (token === 'token' ? { admin: true } : null),
}));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn() }));

import { GET } from '@/app/api/admin/policy/route';

const get = async () => (await GET(new NextRequest('https://mail.example/api/admin/policy'))).json();

beforeEach(() => {
  who.identity = null;
  who.adminCookie = false;
});

describe('GET /api/admin/policy company calendar addresses', () => {
  it('gives a signed-in user every feed without its address, in Everyone and in the scopes', async () => {
    who.identity = { admin: false, addresses: ['alice@example.org'] };
    const body = await get();
    expect(body.organisation.calendars.feeds).toEqual([{ ...FEED, url: '', urlHeld: true }]);
    expect(body.scopes[0].policy.organisation.calendars.feeds).toEqual([{ ...TEAM_FEED, url: '', urlHeld: true }]);
    expect(JSON.stringify(body)).not.toContain('token=secret');
    expect(JSON.stringify(body)).not.toContain('key=k');
  });

  it('gives the admin pages the addresses', async () => {
    who.identity = { admin: true };
    const body = await get();
    expect(body.organisation.calendars.feeds[0].url).toBe(FEED.url);
    expect(body.scopes[0].policy.organisation.calendars.feeds[0].url).toBe(TEAM_FEED.url);
  });

  // No session secret: the server can't tell users apart (signedInIdentity null).
  it('keeps the addresses back without a session secret unless the admin dashboard asks', async () => {
    const anyone = await get();
    expect(JSON.stringify(anyone)).not.toContain('token=secret');
    expect(JSON.stringify(anyone)).not.toContain('key=k');
    expect(anyone.organisation.calendars.feeds[0]).toMatchObject({ id: 'hol', url: '', urlHeld: true });
    who.adminCookie = true;
    const admin = await get();
    expect(admin.organisation.calendars.feeds[0].url).toBe(FEED.url);
  });
});
