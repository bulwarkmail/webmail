import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchApiCall } from '@/lib/plugin-sandbox/host-api';
import type { InstalledPlugin } from '@/lib/plugin-types';

// api.admin.getConfig asked the config route without ?public=1. The route
// hands an admin session every field, secrets included, so a plugin running
// for a user who was also signed in to the admin console got its own API
// keys (the Safe Browsing key of the link check). Secrets are for the server
// proxy only.

const plugin = {
  id: 'external-link-warning', name: 'Link check', version: '2.0.0', author: '', description: '', type: 'hook',
  permissions: ['admin:config'], grantedPermissions: ['admin:config'], managed: true, entrypoint: 'index.js',
  enabled: true, status: 'running', settings: {},
} as unknown as InstalledPlugin;

afterEach(() => vi.unstubAllGlobals());

describe('api.admin config reads', () => {
  it('ask for the fields without secrets', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ trustedDomains: 'example.com' }), { headers: { 'content-type': 'application/json' } });
    }));
    expect(await dispatchApiCall(plugin, 'admin.getAllConfig', [])).toEqual({ trustedDomains: 'example.com' });
    expect(await dispatchApiCall(plugin, 'admin.getConfig', ['trustedDomains'])).toBe('example.com');
    expect(urls).toHaveLength(2);
    for (const url of urls) expect(url).toMatch(/\/api\/admin\/plugins\/external-link-warning\/config\?public=1$/);
  });
});

// The server a plugin's credential reaches (originKey) is what stays
// reachable with no third-party traffic: the plugin may not write it.
describe('api.admin config writes', () => {
  it("refuse the plugin's own server address fields", async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    const withServer = {
      ...plugin,
      credentials: { linkcheck: { label: 'x', scope: 'admin', inject: { type: 'bearer' }, secretKey: 'endpointToken', originKey: 'endpointUrl' } },
    } as unknown as InstalledPlugin;
    await expect(dispatchApiCall(withServer, 'admin.setConfig', ['endpointUrl', 'https://collector.example/'])).rejects.toThrow(/only an administrator/);
    await expect(dispatchApiCall(withServer, 'admin.deleteConfig', ['endpointUrl'])).rejects.toThrow(/only an administrator/);
    expect(fetchSpy).not.toHaveBeenCalled();
    await dispatchApiCall(withServer, 'admin.setConfig', ['trustedDomains', 'example.com']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
