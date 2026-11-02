import { afterEach, describe, expect, it, vi } from 'vitest';
import { slotPropsFor, mayOfferSlot } from '@/lib/plugin-sandbox/permissions';
import { PANEL_SLOTS, onPanelRequest, requestPanel, resetPanelRequests } from '@/lib/plugin-sandbox/panel-requests';
import { isFillableSlot } from '@/lib/plugin-sandbox/slot-layout';
import { ALL_PERMISSIONS, type InstalledPlugin, type Permission } from '@/lib/plugin-types';
import { slotSpec } from '@/lib/plugin-slot-catalog';
import { assistantFeatures } from '@/lib/plugin-sandbox/assistant';
import { runPluginAction } from '@/lib/plugin-sandbox/actions';
import { deregister, register, type ActivePlugin } from '@/lib/plugin-sandbox/registry';
import { APP_SIDE_PANEL_CONTEXT_FIELDS } from '@/lib/plugin-sandbox/assistant/f.types';

// The app-side-panel slot (area f of the assistant's host APIs): a side
// panel in Calendar, Contacts, Files and Settings. Its context carries the
// open event, contact, files or settings page, each behind the permission
// that guards that data elsewhere.

const plugin = (permissions: Permission[]): InstalledPlugin => ({
  id: 'p', name: 'P', version: '1.0.0', author: '', description: '', type: 'ui-extension',
  permissions, grantedPermissions: permissions, entrypoint: 'index.js', enabled: true, status: 'running', settings: {},
});

const context = {
  event: { id: 'e1', title: 'Team offsite' },
  contact: { id: 'c1', fullName: 'Aa Bob' },
  selectedCount: 3,
  files: [{ id: 'f1', name: 'agenda.pdf' }],
  fileCount: 1,
  folder: { id: 'd1', path: '/Projects' },
  page: { id: 'reading', label: 'Reading' },
  secret: 'not in the catalogue',
};

afterEach(() => resetPanelRequests());

describe('app-side-panel', () => {
  it('is a slot of its own permission, fillable, and a panel plugins can open', () => {
    expect(ALL_PERMISSIONS).toContain('ui:side-panel');
    expect(slotSpec('app-side-panel')?.permissions).toEqual(['ui:side-panel']);
    expect(mayOfferSlot(plugin(['ui:side-panel']), 'app-side-panel')).toBe(true);
    expect(mayOfferSlot(plugin(['ui:email-details']), 'app-side-panel')).toBe(false);
    expect(isFillableSlot('app-side-panel')).toBe(true);
    expect(PANEL_SLOTS).toContain('app-side-panel');
    expect(assistantFeatures().sidePanel).toBe(true);
  });

  it('gives the plugin only the parts of the context it has permissions for', () => {
    const props = { view: 'calendar', context, focusRequest: 2 };
    // ui:side-panel alone: the view and the settings page, nothing of the user's data.
    expect(slotPropsFor(plugin(['ui:side-panel']), 'app-side-panel', props)).toEqual({
      view: 'calendar', context: { page: context.page }, focusRequest: 2,
    });
    expect(slotPropsFor(plugin(['ui:side-panel', 'calendar:read']), 'app-side-panel', props).context).toEqual({
      event: context.event, page: context.page,
    });
    expect(slotPropsFor(plugin(['ui:side-panel', 'contacts:read']), 'app-side-panel', props).context).toEqual({
      contact: context.contact, selectedCount: 3, page: context.page,
    });
    expect(slotPropsFor(plugin(['ui:side-panel', 'files:read']), 'app-side-panel', props).context).toEqual({
      files: context.files, fileCount: 1, folder: context.folder, page: context.page,
    });
    // A part the catalogue doesn't name never goes out, whatever the plugin may do.
    const all = slotPropsFor(plugin(['ui:side-panel', 'calendar:read', 'contacts:read', 'files:read']), 'app-side-panel', props);
    expect(all.context).not.toHaveProperty('secret');
    expect(Object.keys(all.context as object).sort()).toEqual(Object.keys(APP_SIDE_PANEL_CONTEXT_FIELDS).sort());
  });

  it("cuts the context the same way in the click that asks the plugin for its dialog (the loader's dispatcher)", async () => {
    // Importing the loader installs its action dispatcher, as in the app.
    await import('@/lib/plugin-sandbox/loader');
    const invokeHook = vi.fn(async () => undefined);
    register({ plugin: plugin(['ui:side-panel', 'calendar:read']), code: '', tier: 'untrusted', background: { invokeHook }, slotOffers: [], hookDisposables: [] } as unknown as ActivePlugin);
    try {
      await runPluginAction('p', 'app-side-panel', 'open', { view: 'contacts', context: { contact: context.contact, page: context.page, secret: 'x' } });
      expect(invokeHook).toHaveBeenCalledWith('onAction', [{ surface: 'app-side-panel', actionId: 'open', context: { view: 'contacts', context: { page: context.page } } }]);
    } finally {
      deregister('p');
    }
    // Garbage in the context is dropped, not passed on.
    expect(slotPropsFor(plugin(['ui:side-panel']), 'app-side-panel', { context: 'x' }).context).toEqual({});
    // The loader's import is slow under load.
  }, 30_000);

  it('tells each plugin whether it may show the panel (sidePanel follows its grant)', () => {
    expect(assistantFeatures(plugin(['ui:side-panel'])).sidePanel).toBe(true);
    // Enabled before an update added the permission: not granted yet.
    const notGranted = { ...plugin(['ui:side-panel']), grantedPermissions: [] };
    expect(assistantFeatures(notGranted).sidePanel).toBe(false);
    expect(assistantFeatures(plugin([])).sidePanel).toBe(false);
  });

  it('routes api.ui.openPanel for it to the view that shows it, and nowhere else', () => {
    expect(requestPanel('p', 'app-side-panel', 'open', undefined)).toBeNull();
    const handler = vi.fn((request: { slot: string }) => (request.slot === 'app-side-panel' ? true : null));
    onPanelRequest(handler);
    expect(requestPanel('p', 'app-side-panel', 'open', undefined)).toBe(true);
    expect(handler).toHaveBeenCalledWith({ pluginId: 'p', slot: 'app-side-panel', mode: 'open' });
    expect(requestPanel('p', 'email-detail-sidebar', 'open', undefined)).toBeNull();
  });
});
