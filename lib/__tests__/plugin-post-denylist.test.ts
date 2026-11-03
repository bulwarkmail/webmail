import { describe, expect, it, vi } from 'vitest';
import { sanitizeApiPostPaths } from '@/lib/extension-origins';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

// host-api pulls in the whole store layer; only the pure gate is used here.
import { isPluginPostDenied } from '@/lib/plugin-sandbox/host-api';

// A plugin with `http:post` may POST to the same-origin routes its manifest
// lists, with the user's cookies. The denylist kept it off the passthrough,
// admin and sign-in routes but not off the plugin proxy and secrets routes:
// `/api/plugin-proxy?plugin=<other>&credential=<id>` injects another
// plugin's connected account or admin key into a request and hands the
// answer back, and `/api/plugin-secrets` re-points or deletes them. The
// agenda, fetch-ical and translate routes gave data and reach the plugin's
// own permissions would not. A manifest entry of the bare `/api/` prefix
// also passed validation and allowed every route at once.

describe('routes no plugin may POST to', () => {
  it.each([
    '/api/plugin-proxy',
    '/api/plugin-secrets',
    '/api/calendar-agenda',
    '/api/fetch-ical',
    '/api/translate',
    '/api/account-archive',
    '/api/%70lugin-proxy',
    '/api//plugin-secrets',
    '/api/account/stalwart/jmap',
    '/api/push/action',
  ])('%s is denied', (path) => {
    expect(isPluginPostDenied(path)).toBe(true);
  });

  it('leaves a plugin sidecar route alone', () => {
    expect(isPluginPostDenied('/api/my-plugin/webhook')).toBe(false);
  });
});

describe('apiPostPaths manifest entries', () => {
  it('rejects the bare API prefix and keeps named routes', () => {
    expect(sanitizeApiPostPaths(['/api/', '/api//x', '/api/my-plugin/', '/api/my-plugin/hook'])).toEqual([
      '/api/my-plugin/',
      '/api/my-plugin/hook',
    ]);
  });
});
