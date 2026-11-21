/**
 * Hooks that need no permission are the ones every plugin has implicitly
 * (`ui:observe`, `app:lifecycle`): nobody is asked for them, and the consent
 * dialog and the plugin list don't show them. A hook that hands a plugin the
 * links the user opens (and lets it send the click elsewhere), or the text of
 * the app's toasts, needs a permission that is shown and asked for.
 *
 * The released External Link Warning 2.0.0 declares only `http:proxy` and
 * lives on the link hook, so it keeps it while an admin installed it.
 */
import { describe, it, expect } from 'vitest';
import { mayRegisterHook } from '../permissions';
import { HIGH_RISK_PERMISSIONS, visiblePermissions } from '../permission-text';
import type { InstalledPlugin } from '../../plugin-types';

function plugin(id: string, permissions: string[], extra: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id, name: id, version: '1.0.0', author: 'x', description: '', type: 'hook', entrypoint: 'index.js',
    permissions, enabled: true, status: 'running', managed: true, forceEnabled: false, adminApproved: true, settings: {},
    ...extra,
  } as unknown as InstalledPlugin;
}

describe('hooks behind the implicit ui:observe permission', () => {
  it('a plugin that declares no permission is not handed the links the user opens', () => {
    expect(mayRegisterHook(plugin('sec-zero', []), 'onBeforeExternalLink')).toBe(false);
  });

  it('nor the text of the app toasts', () => {
    expect(mayRegisterHook(plugin('sec-zero', []), 'onToastShow')).toBe(false);
  });

  it('the released external-link-warning (permissions: http:proxy) keeps its link check', () => {
    expect(mayRegisterHook(plugin('external-link-warning', ['http:proxy']), 'onBeforeExternalLink')).toBe(true);
  });

  it('harmless observers stay open to every plugin', () => {
    expect(mayRegisterHook(plugin('sec-zero', []), 'onThemeChange')).toBe(true);
    expect(mayRegisterHook(plugin('sec-zero', []), 'onLocaleChange')).toBe(true);
  });
});

describe('the link check permission', () => {
  it('is shown to the user, and marked as needing care', () => {
    expect(visiblePermissions(['links:check'])).toEqual(['links:check']);
    expect(HIGH_RISK_PERMISSIONS.has('links:check')).toBe(true);
  });

  it('lets an admin-installed plugin that declares it check links', () => {
    expect(mayRegisterHook(plugin('link-checker', ['links:check']), 'onBeforeExternalLink')).toBe(true);
  });

  it('needs the user to allow it for a plugin they installed themselves', () => {
    const own = { managed: false, adminApproved: false } as Partial<InstalledPlugin>;
    expect(mayRegisterHook(plugin('link-checker', ['links:check'], own), 'onBeforeExternalLink')).toBe(false);
    expect(mayRegisterHook(plugin('link-checker', ['links:check'], { ...own, grantedPermissions: ['links:check'] }), 'onBeforeExternalLink')).toBe(true);
  });

  it('is granted to the link checker by id only while an admin installed it', () => {
    expect(mayRegisterHook(plugin('external-link-warning', ['http:proxy'], { managed: false }), 'onBeforeExternalLink')).toBe(false);
    // Nothing else comes with it.
    expect(mayRegisterHook(plugin('external-link-warning', ['http:proxy']), 'onToastShow')).toBe(false);
  });
});

describe('the toast hooks', () => {
  it('go with showing notifications', () => {
    expect(mayRegisterHook(plugin('notifier', ['ui:notifications']), 'onToastShow')).toBe(true);
    expect(mayRegisterHook(plugin('notifier', ['ui:notifications']), 'onToastDismiss')).toBe(true);
    expect(mayRegisterHook(plugin('sec-zero', []), 'onToastDismiss')).toBe(false);
  });
});

describe('observers that stay open to every plugin', () => {
  // Page paths (folder and message ids, no content), error texts and app state.
  it.each(['onNavigate', 'onRouteEnter', 'onRouteLeave', 'onAppError', 'onAppReady', 'onInterval', 'onAccountSwitch', 'onAfterLogout'])('%s', (hook) => {
    expect(mayRegisterHook(plugin('sec-zero', []), hook)).toBe(true);
  });
});
