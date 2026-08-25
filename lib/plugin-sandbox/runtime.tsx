'use client';

// Runtime that boots inside the null-origin plugin sandbox iframe.
//
// Lifecycle:
//   1. Iframe loads → posts 'sandbox-ready' to parent (targetOrigin '*' is OK;
//      the message carries no secrets, and the parent's first inbound message
//      gives us the origin to pin for everything that follows).
//   2. Parent posts 'init' with the bundle code + manifest + mode/slot.
//   3. We evaluate the bundle in a `new Function` scope with React/ReactDOM
//      injected as globals; the bundle is CommonJS-style (`module.exports = {
//      slots, hooks, activate }`). ES-module syntax inside the bundle is a
//      build-time concern handled by the plugin's bundler.
//   4. In background mode: register hook handlers and call `activate(api)`.
//      The host installs HookBus stubs and dispatches via 'hook-invoke'.
//   5. In slot mode: look up `slots[slot].component`, render it into the
//      iframe body, push height back via ResizeObserver.

import { useEffect } from 'react';
import * as React from 'react';
import * as ReactDOM from 'react-dom/client';
import * as ReactJSXRuntime from 'react/jsx-runtime';
import type {
  HostToSandbox,
  SandboxToHost,
  InitPayload,
  BackgroundInit,
  SlotInit,
} from './protocol';
import { themeSnapshotToCSS, type ThemeSnapshot } from './host-theme';
import type { SlotName } from '../plugin-types';
import { ContactCard } from '../jmap/types';
import { EncryptionAtRestConfig, PublicKeyInput } from '@/stores/account-security-store';

// ─── Module-scope state ──────────────────────────────────────

interface PluginExports {
  slots?: Record<string, { component: React.ComponentType<Record<string, unknown>>; shouldShow?: (ctx: unknown) => boolean; order?: number }>;
  hooks?: Record<string, (...args: unknown[]) => unknown>;
  /**
   * Keyboard shortcut bindings. Each entry's `handler` is registered as a
   * hook named `shortcut:<id>` so the host's keydown dispatcher can fire it.
   */
  shortcuts?: Record<string, {
    keys: string;
    label: string;
    category?: string;
    handler: () => void | Promise<void>;
  }>;
  activate?: (api: unknown) => void | Promise<void> | { dispose: () => void };
  default?: unknown;
}

let parentWindow: Window | null = null;
let parentOrigin: string | null = null;
let pluginExports: PluginExports | null = null;
let mode: 'background' | 'slot' | null = null;
let slotName: SlotName | null = null;
let bootDone = false;
// Guards the initial sandbox-ready post against React strict mode's double
// useEffect invocation; the parent only needs to be pinged once per iframe.
let readyPosted = false;

const pendingApi = new Map<string, { resolve: (v: unknown) => void; reject: (err: Error) => void }>();
const pendingCallbacks = new Map<string, { resolve: (v: unknown) => void; reject: (err: Error) => void }>();
const hookHandlers: Record<string, (...args: unknown[]) => unknown> = {};

function sendToHost(msg: SandboxToHost): void {
  if (!parentWindow || !parentOrigin) return;
  parentWindow.postMessage(msg, parentOrigin);
}

// ─── Theme replay ────────────────────────────────────────────

const THEME_STYLE_ID = '__plugin_host_theme';

/**
 * Replay a host theme snapshot inside the iframe: inject the token + font CSS
 * and mirror the `.dark` class onto <html> so plugin styles that key off
 * `.dark` (or read `var(--color-*)`) behave like the host. Idempotent — safe
 * to call again on every 'theme-change'.
 */
function applyHostTheme(theme: ThemeSnapshot): void {
  if (typeof document === 'undefined') return;
  let styleEl = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = THEME_STYLE_ID;
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = themeSnapshotToCSS(theme);
  document.documentElement.classList.toggle('dark', theme.dark);
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ─── Sandboxed API facade (calls flow to host via postMessage) ─

const DEFAULT_API_TIMEOUT_MS = 30_000;
// http.post / http.fetch can be carrying an attachment to an external store,
// which is a transfer rather than a round-trip - 30s is not enough for the
// files a plugin has any reason to offload. Still bounded so a hung host
// can't leak the pending promise.
const NETWORK_API_TIMEOUT_MS = 120_000;

function callApi(method: string, args: unknown[], timeoutMs: number = DEFAULT_API_TIMEOUT_MS): Promise<unknown> {
  const id = uid();
  return new Promise((resolve, reject) => {
    pendingApi.set(id, { resolve, reject });
    sendToHost({ type: 'api-request', id, method, args });
    // Bounded so a hung host can't leak the promise forever. Interactive UI
    // dialogs (ui.confirm/ui.alert) pass timeoutMs <= 0 to opt out: they wait
    // for human input, the host always resolves them on confirm/cancel/close,
    // and any still-pending call dies with the iframe on teardown - so there's
    // nothing to leak, and a thinking user must not trip a 30s timeout.
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      setTimeout(() => {
        const entry = pendingApi.get(id);
        if (!entry) return;
        pendingApi.delete(id);
        entry.reject(new Error(`API call ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    }
  });
}

function invokeHostCallback(callbackId: string, args: unknown[]): Promise<unknown> {
  const id = uid();
  return new Promise((resolve, reject) => {
    pendingCallbacks.set(id, { resolve, reject });
    sendToHost({ type: 'callback-invoke', id, callbackId, args });
    setTimeout(() => {
      const entry = pendingCallbacks.get(id);
      if (!entry) return;
      pendingCallbacks.delete(id);
      entry.reject(new Error('host callback timed out after 30s'));
    }, 30_000);
  });
}

/**
 * Walks an object graph received from the host and rehydrates
 * `{ __pluginCallback: id }` markers into stub functions that round-trip via
 * the 'callback-invoke' RPC. Mirrors `encodeCallbacks` in host-bridge.ts.
 */
function decodeCallbacks(value: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => decodeCallbacks(v, depth + 1));
  const obj = value as Record<string, unknown>;
  if (typeof obj.__pluginCallback === 'string') {
    const cbId = obj.__pluginCallback;
    return (...args: unknown[]) => invokeHostCallback(cbId, args);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = decodeCallbacks(v, depth + 1);
  }
  return out;
}

type PluginManifest = BackgroundInit['manifest'];

type PluginKeywordVisibility = 'show' | 'hide' | 'unread';

interface PluginKeywordDefinition {
  id: string;
  label: string;
  color: string;
  visibility?: PluginKeywordVisibility;
}

type PluginKeywordDefinitionInput = Omit<PluginKeywordDefinition, 'color'> & { color?: string };

interface PluginKeywordCounts {
  total: number;
  unread: number;
}

function buildPluginApi(manifest: PluginManifest) {
  return {
    plugin: {
      id: manifest.id,
      version: manifest.version,
      settings: { ...manifest.settings },
    },
    crypto: {
      getPublicKeys: () => callApi('crypto.getPublicKeys', []),
      createPublicKey: (input: PublicKeyInput) => callApi('crypto.createPublicKey', [input]),
      removePublicKey: (keyId: string) => callApi('crypto.removePublicKey', [keyId]),
      setEncryptionAtRest: (config: EncryptionAtRestConfig) => callApi('crypto.setEncryptionAtRest', [config]),
      getEncryptionAtRest: () => callApi('crypto.getEncryptionAtRest', []),
      getWebAuthn: (masterCredentialIdBytes: number[]) => callApi('crypto.getWebAuthn', [masterCredentialIdBytes, manifest.id], 0),
      createWebAuthn: (name: string, displayName: string) => callApi('crypto.createWebAuthn', [manifest.id, name, displayName], 0),
      getPublicKeyFromWKD: (email: string) => callApi('crypto.getPublicKeyFromWKD', [email]),
    },
    storage: {
      get: (key: string) => callApi('storage.get', [key]),
      set: (key: string, value: unknown) => callApi('storage.set', [key, value]),
      remove: (key: string) => callApi('storage.remove', [key]),
      keys: () => callApi('storage.keys', []),
    },
    user: {
      getAccounts: () => callApi('user.getAccounts', []),
      getIdentities: () => callApi('user.getIdentities', []),
      logout: () => callApi('user.logout', []),
    },
    http: {
      // A Blob/File body is sent as a binary request; options.headers may then
      // carry Content-Type and X-Plugin-* metadata for the receiving route.
      // Any other body keeps the stock JSON behaviour.
      post: (path: string, body: Record<string, unknown> | Blob, options?: { headers?: Record<string, string> }) =>
        callApi('http.post', [path, body, options], NETWORK_API_TIMEOUT_MS),
      fetch: (url: string, init?: unknown) => callApi('http.fetch', [url, init], NETWORK_API_TIMEOUT_MS),
    },
    // Safe keyword methods are available to untrusted plugins with the
    // matching email permission. Raw blob/submission methods remain restricted
    // to the privileged tier for crypto plugins.
    jmap: {
      /**
       * Enumerate keywords in the active account. JMAP servers supporting
       * Keyword/get supply exact counts and provider-label metadata; other
       * servers fall back to scanning message keywords.
       */
      getKeywords: (options?: { limit?: number }) =>
        callApi('jmap.getKeywords', [options]) as Promise<{
          keywords: Record<string, number>;
          scanned: number;
          total: number;
          complete: boolean;
          labels: Array<{
            id: string;
            name: string;
            color: string | null;
            total: number;
            unread: number;
            isProviderLabel: boolean;
            source: 'provider' | 'message';
          }>;
        }>,
      /**
       * Replace an email's complete keyword map. Omitted keywords are removed;
       * use api.email.setKeyword/removeKeyword for an incremental mutation.
       */
      setKeywords: (emailId: string, keywords: Record<string, true>, accountId?: string) =>
        callApi('jmap.setKeywords', [emailId, keywords, accountId]) as Promise<void>,
      /** Add one keyword without changing the message's other keywords. */
      setKeyword: (emailId: string, keyword: string, accountId?: string) =>
        callApi('jmap.setKeyword', [emailId, keyword, accountId]) as Promise<void>,
      /** Remove one keyword without changing the message's other keywords. */
      removeKeyword: (emailId: string, keyword: string, accountId?: string) =>
        callApi('jmap.removeKeyword', [emailId, keyword, accountId]) as Promise<void>,
      /** Fetch a blob's raw bytes by id. Resolves to a Uint8Array. */
      fetchBlob: (blobId: string, opts?: { name?: string; type?: string, rangeHeader?: number }) =>
        callApi('jmap.fetchBlob', [blobId, opts]) as Promise<Uint8Array>,
      uploadBlob: (content: Uint8Array, name: string, type: string) =>
        callApi('jmap.uploadBlob', [content, name, type]) as Promise<{ blobId: string; size: number; type: string; }>,
      /** Submit a fully-formed raw RFC822 message (already signed/encrypted). */
      sendRaw: (
        rawBytes: ArrayBuffer | ArrayBufferView,
        identityId: string,
        opts?: { delayedUntil?: string; envelopeRecipients?: string[] },
      ) => callApi('jmap.sendRaw', [rawBytes, identityId, opts]),
      /** Submit without putting in sent box a fully-formed raw RFC822 message (already signed/encrypted). */
      submitRaw: (
        rawBytes: ArrayBuffer | ArrayBufferView,
        identityId: string,
        opts?: { delayedUntil?: string; envelopeRecipients?: string[] },
      ) => callApi('jmap.submitRaw', [rawBytes, identityId, opts]),
      /** Import a fully-formed raw RFC822 message into the user's mailbox. */
      importRaw: (
        rawBytes: ArrayBuffer | ArrayBufferView,
        mailboxRoles: string[],
        opts?:  { keywords?: Record<string, boolean>; accountId?: string },
      ) => callApi('jmap.importRaw', [rawBytes, mailboxRoles, opts]),
    },
    contacts: {
      get: (contactId: string) => callApi('contact.get', [contactId]) as Promise<ContactCard>,
      update: (contactId: string, updates: Partial<ContactCard>) => callApi('contact.update', [contactId, updates]),
      create: (contact: ContactCard) => callApi('contact.create', [contact]) as Promise<string>,
      search: (query: string) => callApi('contact.search', [query]) as Promise<ContactCard[]>,
    },
    /**
     * Used to alterate files before they are uploaded to server.
     * Edited files are saved on indexedDB and remove once the upload to server begins.
     * `get` needs the email:blob-read permission. `save` needs
     * email:blob-write AND the privileged tier - replacing the bytes of a file
     * the user is about to send is not something an untrusted plugin may do.
     */
    upfiles: {
      save: (formerFileId:string, file:File) =>
        callApi('upfiles.save', [formerFileId, file]) as Promise<string>,
      get: (fileId:string) =>
        callApi('upfiles.get', [fileId]) as Promise<File>,
    },
    toast: {
      success: (m: string) => { void callApi('toast.success', [m]); },
      error: (m: string) => { void callApi('toast.error', [m]); },
      info: (m: string) => { void callApi('toast.info', [m]); },
      warning: (m: string) => { void callApi('toast.warning', [m]); },
    },
    ui: {
      /** Opens a host-rendered confirm dialog. Resolves to true on confirm, false otherwise.
       *  No timeout - it waits for the user's choice. */
      confirm: (opts: { title?: string; message?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }) =>
        callApi('ui.confirm', [opts], 0) as Promise<boolean>,
      /** Opens a host-rendered alert (one button). Resolves once dismissed. No timeout. */
      alert: (opts: { title?: string; message?: string; confirmLabel?: string }) =>
        callApi('ui.alert', [opts], 0) as Promise<void>,
      /** Opens a host-rendered prompt collecting one or more (optionally masked)
       *  fields. Resolves to a name→value map on submit, or null if cancelled.
       *  No timeout. */
      prompt: (opts: {
        title?: string;
        message?: string;
        confirmLabel?: string;
        cancelLabel?: string;
        fields?: Array<{ name: string; label: string; type?: 'text' | 'password'; placeholder?: string; required?: boolean }>;
      }) => callApi('ui.prompt', [opts], 0) as Promise<Record<string, string> | null>,
      /** Re-runs the onRenderEmailBody hook for the open message (e.g. after a
       *  crypto plugin unlocks a key) so its body re-renders without a reload. */
      rerenderEmail: () => callApi('ui.rerenderEmail', []) as Promise<void>,
      rerenderFetchedEmails: () => callApi('ui.rerenderFetchedEmails', []) as Promise<void>,
      /** Opens an http/https URL in a new tab via host `window.open`. */
      openExternalUrl: (url: string, target?: string) =>
        callApi('ui.openExternalUrl', [url, target]) as Promise<void>,
      /** Downloads a file generated by the plugin. Not a user's file or attachment. */
      downloadFile: (opts: { content: string; filename: string; contentType?: string }) =>
        callApi('ui.downloadFile', [opts]) as Promise<void>,
    },
    // Email keyword mutations (permission: email:write). Keywords follow JMAP
    // syntax, e.g. '$category-promotions' or '$label:<tagId>'.
    email: {
      setKeyword: (emailId: string, keyword: string, accountId?: string) =>
        callApi('email.setKeyword', [emailId, keyword, accountId]) as Promise<void>,
      removeKeyword: (emailId: string, keyword: string, accountId?: string) =>
        callApi('email.removeKeyword', [emailId, keyword, accountId]) as Promise<void>,
    },
    // Native sidebar tag definitions. Definition reads/writes use the existing
    // settings permissions; server discovery and message counts use email:read.
    // add() is intentionally append-only. reorder() requires a complete
    // permutation of existing ids. Neither method overwrites or removes tags.
    keywords: {
      list: () => callApi('keywords.list', []) as Promise<PluginKeywordDefinition[]>,
      add: (definitions: PluginKeywordDefinitionInput[]) =>
        callApi('keywords.add', [definitions]) as Promise<{
          added: PluginKeywordDefinition[];
          skipped: string[];
        }>,
      reorder: (ids: string[], options?: { caseSensitive?: boolean }) =>
        callApi('keywords.reorder', [ids, options]) as Promise<PluginKeywordDefinition[]>,
      discover: (options?: { limit?: number }) =>
        callApi('keywords.discover', [options]) as Promise<{
          keywords: Record<string, number>;
          scanned: number;
          total: number;
          complete: boolean;
        }>,
      getCounts: (ids?: string[]) =>
        callApi('keywords.getCounts', [ids]) as Promise<Record<string, PluginKeywordCounts>>,
      refreshCounts: () =>
        callApi('keywords.refreshCounts', []) as Promise<Record<string, PluginKeywordCounts>>,
    },
    // Message-list category tabs (permission: ui:message-list-tabs; categorize
    // additionally needs email:write). The host renders the strip natively and
    // ANDs the active tab's JMAP search filter (`query`) or keyword into the
    // mailbox Email/query - see MessageListTabsConfig in plugin-types. Tabs
    // are cleared automatically when the plugin unloads.
    tabs: {
      /** Register (or replace) this plugin's tab set. */
      set: (config: unknown) => callApi('tabs.set', [config]) as Promise<void>,
      /** Remove this plugin's tabs from the strip. */
      clear: () => callApi('tabs.clear', []) as Promise<void>,
      /** Current merged tabs, active tab id and unread counts. */
      getState: () => callApi('tabs.getState', []) as Promise<{
        tabs: unknown[]; activeTabId: string | null; tabCounts: Record<string, number>;
      }>,
      /** Re-query per-tab unread counts for the current mailbox. */
      refreshCounts: () => callApi('tabs.refreshCounts', []) as Promise<Record<string, number>>,
      /**
       * Move messages to a tab (patches the category keywords via Email/set).
       * Fires onBeforeEmailCategorize (cancellable) and onEmailCategorize.
       * Resolves false when cancelled.
       */
      categorize: (emailIds: string[], tabId: string) =>
        callApi('tabs.categorize', [emailIds, tabId]) as Promise<boolean>,
    },
    // Sieve integration for delivery-time classification (permissions:
    // filters:read / filters:write). Plugins never write scripts directly -
    // they register an onSieveScriptGenerate transform hook and call
    // regenerate(), so user filter rules and plugin sections coexist in the
    // single active script.
    sieve: {
      isSupported: () => callApi('sieve.isSupported', []) as Promise<boolean>,
      getActiveScript: () => callApi('sieve.getActiveScript', []) as Promise<{ id: string; name: string; content: string } | null>,
      validateScript: (content: string) =>
        callApi('sieve.validateScript', [content]) as Promise<{ isValid: boolean; errors?: string[] }>,
      /** Rebuild + re-upload the active script, running onSieveScriptGenerate. */
      regenerate: () => callApi('sieve.regenerate', []) as Promise<void>,
    },
    admin: {
      getConfig: (key: string) => callApi('admin.getConfig', [key]),
      getAllConfig: () => callApi('admin.getAllConfig', []),
      setConfig: (key: string, v: unknown) => callApi('admin.setConfig', [key, v]),
      deleteConfig: (key: string) => callApi('admin.deleteConfig', [key]),
    },
    log: {
      debug: (...a: unknown[]) => console.debug(`[plugin:${manifest.id}]`, ...a),
      info:  (...a: unknown[]) => console.info(`[plugin:${manifest.id}]`, ...a),
      warn:  (...a: unknown[]) => console.warn(`[plugin:${manifest.id}]`, ...a),
      error: (...a: unknown[]) => console.error(`[plugin:${manifest.id}]`, ...a),
    },
    // Localization for plugins. The host pushes the active locale (init +
    // 'locale-change'); `t` resolves a key against the plugin's declared
    // `locales` map (manifest.locales), falling back to English then the key
    // itself, with optional {placeholder} interpolation.
    i18n: {
      get locale(): string {
        return (globalThis as unknown as { __PLUGIN_LOCALE__?: string }).__PLUGIN_LOCALE__ || 'en';
      },
      t(key: string, vars?: Record<string, string | number>): string {
        const loc = (globalThis as unknown as { __PLUGIN_LOCALE__?: string }).__PLUGIN_LOCALE__ || 'en';
        const tables = manifest.locales || {};
        let out = tables[loc]?.[key] ?? tables['en']?.[key] ?? key;
        if (vars) {
          for (const [k, v] of Object.entries(vars)) {
            out = out.split('{' + k + '}').join(String(v));
          }
        }
        return out;
      },
    },
  };
}

// ─── Bundle evaluation ───────────────────────────────────────

/**
 * Resolve a bundler-emitted `require(name)` call inside the sandbox. Plugin
 * bundlers should be configured to externalise React; the runtime provides
 * those modules here. Anything else is refused - the sandbox has no Node-
 * compatible module resolution and we don't want plugins probing globals.
 *
 * The host injects the per-plugin API as `@plugin-host`, so plugin code can
 * `const api = require('@plugin-host')` in both background and slot modes.
 */
function makePluginRequire(api: ReturnType<typeof buildPluginApi> | null): (name: string) => unknown {
  const known: Record<string, unknown> = {
    'react': React,
    'react-dom': ReactDOM,
    'react-dom/client': ReactDOM,
    'react/jsx-runtime': ReactJSXRuntime,
    'react/jsx-dev-runtime': ReactJSXRuntime,
  };
  if (api) known['@plugin-host'] = api;
  return (name: string) => {
    if (Object.prototype.hasOwnProperty.call(known, name)) return known[name];
    throw new Error(`Plugin sandbox: module "${name}" is not available. Externalise it in your bundler or ship it bundled.`);
  };
}

function evaluateBundle(code: string, api: ReturnType<typeof buildPluginApi> | null): PluginExports {
  const mod: { exports: PluginExports } = { exports: {} };
  const requireShim = makePluginRequire(api);
  let fn: (...args: unknown[]) => void;
  try {
    fn = new Function(
      'module', 'exports', 'require', 'React', 'ReactDOM', 'JsxRuntime', 'console',
      code,
    ) as (...args: unknown[]) => void;
  } catch (err) {
    throw new Error(`Bundle parse error: ${(err as Error).message}`);
  }
  try {
    fn(mod, mod.exports, requireShim, React, ReactDOM, ReactJSXRuntime, console);
  } catch (err) {
    throw new Error(`Bundle evaluation threw: ${(err as Error).message}`);
  }
  const exports = (mod.exports?.default ?? mod.exports) as PluginExports;
  if (!exports || typeof exports !== 'object') {
    throw new Error('Bundle did not produce module.exports object');
  }
  return exports;
}

// ─── Init flow ───────────────────────────────────────────────

async function bootBackground(payload: BackgroundInit): Promise<void> {
  const api = buildPluginApi(payload.manifest);
  const exports = evaluateBundle(payload.code, api);
  pluginExports = exports;

  // Register hooks (each value must be a function).
  const hookNames: string[] = [];
  const hooks = exports.hooks ?? {};
  for (const [name, handler] of Object.entries(hooks)) {
    if (typeof handler === 'function') {
      hookHandlers[name] = handler;
      hookNames.push(name);
    }
  }

  // Enumerate slot offers.
  const slotInfo: Array<{ name: SlotName; hasShouldShow: boolean; order: number }> = [];
  const slots = exports.slots ?? {};
  for (const [name, def] of Object.entries(slots)) {
    if (def && typeof def.component === 'function') {
      slotInfo.push({
        name: name as SlotName,
        hasShouldShow: typeof def.shouldShow === 'function',
        order: typeof def.order === 'number' ? def.order : 100,
      });
    }
  }

  // Shortcuts: register each handler as a 'shortcut:<id>' hook so the host's
  // global keydown dispatcher can invoke it.
  const shortcutInfo: Array<{ id: string; keys: string; label: string; category?: string }> = [];
  const shortcuts = exports.shortcuts ?? {};
  for (const [id, def] of Object.entries(shortcuts)) {
    if (!def || typeof def.handler !== 'function' || typeof def.keys !== 'string') continue;
    hookHandlers[`shortcut:${id}`] = def.handler as (...args: unknown[]) => unknown;
    hookNames.push(`shortcut:${id}`);
    shortcutInfo.push({
      id,
      keys: def.keys,
      label: typeof def.label === 'string' ? def.label : id,
      category: typeof def.category === 'string' ? def.category : undefined,
    });
  }

  // Side effects.
  if (typeof exports.activate === 'function') {
    await Promise.resolve(exports.activate(api));
  }

  sendToHost({ type: 'init-done', hooks: hookNames, slots: slotInfo, shortcuts: shortcutInfo });
}

function bootSlot(payload: SlotInit): void {
  // Replay the host theme before first paint so the slot never flashes the UA
  // default serif font or a light-on-light/dark mismatch.
  applyHostTheme(payload.theme);

  const api = buildPluginApi(payload.manifest);
  const exports = evaluateBundle(payload.code, api);
  pluginExports = exports;
  slotName = payload.slot;

  const slotDef = exports.slots?.[payload.slot];
  if (!slotDef || typeof slotDef.component !== 'function') {
    throw new Error(`Plugin "${payload.pluginId}" does not export slots["${payload.slot}"].component`);
  }

  const rootEl = document.getElementById('plugin-sandbox-root');
  if (!rootEl) throw new Error('Sandbox root element missing');

  let currentProps = decodeCallbacks(payload.extraProps) as Record<string, unknown>;
  const Component = slotDef.component;

  // A trivial pub/sub so host-pushed `props-update` messages re-render the
  // slot tree without tearing down the iframe.
  const propsListeners = new Set<(p: Record<string, unknown>) => void>();
  slotPropsUpdater = (next) => {
    currentProps = decodeCallbacks(next) as Record<string, unknown>;
    for (const l of propsListeners) {
      try { l(currentProps); } catch { /* ignore */ }
    }
  };

  const SlotShell = () => {
    const wrapRef = React.useRef<HTMLDivElement>(null);
    const [props, setProps] = React.useState(currentProps);
    React.useEffect(() => {
      propsListeners.add(setProps);
      return () => { propsListeners.delete(setProps); };
    }, []);
    React.useEffect(() => {
      if (!wrapRef.current) return;
      let lastHeight = -1;
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const h = Math.ceil(entry.contentRect.height);
          if (h !== lastHeight) {
            lastHeight = h;
            sendToHost({ type: 'slot-resize', height: h });
          }
        }
      });
      ro.observe(wrapRef.current);
      return () => ro.disconnect();
    }, []);
    return React.createElement('div', { ref: wrapRef }, React.createElement(Component, props));
  };

  const reactRoot = ReactDOM.createRoot(rootEl);
  reactRoot.render(React.createElement(SlotShell));
  sendToHost({ type: 'init-done', hooks: [], slots: [], shortcuts: [] });
}

// Populated by bootSlot - receives `props-update` messages.
let slotPropsUpdater: ((next: Record<string, unknown>) => void) | null = null;

async function handleInit(payload: InitPayload): Promise<void> {
  if (bootDone) return;
  bootDone = true;
  mode = payload.mode;
  // Make the active locale available to plugin code (api.i18n) right away -
  // not only after the first 'locale-change' push.
  (globalThis as unknown as { __PLUGIN_LOCALE__?: string }).__PLUGIN_LOCALE__ = payload.locale;
  try {
    if (payload.mode === 'background') {
      await bootBackground(payload);
    } else {
      bootSlot(payload);
    }
  } catch (err) {
    sendToHost({ type: 'init-error', error: (err as Error).message ?? String(err) });
  }
}

// ─── Host message handler ────────────────────────────────────

function handleHostMessage(ev: MessageEvent): void {
  // First inbound message pins source + origin. Reject everything else.
  if (!parentWindow) {
    if (!ev.source || ev.source === window) return;
    parentWindow = ev.source as Window;
    parentOrigin = ev.origin || null;
  }
  if (ev.source !== parentWindow) return;
  if (parentOrigin && ev.origin !== parentOrigin) return;

  const msg = ev.data as HostToSandbox;
  if (!msg || typeof (msg as { type?: unknown }).type !== 'string') return;

  switch (msg.type) {
    case 'init':
      void handleInit(msg.payload);
      break;

    case 'api-response': {
      const pending = pendingApi.get(msg.id);
      if (!pending) return;
      pendingApi.delete(msg.id);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(new Error(msg.error ?? 'api error'));
      break;
    }

    case 'callback-response': {
      const pending = pendingCallbacks.get(msg.id);
      if (!pending) return;
      pendingCallbacks.delete(msg.id);
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(new Error(msg.error ?? 'callback error'));
      break;
    }

    case 'hook-invoke': {
      const handler = hookHandlers[msg.hookName];
      if (!handler) {
        sendToHost({ type: 'hook-result', id: msg.id, ok: false, error: `no handler for ${msg.hookName}` });
        return;
      }
      try {
        const result = handler(...(msg.args ?? []));
        Promise.resolve(result).then(
          (v) => sendToHost({ type: 'hook-result', id: msg.id, ok: true, result: v }),
          (e) => sendToHost({ type: 'hook-result', id: msg.id, ok: false, error: (e as Error).message ?? String(e) }),
        );
      } catch (err) {
        sendToHost({ type: 'hook-result', id: msg.id, ok: false, error: (err as Error).message });
      }
      break;
    }

    case 'slot-should-show': {
      // Resolved by the background instance for any slot it offers.
      const slotDef = pluginExports?.slots?.[msg.slot];
      let show = true;
      try {
        if (slotDef && typeof slotDef.shouldShow === 'function') {
          show = !!slotDef.shouldShow(msg.context);
        }
      } catch {
        show = false;
      }
      sendToHost({ type: 'slot-should-show-result', id: msg.id, show });
      break;
    }

    case 'locale-change':
      (globalThis as unknown as { __PLUGIN_LOCALE__?: string }).__PLUGIN_LOCALE__ = msg.locale;
      break;

    case 'theme-change':
      applyHostTheme(msg.theme);
      break;

    case 'props-update':
      slotPropsUpdater?.(msg.props ?? {});
      break;
  }
}

// ─── React entry ─────────────────────────────────────────────

export function SandboxRuntime(): React.JSX.Element {
  useEffect(() => {
    window.addEventListener('message', handleHostMessage);
    // Initial ping. We don't know parent origin yet, so '*' is required.
    // Guard at module scope so React strict mode's double-invoke doesn't
    // re-post (and so a re-post can't race with the parent's init reply).
    if (!readyPosted && window.parent && window.parent !== window) {
      readyPosted = true;
      window.parent.postMessage({ type: 'sandbox-ready' } satisfies SandboxToHost, '*');
    }
    return () => {
      window.removeEventListener('message', handleHostMessage);
    };
  }, []);
  return <div id="plugin-sandbox-root" />;
}

// Suppress unused-variable warning when `mode` is only read for debugging.
void mode;
void slotName;
