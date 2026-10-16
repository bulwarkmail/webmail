// Host-side wrapper around a single sandbox iframe (one per plugin/background,
// plus one per slot mount). Owns the iframe lifecycle and the postMessage RPC.
//
// Origin model: the iframe is `sandbox="allow-scripts"` with no
// `allow-same-origin`, so its origin is opaque ("null"). We can't pin on
// `event.origin`; instead, every inbound message is gated on
// `event.source === iframe.contentWindow`. The iframe's runtime pins the
// parent on the first inbound message.

import type { InstalledPlugin, SlotName, PluginTier } from '../plugin-types';
import { dispatchApiCall } from './host-api';
import { SANDBOX_PATH, SANDBOX_PRIVILEGED_PATH } from './protocol';
import { withBasePath } from '../browser-navigation';
import { snapshotHostTheme, type ThemeSnapshot } from './host-theme';
import { effectiveSettings } from '../plugin-settings';
import { clampSlotHeight, clampSlotWidth, isInlineSlot, MAX_INLINE_SLOT_WIDTH } from './slot-layout';
import type {
  SandboxToHost, HostToSandbox, InitMsg, InitPayload, StreamChunkMsg, StreamEndMsg, StreamProgressMsg,
  FloatingDropdownOpenMsg, FloatingDropdownUpdateMsg, FloatingDropdownCloseMsg,
  FloatingDropdownSelectMsg, FloatingDropdownHighlightMsg, FloatingDropdownDismissMsg,
} from './protocol';

export type FloatingDropdownHostMsg = FloatingDropdownOpenMsg | FloatingDropdownUpdateMsg | FloatingDropdownCloseMsg;

// ─── Callback marshalling ────────────────────────────────────

/**
 * Walks an object graph and replaces any function values with
 * `{ __pluginCallback: id }` markers, registering each function in `table` so
 * the iframe can call back later via 'callback-invoke'. Non-plain values
 * (functions on prototype, DOM nodes, etc.) are dropped.
 */
function encodeCallbacks(
  value: unknown,
  table: Map<string, (...args: unknown[]) => unknown>,
  depth = 0,
): unknown {
  if (depth > 6) return null; // hard cap to avoid pathological graphs
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'function') {
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    table.set(id, value as (...args: unknown[]) => unknown);
    return { __pluginCallback: id };
  }
  if (t !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => encodeCallbacks(v, table, depth + 1));
  }
  // Plain object - copy own enumerable keys.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = encodeCallbacks(v, table, depth + 1);
  }
  return out;
}

// ─── Public option types ─────────────────────────────────────

export interface BackgroundOptions {
  plugin: InstalledPlugin;
  code: string;
  locale: string;
  /** Resolved execution tier (from `resolvePluginTier`). */
  tier: PluginTier;
  /** Where the hidden iframe should attach. Defaults to document.body. */
  hostContainer?: HTMLElement;
}

export interface SlotOptions {
  plugin: InstalledPlugin;
  slot: SlotName;
  code: string;
  locale: string;
  /** Resolved execution tier (from `resolvePluginTier`). */
  tier: PluginTier;
  extraProps: Record<string, unknown>;
  /** Container element the visible slot iframe is mounted into. */
  hostContainer: HTMLElement;
  /** Called whenever the sandbox reports a new content size (width only for inline slots). */
  onResize: (height: number, width?: number) => void;
  /** Called whenever the sandbox requests to open/update/close a floating dropdown. */
  onFloatingDropdown?: (msg: FloatingDropdownHostMsg) => void;
}

export interface InitDoneInfo {
  hooks: string[];
  slots: Array<{ name: SlotName; hasShouldShow: boolean; order: number }>;
  shortcuts: Array<{ id: string; keys: string; label: string; category?: string }>;
}

// ─── Live instances ──────────────────────────────────────────

/**
 * Every iframe currently running, background and slot alike, so a change
 * that concerns a plugin (its settings, the app locale) reaches all of them.
 */
const liveInstances = new Set<SandboxInstance>();

export function forEachInstance(pluginId: string | null, fn: (instance: SandboxInstance) => void): void {
  for (const instance of liveInstances) {
    if (pluginId !== null && instance.pluginId !== pluginId) continue;
    try { fn(instance); } catch { /* one broken iframe must not stop the rest */ }
  }
}

// ─── Theme watcher ───────────────────────────────────────────

// Plugin frames follow the theme the page actually shows, whichever code
// path changed it: the theme store, settings synced from the server after
// load, a custom theme's injected stylesheet. Watching the page itself
// (the root's class and style, the stylesheets in <head>) catches all of
// them; changes are batched to one update per frame.
let themeWatcher: MutationObserver | null = null;
let lastThemeKey = '';

function pushThemeToFrames(): void {
  const theme = snapshotHostTheme();
  const key = JSON.stringify(theme);
  if (key === lastThemeKey) return;
  lastThemeKey = key;
  for (const instance of liveInstances) {
    if (instance.mode !== 'slot') continue;
    try { instance.setTheme(theme); } catch { /* one broken iframe must not stop the rest */ }
  }
}

function ensureThemeWatcher(): void {
  if (themeWatcher || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
  let scheduled = false;
  themeWatcher = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; pushThemeToFrames(); });
  });
  themeWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  themeWatcher.observe(document.head, { childList: true, subtree: true, characterData: true });
  // Breakpoint-dependent tokens (the touch row height) change with the
  // page width, which no mutation reports.
  window.addEventListener('resize', () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; pushThemeToFrames(); });
  });
}

// ─── Sandbox instance ────────────────────────────────────────

export class SandboxInstance {
  readonly iframe: HTMLIFrameElement;
  readonly pluginId: string;
  readonly mode: 'background' | 'slot';
  /** True for the same-origin privileged tier; gates the origin assertion. */
  readonly privileged: boolean;
  /** An inline slot (toolbar row) sized to its content's width. */
  readonly inline: boolean;

  readyPromise: Promise<void>;
  initPromise: Promise<InitDoneInfo>;

  private resolveReady!: () => void;
  private resolveInit!: (info: InitDoneInfo) => void;
  private rejectInit!: (err: Error) => void;
  private listener: (ev: MessageEvent) => void;
  private destroyed = false;

  private pendingHookInvokes = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private pendingShouldShow = new Map<string, (show: boolean) => void>();
  /** Host-side function references the sandbox can call back via 'callback-invoke'. */
  private callbackTable = new Map<string, (...args: unknown[]) => unknown>();
  /** Ids in callbackTable that came from the current props. */
  private propCallbackIds = new Set<string>();

  constructor(
    private plugin: InstalledPlugin,
    initPayload: InitPayload,
    hostContainer: HTMLElement,
    private slotResizeCb: ((height: number, width?: number) => void) | null,
    private slotFloatingDropdownCb?: ((msg: FloatingDropdownHostMsg) => void) | null,
  ) {
    this.pluginId = plugin.id;
    this.mode = initPayload.mode;
    this.privileged = initPayload.tier === 'privileged';
    this.inline = initPayload.mode === 'slot' && isInlineSlot(initPayload.slot);

    // Slot iframes get `extraProps`; encode any function values now so the
    // structured-clone send doesn't drop them.
    if (initPayload.mode === 'slot') {
      const before = new Set(this.callbackTable.keys());
      initPayload.extraProps = encodeCallbacks(initPayload.extraProps, this.callbackTable) as Record<string, unknown>;
      this.propCallbackIds = new Set([...this.callbackTable.keys()].filter((k) => !before.has(k)));
    }

    this.readyPromise = new Promise<void>((res) => { this.resolveReady = res; });
    this.initPromise = new Promise<InitDoneInfo>((res, rej) => {
      this.resolveInit = res;
      this.rejectInit = rej;
    });

    this.iframe = document.createElement('iframe');
    // Privileged tier: same-origin in BOTH dev and prod so the iframe gets real
    // `crypto.subtle` + IndexedDB and can run its own bundled crypto libs. The
    // postMessage RPC membrane still applies; the trust gate is enforced
    // host-side (signature + admin approval) BEFORE this instance is created.
    // Untrusted tier: null-origin in prod; dev adds allow-same-origin only
    // because Next's HMR/dev runtime refuses requests from the opaque ("null")
    // origin a strict sandbox produces (the iframe would never hydrate and
    // `sandbox-ready` would never post).
    const sandboxFlags = this.privileged || process.env.NODE_ENV === 'development'
      ? 'allow-scripts allow-same-origin'
      // allow-forms: plugin UIs can use <form> and get its submit event. The
      // sandbox CSP sets form-action 'none', so a form can't post anywhere.
      : 'allow-scripts allow-forms';
    if (!this.privileged && process.env.NODE_ENV === 'development') warnDevSandboxOnce();
    this.iframe.setAttribute('sandbox', sandboxFlags);
    this.iframe.setAttribute('referrerpolicy', 'no-referrer');
    // "Copy" buttons in plugin UIs. Writing only; reading the clipboard
    // stays off.
    this.iframe.setAttribute('allow', 'clipboard-write');
    this.iframe.title = `plugin-${plugin.id}-${initPayload.mode}`;
    this.iframe.style.border = 'none';
    // The frame's document declares the theme's color-scheme (themeSnapshotToCSS).
    // When the iframe element's own color-scheme differs, the browser paints
    // an opaque canvas behind the frame (white in a dark theme), so the two
    // are always set together.
    if (initPayload.mode === 'slot') this.iframe.style.colorScheme = initPayload.theme.dark ? 'dark' : 'light';
    this.iframe.style.display = 'block';
    if (initPayload.mode === 'background') {
      this.iframe.style.position = 'absolute';
      this.iframe.style.width = '1px';
      this.iframe.style.height = '1px';
      this.iframe.style.opacity = '0';
      this.iframe.style.pointerEvents = 'none';
      this.iframe.style.left = '-9999px';
      this.iframe.setAttribute('aria-hidden', 'true');
    } else if (this.inline) {
      // Starts at the widest it may get; the first resize shrinks it.
      this.iframe.style.width = `${MAX_INLINE_SLOT_WIDTH}px`;
      this.iframe.style.height = '0px';
    } else {
      this.iframe.style.width = '100%';
      this.iframe.style.height = '0px';
    }
    // Prefix with the mount path so the sandbox route resolves under a
    // subpath deployment (NEXT_PUBLIC_BASE_PATH=/webmail). A bare
    // "/plugin-sandbox" would hit the origin root and 404, breaking plugins.
    // Privileged plugins load the same-origin route so the CSP/allow-same-origin
    // pairing is consistent.
    this.iframe.src = withBasePath(this.privileged ? SANDBOX_PRIVILEGED_PATH : SANDBOX_PATH);

    this.listener = (ev) => this.onMessage(ev);
    window.addEventListener('message', this.listener);
    hostContainer.appendChild(this.iframe);
    liveInstances.add(this);
    if (this.mode === 'slot') ensureThemeWatcher();

    // Send init after the iframe runtime signals it's ready.
    this.readyPromise.then(() => {
      if (this.destroyed) return;
      const msg: InitMsg = { type: 'init', payload: initPayload };
      this.send(msg);
    });
  }

  // ─── Internal ───────────────────────────────────────────────

  private send(msg: HostToSandbox): void {
    // targetOrigin '*' is required because the iframe is opaque-origin. The
    // payload contains no host secrets - bundle code and manifest fields the
    // plugin already owns.
    this.iframe.contentWindow?.postMessage(msg, '*');
  }

  private onMessage(ev: MessageEvent): void {
    if (this.destroyed) return;
    if (ev.source !== this.iframe.contentWindow) return;
    // Privileged iframes are same-origin, so we can additionally pin the origin
    // (defence-in-depth on top of the contentWindow check). Untrusted iframes
    // are null-origin (event.origin === "null") in prod and can't be pinned
    // this way, so the contentWindow check above is the sole gate for them.
    if (this.privileged && ev.origin !== window.location.origin) return;
    // Untrusted iframes are opaque-origin, so their messages say "null". A
    // sandboxed frame can still navigate itself; the page it lands on runs
    // outside the sandbox CSP and must not inherit the RPC channel. Dev mode
    // adds allow-same-origin (see the sandbox flags), so it posts as us.
    if (!this.privileged) {
      const expected = process.env.NODE_ENV === 'development' ? window.location.origin : 'null';
      if (ev.origin !== expected) return;
    }
    const msg = ev.data as SandboxToHost;
    if (!msg || typeof (msg as { type?: unknown }).type !== 'string') return;

    switch (msg.type) {
      case 'sandbox-ready':
        this.resolveReady();
        return;

      case 'init-done':
        this.resolveInit({ hooks: msg.hooks, slots: msg.slots, shortcuts: msg.shortcuts ?? [] });
        return;

      case 'init-error':
        this.rejectInit(new Error(msg.error));
        return;

      case 'api-request': {
        const { id, method, args } = msg;
        void (async () => {
          try {
            const result = await dispatchApiCall(this.plugin, method, args ?? [], { privileged: this.privileged, sink: this });
            this.send({ type: 'api-response', id, ok: true, result });
          } catch (err) {
            this.send({ type: 'api-response', id, ok: false, error: (err as Error).message ?? String(err) });
          }
        })();
        return;
      }

      case 'callback-invoke': {
        const { id, callbackId, args } = msg;
        const fn = this.callbackTable.get(callbackId);
        if (!fn) {
          this.send({ type: 'callback-response', id, ok: false, error: `unknown callback ${callbackId}` });
          return;
        }
        void (async () => {
          try {
            const result = await Promise.resolve(fn(...(args ?? [])));
            // Only send back primitives / plain objects; functions inside
            // results would round-trip but we don't support that yet.
            this.send({ type: 'callback-response', id, ok: true, result });
          } catch (err) {
            this.send({ type: 'callback-response', id, ok: false, error: (err as Error).message ?? String(err) });
          }
        })();
        return;
      }

      case 'hook-result': {
        const entry = this.pendingHookInvokes.get(msg.id);
        if (!entry) return;
        this.pendingHookInvokes.delete(msg.id);
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(new Error(msg.error ?? 'hook error'));
        return;
      }

      case 'slot-should-show-result': {
        const cb = this.pendingShouldShow.get(msg.id);
        if (!cb) return;
        this.pendingShouldShow.delete(msg.id);
        cb(msg.show);
        return;
      }

      case 'slot-resize': {
        // The iframe has no intrinsic height - sync it to the content height
        // the sandbox reported, otherwise the wrapper reserves space but the
        // iframe stays at 0px and the slot appears blank. The plugin reports
        // the numbers, so they are clamped: a slot whose content is 100vh
        // tall would otherwise grow with every resize.
        const height = clampSlotHeight(msg.height);
        if (height === null) return;
        const width = this.inline ? clampSlotWidth(msg.width) : null;
        this.iframe.style.height = `${height}px`;
        if (width !== null) this.iframe.style.width = `${width}px`;
        this.slotResizeCb?.(height, width ?? undefined);
        return;
      }

      case 'floating-dropdown-open':
      case 'floating-dropdown-update':
      case 'floating-dropdown-close': {
        this.slotFloatingDropdownCb?.(msg);
        return;
      }
    }
  }

  // ─── Public ─────────────────────────────────────────────────

  /** Dispatch a hook handler inside the sandbox; resolves with its return value. */
  invokeHook(hookName: string, args: unknown[]): Promise<unknown> {
    if (this.destroyed) return Promise.reject(new Error('sandbox destroyed'));
    const id = uid();
    const p = new Promise<unknown>((resolve, reject) => {
      // The bus gives up on a slow handler, but the entry used to stay here
      // until the iframe answered, which a hung plugin never does.
      const timer = setTimeout(() => {
        if (this.pendingHookInvokes.delete(id)) reject(new Error(`hook ${hookName} got no answer`));
      }, HOOK_INVOKE_TTL_MS);
      this.pendingHookInvokes.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
    try {
      this.send({ type: 'hook-invoke', id, hookName, args });
    } catch (err) {
      // Arguments that can't be cloned: fail this call, don't leak it.
      this.pendingHookInvokes.get(id)?.reject(err as Error);
      this.pendingHookInvokes.delete(id);
    }
    return p;
  }

  /** Ask the background instance whether a slot should mount for this context. */
  evaluateShouldShow(slot: SlotName, context: unknown): Promise<boolean> {
    if (this.destroyed) return Promise.resolve(false);
    const id = uid();
    const p = new Promise<boolean>((resolve) => {
      this.pendingShouldShow.set(id, resolve);
    });
    // shouldShow only decides; it gets the data, not the host callbacks.
    // Functions can't be posted at all - sending them threw and took the
    // composer or event form down with it.
    this.send({ type: 'slot-should-show', id, slot, context: withoutFunctions(context) });
    return p;
  }

  /** Streamed proxy responses and upload progress (see proxy-client.ts). */
  sendStream(msg: StreamChunkMsg | StreamEndMsg | StreamProgressMsg): void {
    if (this.destroyed) return;
    if (msg.type === 'stream-chunk') {
      // Hand the buffer over instead of copying it.
      this.iframe.contentWindow?.postMessage(msg, '*', [msg.chunk]);
      return;
    }
    this.send(msg);
  }

  setLocale(locale: string): void {
    if (this.destroyed) return;
    this.send({ type: 'locale-change', locale });
  }

  /** Push a new resolved theme so the slot iframe re-injects its theme CSS. */
  setTheme(theme: ThemeSnapshot): void {
    if (this.destroyed) return;
    this.iframe.style.colorScheme = theme.dark ? 'dark' : 'light';
    this.send({ type: 'theme-change', theme });
  }

  /** Push the plugin's current settings (see effectiveSettings). */
  setSettings(settings: Record<string, unknown>): void {
    if (this.destroyed) return;
    this.send({ type: 'settings-change', settings });
  }

  updateProps(props: Record<string, unknown>): void {
    if (this.destroyed) return;
    // Callbacks from the props being replaced are dropped, so the table
    // holds only what the slot can currently reach.
    const fresh = new Map<string, (...args: unknown[]) => unknown>();
    const encoded = encodeCallbacks(props, fresh) as Record<string, unknown>;
    for (const id of this.propCallbackIds) this.callbackTable.delete(id);
    this.propCallbackIds = new Set(fresh.keys());
    for (const [id, fn] of fresh) this.callbackTable.set(id, fn);
    this.send({ type: 'props-update', props: encoded });
  }

  sendFloatingDropdownEvent(msg: FloatingDropdownSelectMsg | FloatingDropdownHighlightMsg | FloatingDropdownDismissMsg): void {
    if (this.destroyed) return;
    this.send(msg);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    liveInstances.delete(this);
    window.removeEventListener('message', this.listener);
    this.iframe.remove();
    for (const { reject } of this.pendingHookInvokes.values()) {
      reject(new Error('sandbox destroyed'));
    }
    this.pendingHookInvokes.clear();
    this.pendingShouldShow.clear();
    this.callbackTable.clear();
  }
}

/** Copy of a props object with every function left out. */
export function withoutFunctions(value: unknown, depth = 0): unknown {
  if (depth > 6 || typeof value === 'function') return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => withoutFunctions(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'function') continue;
    out[k] = withoutFunctions(v, depth + 1);
  }
  return out;
}

let devSandboxWarned = false;
function warnDevSandboxOnce(): void {
  if (devSandboxWarned) return;
  devSandboxWarned = true;
  console.warn('[plugin-sandbox] next dev runs untrusted plugins same-origin (Next needs it for HMR). '
    + 'They can reach the whole app here; test isolation against a production build.');
}

/** How long the host waits for a hook answer; longer than any bus budget. */
const HOOK_INVOKE_TTL_MS = 11 * 60_000;

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ─── Factory helpers ─────────────────────────────────────────

export function createBackgroundInstance(opts: BackgroundOptions): SandboxInstance {
  const payload: InitPayload = {
    mode: 'background',
    pluginId: opts.plugin.id,
    tier: opts.tier,
    manifest: {
      id: opts.plugin.id,
      version: opts.plugin.version,
      permissions: opts.plugin.permissions,
      settings: effectiveSettings(opts.plugin),
      locales: opts.plugin.locales,
      httpOrigins: opts.plugin.httpOrigins,
    },
    code: opts.code,
    locale: opts.locale,
  };
  return new SandboxInstance(
    opts.plugin,
    payload,
    opts.hostContainer ?? document.body,
    null,
  );
}

export function createSlotInstance(opts: SlotOptions): SandboxInstance {
  const payload: InitPayload = {
    mode: 'slot',
    pluginId: opts.plugin.id,
    tier: opts.tier,
    slot: opts.slot,
    code: opts.code,
    manifest: {
      id: opts.plugin.id,
      version: opts.plugin.version,
      permissions: opts.plugin.permissions,
      settings: effectiveSettings(opts.plugin),
      locales: opts.plugin.locales,
      httpOrigins: opts.plugin.httpOrigins,
    },
    extraProps: opts.extraProps,
    locale: opts.locale,
    theme: snapshotHostTheme(),
  };
  return new SandboxInstance(opts.plugin, payload, opts.hostContainer, opts.onResize, opts.onFloatingDropdown);
}
