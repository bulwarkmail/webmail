/**
 * @vitest-environment node
 *
 * With no third-party traffic (#903) the page's CSP lists only its own origin
 * and the hosts the deployment configured, so anything the in-app switches
 * miss (a privileged plugin, a Gravatar URL) is still stopped by the browser.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const config: Record<string, unknown> = {};
let policy: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn(async () => {}),
    get: vi.fn((key: string, fallback: unknown) => (key in config ? config[key] : fallback)),
    getPolicy: vi.fn(() => policy),
  },
}));
vi.mock('@/lib/setup/state', () => ({ detectSetupState: vi.fn(() => 'configured') }));
vi.mock('@/lib/admin/csp-frame-origins', () => ({ getEnabledPluginFrameOrigins: vi.fn(async () => []) }));
vi.mock('@/lib/wopi/discovery', () => ({ getWopiEditorOrigins: vi.fn(async () => []) }));
vi.mock('next-intl/middleware', async () => {
  const { NextResponse } = await import('next/server');
  return { default: () => () => NextResponse.next() };
});

import { proxy } from '@/proxy';

async function csp(): Promise<Record<string, string>> {
  const res = await proxy(new NextRequest('http://localhost:3000/en/mail', { headers: { 'sec-fetch-dest': 'document' } }));
  const header = res.headers.get('content-security-policy') ?? '';
  return Object.fromEntries(header.split('; ').map((d) => [d.split(' ')[0], d.slice(d.indexOf(' ') + 1)]));
}

beforeEach(() => {
  for (const key of Object.keys(config)) delete config[key];
  policy = { features: { pluginsEnabled: false }, pushRelays: [{ label: 'Own', url: 'https://push.corp.example' }], defaultSidebarApps: [] };
  config.jmapServerUrl = 'https://mail.corp.example';
});

describe('page CSP with no third-party traffic', () => {
  it('lists only the own origin and the configured hosts', async () => {
    config.noThirdPartyTraffic = true;
    const d = await csp();
    expect(d['connect-src']).toBe("'self' https://mail.corp.example https://push.corp.example");
    expect(d['img-src']).toBe("'self' data: blob: https://mail.corp.example https://push.corp.example");
    expect(d['font-src']).toBe("'self' data: https://mail.corp.example https://push.corp.example");
    expect(d['media-src']).toBe("'self' blob: https://mail.corp.example https://push.corp.example");
    expect(d['frame-src']).toContain('https://mail.corp.example');
    for (const directive of ['connect-src', 'img-src', 'font-src', 'media-src', 'frame-src']) {
      expect(d[directive], directive).not.toMatch(/(^| )https?:( |$)|gravatar|bulwarkmail\.org/);
    }
  });

  it('keeps https: in connect-src only when users may sign in to any server', async () => {
    config.noThirdPartyTraffic = true;
    config.allowCustomJmapEndpoint = true;
    const d = await csp();
    expect(d['connect-src']).toMatch(/ https:( |$)/);
    expect(d['img-src']).not.toMatch(/ https:( |$)/);
  });

  it("lets an admin sidebar app's icon image load from the app's origin", async () => {
    policy.defaultSidebarApps = [{ id: 'admin-app-chat', name: 'Chat', url: 'https://chat.corp.example/',
      icon: 'tabler:messages', iconUrl: 'https://chat.corp.example/favicon.png', openMode: 'tab', showOnMobile: false }];
    expect((await csp())['img-src']).toBe("'self' data: blob: https:");
    config.noThirdPartyTraffic = true;
    expect((await csp())['img-src']).toContain(' https://chat.corp.example');
  });

  it('stays as before with the mode off', async () => {
    const d = await csp();
    expect(d['img-src']).toBe("'self' data: blob: https:");
    expect(d['connect-src']).toContain('https:');
  });
});
