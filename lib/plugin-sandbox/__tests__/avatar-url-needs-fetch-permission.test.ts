/**
 * The hosts in a manifest's httpOrigins are shown to the user as the targets of the http:fetch
 * permission (components/plugins/plugin-permission-list.tsx lists them under that row only), and
 * api.http.fetch works only with that permission. An avatar address on one of those hosts is the
 * same reach, so it is kept only for a plugin that holds http:fetch. A plugin that lists hosts
 * without the permission, or that was not granted it, answers data: and blob: pictures only.
 */
import { describe, it, expect } from 'vitest';
import { hookResultFor } from '../hook-payload';
import type { InstalledPlugin } from '../../plugin-types';

function plugin(permissions: string[], httpOrigins: string[], extra: Record<string, unknown> = {}): InstalledPlugin {
  return {
    id: 'avatars', name: 'avatars', version: '1.0.0', author: 'x', description: '', type: 'hook', entrypoint: 'index.js',
    permissions, enabled: true, status: 'running', managed: true, forceEnabled: false, adminApproved: true, settings: {},
    httpOrigins, ...extra,
  } as unknown as InstalledPlugin;
}

const ARGS = [null, { email: 'boss@example.org', name: 'Boss' }];
const ADDRESS = 'https://pictures.example/a.png?who=boss%40example.org';
const DATA = 'data:image/png;base64,iVBORw0KGgo=';

describe('onAvatarResolve: hosts count only with the permission that shows them', () => {
  // Control: with the permission the declared host is kept.
  it('keeps a declared host for a plugin that holds http:fetch', () => {
    expect(hookResultFor(plugin(['email:read', 'http:fetch'], ['https://pictures.example']), 'onAvatarResolve', ARGS, ADDRESS)).toBe(ADDRESS);
  });

  it('drops a declared host for a plugin whose manifest asks for email:read only', () => {
    const readOnly = plugin(['email:read'], ['https://pictures.example']);
    expect(hookResultFor(readOnly, 'onAvatarResolve', ARGS, ADDRESS) == null).toBe(true);
    expect(hookResultFor(plugin(['email:read'], ['https://*.pictures.example']), 'onAvatarResolve', ARGS, 'https://eu.pictures.example/a.png') == null).toBe(true);
    // Its own pictures still work.
    expect(hookResultFor(readOnly, 'onAvatarResolve', ARGS, DATA)).toBe(DATA);
  });

  it('drops a declared host for a plugin the user did not grant http:fetch', () => {
    // Installed by the user (not managed by the admin): a permission counts once it is granted.
    const asked = plugin(['email:read', 'http:fetch'], ['https://pictures.example'], { managed: false, grantedPermissions: ['email:read'] });
    expect(hookResultFor(asked, 'onAvatarResolve', ARGS, ADDRESS) == null).toBe(true);
    const granted = plugin(['email:read', 'http:fetch'], ['https://pictures.example'], { managed: false, grantedPermissions: ['email:read', 'http:fetch'] });
    expect(hookResultFor(granted, 'onAvatarResolve', ARGS, ADDRESS)).toBe(ADDRESS);
  });
});
