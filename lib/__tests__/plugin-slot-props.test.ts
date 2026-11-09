import { describe, it, expect } from 'vitest';
import type { InstalledPlugin, Permission } from '../plugin-types';
import { slotPropsFor } from '../plugin-sandbox/permissions';

function plugin(perms: Permission[]): InstalledPlugin {
  return {
    id: 'p1', name: 'P', version: '1.0.0', author: '', description: '', type: 'ui-extension',
    permissions: perms, grantedPermissions: perms, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
}

const EMAIL = { id: 'm1', subject: 'Salary review', text: 'confidential body' };

describe('slot props follow read permissions', () => {
  it('withholds the opened message from an email-banner plugin without email:read', () => {
    // ui:email-banner only lets a plugin draw a banner. Handing it the body,
    // headers and source would make it as good as email:read.
    const props = slotPropsFor(plugin(['ui:email-banner']), 'email-banner', { email: EMAIL });

    expect(props.email).toBeUndefined();
  });

  it('passes the message once the plugin also holds email:read', () => {
    const props = slotPropsFor(plugin(['ui:email-banner', 'email:read']), 'email-banner', { email: EMAIL });

    expect(props.email).toEqual(EMAIL);
  });

  it.each([
    ['email-details-section', 'email', 'email:read'],
    ['email-detail-sidebar', 'email', 'email:read'],
    ['calendar-event-actions', 'eventData', 'calendar:read'],
    ['contact-cryptokeys', 'cryptoKeys', 'contacts:read'],
    ['app-top-banner', 'username', 'account:read'],
    ['app-top-banner', 'serverUrl', 'account:read'],
    ['app-top-banner', 'impersonated', 'account:read'],
  ] as const)('%s.%s needs %s', (slot, key, perm) => {
    const without = slotPropsFor(plugin([]), slot, { [key]: 'value' });
    const withPerm = slotPropsFor(plugin([perm]), slot, { [key]: 'value' });

    expect(without[key]).toBeUndefined();
    expect(withPerm[key]).toBe('value');
  });

  it('drops props a slot does not declare', () => {
    const props = slotPropsFor(plugin(['email:read']), 'email-footer', { email: EMAIL, extra: 1 });

    expect(props).toEqual({});
  });

  it('keeps host callbacks that are part of the slot contract', () => {
    const onAttach = () => {};
    const props = slotPropsFor(plugin([]), 'composer-attachment-source', { onAttach });

    expect(props.onAttach).toBe(onAttach);
  });

  it('passes a plugin dialog its own props unchanged', () => {
    const props = slotPropsFor(plugin([]), 'plugin-dialog', { anything: { nested: true }, onResult: () => {} });

    expect(Object.keys(props).sort()).toEqual(['anything', 'onResult']);
  });
});
