// Plugin store - manages installed plugins, slot registrations, and lifecycle

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  InstalledPlugin,
  PluginStatus,
  SlotName,
  SlotRegistration,
  Disposable,
} from '@/lib/plugin-types';
import { pluginStorage } from '@/lib/plugin-storage';
import { extractPlugin } from '@/lib/plugin-validator';
import { loadPlugin, deactivatePlugin, setPluginStoreAccessor, setupAutoDisable } from '@/lib/plugin-loader';
import { setSlotRegistrationBridge } from '@/lib/plugin-api';
import { removeAllPluginHooks } from '@/lib/plugin-hooks';
import { usePolicyStore } from '@/stores/policy-store';
import { apiFetch } from '@/lib/browser-navigation';

// ─── Slot State ──────────────────────────────────────────────

const SLOT_NAMES: SlotName[] = [
  'toolbar-actions', 'email-banner', 'email-footer', 'composer-toolbar', 'composer-sidebar', 'composer-sidebar-right',
  'sidebar-widget', 'email-detail-sidebar', 'settings-section', 'context-menu-email', 'navigation-rail-bottom',
  'calendar-event-actions', 'admin-plugin-page',
];

function emptySlots(): Record<SlotName, SlotRegistration[]> {
  const slots = {} as Record<SlotName, SlotRegistration[]>;
  for (const name of SLOT_NAMES) {
    slots[name] = [];
  }
  return slots;
}

let pluginInitializationPromise: Promise<void> | null = null;

// ─── Store Interface ─────────────────────────────────────────

interface PluginStoreState {
  plugins: InstalledPlugin[];
  slots: Record<SlotName, SlotRegistration[]>;
  initialized: boolean;

  // Management
  installPlugin: (file: File) => Promise<{ success: boolean; error?: string; warnings?: string[] }>;
  uninstallPlugin: (id: string) => void;
  enablePlugin: (id: string) => Promise<void>;
  disablePlugin: (id: string) => void;
  updatePluginSettings: (id: string, settings: Record<string, unknown>) => void;

  // Runtime (called by plugin loader / API bridge)
  registerSlot: (slotName: SlotName, registration: SlotRegistration) => Disposable;
  setPluginStatus: (id: string, status: PluginStatus, error?: string) => void;

  // Init
  initializePlugins: () => Promise<void>;
}

// ─── Store ───────────────────────────────────────────────────

export const usePluginStore = create<PluginStoreState>()(
  persist(
    (set, get) => ({
      plugins: [],
      slots: emptySlots(),
      initialized: false,

      installPlugin: async (file: File) => {
        const result = await extractPlugin(file);
        if (!result.valid || !result.manifest) {
          return { success: false, error: result.errors.join('; '), warnings: result.warnings };
        }

        const { manifest, code } = result;
        const { plugins } = get();

        // Check for duplicate
        const existing = plugins.find(p => p.id === manifest.id);
        if (existing) {
          // Update: deactivate old, replace
          deactivatePlugin(manifest.id);
        }

        const plugin: InstalledPlugin = {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          author: manifest.author,
          description: manifest.description,
          type: manifest.type,
          permissions: manifest.permissions,
          entrypoint: manifest.entrypoint,
          enabled: false, // Start disabled, user must enable
          status: 'installed',
          managed: false,
          forceEnabled: false,
          adminApproved: false, // Requires admin approval before it can be enabled
          settings: existing?.settings ?? {},
          settingsSchema: manifest.settingsSchema,
        };

        // Save code to IndexedDB
        await pluginStorage.saveCode(manifest.id, code);

        if (existing) {
          set({ plugins: plugins.map(p => p.id === manifest.id ? plugin : p) });
        } else {
          set({ plugins: [...plugins, plugin] });
        }

        return { success: true, warnings: result.warnings };
      },

      uninstallPlugin: (id: string) => {
        const { plugins } = get();
        const plugin = plugins.find(p => p.id === id);
        if (!plugin) return;
        const forceEnabledByPolicy = usePolicyStore.getState().isPluginForceEnabled(id);
        if (plugin.forceEnabled || forceEnabledByPolicy) return;

        // Deactivate if running
        deactivatePlugin(id);
        removeAllPluginHooks(id);

        // Clean up storage
        pluginStorage.deleteCode(id);
        pluginStorage.deletePreview(id);

        // Remove plugin-scoped localStorage entries
        if (typeof window !== 'undefined') {
          const prefix = `plugin:${id}:`;
          const keysToRemove: string[] = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith(prefix)) keysToRemove.push(key);
          }
          keysToRemove.forEach(k => localStorage.removeItem(k));
        }

        set({ plugins: plugins.filter(p => p.id !== id) });
      },

      enablePlugin: async (id: string) => {
        const { plugins } = get();
        const plugin = plugins.find(p => p.id === id);
        if (!plugin) return;

        // Block enabling if plugin requires admin approval and hasn't been approved
        const requireApproval = usePolicyStore.getState().isFeatureEnabled('requirePluginApproval');
        const isApproved = plugin.adminApproved || plugin.managed || usePolicyStore.getState().isPluginApproved(id);
        if (requireApproval && !isApproved) return;

        // Ensure bridges are wired before loading (may not have run initializePlugins yet)
        setPluginStoreAccessor({ setPluginStatus: get().setPluginStatus });
        setSlotRegistrationBridge(get().registerSlot);

        set({
          plugins: plugins.map(p =>
            p.id === id ? { ...p, enabled: true, status: 'enabled' as PluginStatus, error: undefined } : p
          ),
        });

        // Load it immediately
        const updatedPlugin = get().plugins.find(p => p.id === id);
        if (updatedPlugin) {
          await loadPlugin(updatedPlugin);
        }
      },

      disablePlugin: (id: string) => {
        const { plugins } = get();
        const plugin = plugins.find(p => p.id === id);
        if (!plugin) return;
        const forceEnabledByPolicy = usePolicyStore.getState().isPluginForceEnabled(id);
        if (plugin.forceEnabled || forceEnabledByPolicy) return;

        deactivatePlugin(id);

        set({
          plugins: plugins.map(p =>
            p.id === id ? { ...p, enabled: false, status: 'disabled' as PluginStatus, error: undefined } : p
          ),
        });
      },

      updatePluginSettings: (id: string, settings: Record<string, unknown>) => {
        const { plugins } = get();
        set({
          plugins: plugins.map(p =>
            p.id === id ? { ...p, settings: { ...p.settings, ...settings } } : p
          ),
        });
      },

      registerSlot: (slotName: SlotName, registration: SlotRegistration): Disposable => {
        set(state => ({
          slots: {
            ...state.slots,
            [slotName]: [
              ...state.slots[slotName],
              registration,
            ].sort((a, b) => a.order - b.order),
          },
        }));

        return {
          dispose: () => {
            set(state => ({
              slots: {
                ...state.slots,
                [slotName]: state.slots[slotName].filter(r => r !== registration),
              },
            }));
          },
        };
      },

      setPluginStatus: (id: string, status: PluginStatus, error?: string) => {
        set(state => ({
          plugins: state.plugins.map(p =>
            p.id === id ? { ...p, status, error } : p
          ),
        }));
      },

      initializePlugins: async () => {
        if (get().initialized) return;

        if (pluginInitializationPromise) {
          await pluginInitializationPromise;
          return;
        }

        pluginInitializationPromise = (async () => {
          // Clean up any previously persisted duplicates by plugin id.
          const deduped = dedupeInstalledPlugins(get().plugins);
          if (deduped.length !== get().plugins.length) {
            set({ plugins: deduped });
          }

          // Wire up bridges
          setPluginStoreAccessor({
            setPluginStatus: get().setPluginStatus,
          });
          setSlotRegistrationBridge(get().registerSlot);
          setupAutoDisable();

          // Sync server-managed plugins before loading
          await syncServerPlugins(get, set);

          // Load all enabled plugins
          const enabledPlugins = get().plugins.filter(p => p.enabled && p.status !== 'error');
          for (const plugin of enabledPlugins) {
            await loadPlugin(plugin);
          }

          set({ initialized: true });
        })();

        try {
          await pluginInitializationPromise;
        } finally {
          pluginInitializationPromise = null;
        }
      },
    }),
    {
      name: 'plugin-storage',
      partialize: (state) => ({
        plugins: state.plugins.map(p => ({
          ...p,
          // Reset runtime state on persist
          status: p.enabled ? 'enabled' : 'installed',
          error: undefined,
        })),
        // Don't persist slots - they are runtime-only, rebuilt on load
      }),
      onRehydrateStorage: () => {
        return (state) => {
          if (state) {
            state.plugins = markServerManagedPlugins(state.plugins);
            state.plugins = dedupeInstalledPlugins(state.plugins);
            // Ensure slots are initialized after rehydration
            state.slots = emptySlots();
            state.initialized = false;
          }
        };
      },
    }
  )
);

// ─── Server Plugin Sync ──────────────────────────────────────

interface ServerPluginInfo {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  type: string;
  permissions: string[];
  entrypoint: string;
  forceEnabled: boolean;
}

const SERVER_MANAGED_KEY = 'server-managed-plugin-ids';

function getServerManagedPluginIds(): Set<string> {
  try {
    const raw = localStorage.getItem(SERVER_MANAGED_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

function setServerManagedPluginIds(ids: Set<string>): void {
  try {
    localStorage.setItem(SERVER_MANAGED_KEY, JSON.stringify([...ids]));
  } catch { /* ok */ }
}

function dedupeInstalledPlugins(plugins: InstalledPlugin[]): InstalledPlugin[] {
  const byId = new Map<string, InstalledPlugin>();

  for (const plugin of plugins) {
    const existing = byId.get(plugin.id);
    if (!existing) {
      byId.set(plugin.id, plugin);
      continue;
    }

    byId.set(plugin.id, {
      ...existing,
      ...plugin,
      enabled: existing.enabled || plugin.enabled,
      status: existing.enabled || plugin.enabled ? 'enabled' : plugin.status,
      settings: { ...existing.settings, ...plugin.settings },
      error: plugin.error ?? existing.error,
      managed: existing.managed || plugin.managed,
      forceEnabled: existing.forceEnabled || plugin.forceEnabled,
    });
  }

  return [...byId.values()];
}

function markServerManagedPlugins(plugins: InstalledPlugin[]): InstalledPlugin[] {
  const serverIds = getServerManagedPluginIds();
  if (serverIds.size === 0) return plugins;
  return plugins.map(plugin =>
    serverIds.has(plugin.id) ? { ...plugin, managed: true } : plugin
  );
}

/**
 * Sync server-managed plugins to the client.
 * Downloads missing plugin bundles and installs them into IndexedDB + store.
 * Force-enabled plugins are auto-enabled.
 * Plugins removed from the server are cleaned up from the client.
 */
async function syncServerPlugins(
  get: () => PluginStoreState,
  set: (partial: Partial<PluginStoreState> | ((state: PluginStoreState) => Partial<PluginStoreState>)) => void,
): Promise<void> {
  try {
    const res = await apiFetch('/api/plugins');
    if (!res.ok) return;

    const data: { plugins: ServerPluginInfo[] } = await res.json();
    if (!data.plugins || !Array.isArray(data.plugins)) return;

    const serverPlugins = data.plugins;
    const serverPluginIds = new Set(serverPlugins.map(p => p.id));

    // Track which plugins came from the server (so we can clean up stale ones)
    const prevServerIds = getServerManagedPluginIds();

    // Install or update server plugins that are missing/outdated locally
    for (const sp of serverPlugins) {
      const local = get().plugins.find(p => p.id === sp.id);

      if (!local) {
        // New server plugin - download and install
        const code = await downloadPluginBundle(sp.id);
        if (!code) continue;

        await pluginStorage.saveCode(sp.id, code);

        const plugin: InstalledPlugin = {
          id: sp.id,
          name: sp.name,
          version: sp.version,
          author: sp.author,
          description: sp.description,
          type: sp.type as InstalledPlugin['type'],
          permissions: sp.permissions,
          entrypoint: sp.entrypoint,
          enabled: sp.forceEnabled,
          status: sp.forceEnabled ? 'enabled' : 'installed',
          managed: true,
          forceEnabled: sp.forceEnabled,
          adminApproved: true, // Server-managed plugins are always approved
          settings: {},
        };

        set(state => {
          if (state.plugins.some(p => p.id === sp.id)) {
            return {};
          }
          return { plugins: [...state.plugins, plugin] };
        });
      } else if (local.version !== sp.version) {
        // Version changed - re-download bundle
        const code = await downloadPluginBundle(sp.id);
        if (!code) continue;

        await pluginStorage.saveCode(sp.id, code);

        set(state => ({
          plugins: state.plugins.map(p =>
            p.id === sp.id
              ? {
                  ...p,
                  name: sp.name,
                  version: sp.version,
                  author: sp.author,
                  description: sp.description,
                  permissions: sp.permissions,
                  entrypoint: sp.entrypoint,
                  managed: true,
                  forceEnabled: sp.forceEnabled,
                }
              : p
          ),
        }));
      } else if (local.managed !== true || local.forceEnabled !== sp.forceEnabled) {
        set(state => ({
          plugins: state.plugins.map(p =>
            p.id === sp.id
              ? {
                  ...p,
                  managed: true,
                  forceEnabled: sp.forceEnabled,
                }
              : p
          ),
        }));
      } else if (sp.forceEnabled && !local.enabled) {
        // Force-enable if the server says so but client has it disabled
        set(state => ({
          plugins: state.plugins.map(p =>
            p.id === sp.id
              ? { ...p, enabled: true, status: 'enabled' as const, managed: true, forceEnabled: true }
              : p
          ),
        }));
      }
    }

    // Ensure no duplicate IDs remain after sync.
    set(state => ({ plugins: dedupeInstalledPlugins(state.plugins) }));

    // Remove plugins that were previously server-managed but no longer on the server
    const staleIds = [...prevServerIds].filter(id => !serverPluginIds.has(id));
    if (staleIds.length > 0) {
      for (const id of staleIds) {
        deactivatePlugin(id);
        removeAllPluginHooks(id);
        pluginStorage.deleteCode(id);
      }
      const staleSet = new Set(staleIds);
      set(state => ({
        plugins: state.plugins.filter(p => !staleSet.has(p.id)),
      }));
    }

    // Persist current server plugin IDs for future cleanup
    setServerManagedPluginIds(serverPluginIds);
  } catch {
    // Sync failure is non-fatal - client continues with local plugins
    console.warn('[plugin-store] Server plugin sync failed, using local plugins only');
  }
}

async function downloadPluginBundle(pluginId: string): Promise<string | null> {
  try {
    const res = await apiFetch(`/api/admin/plugins/${encodeURIComponent(pluginId)}/bundle`);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    console.warn(`[plugin-store] Failed to download bundle for plugin "${pluginId}"`);
    return null;
  }
}
