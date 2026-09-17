// Plugin store - manages installed plugins and lifecycle. Slot registrations
// are owned by `lib/plugin-sandbox/registry` (per-iframe), not by the store.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { InstalledPlugin, PluginStatus, PluginTier } from '@/lib/plugin-types';
import { pluginStorage } from '@/lib/plugin-storage';
import { extractPlugin } from '@/lib/plugin-validator';
import { loadPlugin, deactivatePlugin, setPluginStoreAccessor, setupAutoDisable, setSandboxLocale } from '@/lib/plugin-loader';
import { useLocaleStore } from '@/stores/locale-store';
import { getEffectiveLocale } from '@/i18n/detect-locale';
import { removeAllPluginHooks } from '@/lib/plugin-hooks';
import { requestConsent } from '@/lib/plugin-sandbox/consent';
import { sha256Hex } from '@/lib/plugin-sandbox/bundle-integrity';
import { downloadManagedBundle } from '@/lib/plugin-sandbox/bundle-fetch';
import { usePolicyStore } from '@/stores/policy-store';
import { apiFetch } from '@/lib/browser-navigation';
import { IMPLICIT_PERMISSIONS } from '@/lib/plugin-types';
import type { Permission } from '@/lib/plugin-types';

let pluginInitializationPromise: Promise<void> | null = null;
// One-time guard so we attach the locale->sandbox subscription only once.
let localeSubscribed = false;

// ─── Store Interface ─────────────────────────────────────────

interface PluginStoreState {
  plugins: InstalledPlugin[];
  initialized: boolean;

  // Management
  installPlugin: (file: File) => Promise<{ success: boolean; error?: string; warnings?: string[] }>;
  uninstallPlugin: (id: string) => void;
  enablePlugin: (id: string) => Promise<void>;
  disablePlugin: (id: string) => void;
  updatePluginSettings: (id: string, settings: Record<string, unknown>) => void;

  // Runtime (called by plugin loader)
  setPluginStatus: (id: string, status: PluginStatus, error?: string) => void;

  // Init
  initializePlugins: () => Promise<void>;
}

// ─── Store ───────────────────────────────────────────────────

export const usePluginStore = create<PluginStoreState>()(
  persist(
    (set, get) => ({
      plugins: [],
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

        // Compute bundleHash so the admin-approval gate can pin to this
        // specific bundle (server-side state keys on (id, hash) pairs).
        const bundleHash = await sha256Hex(code).catch(() => undefined);

        const plugin: InstalledPlugin = {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          author: manifest.author,
          description: manifest.description,
          type: manifest.type,
          ...(manifest.tier ? { tier: manifest.tier } : {}),
          permissions: manifest.permissions,
          entrypoint: manifest.entrypoint,
          enabled: false, // Start disabled, user must enable
          status: 'installed',
          managed: false,
          forceEnabled: false,
          adminApproved: false, // Requires admin approval before it can be enabled
          settings: existing?.settings ?? {},
          settingsSchema: manifest.settingsSchema,
          ...(bundleHash ? { bundleHash } : {}),
          ...(manifest.httpOrigins && manifest.httpOrigins.length > 0
            ? { httpOrigins: manifest.httpOrigins }
            : {}),
          ...(manifest.apiPostPaths && manifest.apiPostPaths.length > 0
            ? { apiPostPaths: manifest.apiPostPaths }
            : {}),
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

        // Admin approval gate. Managed (admin-pushed) plugins are pre-
        // approved. For user-installed plugins the server-side state is
        // authoritative: the client-only `isPluginApproved` flag is kept as
        // a fast-path hint but the server result wins.
        const requireApproval = usePolicyStore.getState().isFeatureEnabled('requirePluginApproval');
        const policyApproved = plugin.adminApproved || plugin.managed || usePolicyStore.getState().isPluginApproved(id);
        if (requireApproval && !policyApproved && plugin.bundleHash) {
          const status = await checkServerApproval(plugin.id, plugin.bundleHash).catch(() => null);
          if (status?.status === 'approved') {
            // Approval available; proceed.
          } else if (status?.status === 'denied') {
            set(state => ({
              plugins: state.plugins.map(p =>
                p.id === id ? { ...p, status: 'error' as PluginStatus, error: 'Plugin denied by administrator' } : p
              ),
            }));
            return;
          } else {
            // 'pending' or 'not-requested' - submit a request and refuse to enable.
            await submitApprovalRequest(plugin).catch(() => { /* best effort */ });
            set(state => ({
              plugins: state.plugins.map(p =>
                p.id === id ? { ...p, status: 'error' as PluginStatus, error: 'Awaiting administrator approval' } : p
              ),
            }));
            return;
          }
        } else if (requireApproval && !policyApproved) {
          // No bundleHash means we can't pin the approval - refuse.
          return;
        }

        // Per-user consent gate: prompt for any permission the user has not
        // explicitly approved yet. Managed plugins (admin-pushed) skip this -
        // the admin has already approved them at install time.
        const implicit = new Set<string>(IMPLICIT_PERMISSIONS);
        const granted = new Set<string>(plugin.grantedPermissions ?? []);
        const missing = (plugin.permissions ?? [])
          .filter((p): p is Permission => !!p)
          .filter((p) => !implicit.has(p) && !granted.has(p));
        if (missing.length > 0 && !plugin.managed) {
          const accepted = await requestConsent(plugin.id, plugin.name, missing as Permission[]);
          if (!accepted) return;
          // Persist the grants so future enables don't re-prompt.
          const allGranted = [...new Set<string>([...granted, ...missing])];
          set(state => ({
            plugins: state.plugins.map(p =>
              p.id === id ? { ...p, grantedPermissions: allGranted } : p
            ),
          }));
        }

        // Ensure bridge is wired before loading (may not have run initializePlugins yet)
        setPluginStoreAccessor({ setPluginStatus: get().setPluginStatus });

        set(state => ({
          plugins: state.plugins.map(p =>
            p.id === id ? { ...p, enabled: true, status: 'enabled' as PluginStatus, error: undefined } : p
          ),
        }));

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
          setupAutoDisable();
          // Keep the sandbox locale in step with the app locale. Set it
          // synchronously *before* activation so background instances get the
          // right locale in their init payload (the bug: the only wiring lived
          // in the dead activateAllPlugins() path, so the sandbox locale stayed
          // 'en' forever and plugin i18n never localized). Subscribe once for
          // later language switches; those affect plugins/slots loaded after.
          //
          // Use getEffectiveLocale(), NOT the raw store value: the stored
          // choice is '' by default and stays '' under "Automatic" (see
          // language-switcher.tsx / settings/language-settings.tsx) - the
          // app's own UI resolves that via document.documentElement.lang /
          // detectBrowserLocale (see i18n/detect-locale.ts), so a plugin
          // reading the raw store value would see an empty string (falling
          // back to English) even when the app itself is fully localized to
          // the visitor's browser language. Found via a plugin dev report:
          // native UI in Hungarian, plugin's own i18n stuck on English.
          setSandboxLocale(getEffectiveLocale());
          if (!localeSubscribed) {
            localeSubscribed = true;
            useLocaleStore.subscribe(() => setSandboxLocale(getEffectiveLocale()));
          }

          // Sync server-managed plugins before loading
          await syncServerPlugins(get, set);

          // Load all enabled plugins in parallel. Sequential `await` made one
          // hung/slow plugin block every subsequent one; loadSandboxedPlugin
          // catches its own errors so allSettled is just for tidy completion.
          const enabledPlugins = get().plugins.filter(p => p.enabled && p.status !== 'error');
          await Promise.allSettled(enabledPlugins.map(plugin => loadPlugin(plugin)));

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
      }),
      onRehydrateStorage: () => {
        return (state) => {
          if (state) {
            state.plugins = markServerManagedPlugins(state.plugins);
            state.plugins = dedupeInstalledPlugins(state.plugins);
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
  /** Requested execution tier (privileged plugins run same-origin). */
  tier?: PluginTier;
  permissions: string[];
  entrypoint: string;
  forceEnabled: boolean;
  /** Content hash of the bundle - changes whenever code changes, even if the version doesn't */
  bundleHash?: string;
  updatedAt?: string;
  /** True when the plugin was loaded from the server's PLUGIN_DEV_DIR */
  dev?: boolean;
  /** Allowlist of origins this plugin may target via api.http.fetch(). */
  httpOrigins?: string[];
  /** Allowlist of same-origin /api/* paths this plugin may target via api.http.post(). */
  apiPostPaths?: string[];
  /** Per-user settings schema, captured from the manifest server-side. */
  settingsSchema?: InstalledPlugin['settingsSchema'];
  /** Plugin-declared i18n tables (locale -> key -> string), from the manifest. */
  locales?: InstalledPlugin['locales'];
}

/**
 * Server-owned metadata, passed through verbatim on every sync. Centralised in
 * ONE place so a newly added passthrough field can't be silently dropped at one
 * of several copy sites - which is exactly what previously lost `settingsSchema`
 * (hence the old "schema drift" special-case) and then `locales`. Excludes
 * fields the client owns (id, type, enabled/status, settings, adminApproved).
 */
function serverMeta(sp: ServerPluginInfo) {
  return {
    name: sp.name,
    version: sp.version,
    author: sp.author,
    description: sp.description,
    permissions: sp.permissions,
    entrypoint: sp.entrypoint,
    ...(sp.tier ? { tier: sp.tier } : {}),
    managed: true as const,
    forceEnabled: sp.forceEnabled,
    bundleHash: sp.bundleHash,
    httpOrigins: sp.httpOrigins,
    apiPostPaths: sp.apiPostPaths,
    settingsSchema: sp.settingsSchema,
    locales: sp.locales,
  };
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
        // New server plugin - download bundle and install.
        const code = await downloadPluginBundle(sp.id, sp.bundleHash);
        if (!code) continue;
        await pluginStorage.saveCode(sp.id, code);

        const plugin: InstalledPlugin = {
          id: sp.id,
          type: sp.type as InstalledPlugin['type'],
          enabled: sp.forceEnabled,
          status: sp.forceEnabled ? 'enabled' : 'installed',
          adminApproved: true, // Server-managed plugins are always approved
          settings: {},
          ...serverMeta(sp),
        };
        set(state =>
          state.plugins.some(p => p.id === sp.id)
            ? {}
            : { plugins: [...state.plugins, plugin] },
        );
        continue;
      }

      // Existing plugin. Re-download the bundle only when the code actually
      // changed or the local copy is gone, but ALWAYS re-derive server-owned
      // metadata from one place (serverMeta) so no passthrough field is
      // silently dropped on a metadata-only change. Only write when something
      // differs, to avoid a needless persist/re-render on every sync.
      //
      // The record (persisted store) and the bundle (IndexedDB) have separate
      // lifetimes: the bundle can be evicted, cleared, or never have been
      // written in this browser while the record says everything is current.
      // The loader used to strand such plugins on "No bundle in storage" with
      // no way for a non-admin to recover (#636); a missing local copy is
      // treated exactly like a changed one instead.
      const hasLocalBundle = await pluginStorage.getCode(sp.id)
        .then((code) => !!code)
        .catch(() => false);
      const needsBundle =
        !hasLocalBundle ||
        local.version !== sp.version ||
        // bundleHash mismatch covers re-uploads of the same version with new
        // code; a falsy local hash (older installs) also forces a refresh so
        // we capture the hash on the next sync.
        (!!sp.bundleHash && local.bundleHash !== sp.bundleHash);

      if (needsBundle) {
        const code = await downloadPluginBundle(sp.id, sp.bundleHash);
        if (!code) continue;
        await pluginStorage.saveCode(sp.id, code);
      }

      // Force-enable in the same pass when the server flips it on, so the user
      // doesn't need a second refresh for it to run.
      const shouldAutoEnable = sp.forceEnabled && !local.enabled;
      const next: InstalledPlugin = {
        ...local,
        ...serverMeta(sp),
        ...(shouldAutoEnable ? { enabled: true, status: 'enabled' as const } : {}),
      };
      if (needsBundle || JSON.stringify(next) !== JSON.stringify(local)) {
        set(state => ({
          plugins: state.plugins.map(p => (p.id === sp.id ? next : p)),
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

/**
 * Download + signature-check a managed bundle; `null` (after logging) on any
 * failure so the sync loop skips that plugin and carries on with the rest.
 * The sandbox loader shares the same download path
 * (`lib/plugin-sandbox/bundle-fetch`) to refill a missing bundle at load time.
 */
async function downloadPluginBundle(pluginId: string, bundleHash?: string): Promise<string | null> {
  try {
    return await downloadManagedBundle(pluginId, bundleHash);
  } catch (err) {
    console.error(`[plugin-store] ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ─── Server-side admin-approval helpers ───────────────────────

async function checkServerApproval(pluginId: string, bundleHash: string): Promise<{ status: 'pending' | 'approved' | 'denied' | 'not-requested' } | null> {
  try {
    const url = `/api/plugin-approval-status?pluginId=${encodeURIComponent(pluginId)}&bundleHash=${encodeURIComponent(bundleHash)}`;
    const res = await apiFetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function submitApprovalRequest(plugin: InstalledPlugin): Promise<void> {
  if (!plugin.bundleHash) return;
  try {
    await apiFetch('/api/plugin-approval-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pluginId: plugin.id,
        bundleHash: plugin.bundleHash,
        manifest: {
          name: plugin.name,
          version: plugin.version,
          author: plugin.author,
          description: plugin.description,
          permissions: plugin.permissions,
          httpOrigins: plugin.httpOrigins,
          apiPostPaths: plugin.apiPostPaths,
        },
      }),
    });
  } catch {
    /* best effort */
  }
}
