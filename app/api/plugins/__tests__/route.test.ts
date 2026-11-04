/**
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/auth/instance-details', () => ({ canSeeInstanceDetails: vi.fn(async () => true) }));
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    getPolicy: vi.fn(() => ({ forceEnabledPlugins: ['policy-forced'] })),
  },
}));
const base = { name: 'P', version: '1.0.0', author: 'a', description: 'd', type: 'hook', permissions: [], entrypoint: 'index.js', enabled: true, installedAt: '', updatedAt: '' };
vi.mock('@/lib/admin/plugin-registry', () => ({
  getPluginRegistry: vi.fn(async () => ({
    plugins: [
      { ...base, id: 'default-on' },
      { ...base, id: 'default-off', defaultOff: true },
      { ...base, id: 'forced', forceEnabled: true, defaultOff: true },
      { ...base, id: 'policy-forced' },
    ],
  })),
  getThemeRegistry: vi.fn(async () => ({ themes: [] })),
}));
vi.mock('@/lib/admin/plugin-dev', () => ({ listDevPlugins: vi.fn(async () => []) }));
vi.mock('@/lib/admin/third-party-mode', () => ({ isNoThirdPartyTrafficOn: vi.fn(async () => false) }));
vi.mock('@/lib/desktop/server-policy', () => ({ pluginRefusedByDevicePolicy: () => false }));

import { GET } from '../route';

describe('GET /api/plugins', () => {
  it('tells clients what users get while they haven\'t chosen', async () => {
    const res = await GET(new NextRequest('https://webmail.example/api/plugins'));
    const { plugins } = await res.json() as { plugins: Array<{ id: string; defaultOn: boolean; forceEnabled: boolean }> };
    const byId = Object.fromEntries(plugins.map((p) => [p.id, { defaultOn: p.defaultOn, forceEnabled: p.forceEnabled }]));
    expect(byId).toEqual({
      'default-on': { defaultOn: true, forceEnabled: false },
      'default-off': { defaultOn: false, forceEnabled: false },
      forced: { defaultOn: false, forceEnabled: true },
      'policy-forced': { defaultOn: true, forceEnabled: true },
    });
  });
});
