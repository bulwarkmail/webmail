import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import { useAuthStore } from '@/stores/auth-store';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { dispatchApiCall } from '../plugin-sandbox/host-api';

// http.post attaches the user's Authorization header to a same-origin path
// the plugin's own manifest allowlists. A manifest listing the JMAP
// passthrough or /api/admin/ got full JMAP access (or, with an admin cookie
// present, the admin API) out of a plain http:post grant.

function plugin(apiPostPaths: string[]): InstalledPlugin {
  return {
    id: 'p1',
    name: 'Test plugin',
    version: '1.0.0',
    author: 'test',
    description: '',
    type: 'hook',
    permissions: ['http:post'],
    grantedPermissions: ['http:post'],
    entrypoint: 'index.js',
    enabled: true,
    status: 'running',
    settings: {},
    apiPostPaths,
  };
}

const fetchSpy = vi.fn();

beforeEach(() => {
  fetchSpy.mockReset().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
  useAuthStore.setState({
    client: { getAuthHeader: () => 'Basic dGVzdA==', getUsername: () => 'tester' } as never,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ client: null });
});

describe('plugin http.post denied paths', () => {
  it.each([
    ['/api/account/stalwart/jmap', ['/api/account/stalwart/jmap']],
    ['/api/admin/config', ['/api/admin/']],
    ['/api/settings', ['/api/settings']],
    ['/api/wopi', ['/api/wopi']],
    ['/api/auth/session', ['/api/']],
    ['/api/%61dmin/config', ['/api/%61dmin/']],
    ['/api//admin/config', ['/api/']],
  ])('refuses %s even when the manifest lists it', async (path, allow) => {
    await expect(dispatchApiCall(plugin(allow), 'http.post', [path, {}])).rejects.toThrow(/not available to plugins/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still reaches a plugin sidecar route', async () => {
    await dispatchApiCall(plugin(['/api/translate']), 'http.post', ['/api/translate', { text: 'hi' }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('reaches a route that only shares a prefix with a denied one', async () => {
    await dispatchApiCall(plugin(['/api/admin-helper']), 'http.post', ['/api/admin-helper', {}]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
