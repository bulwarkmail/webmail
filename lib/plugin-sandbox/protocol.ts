// Shared message-protocol types for host ↔ sandbox postMessage RPC.
//
// In production the sandbox iframe is null-origin (`sandbox="allow-scripts"`),
// so postMessage events arrive with `event.origin === "null"`. In development
// the iframe also gets `allow-same-origin` so Next's HMR/dev runtime works;
// `event.origin` is then the host's actual origin. The host pins messages by
// the iframe's `contentWindow` reference in either case. All values crossing
// the boundary must be structured-cloneable: no functions, no DOM nodes, no
// class instances.

import type { SlotName, PluginTier } from '../plugin-types';
import type { ThemeSnapshot } from './host-theme';

// ─── Sandbox mode ────────────────────────────────────────────

export type SandboxMode = 'background' | 'slot';

/** Initialisation payload for a background-instance iframe (one per plugin). */
export interface BackgroundInit {
  mode: 'background';
  pluginId: string;
  /**
   * Execution tier. 'privileged' iframes are same-origin (real WebCrypto +
   * IndexedDB); 'untrusted' iframes are null-origin. Decided host-side by
   * `resolvePluginTier`; the sandbox itself does not act on this field.
   */
  tier: PluginTier;
  /** Trimmed manifest visible to the plugin. No host secrets. */
  manifest: {
    id: string;
    version: string;
    permissions: string[];
    settings: Record<string, unknown>;
    locales?: Record<string, Record<string, string>>;
    httpOrigins?: string[];
  };
  /** UTF-8 plugin bundle source (CommonJS). */
  code: string;
  /** Initial app locale; host pushes updates via 'locale-change'. */
  locale: string;
}

/** Initialisation payload for a slot-instance iframe (one per slot mount). */
export interface SlotInit {
  mode: 'slot';
  pluginId: string;
  /** Execution tier (mirrors `BackgroundInit.tier`). */
  tier: PluginTier;
  /** Slot name the iframe should render a component for. */
  slot: SlotName;
  /** Same bundle code as the background instance. */
  code: string;
  /**
   * Trimmed manifest (mirrors `BackgroundInit.manifest`). Slot iframes get the
   * same fields so `api.plugin.settings` and `httpOrigins` work identically
   * to the background context.
   */
  manifest: {
    id: string;
    version: string;
    permissions: string[];
    settings: Record<string, unknown>;
    locales?: Record<string, Record<string, string>>;
    httpOrigins?: string[];
  };
  /**
   * Initial props the host passes through from `PluginSlot` `extraProps`.
   * Function values are pre-encoded by the host as
   * `{ __pluginCallback: '<id>' }` markers and rehydrated to stub functions
   * by the runtime; the stubs round-trip to the host via 'callback-invoke'.
   */
  extraProps: Record<string, unknown>;
  locale: string;
  /**
   * Resolved host theme (colour tokens, font stack, dark flag). The sandbox
   * can't load globals.css/fonts cross-origin, so the runtime replays this as
   * injected CSS + a `.dark` class. Host pushes updates via 'theme-change'.
   */
  theme: ThemeSnapshot;
}

export type InitPayload = BackgroundInit | SlotInit;

// ─── Sandbox → Host messages ─────────────────────────────────

export interface ReadyMsg { type: 'sandbox-ready'; }

export interface InitDoneMsg {
  type: 'init-done';
  /** Hook names the plugin registered. The host installs proxy handlers. */
  hooks: string[];
  /** Slots the plugin claims. Used by the host to know when a slot is offered. */
  slots: Array<{ name: SlotName; hasShouldShow: boolean; order: number }>;
  /**
   * Keyboard shortcuts the plugin declares. The host installs a global
   * keydown listener that dispatches to the `shortcut:<id>` hook when the
   * combo matches. `keys` is a `+`-separated string like "Ctrl+Shift+L".
   */
  shortcuts: Array<{ id: string; keys: string; label: string; category?: string }>;
}

export interface InitErrorMsg { type: 'init-error'; error: string; }

export interface ApiRequestMsg {
  type: 'api-request';
  id: string;
  /** Dotted method path, e.g. "http.post", "storage.get", "admin.getConfig". */
  method: string;
  args: unknown[];
}

/** Sandbox → host: invoke a function the host passed in via `extraProps`. */
export interface CallbackInvokeMsg {
  type: 'callback-invoke';
  /** Round-trip id so the host can return a value if the caller awaits. */
  id: string;
  /** The callback marker id (matches `__pluginCallback`). */
  callbackId: string;
  args: unknown[];
}

/** Host → sandbox: response to a callback-invoke. */
export interface CallbackResponseMsg {
  type: 'callback-response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface HookResultMsg {
  type: 'hook-result';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface SlotResizeMsg {
  type: 'slot-resize';
  height: number;
}

export interface SlotShouldShowResultMsg {
  type: 'slot-should-show-result';
  id: string;
  show: boolean;
}

export type SandboxToHost =
  | ReadyMsg
  | InitDoneMsg
  | InitErrorMsg
  | ApiRequestMsg
  | CallbackInvokeMsg
  | HookResultMsg
  | SlotResizeMsg
  | SlotShouldShowResultMsg;

// ─── Host → Sandbox messages ─────────────────────────────────

export interface InitMsg { type: 'init'; payload: InitPayload; }

export interface ApiResponseMsg {
  type: 'api-response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface HookInvokeMsg {
  type: 'hook-invoke';
  id: string;
  hookName: string;
  args: unknown[];
}

export interface LocaleChangeMsg { type: 'locale-change'; locale: string; }

/** Host → sandbox: the resolved theme changed; re-inject the slot's theme CSS. */
export interface ThemeChangeMsg { type: 'theme-change'; theme: ThemeSnapshot; }

export interface PropsUpdateMsg { type: 'props-update'; props: Record<string, unknown>; }

export interface SlotShouldShowMsg {
  type: 'slot-should-show';
  id: string;
  slot: SlotName;
  context: unknown;
}

export type HostToSandbox =
  | InitMsg
  | ApiResponseMsg
  | CallbackResponseMsg
  | HookInvokeMsg
  | LocaleChangeMsg
  | ThemeChangeMsg
  | PropsUpdateMsg
  | SlotShouldShowMsg;

/** Marker used in extraProps for function values that the host owns. */
export interface PluginCallbackMarker {
  __pluginCallback: string;
}

export function isCallbackMarker(value: unknown): value is PluginCallbackMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { __pluginCallback?: unknown }).__pluginCallback === 'string'
  );
}

// ─── Type guards ─────────────────────────────────────────────

export function isSandboxMessage(value: unknown): value is SandboxToHost {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

// ─── Constants ───────────────────────────────────────────────

/** Path used for the untrusted (null-origin) sandbox iframe `src`. Matched in
 * `proxy.ts` for CSP. */
export const SANDBOX_PATH = '/plugin-sandbox';

/**
 * Path used for the privileged (same-origin) sandbox iframe `src`. A distinct
 * route so the iframe gets `allow-same-origin` (real WebCrypto + IndexedDB)
 * while keeping the same CSP relaxations as the untrusted sandbox. Matched in
 * `proxy.ts`. Renders the identical `SandboxRuntime`.
 */
export const SANDBOX_PRIVILEGED_PATH = '/plugin-sandbox-privileged';

/** Methods callable by a plugin via api-request. Host enforces permissions. */
export const API_METHODS = [
  'storage.get', 'storage.set', 'storage.remove', 'storage.keys',
  'http.post', 'http.fetch',
  'webauthn.getOrCreate',
  'jmap.fetchBlob', 'jmap.sendRaw',
  'admin.getConfig', 'admin.getAllConfig', 'admin.setConfig', 'admin.deleteConfig',
  'toast.success', 'toast.error', 'toast.info', 'toast.warning',
  'ui.confirm', 'ui.alert', 'ui.prompt', 'ui.rerenderEmail', 'ui.openExternalUrl',
] as const;

export type ApiMethod = (typeof API_METHODS)[number];
