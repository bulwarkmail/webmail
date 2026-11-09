// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// /api/admin/auth caches "is this credential a Stalwart superuser" for 60 s
// per credential, so the panel's three checks per navigation cost one probe.
// The cache kept one entry for every credential that ever asked and never
// let go of them; it now holds at most 1000 and drops the oldest first.

vi.mock('next/server', () => ({
  NextResponse: { json: (data: unknown, init?: { status?: number }) => ({ json: async () => data, status: init?.status ?? 200 }) },
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: { ensureLoaded: vi.fn(async () => {}), get: (_key: string, d?: unknown) => d },
}));
vi.mock('@/lib/admin/password', () => ({
  initAdminPassword: vi.fn(async () => true),
  isAdminEnabled: () => false,
  verifyAdminPassword: vi.fn(),
  updateLastLogin: vi.fn(async () => {}),
  getAdminMeta: () => null,
}));
vi.mock('@/lib/admin/session', () => ({
  setAdminSessionCookie: vi.fn(),
  clearAdminSessionCookie: vi.fn(),
  requireAdminAuth: async () => ({ error: 'unauthorized' }),
  getClientIP: () => '127.0.0.1',
  isSameOriginRequest: () => true,
  getAdminDeviceId: async () => null,
  setAdminDeviceCookie: vi.fn(),
}));
vi.mock('@/lib/admin/rate-limit', () => ({ checkRateLimit: vi.fn(), checkDeviceRateLimit: vi.fn() }));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn() }));
vi.mock('@/lib/admin/stalwart-admin-access', () => ({ getStalwartAdminAccessMode: async () => 'auto' }));

const who = { header: 'Bearer 0' };
vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: async () => ({ serverUrl: 'https://mail.example.com', authHeader: who.header, username: 'u', trusted: true }),
}));

const probes: string[] = [];
vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
  if (url.endsWith('/.well-known/jmap')) {
    probes.push(init?.headers?.Authorization ?? '');
    return { ok: true, json: async () => ({ primaryAccounts: { 'urn:stalwart:jmap': 'a' } }) };
  }
  return { ok: true, json: async () => ({ methodResponses: [['x:Tenant/query', { ids: [] }, '0']] }) };
}));

import { GET } from '@/app/api/admin/auth/route';

async function check(header: string) {
  who.header = header;
  await GET({} as Parameters<typeof GET>[0]);
}

describe('Stalwart admin check cache', () => {
  it('asks Stalwart once per credential within the minute', async () => {
    await check('Bearer first');
    await check('Bearer first');
    expect(probes.filter((p) => p === 'Bearer first')).toHaveLength(1);
  });

  it('holds at most 1000 credentials and forgets the oldest first', async () => {
    probes.length = 0;
    await check('Bearer oldest');
    for (let i = 0; i < 1000; i++) await check(`Bearer filler ${i}`);
    await check('Bearer filler 999');
    await check('Bearer oldest');
    // The newest filler was still cached; the oldest credential was dropped and asked again.
    expect(probes.filter((p) => p === 'Bearer filler 999')).toHaveLength(1);
    expect(probes.filter((p) => p === 'Bearer oldest')).toHaveLength(2);
  });
});
