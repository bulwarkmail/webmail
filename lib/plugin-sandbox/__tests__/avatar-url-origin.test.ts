/**
 * onAvatarResolve needs email:read only. The address a plugin returns becomes the src of an <img>
 * in the host page, whose CSP allows any https host. So an answer is kept only when the picture is
 * the plugin's own (data: image, blob:) or on a host in its httpOrigins, matched as api.http.fetch
 * matches them; the answer of one plugin is filtered per plugin in hookResultFor (hook-payload.ts).
 *
 * Released plugins: gravatar 1.4.1 returns https://gravatar.com/avatar/... with httpOrigins
 * ["https://gravatar.com"], libravatar 1.1.0 returns https://seccdn.libravatar.org/avatar/...
 * with httpOrigins ["https://seccdn.libravatar.org"]. Both keep working with this rule.
 */
import { describe, it, expect } from 'vitest';
import { hookResultFor } from '../hook-payload';
import type { InstalledPlugin } from '../../plugin-types';

function plugin(id: string, permissions: string[], httpOrigins?: string[]): InstalledPlugin {
  return {
    id, name: id, version: '1.0.0', author: 'x', description: '', type: 'hook', entrypoint: 'index.js',
    permissions, enabled: true, status: 'running', managed: true, forceEnabled: false, adminApproved: true, settings: {},
    ...(httpOrigins ? { httpOrigins } : {}),
  } as unknown as InstalledPlugin;
}

const ARGS = [null, { email: 'boss@example.org', name: 'Boss' }];
const gravatarPlugin = plugin('gravatar', ['email:read', 'http:fetch'], ['https://gravatar.com']);

describe('onAvatarResolve: where a plugin may point the host', () => {
  it('drops an address on a host the plugin did not declare', () => {
    const answer = hookResultFor(plugin('avatars', ['email:read']), 'onAvatarResolve', ARGS, 'https://avatars.invalid/avatar.png?who=boss%40example.org&subject=Quarterly%20numbers');
    expect(answer == null).toBe(true);
  });

  it('drops it for a plugin with http:fetch when the host is not in its httpOrigins', () => {
    const answer = hookResultFor(plugin('avatars', ['email:read', 'http:fetch'], ['https://gravatar.com']), 'onAvatarResolve', ARGS, 'https://avatars.invalid/a.png');
    expect(answer == null).toBe(true);
  });

  // Where the browser goes from there (a redirect) is up to the declared host.
  it('keeps gravatar and libravatar addresses', () => {
    const gravatar = 'https://gravatar.com/avatar/0bc83cb571cd1c50ba6f3e8a78ef1346?s=80&d=404';
    expect(hookResultFor(gravatarPlugin, 'onAvatarResolve', ARGS, gravatar)).toBe(gravatar);
    const libravatar = 'https://seccdn.libravatar.org/avatar/0bc83cb571cd1c50ba6f3e8a78ef1346?s=80&d=404';
    expect(hookResultFor(plugin('libravatar', ['email:read', 'http:fetch'], ['https://seccdn.libravatar.org']), 'onAvatarResolve', ARGS, libravatar)).toBe(libravatar);
  });

  it('keeps a picture the plugin made itself (data:)', () => {
    const data = 'data:image/png;base64,iVBORw0KGgo=';
    expect(hookResultFor(plugin('initials', ['email:read']), 'onAvatarResolve', ARGS, data)).toBe(data);
    const svg = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E';
    expect(hookResultFor(plugin('initials', ['email:read']), 'onAvatarResolve', ARGS, svg)).toBe(svg);
    const blob = 'blob:https://webmail.example/0b0c1b37-5b1e-4c5e-9d4e-2f1a2b3c4d5e';
    expect(hookResultFor(plugin('initials', ['email:read']), 'onAvatarResolve', ARGS, blob)).toBe(blob);
  });

  it('drops a data: answer that is not a picture', () => {
    expect(hookResultFor(plugin('initials', ['email:read']), 'onAvatarResolve', ARGS, 'data:text/html,<b>x</b>') == null).toBe(true);
  });

  it('drops a declared host on another port or over http', () => {
    expect(hookResultFor(gravatarPlugin, 'onAvatarResolve', ARGS, 'https://gravatar.com:8443/avatar/x') == null).toBe(true);
    expect(hookResultFor(gravatarPlugin, 'onAvatarResolve', ARGS, 'http://gravatar.com/avatar/x') == null).toBe(true);
    expect(hookResultFor(gravatarPlugin, 'onAvatarResolve', ARGS, 'https://www.gravatar.com/avatar/x') == null).toBe(true);
  });

  it('matches a wildcard origin for one label, as api.http.fetch does', () => {
    const cdn = plugin('cdn', ['email:read', 'http:fetch'], ['https://*.avatars.example']);
    expect(hookResultFor(cdn, 'onAvatarResolve', ARGS, 'https://eu.avatars.example/a.png')).toBe('https://eu.avatars.example/a.png');
    expect(hookResultFor(cdn, 'onAvatarResolve', ARGS, 'https://a.eu.avatars.example/a.png') == null).toBe(true);
  });

  it('drops an address on this webmail, which the plugin did not declare either', () => {
    expect(hookResultFor(plugin('avatars', ['email:read']), 'onAvatarResolve', ARGS, '/api/bimi?domain=boss.example.org') == null).toBe(true);
    expect(hookResultFor(plugin('avatars', ['email:read']), 'onAvatarResolve', ARGS, { src: 'https://avatars.invalid/a.png' }) == null).toBe(true);
  });

  it('passes "no answer" through unchanged', () => {
    expect(hookResultFor(gravatarPlugin, 'onAvatarResolve', ARGS, undefined)).toBeUndefined();
    expect(hookResultFor(gravatarPlugin, 'onAvatarResolve', ARGS, null)).toBeNull();
  });
});
