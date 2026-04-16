// Plugin Loader - loads and activates plugins via blob URL dynamic import

import type { InstalledPlugin, Disposable } from './plugin-types';
import { pluginStorage } from './plugin-storage';
import { createPluginAPI, type PluginAPI } from './plugin-api';
import { removeAllPluginHooks, pluginErrorTracker } from './plugin-hooks';
import { setPluginI18nLocale, clearPluginI18nTranslations } from './plugin-i18n';
import React from 'react';
import ReactDOM from 'react-dom';
import * as ReactJSX from 'react/jsx-runtime';

// --- Shared React (window.__PLUGIN_EXTERNALS__) -------------

let localeSyncInitialised = false;

export function exposePluginExternals(): void {
  if (typeof window === 'undefined') return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__PLUGIN_EXTERNALS__ = {
    React,
    ReactDOM,
    ReactJSX,
  };

  // Sync plugin i18n with the app locale (runs once per page load)
  if (!localeSyncInitialised) {
    localeSyncInitialised = true;
    // Dynamic import avoids a circular dependency chain at module evaluation time
    import('@/stores/locale-store').then(({ useLocaleStore }) => {
      setPluginI18nLocale(useLocaleStore.getState().locale);
      useLocaleStore.subscribe((state) => setPluginI18nLocale(state.locale));
    }).catch(() => {/* locale sync is best-effort */});
  }
}

// --- Active plugin tracking ----------------------------------

interface ActivePlugin {
  id: string;
  api: PluginAPI;
  disposable?: Disposable;
  deactivate?: () => void;
}

const activePlugins = new Map<string, ActivePlugin>();

// --- Load a single plugin ------------------------------------

type PluginStoreAccessor = {
  setPluginStatus: (id: string, status: InstalledPlugin['status'], error?: string) => void;
};

let storeAccessor: PluginStoreAccessor | null = null;

export function setPluginStoreAccessor(accessor: PluginStoreAccessor): void {
  storeAccessor = accessor;
}

export async function loadPlugin(plugin: InstalledPlugin): Promise<void> {
  if (activePlugins.has(plugin.id)) {
    console.warn(`[plugin-loader] Plugin "${plugin.id}" is already loaded`);
    return;
  }

  // Ensure React/ReactDOM are exposed before any plugin module evaluates
  exposePluginExternals();

  try {
    // 1. Read bundle from IndexedDB
    const code = await pluginStorage.getCode(plugin.id);
    if (!code) {
      throw new Error(`No code found in storage for plugin "${plugin.id}"`);
    }

    // 2. Create scoped module via blob URL
    const blob = new Blob([code], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);

    // 3. Dynamic import (webpackIgnore prevents bundler processing)
    let mod: { activate?: (api: PluginAPI) => void | Disposable; deactivate?: () => void };
    try {
      mod = await import(/* webpackIgnore: true */ url);
    } finally {
      URL.revokeObjectURL(url);
    }

    if (typeof mod.activate !== 'function') {
      throw new Error(`Plugin "${plugin.id}" has no activate() export`);
    }

    // 4. Build sandboxed API
    const api = createPluginAPI(plugin);

    // 4b. Auto-register translations bundled in the manifest (plugin.locales)
    //     Plugins may still call api.i18n.addTranslations() in activate() to add more.
    if (plugin.locales) {
      for (const [locale, strings] of Object.entries(plugin.locales)) {
        api.i18n.addTranslations(locale, strings);
      }
    }

    // 5. Call activate
    const disposable = await mod.activate(api);

    // 6. Track active plugin
    activePlugins.set(plugin.id, {
      id: plugin.id,
      api,
      disposable: disposable && typeof disposable === 'object' && 'dispose' in disposable
        ? disposable as Disposable
        : undefined,
      deactivate: mod.deactivate,
    });

    // 7. Mark running
    storeAccessor?.setPluginStatus(plugin.id, 'running');
    console.info(`[plugin-loader] Plugin "${plugin.id}" activated`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    storeAccessor?.setPluginStatus(plugin.id, 'error', errorMsg);
    console.error(`[plugin-loader] Plugin "${plugin.id}" failed to load:`, err);
  }
}

// --- Deactivate a single plugin ------------------------------

export function deactivatePlugin(pluginId: string): void {
  const active = activePlugins.get(pluginId);
  if (!active) return;

  try {
    // Call deactivate() if provided
    active.deactivate?.();
    // Dispose the disposable returned from activate()
    active.disposable?.dispose();
  } catch (err) {
    console.error(`[plugin-loader] Error deactivating plugin "${pluginId}":`, err);
  }

  // Remove all hook subscriptions for this plugin
  removeAllPluginHooks(pluginId);

  // Clear cached translations (avoids memory leak on repeated enable/disable cycles)
  clearPluginI18nTranslations(pluginId);

  // Reset error tracker
  pluginErrorTracker.reset(pluginId);

  activePlugins.delete(pluginId);
  storeAccessor?.setPluginStatus(pluginId, 'disabled');
  console.info(`[plugin-loader] Plugin "${pluginId}" deactivated`);
}

// --- Activate all enabled plugins ----------------------------

export async function activateAllPlugins(plugins: InstalledPlugin[]): Promise<void> {
  // Ensure externals are exposed
  exposePluginExternals();

  const enabledPlugins = plugins.filter(p => p.enabled && p.status !== 'error');
  for (const plugin of enabledPlugins) {
    await loadPlugin(plugin);
  }
}

// --- Deactivate all plugins ---------------------------------

export function deactivateAllPlugins(): void {
  for (const pluginId of [...activePlugins.keys()]) {
    deactivatePlugin(pluginId);
  }
}

// --- Check if a plugin is active -----------------------------

export function isPluginActive(pluginId: string): boolean {
  return activePlugins.has(pluginId);
}

// --- Setup auto-disable callback -----------------------------

export function setupAutoDisable(): void {
  pluginErrorTracker.setAutoDisableCallback((pluginId) => {
    deactivatePlugin(pluginId);
    storeAccessor?.setPluginStatus(pluginId, 'error', 'Auto-disabled due to repeated errors');
  });
}
