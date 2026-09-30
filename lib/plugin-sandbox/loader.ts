// Iframe-based plugin loader. Replaces the blob-URL `import()` flow in
// `lib/plugin-loader.ts` with a postMessage-isolated sandbox.

import type { Disposable, InstalledPlugin } from '../plugin-types';
import { pluginStorage } from '../plugin-storage';
import {
  emailHooks, calendarHooks, calendarFormHooks, contactHooks, fileHooks,
  authHooks, settingsHooks, identityHooks, filterHooks,
  taskHooks, templateHooks, smimeHooks, vacationHooks,
  uiHooks, themeHooks, toastHooks, dragDropHooks,
  keyboardHooks, appLifecycleHooks, accountSecurityHooks,
  sidebarAppHooks, avatarHooks, renderHooks, routerHooks,
  messageListTabHooks,
  removeAllPluginHooks, pluginErrorTracker,
} from '../plugin-hooks';
import { useMessageListTabsStore } from '@/stores/message-list-tabs-store';
import { verifyBundle } from './bundle-integrity';
import { downloadManagedBundle } from './bundle-fetch';
import { createBackgroundInstance } from './host-bridge';
import { resolvePluginTier } from './tier';
import { register as registerActive, deregister as deregisterActive, all as allActiveEntries } from './registry';
import { cancelPluginDialogs } from './host-api';
import { registerShortcuts } from './shortcuts';
import { mayOfferSlot, mayRegisterHook } from './permissions';

// ─── Hook-bus lookup (one flat map for name → bus) ────────────

type AnyBus = { register: (pluginId: string, handler: (...args: unknown[]) => unknown, order?: number) => Disposable };

const HOOK_BUSES: Record<string, AnyBus> = Object.assign({},
  emailHooks, calendarHooks, calendarFormHooks, contactHooks, fileHooks,
  authHooks, settingsHooks, identityHooks, filterHooks,
  taskHooks, templateHooks, smimeHooks, vacationHooks,
  uiHooks, themeHooks, toastHooks, dragDropHooks,
  keyboardHooks, appLifecycleHooks, accountSecurityHooks,
  sidebarAppHooks, avatarHooks, renderHooks, routerHooks,
  messageListTabHooks,
) as Record<string, AnyBus>;

// ─── Store accessor (status updates flow through the existing store) ──

type StoreAccessor = { setPluginStatus: (id: string, status: InstalledPlugin['status'], error?: string) => void };
let storeAccessor: StoreAccessor | null = null;
export function setSandboxStoreAccessor(a: StoreAccessor): void { storeAccessor = a; }

// ─── Locale (kept in step with the app locale) ────────────────

let currentLocale = 'en';
export function setSandboxLocale(locale: string): void {
  // Ignore empty/falsy values so a not-yet-seeded locale store can't clobber a
  // good locale back to '' - the initial 'en' default stands until the real
  // locale arrives via the store subscription.
  if (!locale) return;
  currentLocale = locale;
  // Background instances read `currentLocale` at load time; the slot-iframe
  // component reads this global at spawn time (plugin-iframe-slot.tsx). Keep
  // both in step from one place. Already-running instances are not re-pushed,
  // so a locale switch only affects plugins/slots loaded afterwards.
  (globalThis as unknown as { __APP_LOCALE__?: string }).__APP_LOCALE__ = locale;
}

// ─── Bundle fetch ─────────────────────────────────────────────

async function readCachedBundle(plugin: InstalledPlugin): Promise<string | null> {
  try {
    return await pluginStorage.getCode(plugin.id);
  } catch (err) {
    // IndexedDB itself is unusable (some private modes, storage disabled). A
    // managed bundle can still be fetched and run from memory; a user upload
    // has no other copy, so surface the storage error for it.
    if (!plugin.managed) throw err;
    console.warn(`[plugin-sandbox] Could not read cached bundle for "${plugin.id}":`, err);
    return null;
  }
}

async function getBundleCode(plugin: InstalledPlugin): Promise<string> {
  // IndexedDB is the fast path: the store's server sync (managed plugins) and
  // the upload flow (user plugins) both populate it. It is per-browser though,
  // while a managed plugin's record travels with the server registry to every
  // user - so the record can exist without a local copy of the bundle: another
  // browser or profile, a private window, cleared site data, an evicted
  // IndexedDB (#636). Managed bundles are re-fetched from the server in that
  // case, signature- and hash-checked, and cached again. User-uploaded
  // bundles only ever existed in this browser, so reinstalling is the only
  // way back for those.
  const cached = await readCachedBundle(plugin);
  if (cached) {
    try {
      await verifyBundle(cached, plugin.bundleHash);
      return cached;
    } catch (err) {
      if (!plugin.managed) throw err;
      // Stale (sync updated the record but not the bytes) or corrupt copy; the
      // server has the canonical bytes, so try those before giving up.
      console.warn(`[plugin-sandbox] Cached bundle for "${plugin.id}" failed verification, re-downloading:`, err);
    }
  }
  if (!plugin.managed) {
    throw new Error(`No bundle in storage for plugin "${plugin.id}". Reinstall to populate.`);
  }

  const code = await downloadManagedBundle(plugin.id, plugin.bundleHash);
  await verifyBundle(code, plugin.bundleHash);
  try {
    await pluginStorage.saveCode(plugin.id, code);
  } catch (err) {
    // Caching is best effort - the plugin runs from the fetched bytes either way.
    console.warn(`[plugin-sandbox] Could not cache bundle for "${plugin.id}":`, err);
  }
  return code;
}

// ─── Load ─────────────────────────────────────────────────────

// Bound on how long the sandbox iframe may take to send back init-done.
// Without this a single misbehaving plugin can hang the whole load loop.
// 30s accommodates Next.js dev-mode per-iframe compile + SSR + hydrate on
// slower machines, while still catching truly stuck plugins.
const INIT_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export async function loadSandboxedPlugin(plugin: InstalledPlugin): Promise<void> {
  if (typeof window === 'undefined') return;

  let background: ReturnType<typeof createBackgroundInstance> | null = null;
  try {
    // Decide the execution tier BEFORE creating any iframe. A refused privileged
    // request is a hard error (never silently downgraded to null-origin).
    const resolution = resolvePluginTier(plugin);
    if (resolution.tier === null) {
      storeAccessor?.setPluginStatus(plugin.id, 'error', resolution.error);
      console.error(`[plugin-sandbox] "${plugin.id}" tier refused: ${resolution.error}`);
      return;
    }
    const tier = resolution.tier;

    const code = await getBundleCode(plugin);
    background = createBackgroundInstance({
      plugin,
      code,
      locale: currentLocale,
      tier,
    });

    // Wait for the background runtime to evaluate the bundle, register hooks,
    // and enumerate slots. Bounded so a stuck iframe doesn't hang activation.
    const bg = background;
    const info = await withTimeout(
      bg.initPromise,
      INIT_TIMEOUT_MS,
      `[plugin-sandbox] "${plugin.id}" init`,
    );

    // Wire hook proxies: every hookName the plugin registered gets a HookBus
    // entry whose handler dispatches into the sandbox. `shortcut:<id>` hooks
    // are dispatched by the keyboard module separately and don't have a bus.
    // A hook hands the plugin data or a say in what the host sends, so it
    // needs the same manifest permission as the matching API call.
    const hookDisposables: Disposable[] = [];
    for (const hookName of info.hooks) {
      if (hookName.startsWith('shortcut:')) continue;
      const bus = HOOK_BUSES[hookName];
      if (!bus) {
        console.warn(`[plugin-sandbox] Plugin "${plugin.id}" registered unknown hook "${hookName}"`);
        continue;
      }
      if (!mayRegisterHook(plugin, hookName)) {
        console.warn(`[plugin-sandbox] Plugin "${plugin.id}" lacks the permission for hook "${hookName}"; not registered`);
        continue;
      }
      const proxy = async (...args: unknown[]) => {
        try {
          return await bg.invokeHook(hookName, args);
        } catch (err) {
          pluginErrorTracker.record(plugin.id, err);
          throw err;
        }
      };
      hookDisposables.push(bus.register(plugin.id, proxy as (...a: unknown[]) => unknown));
    }

    // Install plugin-declared keyboard shortcuts.
    const shortcutDispose = registerShortcuts(bg, info.shortcuts ?? []);
    hookDisposables.push({ dispose: shortcutDispose });

    const slotOffers = info.slots.filter((offer) => {
      if (mayOfferSlot(plugin, offer.name)) return true;
      console.warn(`[plugin-sandbox] Plugin "${plugin.id}" lacks the permission for slot "${offer.name}"; not rendered`);
      return false;
    });

    registerActive({
      plugin,
      code,
      tier,
      background: bg,
      slotOffers,
      hookDisposables,
    });

    storeAccessor?.setPluginStatus(plugin.id, 'running');
    console.info(`[plugin-sandbox] "${plugin.id}" activated (hooks=${info.hooks.length}, slots=${info.slots.length})`);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    storeAccessor?.setPluginStatus(plugin.id, 'error', msg);
    console.error(`[plugin-sandbox] Failed to load "${plugin.id}":`, err);
    // Tear down the hung/failed iframe so it can't keep posting messages or
    // occupy DOM and resources after we've given up on it.
    if (background) {
      try { background.destroy(); } catch { /* ignore */ }
    }
  }
}

// ─── Unload ───────────────────────────────────────────────────

export function unloadSandboxedPlugin(pluginId: string): void {
  const entry = deregisterActive(pluginId);
  if (!entry) return;
  for (const d of entry.hookDisposables) {
    try { d.dispose(); } catch { /* ignore */ }
  }
  removeAllPluginHooks(pluginId);
  // Drop any message-list category tabs the plugin registered so the strip
  // disappears (and the inbox unfilters) the moment the plugin is disabled.
  try { useMessageListTabsStore.getState().clearTabs(pluginId); } catch { /* ignore */ }
  try { entry.background.destroy(); } catch { /* ignore */ }
  cancelPluginDialogs(pluginId);
  pluginErrorTracker.reset(pluginId);
  storeAccessor?.setPluginStatus(pluginId, 'disabled');
  console.info(`[plugin-sandbox] "${pluginId}" deactivated`);
}

// ─── Bulk ─────────────────────────────────────────────────────

export async function activateAllSandboxed(plugins: InstalledPlugin[]): Promise<void> {
  const enabled = plugins.filter(p => p.enabled && p.status !== 'error');
  for (const p of enabled) await loadSandboxedPlugin(p);
}

export function deactivateAllSandboxed(): void {
  // all() returns a fresh array copy, so iterating while unload -> deregister
  // mutates the underlying registry map is safe. (No circular import: registry
  // only pulls in types, so a static import is fine and works under ESM.)
  for (const e of allActiveEntries()) unloadSandboxedPlugin(e.plugin.id);
}

// ─── Auto-disable ─────────────────────────────────────────────

export function setupSandboxAutoDisable(): void {
  pluginErrorTracker.setAutoDisableCallback((pluginId) => {
    unloadSandboxedPlugin(pluginId);
    storeAccessor?.setPluginStatus(pluginId, 'error', 'Auto-disabled due to repeated errors');
  });
}

// ─── Re-export for compat with the existing loader name ───────

export { SandboxInstance } from './host-bridge';
