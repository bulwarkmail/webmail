// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// The policy route hands each browser only the scopes of the domains it is
// signed in with, so one organisation on a shared instance never sees
// another's settings.

const who = vi.hoisted(() => ({
  signedIn: true,
  identity: null as null | { admin: true } | { admin: false; addresses: string[] },
}));
vi.mock('@/lib/auth/instance-details', () => ({
  canSeeInstanceDetails: async () => who.signedIn,
  signedInIdentity: async () => who.identity,
}));

const SCOPES = [
  { id: 'two', label: 'Two', match: { domains: ['org-two.test'] }, policy: { features: { calendarEnabled: false } } },
  { id: 'team', label: 'Team', match: { groups: ['org-team@example.org'] }, policy: {} },
];
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    getPolicy: () => ({
      restrictions: {}, features: {}, defaults: {}, themePolicy: {},
      forceEnabledPlugins: [], approvedPlugins: [], forceEnabledThemes: [],
      organisation: { disclaimer: { html: '<p>Acme GmbH</p>', text: 'Acme GmbH' } },
      scopes: SCOPES,
    }),
    getPolicyVersion: () => 'v1',
    getPolicyWithVersion() { return { policy: this.getPolicy(), version: 'v1' }; },
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/admin/session', () => ({ requireAdminAuth: vi.fn(), getClientIP: () => '0.0.0.0' }));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn() }));

import { GET } from '@/app/api/admin/policy/route';

const get = async () => (await GET(new NextRequest('https://mail.example/api/admin/policy'))).json();

beforeEach(() => {
  who.signedIn = true;
  who.identity = null;
});

describe('GET /api/admin/policy scopes', () => {
  it('gives visitors who are not signed in no scopes and no organisation settings', async () => {
    who.signedIn = false;
    const body = await get();
    expect(body.scopes).toEqual([]);
    expect(body.organisation).toBeUndefined();
  });

  it('gives a signed-in user only the scopes of their domains', async () => {
    who.identity = { admin: false, addresses: ['org-dave@org-two.test'] };
    expect((await get()).scopes.map((s: { id: string }) => s.id)).toEqual(['two']);
    who.identity = { admin: false, addresses: ['org-alice@example.org'] };
    const body = await get();
    expect(body.scopes.map((s: { id: string }) => s.id)).toEqual(['team']);
    expect(body.organisation.disclaimer.text).toBe('Acme GmbH');
  });

  it('says which domains the scopes were picked for, and nothing when all are sent', async () => {
    who.identity = { admin: false, addresses: ['org-alice@example.org', 'org-dave@org-two.test'] };
    const res = await GET(new NextRequest('https://mail.example/api/admin/policy'));
    expect(res.headers.get('x-bulwark-policy-domains')).toBe('example.org,org-two.test');
    who.identity = { admin: true };
    expect((await GET(new NextRequest('https://mail.example/api/admin/policy'))).headers.get('x-bulwark-policy-domains')).toBeNull();
  });

  it('gives the admin every scope', async () => {
    who.identity = { admin: true };
    expect((await get()).scopes).toHaveLength(2);
  });

  it('gives every scope when the server can\'t tell who is asking', async () => {
    who.identity = null;
    expect((await get()).scopes).toHaveLength(2);
  });
});
