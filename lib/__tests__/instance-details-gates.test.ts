// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Endpoints answering anyone used to hand out what fingerprints an instance:
// exact versions and pending advisories, memory figures, the installed
// plugins and the hosts they reach, push relays, sidebar app URLs and every
// served domain.

const gate = vi.hoisted(() => ({ signedIn: false }));
vi.mock('@/lib/auth/instance-details', () => ({
  canSeeInstanceDetails: async () => gate.signedIn,
}));

const config = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
const POLICY = {
  restrictions: {},
  features: {},
  defaults: {},
  themePolicy: { allowUserThemes: true },
  forceEnabledPlugins: ['bulwark-gpg'],
  approvedPlugins: ['quick-notes'],
  forceEnabledThemes: [],
  pushRelays: [{ label: 'Internal', url: 'https://relay.corp.example' }],
  pushRelayUrl: 'https://relay.corp.example',
  pushRelayUrlLocked: true,
  defaultSidebarApps: [{ id: 'wiki', name: 'Wiki', url: 'https://wiki.corp.example' }],
};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: async () => {},
    get: (key: string, fallback: unknown) => (key in config.values ? config.values[key] : fallback),
    getPolicy: () => POLICY,
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/admin/session', () => ({ requireAdminAuth: vi.fn(), getClientIP: () => '0.0.0.0' }));
vi.mock('@/lib/admin/audit', () => ({ auditLog: vi.fn() }));

const STATUS = {
  schema: 1, current: '1.9.0', latest: '1.9.2', updateAvailable: true, severity: 'security',
  url: 'https://example.org/release', advisory: 'Stored XSS in the reader, fixed in 1.9.2', checkedAt: '2026-09-26T00:00:00Z',
};
vi.mock('@/lib/version-check', () => ({
  checkOnce: vi.fn(),
  loadState: async () => ({ status: STATUS, lastCheckedAt: null, lastSuccessAt: null }),
  freshStatus: (state: { status: unknown }) => state.status,
}));
vi.mock('@/lib/admin/plugin-registry', () => ({
  getPluginRegistry: async () => ({ plugins: [] }),
  getThemeRegistry: async () => ({ themes: [] }),
}));
vi.mock('@/lib/admin/plugin-dev', () => ({ listDevPlugins: async () => [] }));

import { GET as health } from '@/app/api/health/route';
import { GET as updateStatus } from '@/app/api/system/update-status/route';
import { GET as plugins } from '@/app/api/plugins/route';
import { GET as policy } from '@/app/api/admin/policy/route';

const req = (path: string) => new NextRequest(`https://mail.example${path}`);

beforeEach(() => {
  gate.signedIn = false;
  config.values = {};
});

describe('endpoints for visitors who are not signed in', () => {
  it('health answers the liveness probe but no diagnostics', async () => {
    const body = await (await health(req('/api/health?detailed=true'))).json();
    expect(body.status).toBe('healthy');
    expect(body).not.toHaveProperty('version');
    expect(body).not.toHaveProperty('memory');
    expect(body).not.toHaveProperty('nodeVersion');

    gate.signedIn = true;
    expect(await (await health(req('/api/health?detailed=true'))).json()).toHaveProperty('memory');
  });

  it('update status follows loginShowVersion and never carries the advisory text', async () => {
    const shown = await (await updateStatus(req('/api/system/update-status'))).json();
    expect(shown.status).toMatchObject({ current: '1.9.0', severity: 'security', advisory: null });

    config.values.loginShowVersion = false;
    expect((await (await updateStatus(req('/api/system/update-status'))).json()).status).toBeNull();

    gate.signedIn = true;
    expect((await (await updateStatus(req('/api/system/update-status'))).json()).status).toEqual(STATUS);
  });

  it('the plugin list needs a session', async () => {
    expect((await plugins(req('/api/plugins'))).status).toBe(401);
    gate.signedIn = true;
    expect((await plugins(req('/api/plugins'))).status).toBe(200);
  });

  it('the policy keeps what the login page needs and drops the deployment map', async () => {
    const res = await policy(req('/api/admin/policy'));
    expect(res.headers.get('x-bulwark-policy-scope')).toBe('public');
    const body = await res.json();
    expect(body.themePolicy).toEqual(POLICY.themePolicy);
    expect(body).toMatchObject({
      forceEnabledPlugins: [], approvedPlugins: [], pushRelays: [], pushRelayUrl: '', defaultSidebarApps: [],
    });

    gate.signedIn = true;
    const full = await policy(req('/api/admin/policy'));
    expect(full.headers.get('x-bulwark-policy-scope')).toBeNull();
    expect(await full.json()).toEqual(POLICY);
  });
});
