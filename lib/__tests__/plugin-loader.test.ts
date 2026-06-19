import { describe, it, expect, beforeEach } from 'vitest';
import {
  exposePluginExternals,
  deactivatePlugin,
  isPluginActive,
  deactivateAllPlugins,
} from '../plugin-loader';
import { clearAllHooks, pluginErrorTracker } from '../plugin-hooks';

beforeEach(() => {
  clearAllHooks();
  pluginErrorTracker.resetAll();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).__PLUGIN_EXTERNALS__;
});

describe('exposePluginExternals', () => {
  it('is a no-op that does not publish globals (sandbox injects React per-iframe)', () => {
    exposePluginExternals();
    // The blob-import loader that needed window.__PLUGIN_EXTERNALS__ is gone;
    // exposePluginExternals is kept only as a no-op for legacy callers.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((globalThis as any).__PLUGIN_EXTERNALS__).toBeUndefined();
  });
});

describe('isPluginActive', () => {
  it('returns false for unknown plugin', () => {
    expect(isPluginActive('nonexistent')).toBe(false);
  });
});

describe('deactivatePlugin', () => {
  it('does nothing for unknown plugin (no error)', () => {
    expect(() => deactivatePlugin('nonexistent')).not.toThrow();
  });
});

describe('deactivateAllPlugins', () => {
  it('does not throw when no plugins active', () => {
    expect(() => deactivateAllPlugins()).not.toThrow();
  });
});
