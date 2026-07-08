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
  removeAllPluginHooks, pluginErrorTracker,
} from '../plugin-hooks';
import { verifyBundle } from './bundle-integrity';
import { createBackgroundInstance } from './host-bridge';
import { resolvePluginTier } from './tier';
import { register as registerActive, deregister as deregisterActive, all as allActiveEntries } from './registry';
import { cancelPluginDialogs } from './host-api';
import { registerShortcuts } from './shortcuts';

// ─── Hook-bus lookup (one flat map for name → bus) ────────────

type AnyBus = { register: (pluginId: string, handler: (...args: unknown[]) => unknown, order?: number) => Disposable };

const HOOK_BUSES: Record<string, AnyBus> = Object.assign({},
  emailHooks, calendarHooks, calendarFormHooks, contactHooks, fileHooks,
  authHooks, settingsHooks, identityHooks, filterHooks,
  taskHooks, templateHooks, smimeHooks, vacationHooks,
  uiHooks, themeHooks, toastHooks, dragDropHooks,
  keyboardHooks, appLifecycleHooks, accountSecurityHooks,
  sidebarAppHooks, avatarHooks, renderHooks, routerHooks,
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

async function getBundleCode(plugin: InstalledPlugin): Promise<string> {
  // Dev plugins are written into IndexedDB by the same install flow; the
  // bundle endpoint is the source of truth for managed plugins. For Phase 1
  // we read from IndexedDB to match the existing flow; the store-side install
  // path already populates this from /api/admin/plugins/[id]/bundle.
  const code = await pluginStorage.getCode(plugin.id);
  if (!code) {
    throw new Error(`No bundle in storage for plugin "${plugin.id}". Reinstall to populate.`);
  }
  await verifyBundle(code, plugin.bundleHash);
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
    const hookDisposables: Disposable[] = [];
    for (const hookName of info.hooks) {
      if (hookName.startsWith('shortcut:')) continue;
      const bus = HOOK_BUSES[hookName];
      if (!bus) {
        console.warn(`[plugin-sandbox] Plugin "${plugin.id}" registered unknown hook "${hookName}"`);
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

    registerActive({
      plugin,
      code,
      tier,
      background: bg,
      slotOffers: info.slots,
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
