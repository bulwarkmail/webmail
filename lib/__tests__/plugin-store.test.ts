import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlotRegistration, InstalledPlugin } from '@/lib/plugin-types';

// We test the raw store by directly invoking Zustand
// Mock the external dependencies the store imports
vi.mock('@/lib/plugin-storage', () => ({
  pluginStorage: {
    saveCode: vi.fn().mockResolvedValue(undefined),
    getCode: vi.fn().mockResolvedValue(null),
    deleteCode: vi.fn().mockResolvedValue(undefined),
    saveThemeCSS: vi.fn().mockResolvedValue(undefined),
    getThemeCSS: vi.fn().mockResolvedValue(null),
    deleteThemeCSS: vi.fn().mockResolvedValue(undefined),
    savePreview: vi.fn().mockResolvedValue(undefined),
    getPreview: vi.fn().mockResolvedValue(null),
    deletePreview: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/plugin-validator', () => ({
  extractPlugin: vi.fn(),
}));

vi.mock('@/lib/plugin-loader', () => ({
  loadPlugin: vi.fn().mockResolvedValue(undefined),
  deactivatePlugin: vi.fn(),
  setPluginStoreAccessor: vi.fn(),
  setupAutoDisable: vi.fn(),
}));

vi.mock('@/lib/plugin-api', () => ({
  setSlotRegistrationBridge: vi.fn(),
}));

vi.mock('@/lib/plugin-hooks', () => ({
  removeAllPluginHooks: vi.fn(),
}));

// Import after mocks
import { usePluginStore } from '@/stores/plugin-store';

function resetStore() {
  usePluginStore.setState({
    plugins: [],
    slots: {
      'toolbar-actions': [],
      'email-banner': [],
      'email-footer': [],
      'composer-toolbar': [],
      'composer-sidebar': [],
      'composer-sidebar-right': [],
      'sidebar-widget': [],
      'email-detail-sidebar': [],
      'settings-section': [],
      'context-menu-email': [],
      'navigation-rail-bottom': [],
      'calendar-event-actions': [],
      'admin-plugin-page': [],
    },
    initialized: false,
  });
}

function mockPlugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: 'test-plugin',
    name: 'Test',
    version: '1.0.0',
    author: 'Test',
    description: '',
    type: 'hook',
    entrypoint: 'index.js',
    permissions: [],
    enabled: false,
    status: 'installed',
    settings: {},
    ...overrides,
  };
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
});

describe('usePluginStore', () => {
  describe('registerSlot / dispose', () => {
    it('adds registration to slot and removes on dispose', () => {
      const { registerSlot } = usePluginStore.getState();
      const reg: SlotRegistration = {
        pluginId: 'p1',
        component: () => null,
        order: 100,
      };
      const disposable = registerSlot('toolbar-actions', reg);
      expect(usePluginStore.getState().slots['toolbar-actions']).toHaveLength(1);
      disposable.dispose();
      expect(usePluginStore.getState().slots['toolbar-actions']).toHaveLength(0);
    });

    it('sorts registrations by order', () => {
      const { registerSlot } = usePluginStore.getState();
      registerSlot('email-banner', { pluginId: 'p1', component: () => null, order: 200 });
      registerSlot('email-banner', { pluginId: 'p2', component: () => null, order: 50 });
      registerSlot('email-banner', { pluginId: 'p3', component: () => null, order: 100 });

      const regs = usePluginStore.getState().slots['email-banner'];
      expect(regs.map(r => r.pluginId)).toEqual(['p2', 'p3', 'p1']);
    });
  });

  describe('setPluginStatus', () => {
    it('updates status for existing plugin', () => {
      usePluginStore.setState({ plugins: [mockPlugin()] });
      usePluginStore.getState().setPluginStatus('test-plugin', 'running');
      expect(usePluginStore.getState().plugins[0].status).toBe('running');
    });

    it('sets error message', () => {
      usePluginStore.setState({ plugins: [mockPlugin()] });
      usePluginStore.getState().setPluginStatus('test-plugin', 'error', 'something broke');
      const p = usePluginStore.getState().plugins[0];
      expect(p.status).toBe('error');
      expect(p.error).toBe('something broke');
    });
  });

  describe('updatePluginSettings', () => {
    it('merges settings', () => {
      usePluginStore.setState({ plugins: [mockPlugin({ settings: { a: 1 } })] });
      usePluginStore.getState().updatePluginSettings('test-plugin', { b: 2 });
      expect(usePluginStore.getState().plugins[0].settings).toEqual({ a: 1, b: 2 });
    });
  });

  describe('disablePlugin', () => {
    it('sets enabled false and status disabled', () => {
      usePluginStore.setState({
        plugins: [mockPlugin({ enabled: true, status: 'running' })],
      });
      usePluginStore.getState().disablePlugin('test-plugin');
      const p = usePluginStore.getState().plugins[0];
      expect(p.enabled).toBe(false);
      expect(p.status).toBe('disabled');
    });
  });

  describe('uninstallPlugin', () => {
    it('removes plugin from list', () => {
      usePluginStore.setState({ plugins: [mockPlugin()] });
      usePluginStore.getState().uninstallPlugin('test-plugin');
      expect(usePluginStore.getState().plugins).toHaveLength(0);
    });

    it('no-op for unknown plugin', () => {
      usePluginStore.setState({ plugins: [mockPlugin()] });
      usePluginStore.getState().uninstallPlugin('unknown');
      expect(usePluginStore.getState().plugins).toHaveLength(1);
    });
  });
});
