// Iframe-based plugin loader. Replaces the blob-URL `import()` flow in
// `lib/plugin-loader.ts` with a postMessage-isolated sandbox.

import type { Disposable, InstalledPlugin } from '../plugin-types';
import { pluginStorage } from '../plugin-storage';
import {
  emailHooks, calendarHooks, calendarFormHooks, contactHooks, fileHooks,
  authHooks, settingsHooks, identityHooks, filterHooks,
  taskHooks, templateHooks, vacationHooks,
  uiHooks, themeHooks, toastHooks, dragDropHooks,
  keyboardHooks, appLifecycleHooks, accountSecurityHooks,
  sidebarAppHooks, avatarHooks, renderHooks, routerHooks,
  messageListTabHooks,
  removeAllPluginHooks, pluginErrorTracker, setHookDialogGate,
} from '../plugin-hooks';
import { useMessageListTabsStore } from '@/stores/message-list-tabs-store';
import { useEmailStore } from '@/stores/email-store';
import { emailToReadView } from '../plugin-projection';
import { verifyBundle } from './bundle-integrity';
import { downloadManagedBundle } from './bundle-fetch';
import { createBackgroundInstance, forEachInstance, snapshotRegionalSettings, type InitDoneInfo, type RegionalSnapshot } from './host-bridge';
import { resolvePluginTier } from './tier';
import { register as registerActive, deregister as deregisterActive, all as allActiveEntries, get as getActive, subscribe as subscribeActive, type SlotOffer } from './registry';
import { cancelPluginDialogs } from './host-api';
import { hasDialogFor, whenNoDialogFor } from './host-dialog';
import { registerShortcuts } from './shortcuts';
import { mayOfferSlot, mayReceiveHookCall, mayRegisterHook, pluginHasPermission, slotPropsFor } from './permissions';
import { clearPluginActions, setActionDispatcher } from './actions';
import { clearPluginCheckers, setCheckerDispatcher } from './checkers';
import { clearDayLabels } from './day-labels';
import { clearPluginListFilters } from './list-filters';
import { clearPluginPages } from './pages';
import { clearSectionTitle } from './section-titles';
import { clearSidePanel } from './side-panels';
import { cancelPluginProxyRequests } from './proxy-client';
import { cancelConnectFor } from './connect-dialog';
import { isHookHandedOver } from './host-features';
import { hookArgsFor } from './hook-payload';
import { rememberDeclaredHooks } from '../plugin-send-guards';
import type { SlotName } from '../plugin-types';
import { PLUGIN_REFUSED_ERROR, pluginAllowed } from '../outgoing-hosts';

// ─── Hook-bus lookup (one flat map for name → bus) ────────────

type AnyBus = { register: (pluginId: string, handler: (...args: unknown[]) => unknown, order?: number) => Disposable };

const HOOK_BUSES: Record<string, AnyBus> = Object.assign({},
  emailHooks, calendarHooks, calendarFormHooks, contactHooks, fileHooks,
  authHooks, settingsHooks, identityHooks, filterHooks,
  taskHooks, templateHooks, vacationHooks,
  uiHooks, themeHooks, toastHooks, dragDropHooks,
  keyboardHooks, appLifecycleHooks, accountSecurityHooks,
  sidebarAppHooks, avatarHooks, renderHooks, routerHooks,
  messageListTabHooks,
) as Record<string, AnyBus>;

// ─── Store accessor (status updates flow through the existing store) ──

type StoreAccessor = {
  setPluginStatus: (id: string, status: InstalledPlugin['status'], error?: string) => void;
  /** Turn a failing plugin off for good (until the user turns it on again). */
  markAutoDisabled?: (id: string) => void;
};
let storeAccessor: StoreAccessor | null = null;
export function setSandboxStoreAccessor(a: StoreAccessor): void { storeAccessor = a; }

// ─── Locale (kept in step with the app locale) ────────────────

let currentLocale = 'en';
let currentRegionalKey = '';

export function setSandboxLocale(locale: string, regional?: RegionalSnapshot): void {
  // Ignore empty/falsy values so a not-yet-seeded locale store can't clobber a
  // good locale back to '' - the initial 'en' default stands until the real
  // locale arrives via the store subscription.
  if (!locale) return;
  const reg = regional ?? (typeof snapshotRegionalSettings === 'function' ? snapshotRegionalSettings(locale) : undefined);
  const regKey = reg ? JSON.stringify(reg) : '';
  const changed = locale !== currentLocale || regKey !== currentRegionalKey;
  currentLocale = locale;
  currentRegionalKey = regKey;
  // Background instances read `currentLocale` at load time; the slot-iframe
  // component reads this global at spawn time (plugin-iframe-slot.tsx). Keep
  // both in step from one place.
  (globalThis as unknown as { __APP_LOCALE__?: string }).__APP_LOCALE__ = locale;
  if (!changed) return;
  // Running plugins switch too: their slots re-render in the new language
  // and their onLocaleChange handlers run.
  forEachInstance(null, (instance) => instance.setLocale(locale, reg));
  void themeHooks.onLocaleChange.emit({ locale });
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

async function getBundleCode(plugin: InstalledPlugin): Promise<{ code: string; hash: string }> {
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
      return { code: cached, hash: await verifyBundle(cached, plugin.bundleHash) };
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

  const code = await downloadManagedBundle(plugin.id, plugin.bundleHash, {
    requireSignature: plugin.tier === 'privileged',
  });
  const hash = await verifyBundle(code, plugin.bundleHash);
  try {
    await pluginStorage.saveCode(plugin.id, code);
  } catch (err) {
    // Caching is best effort - the plugin runs from the fetched bytes either way.
    console.warn(`[plugin-sandbox] Could not cache bundle for "${plugin.id}":`, err);
  }
  return { code, hash };
}

// ─── Slot offers from the last start ─────────────────────────

// A plugin's slots are fixed exports of its bundle. They used to be known
// only once its background frame had booted and run activate(), so a slot
// frame (a sidebar section, say) started ~1 s after the plugin did, behind
// it. The offers are kept per bundle hash, and a plugin started with the
// same verified bundle offers them right away; its frames then boot next to
// the background one. The real list replaces them when init is done. The
// record only says where to draw: the same permission filter applies and
// the frames run the same verified code. A changed bundle has another hash.
const SLOT_CACHE_PREFIX = 'plugin-slot-offers:';

function readSlotOffers(pluginId: string, hash: string): InitDoneInfo['slots'] | null {
  try {
    const raw = localStorage.getItem(SLOT_CACHE_PREFIX + pluginId);
    if (!raw) return null;
    const rec = JSON.parse(raw) as { hash?: unknown; slots?: unknown };
    if (rec.hash !== hash || !Array.isArray(rec.slots)) return null;
    return rec.slots.filter((o): o is InitDoneInfo['slots'][number] =>
      !!o && typeof o === 'object' && typeof (o as { name?: unknown }).name === 'string');
  } catch {
    return null;
  }
}

function writeSlotOffers(pluginId: string, hash: string, slots: InitDoneInfo['slots']): void {
  try {
    localStorage.setItem(SLOT_CACHE_PREFIX + pluginId, JSON.stringify({ hash, slots }));
  } catch {
    // Storage blocked or full: the next start just waits for init again.
  }
}

/** Forget a plugin's remembered slots (it was removed). */
export function forgetSlotOffers(pluginId: string): void {
  try { localStorage.removeItem(SLOT_CACHE_PREFIX + pluginId); } catch { /* ignore */ }
}

function permittedOffers(plugin: InstalledPlugin, slots: InitDoneInfo['slots'], warn: boolean): SlotOffer[] {
  return slots.filter((offer) => {
    if (mayOfferSlot(plugin, offer.name)) return true;
    if (warn) console.warn(`[plugin-sandbox] Plugin "${plugin.id}" lacks the permission for slot "${offer.name}"; not rendered`);
    return false;
  });
}

// ─── Load ─────────────────────────────────────────────────────

// Bound on how long the sandbox iframe may take to send back init-done.
// Without this a single misbehaving plugin can hang the whole load loop.
// 30s accommodates Next.js dev-mode per-iframe compile + SSR + hydrate on
// slower machines, while still catching truly stuck plugins.
const INIT_TIMEOUT_MS = 30_000;

class InitTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new InitTimeoutError(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

const loading = new Map<string, Promise<void>>();
/** Turned off while starting: a start that timed out doesn't try again. */
const startsCancelled = new Set<string>();

/**
 * Start a plugin. Calling it again for a plugin that is running or still
 * starting does nothing: start-up and a force-enable sync used to both load
 * a plugin, leaving two background iframes whose hooks all fired twice.
 */
export function loadSandboxedPlugin(plugin: InstalledPlugin): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  // Before the registry: a plugin offering remembered slots is registered
  // while it is still starting.
  const pending = loading.get(plugin.id);
  if (pending) {
    startsCancelled.delete(plugin.id);
    return pending;
  }
  if (getActive(plugin.id)) return Promise.resolve();
  const run = startSandboxedPlugin(plugin).finally(() => {
    loading.delete(plugin.id);
    startsCancelled.delete(plugin.id);
  });
  loading.set(plugin.id, run);
  return run;
}

/**
 * Turned off during a start with no remembered slots: unload found nothing
 * registered, so the frame is still up and the status still unset.
 */
function stopCancelledStart(pluginId: string, background: { destroy(): void } | null): void {
  try { background?.destroy(); } catch { /* ignore */ }
  storeAccessor?.setPluginStatus(pluginId, 'disabled');
}

async function startSandboxedPlugin(plugin: InstalledPlugin, retried = false): Promise<void> {
  // A plugin that declares network access doesn't start while third-party
  // traffic is off; the rest run (#903).
  if (!pluginAllowed(plugin)) {
    storeAccessor?.setPluginStatus(plugin.id, 'error', PLUGIN_REFUSED_ERROR);
    console.warn(`[plugin-sandbox] "${plugin.id}" not started: it declares network access and third-party traffic is off`);
    return;
  }

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

    const { code, hash } = await getBundleCode(plugin);
    background = createBackgroundInstance({
      plugin,
      code,
      locale: currentLocale,
      tier,
    });

    const remembered = readSlotOffers(plugin.id, hash);
    if (remembered && remembered.length > 0) {
      registerActive({ plugin, code, tier, background, slotOffers: permittedOffers(plugin, remembered, false), hookDisposables: [] });
    }

    // Wait for the background runtime to evaluate the bundle, register hooks,
    // and enumerate slots. Bounded so a stuck iframe doesn't hang activation.
    const bg = background;
    const info = await withTimeout(
      bg.initPromise,
      INIT_TIMEOUT_MS,
      `[plugin-sandbox] "${plugin.id}" init`,
    );
    if (startsCancelled.has(plugin.id)) {
      stopCancelledStart(plugin.id, bg);
      return;
    }

    // Wire hook proxies: every hookName the plugin registered gets a HookBus
    // entry whose handler dispatches into the sandbox. `shortcut:<id>` hooks
    // are dispatched by the keyboard module separately and don't have a bus.
    // A hook hands the plugin data or a say in what the host sends, so it
    // needs the same manifest permission as the matching API call.
    const hookDisposables: Disposable[] = [];
    let openHandler: ((...args: unknown[]) => unknown) | null = null;
    for (const hookName of info.hooks) {
      if (hookName.startsWith('shortcut:')) continue;
      // Not a bus: the host calls it directly for clicks on this plugin's own
      // actions (see setActionDispatcher below).
      if (hookName === 'onAction') continue;
      const bus = HOOK_BUSES[hookName];
      if (!bus) {
        console.warn(`[plugin-sandbox] Plugin "${plugin.id}" registered unknown hook "${hookName}"`);
        continue;
      }
      if (!mayRegisterHook(plugin, hookName)) {
        console.warn(`[plugin-sandbox] Plugin "${plugin.id}" lacks the permission for hook "${hookName}"; not registered`);
        continue;
      }
      // The bus records a failure once; recording it here too made the
      // three-strikes breaker trip on the second error.
      // While Bulwark does a retired plugin's job itself, that plugin's
      // hook is skipped: copies older than the release that steps back on
      // its own would ask twice (host-features.ts). Asked per call, so
      // turning the core switch off gives the plugin its hook back.
      // Parts of the arguments that need another permission are cut per
      // plugin (hook-payload.ts). A hook whose calls carry data of two kinds
      // (a reminder of an event or of a task) hands each call only to a
      // plugin with its permission.
      const pluginId = plugin.id;
      const proxy = (...args: unknown[]) => (
        isHookHandedOver(pluginId, hookName) || !mayReceiveHookCall(plugin, hookName, args)
          ? undefined
          : bg.invokeHook(hookName, hookArgsFor(plugin, hookName, args))
      );
      hookDisposables.push(bus.register(plugin.id, proxy as (...a: unknown[]) => unknown));
      if (hookName === 'onEmailOpen') openHandler = proxy;
    }

    // Install plugin-declared keyboard shortcuts. A shortcut sees every
    // key press outside text fields, so it needs ui:keyboard like the hooks.
    if ((info.shortcuts ?? []).length > 0) {
      if (pluginHasPermission(plugin, 'ui:keyboard')) {
        const shortcutDispose = registerShortcuts(bg, info.shortcuts ?? []);
        hookDisposables.push({ dispose: shortcutDispose });
      } else {
        console.warn(`[plugin-sandbox] Plugin "${plugin.id}" declares shortcuts without the ui:keyboard permission; not registered`);
      }
    }

    const slotOffers = permittedOffers(plugin, info.slots, true);
    writeSlotOffers(plugin.id, hash, info.slots);
    // Whether it checks mail before sending, for the next start (plugin-send-guards.ts).
    rememberDeclaredHooks(plugin, hash, info.hooks);

    registerActive({
      plugin,
      code,
      tier,
      background: bg,
      slotOffers,
      hookDisposables,
    });

    storeAccessor?.setPluginStatus(plugin.id, 'running');

    // onEmailOpen fires when a message is selected. A plugin that starts
    // while one is already open (page load on a message URL, a plugin turned
    // on later) would otherwise not see it until the next one.
    const openEmail = openHandler ? useEmailStore.getState().selectedEmail : null;
    if (openHandler && openEmail) {
      Promise.resolve(openHandler(emailToReadView(openEmail))).catch((err) => pluginErrorTracker.record(plugin.id, err));
    }
    console.info(`[plugin-sandbox] "${plugin.id}" activated (hooks=${info.hooks.length}, slots=${info.slots.length})`);
  } catch (err) {
    // Turned off while it was starting: unload has set the status.
    if (background?.closed && getActive(plugin.id)?.background !== background) return;
    if (startsCancelled.has(plugin.id)) {
      stopCancelledStart(plugin.id, background);
      return;
    }
    // Offered from the last start: take the slots back down.
    if (background && getActive(plugin.id)?.background === background) deregisterActive(plugin.id);
    // A busy machine can take longer than the limit to boot a frame, and the
    // plugin then stayed off until the next page load: its pages and buttons
    // missing. One more go; plugins start in parallel, so a plugin that
    // really hangs holds up nobody else.
    if (err instanceof InitTimeoutError && !retried && !startsCancelled.has(plugin.id)) {
      console.warn(`[plugin-sandbox] "${plugin.id}" took too long to start, trying once more`);
      try { background?.destroy(); } catch { /* ignore */ }
      return startSandboxedPlugin(plugin, true);
    }
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

// ─── Action clicks ────────────────────────────────────────────

// A click on a button a plugin declared (api.ui.setActions) goes to that
// plugin's background instance as its `onAction` hook, with the surface's
// context cut down to what the plugin may see.
setActionDispatcher(async (pluginId, surface, actionId, context) => {
  const entry = allActiveEntries().find((e) => e.plugin.id === pluginId);
  if (!entry) return;
  const visible = slotPropsFor(entry.plugin, surface as SlotName, context);
  try {
    await entry.background.invokeHook('onAction', [{ surface, actionId, context: visible }]);
  } catch (err) {
    pluginErrorTracker.record(pluginId, err);
  }
});

// ─── Text checkers ────────────────────────────────────────────

// Requests for a checker go to the `checker:<id>` handler the plugin put in
// its background frame when it registered (api.composer.registerChecker).
// A slow or failing checker is not a broken plugin: its server may be down.
// Its errors stay with the composer that asked (shown as "checking
// unavailable") and don't count towards turning the plugin off.
// A plugin registers its checker in activate(), a moment before the loader
// counts it as running: wait for that rather than fail the first check.
async function backgroundOf(pluginId: string) {
  let entry = getActive(pluginId);
  if (!entry) {
    entry = await new Promise<ReturnType<typeof getActive>>((resolve) => {
      const timer = setTimeout(() => { unsubscribe(); resolve(getActive(pluginId)); }, 10_000);
      const unsubscribe = subscribeActive(() => {
        const found = getActive(pluginId);
        if (!found) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(found);
      });
    });
  }
  if (!entry) throw new Error('plugin is not running');
  return entry.background;
}

setCheckerDispatcher({
  check: async (pluginId, checkerId, request) => (await backgroundOf(pluginId)).invokeHook(`checker:${checkerId}`, [request]),
  action: async (pluginId, checkerId, payload) => (await backgroundOf(pluginId)).invokeHook(`checker-action:${checkerId}`, [payload]),
});

// ─── Unload ───────────────────────────────────────────────────

export function unloadSandboxedPlugin(pluginId: string): void {
  if (loading.has(pluginId)) startsCancelled.add(pluginId);
  const entry = deregisterActive(pluginId);
  if (!entry) return;
  for (const d of entry.hookDisposables) {
    try { d.dispose(); } catch { /* ignore */ }
  }
  removeAllPluginHooks(pluginId);
  // Drop any message-list category tabs the plugin registered so the strip
  // disappears (and the inbox unfilters) the moment the plugin is disabled.
  try { useMessageListTabsStore.getState().clearTabs(pluginId); } catch { /* ignore */ }
  // Same for the buttons, list filters, day labels and pages it declared,
  // and anything still running through the proxy for it.
  clearPluginActions(pluginId);
  clearPluginCheckers(pluginId);
  clearPluginListFilters(pluginId);
  clearDayLabels(pluginId);
  clearPluginPages(pluginId);
  clearSectionTitle(pluginId);
  clearSidePanel(pluginId);
  cancelPluginProxyRequests(pluginId);
  cancelConnectFor(pluginId);
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
  setHookDialogGate({ hasOpenDialog: hasDialogFor, whenDialogsClosed: whenNoDialogFor });
  pluginErrorTracker.setAutoDisableCallback((pluginId) => {
    unloadSandboxedPlugin(pluginId);
    if (storeAccessor?.markAutoDisabled) storeAccessor.markAutoDisabled(pluginId);
    else storeAccessor?.setPluginStatus(pluginId, 'error', 'auto-disabled');
    // PluginDialogHost turns this into a toast in the user's language.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('plugin:auto-disabled', { detail: { pluginId } }));
    }
  });
}

// ─── Re-export for compat with the existing loader name ───────

export { SandboxInstance } from './host-bridge';
