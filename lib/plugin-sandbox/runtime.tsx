'use client';

// Runtime that boots inside the null-origin plugin sandbox iframe.
//
// Lifecycle:
//   1. Iframe loads → posts 'sandbox-ready' to the window that framed it
//      (`window.parent`, targeted at this document's own URL origin - see
//      `resolveHost`). A top-level load has no host and stays inert.
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
import * as ReactJSXRuntime from 'react/jsx-runtime';
import type {
  HostToSandbox,
  SandboxToHost,
  InitPayload,
  BackgroundInit,
  SlotInit,
  RegionalSnapshot,
} from './protocol';
import { themeSnapshotToCSS, type ThemeSnapshot } from './host-theme';
import { backgroundReactDom, backgroundUiKit } from './ui-kit/background-kit';
import { initFloatingDropdownBridge, dispatchFloatingDropdownEvent } from './ui-kit/floating-dropdown-bridge';
import { interpolate, lookup, textDirection, type LocaleTables } from './plugin-i18n';
import { isFillableSlot, isInlineSlot, MAX_INLINE_SLOT_WIDTH } from './slot-layout';
import type {
  AppInfoView, AppSettingsView, HostFeaturesView, SettingsSearchResult, CalendarEventInput, CalendarEventView, CalendarView, ComposeInput, DraftInput, EmailForwardInput, EmailForwardResult, EmailReadView,
  EmailSummary, IdentityPatch, IdentityView, MailboxView, NotificationInput, SlotName, TaskInput,
  TaskView, TemplateInput, TemplateView, VacationInput, VacationView,
} from '../plugin-types';
import { AddressBook, ContactCard } from '../jmap/types';
import { EncryptionAtRestConfig, PublicKeyInput } from '@/stores/account-security-store';

// ─── Module-scope state ──────────────────────────────────────

interface PluginExports {
  slots?: Record<string, { component: React.ComponentType<Record<string, unknown>>; shouldShow?: (ctx: unknown) => boolean; order?: number; fill?: boolean; startFolded?: boolean }>;
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

// The plugin's settings. One object for the iframe's lifetime, updated in
// place on 'settings-change', so code that kept a reference sees new values.
const settingsState: Record<string, unknown> = {};

// The app language and regional settings, pushed by the host on init and on every change.
let currentRegional: RegionalSnapshot = {
  locale: 'en',
  dateLocale: 'en',
  hour12: false,
  timeZone: 'UTC',
  firstDayOfWeek: 1,
};

const localeListeners = new Set<(locale: string) => void>();

// The plugin's strings. The host sends only the tables of the current locale
// chain (plugin-i18n tablesFor) and the next ones with each locale-change.
let localeTables: LocaleTables = {};

/** Add the tables a locale-change brought; strings the plugin added itself win. */
function mergeLocaleTables(next: LocaleTables | undefined): void {
  if (!next) return;
  for (const [locale, table] of Object.entries(next)) {
    localeTables[locale] = { ...table, ...(localeTables[locale] ?? {}) };
  }
}
function currentLocale(): string {
  return (globalThis as unknown as { __PLUGIN_LOCALE__?: string }).__PLUGIN_LOCALE__ || 'en';
}

function applyLocale(locale: string, regional?: RegionalSnapshot): void {
  (globalThis as unknown as { __PLUGIN_LOCALE__?: string }).__PLUGIN_LOCALE__ = locale;
  if (regional) {
    currentRegional = regional;
  } else {
    currentRegional = {
      ...currentRegional,
      locale,
      dateLocale: locale,
    };
  }
  document.documentElement.lang = locale;
  // Slots sit inside an RTL page in Arabic, Hebrew and Persian; their own
  // document has to flip too.
  document.documentElement.dir = textDirection(locale);
  for (const listener of localeListeners) {
    try { listener(locale); } catch (err) { console.error('[plugin] locale listener failed', err); }
  }
}

function formatIntl(date: Date | number | string, options: Intl.DateTimeFormatOptions): string {
  try {
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return '';
    const locale = currentRegional.dateLocale || currentRegional.locale || 'en';
    return new Intl.DateTimeFormat(locale, { timeZone: currentRegional.timeZone, ...options }).format(d);
  } catch {
    return '';
  }
}

function formatTime(date: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
  return formatIntl(date, { hour12: currentRegional.hour12, hour: 'numeric', minute: 'numeric', ...options });
}

function formatDate(date: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
  return formatIntl(date, options ?? {});
}
const settingsListeners = new Set<(settings: Record<string, unknown>) => void>();

function applySettings(next: Record<string, unknown>): void {
  for (const key of Object.keys(settingsState)) delete settingsState[key];
  Object.assign(settingsState, next);
  for (const listener of settingsListeners) {
    try { listener(settingsState); } catch (err) { console.error('[plugin] settings listener failed', err); }
  }
}
// What api.host.features says: one object for the iframe's lifetime,
// updated in place on 'host-change' like the settings.
const hostFeaturesState: HostFeaturesView = { externalSenderLabel: false, externalRecipientWarning: false };
const hostFeatureListeners = new Set<(features: HostFeaturesView) => void>();

function applyHostFeatures(next: HostFeaturesView | undefined): void {
  if (!next) return;
  hostFeaturesState.externalSenderLabel = next.externalSenderLabel === true;
  hostFeaturesState.externalRecipientWarning = next.externalRecipientWarning === true;
  for (const listener of hostFeatureListeners) {
    try { listener(hostFeaturesState); } catch (err) { console.error('[plugin] host feature listener failed', err); }
  }
}
const pendingCallbacks = new Map<string, { resolve: (v: unknown) => void; reject: (err: Error) => void }>();
const hookHandlers: Record<string, (...args: unknown[]) => unknown> = {};

function sendToHost(msg: SandboxToHost, transfer?: Transferable[]): void {
  if (!parentWindow || !parentOrigin) return;
  if (transfer) parentWindow.postMessage(msg, parentOrigin, transfer);
  else parentWindow.postMessage(msg, parentOrigin);
}

// ─── Activity reports ────────────────────────────────────────

/**
 * Input that counts as the user being here for the host's idle timeout: the
 * host window's own list (components/session/session-timeout-guard.tsx),
 * which input in this frame never reaches. Focus doesn't count there and
 * doesn't here: a focused frame left alone would keep the session open.
 */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel'] as const;

/**
 * At most one report this often. The idle limit is whole minutes, so a
 * report up to 15 s late costs at most 15 s of it, while a user working in
 * the frame sends no more than four messages a minute.
 */
export const ACTIVITY_REPORT_MS = 15_000;

let reportActivity: (() => void) | null = null;
let lastActivityReport = -Infinity;

function onUserInput(event: Event): void {
  // A plugin can dispatch events, but not trusted ones.
  if (!event.isTrusted || !reportActivity) return;
  const at = Date.now();
  if (at - lastActivityReport < ACTIVITY_REPORT_MS) return;
  lastActivityReport = at;
  reportActivity();
}

/**
 * The port reports go through, handed to the host with 'sandbox-ready',
 * before any plugin code runs. The plugin shares this frame and can post to
 * the host as the runtime does, but it never sees this port, and the host
 * counts only what comes through it. `postMessage` is bound now, so a
 * plugin patching MessagePort.prototype later doesn't get hold of the port.
 * (A privileged, same-origin plugin can reach the host page anyway.)
 */
function openActivityPort(): MessagePort | null {
  if (typeof MessageChannel === 'undefined') return null;
  const channel = new MessageChannel();
  const post = channel.port1.postMessage.bind(channel.port1);
  reportActivity = () => {
    try { post(null); } catch { /* host gone */ }
  };
  return channel.port2;
}

// ─── Host binding ────────────────────────────────────────────

/**
 * The one window allowed to drive this runtime, and the origin it must post
 * from. Both are fixed from browser-owned facts at load time and never
 * learned from a message:
 *
 *  - `window.parent` is the document that framed us. The host bridge creates
 *    that iframe itself, so this is the mirror of its own contentWindow check.
 *    A top-level load (window.open from another site, a typed URL) has no
 *    parent - `parent === window` - and gets no host at all: `window.opener`
 *    is never a host.
 *  - `location.origin` is the URL origin even when this iframe runs with an
 *    opaque origin (sandbox="allow-scripts"), and the host page is served
 *    from that same origin: the bridge loads a same-origin path and the route
 *    CSP pins `frame-ancestors 'self'`.
 *
 * Pinning the first sender instead (pre-fix) let any website window.open()
 * the route, post its own `init` before a real host could, and run its code
 * under this document's `'unsafe-eval'` CSP in the webmail origin
 * (GHSA-96cx-gx36-3g79). Returns null when there is no acceptable host.
 */
function resolveHost(): { window: Window; origin: string } | null {
  if (typeof window === 'undefined') return null;
  const parent = window.parent;
  if (!parent || parent === window) return null;
  const origin = window.location.origin;
  // 'null' is what opaque URL origins (blob:, data:, file:) serialise to; an
  // attacker frame could match it, so it never counts as a host origin.
  if (!origin || origin === 'null') return null;
  return { window: parent, origin };
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

// ─── api.proxy streams ───────────────────────────────────────

interface ProxyStream {
  controller?: ReadableStreamDefaultController<Uint8Array>;
  onProgress?: (loaded: number, total: number) => void;
}
const proxyStreams = new Map<string, ProxyStream>();

interface ProxyFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer | Uint8Array | Blob | null;
  /** "text" (default), "json", "arraybuffer", or "stream" for a ReadableStream body. */
  responseType?: 'text' | 'json' | 'arraybuffer' | 'stream';
  /** Upload progress, in bytes. */
  onProgress?: (loaded: number, total: number) => void;
  /** Store these JSON fields of the response as the credential instead of returning them. */
  capture?: { secret: string; username?: string };
  /** Stops the request (and a streamed body). */
  signal?: AbortSignal;
}

async function proxyFetch(credentialId: string, url: string, init: ProxyFetchInit = {}): Promise<unknown> {
  const streamId = uid().replace(/[^a-z0-9]/g, '').slice(0, 24);
  const entry: ProxyStream = { onProgress: init.onProgress };
  proxyStreams.set(streamId, entry);
  const stream = init.responseType === 'stream'
    ? new ReadableStream<Uint8Array>({
        start(controller) { entry.controller = controller; },
        cancel() {
          proxyStreams.delete(streamId);
          void callApi('proxy.cancel', [streamId]).catch(() => {});
        },
      })
    : null;
  const abort = () => {
    void callApi('proxy.cancel', [streamId]).catch(() => {});
    try { entry.controller?.error(new Error('cancelled')); } catch { /* closed */ }
    proxyStreams.delete(streamId);
  };
  init.signal?.addEventListener('abort', abort, { once: true });
  const { onProgress: _p, signal: _s, ...plain } = init;
  void _p; void _s;
  try {
    // No overall timeout: a big upload or a long AI answer takes as long as
    // it takes, and api.proxy.cancel / the signal stop it.
    const res = await callApi('proxy.fetch', [credentialId, url, { ...plain, streamId }], 0) as Record<string, unknown>;
    if (!stream || !res.ok) proxyStreams.delete(streamId);
    return stream && res.ok ? { ...res, body: stream } : res;
  } catch (err) {
    proxyStreams.delete(streamId);
    throw err;
  }
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
  /** The plugin that added it with keywords.add; absent on the user's own tags. */
  addedBy?: string;
}

type PluginKeywordDefinitionInput = Omit<PluginKeywordDefinition, 'color' | 'addedBy'> & { color?: string };

type PluginKeywordPatch = Pick<PluginKeywordDefinition, 'id'> &
  Partial<Pick<PluginKeywordDefinition, 'label' | 'color' | 'visibility'>>;

interface PluginKeywordCounts {
  total: number;
  unread: number;
}

function buildPluginApi(manifest: PluginManifest) {
  applySettings({ ...manifest.settings });
  localeTables = JSON.parse(JSON.stringify(manifest.locales ?? {}));
  return {
    plugin: {
      id: manifest.id,
      version: manifest.version,
      /** Current settings, defaults filled in. Updated in place when the user changes them. */
      settings: settingsState,
      /** Called with the new settings whenever the user changes them. Returns an unsubscribe function. */
      onSettingsChange: (listener: (settings: Record<string, unknown>) => void) => {
        settingsListeners.add(listener);
        return () => { settingsListeners.delete(listener); };
      },
    },
    /**
     * Bulwark features that replace what plugins did, so a plugin can step
     * back while Bulwark does its job. Updated in place; no permission needed.
     */
    host: {
      features: hostFeaturesState,
      /** Called with the new features whenever one turns on or off. Returns an unsubscribe function. */
      onFeaturesChange: (listener: (features: HostFeaturesView) => void) => {
        hostFeatureListeners.add(listener);
        return () => { hostFeatureListeners.delete(listener); };
      },
    },
    /** The app the plugin runs in: product, the administrator's name for it, version, edition. No permission needed. */
    app: {
      getInfo: () => callApi('app.getInfo', []) as Promise<AppInfoView>,
      /** Settings matching a query (the user's language or English): page, label, description. No permission needed. */
      searchSettings: (query: string, options?: { limit?: number }) =>
        callApi('app.searchSettings', [query, options]) as Promise<SettingsSearchResult[]>,
      /** The user's preferences: layout, formats, reading and sending behaviour. Needs settings:read. */
      getSettings: () => callApi('app.getSettings', []) as Promise<AppSettingsView>,
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
      /**
       * The signed-in user: their own JMAP account id (Stalwart's principal
       * id), address and name. Needs account:read.
       */
      getSelf: () => callApi('user.getSelf', []) as Promise<{ accountId: string; email: string; name: string }>,
      /**
       * Every mail account of the signed-in login: their own ('personal'),
       * team mailboxes they are a member of ('group') and mailboxes others
       * shared with them ('shared'); `isOpen` marks the open folder's.
       * Needs account:read.
       */
      getMailAccounts: () => callApi('user.getMailAccounts', []) as Promise<Array<{
        accountId: string; name: string; kind: 'personal' | 'group' | 'shared'; isReadOnly: boolean; isOpen: boolean;
      }>>,
      /**
       * People from the server's directory, as the named mail account (else
       * the user's own) sees it: by principal id (at most 20) or by a part
       * of their name or address (3 characters or more). At most 20 results
       * and 10 lookups a minute. `complete` is false when the administrator
       * turned directory lookups off; only the people the user shares an
       * account with are known then. Needs directory:read.
       */
      findPeople: (query: { text?: string; ids?: string[]; accountId?: string }) =>
        callApi('user.findPeople', [query], NETWORK_API_TIMEOUT_MS) as Promise<{
          people: Array<{ id: string; type: string; name: string; email: string }>; complete: boolean;
        }>,
      getIdentities: () => callApi('user.getIdentities', []),
      /** The IANA time zone the app shows times in (the user's setting, else the browser's). */
      getTimeZone: () => callApi('user.getTimeZone', []) as Promise<string>,
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
      /** Upload bytes to the mail server (email:blob-write); pass the blob id to a composer's onAttach. */
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
      get: (contactId: string) => callApi('contact.get', [contactId]) as Promise<ContactCard | null>,
      update: (contactId: string, updates: Partial<ContactCard>) => callApi('contact.update', [contactId, updates]) as Promise<void>,
      create: (contact: ContactCard) => callApi('contact.create', [contact]) as Promise<ContactCard>,
      search: (query: string) => callApi('contact.search', [query]) as Promise<ContactCard[]>,
      list: (addressBookId?: string) => callApi('contact.list', [addressBookId]) as Promise<ContactCard[]>,
      remove: (contactId: string) => callApi('contact.delete', [contactId]) as Promise<void>,
    },
    addressBooks: {
      list: () => callApi('addressbook.list', []) as Promise<AddressBook[]>,
      create: (name: string) => callApi('addressbook.create', [name]) as Promise<AddressBook>,
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
    // Notifications (permission: ui:notifications).
    notifications: {
      /**
       * A system notification when the user allowed them for the webmail,
       * otherwise a toast; either way it names this plugin. At most 5 a
       * minute. Clicking a system notification brings the webmail to the
       * front and fires this plugin's onNotificationClick hook with the tag.
       * Resolves to 'system' or 'toast'.
       */
      show: (notification: NotificationInput) =>
        callApi('notifications.show', [notification]) as Promise<'system' | 'toast'>,
    },
    // The message being written. `composerId` comes from the composer: the
    // context of a click on a composer action, or a composer slot's props.
    composer: {
      /** The user's own text (no signature, no quote) as { html, text }. Needs compose:read. */
      getBody: (composerId: string) =>
        callApi('composer.getBody', [composerId]) as Promise<{ html: string; text: string }>,
      /** The selection as { html, text, empty }. Needs compose:read. */
      getSelection: (composerId: string) =>
        callApi('composer.getSelection', [composerId]) as Promise<{ html: string; text: string; empty: boolean }>,
      /**
       * Replace the selection, or insert at the caret when nothing is
       * selected; `{ below: true }` adds after the selection instead. One
       * Ctrl+Z undoes it. Needs compose:write.
       */
      replaceSelection: (composerId: string, content: { text: string } | { html: string }, options?: { below?: boolean }) =>
        callApi('composer.replaceSelection', [composerId, content, options]) as Promise<boolean>,
      /** Replace the user's own text; the signature and the quote stay. Needs compose:write. */
      replaceBody: (composerId: string, content: { text: string } | { html: string }) =>
        callApi('composer.replaceBody', [composerId, content]) as Promise<boolean>,
      /** Attach a blob from jmap.uploadBlob. Needs email:blob-write. */
      attach: (composerId: string, file: { blobId: string; name: string; type?: string; size: number }) =>
        callApi('composer.attach', [composerId, file]) as Promise<boolean>,
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
      /** Opens one of this plugin's OWN slots (see the 'plugin-dialog'
       *  SlotName) inside a real, app-root, full-size dialog - unlike every
       *  other slot, which renders wherever it's placed in the page and is
       *  constrained by that spot's own layout. Use this for anything that
       *  needs to be a large, genuinely clickable custom UI (a file browser,
       *  a multi-step form, etc.) rather than a toolbar/row-sized control.
       *  Resolves to whatever value the slot component passes to its
       *  `onResult` prop, or null if the user closes the dialog without
       *  calling it. No timeout - it waits for the user. */
      openDialog: (opts: { title?: string; slot: string; extraProps?: Record<string, unknown>; width?: number }) =>
        callApi('ui.openDialog', [opts], 0) as Promise<unknown>,
      /** Re-runs the onRenderEmailBody hook for the open message (e.g. after a
       *  crypto plugin unlocks a key) so its body re-renders without a reload. */
      rerenderEmail: () => callApi('ui.rerenderEmail', []) as Promise<void>,
      rerenderFetchedEmails: () => callApi('ui.rerenderFetchedEmails', []) as Promise<void>,
      /** Opens an http/https URL in a new tab via host `window.open`. */
      openExternalUrl: (url: string, target?: string) =>
        callApi('ui.openExternalUrl', [url, target]) as Promise<void>,
      /**
       * Print a page the plugin made, such as a document drawn from data:
       * HTML with <style>, sanitised like a message body, no scripts, images
       * as data: URLs only. Opens the browser's print dialog (where the user
       * can also save a PDF); 3 times a minute.
       */
      print: (page: { title?: string; html: string }) => callApi('ui.print', [page], 0) as Promise<boolean>,
      /** Downloads a file generated by the plugin. Not a user's file or attachment. */
      /** `content` is text, or the file's bytes (ArrayBuffer / Uint8Array). */
      downloadFile: (opts: { content: string | ArrayBuffer | Uint8Array; filename: string; contentType?: string }) =>
        callApi('ui.downloadFile', [opts]) as Promise<void>,
      /**
       * Buttons or menu entries on an action surface (see the slot catalogue:
       * message rows, the selection toolbar, attachment menus, the command
       * palette, ...). Replaces what this plugin set there before; [] removes
       * them. Clicks arrive in the `onAction({ surface, actionId, context })` hook.
       */
      setActions: (surface: string, actions: Array<{
        id: string; label: string; icon?: string; order?: number; mailboxRoles?: string[]; mimeTypes?: string[]; danger?: boolean;
        accounts?: Array<'personal' | 'group' | 'shared'>; hasKeyword?: string; notKeyword?: string;
      }>) =>
        callApi('ui.setActions', [surface, actions]) as Promise<void>,
      /**
       * Keyword filters for the message list, drawn as chips in the list
       * header of the folders they apply to. A chip the user turns on adds
       * its condition to the folder's query; replaces this plugin's earlier
       * filters, [] removes them. Needs ui:message-list.
       */
      setListFilters: (filters: Array<{
        id: string; label: string; icon?: string; hasKeyword?: string; notKeyword?: string;
        accounts?: Array<'personal' | 'group' | 'shared'>; mailboxRoles?: string[]; order?: number;
      }>) => callApi('ui.setListFilters', [filters]) as Promise<void>,
      /**
       * Ask every visible message row for its onEmailListItemRender badges
       * again, e.g. after a task was created elsewhere. At most once a second.
       */
      refreshRowBadges: () => callApi('ui.refreshRowBadges', []) as Promise<void>,
      /** Short labels and dots on calendar days. Replaces this plugin's earlier labels. */
      setDayLabels: (labels: Array<{ date: string; text?: string; title?: string; dot?: boolean }>) =>
        callApi('ui.setDayLabels', [labels]) as Promise<void>,
      /** Full pages with a button in the navigation bar; the `app-page` slot renders them. */
      setPages: (pages: Array<{ id: string; title: string; icon?: string }>) =>
        callApi('ui.setPages', [pages]) as Promise<void>,
      /**
       * Moves this tab to one of this plugin's own pages (set with setPages),
       * e.g. from a dialog's link to the record its page shows. `path` is
       * what the `app-page` slot gets as `path` (segments joined by "/").
       * Resolves to false when the app could not take it, so the plugin can
       * open the page in a new tab with openExternalUrl instead.
       */
      openPage: (pageId: string, path?: string) =>
        callApi('ui.openPage', [pageId, path]) as Promise<boolean>,
      /**
       * Opens a message in the reader of this tab, as a click on it in the
       * list does: in place on the mail page, in an email tab in the Pro
       * shell, else the tab loads the message's link (at most 5 times a
       * minute). `accountId` names the JMAP account holding it (a shared or
       * group account); the signed-in account's own when missing. Rejects
       * when no account of the user reads it, the account has no such
       * message, or the mail page could not open it. Needs `email:read`.
       */
      openEmail: (email: { id: string; accountId?: string }) =>
        callApi('ui.openEmail', [email]) as Promise<void>,
      /**
       * The header of this plugin's sidebar section (the host draws it like
       * Folders and Tags), e.g. a translated "Upcoming birthdays". null goes
       * back to the plugin's name. At most 40 characters.
       */
      setSectionTitle: (title: string | null) => callApi('ui.setSectionTitle', [title]) as Promise<void>,
      /**
       * Open, close or toggle the panel this plugin's slot sits in:
       * 'composer-sidebar', 'composer-sidebar-right' (pass the composerId
       * from the click context or the slot's props) or 'email-detail-sidebar'.
       * Resolve to whether the panel is open afterwards, or null when no such
       * panel is on screen (no composer or message open, or a phone), so the
       * plugin can fall back to a dialog. A panel opened this way gets a new
       * `focusRequest` prop, so the slot can focus its input.
       */
      openPanel: (slot: string, opts?: { composerId?: string }) => callApi('ui.setPanel', [slot, 'open', opts]) as Promise<boolean | null>,
      closePanel: (slot: string, opts?: { composerId?: string }) => callApi('ui.setPanel', [slot, 'close', opts]) as Promise<boolean | null>,
      togglePanel: (slot: string, opts?: { composerId?: string }) => callApi('ui.setPanel', [slot, 'toggle', opts]) as Promise<boolean | null>,
    },
    // Requests with an account or key the manifest declares under
    // `credentials`; the server adds the secret (permission http:proxy).
    proxy: {
      fetch: proxyFetch,
      /** Show the host's dialog to connect a user credential. */
      connect: (credentialId: string, opts?: { mode?: 'password' | 'signin'; server?: string; username?: string }) =>
        callApi('proxy.connect', [credentialId, opts ?? {}], 0) as Promise<{ connected: boolean; origin?: string }>,
      /**
       * Which credentials are ready: accounts the user connected (scope
       * 'user', with server and user name) and the admin's (scope 'admin',
       * connected = set up). No secrets.
       */
      accounts: () => callApi('proxy.accounts', []) as Promise<Array<{ credentialId: string; scope: 'user' | 'admin'; origin?: string; username?: string; connected: boolean }>>,
      disconnect: (credentialId: string) => callApi('proxy.disconnect', [credentialId]) as Promise<boolean>,
    },
    // Reading mail (permission: email:read) and keyword mutations
    // (permission: email:write). Keywords follow JMAP syntax, e.g.
    // '$category-promotions' or '$label:<tagId>'.
    email: {
      /**
       * One message with its plain text, headers and source, or null when
       * there is none with that id. Any message of the account, not only the
       * open one. Ids repeat across accounts: pass the view's `accountId` to
       * name the message of that account.
       */
      get: (emailId: string, accountId?: string) =>
        callApi('email.get', [emailId, accountId]) as Promise<EmailReadView | null>,
      /**
       * Move messages (at most 100) into a folder of the account, like the
       * user would; the move hooks run. 20 moves a minute. Needs email:write.
       */
      move: (emailIds: string[], mailboxId: string) => callApi('email.move', [emailIds, mailboxId]) as Promise<void>,
      /** Move messages into the account's Archive folder. Needs email:write. */
      archive: (emailIds: string[]) => callApi('email.archive', [emailIds]) as Promise<void>,
      /**
       * A page of a folder (or of all mail without mailboxId), in the user's
       * list order: summaries without the body. limit 1-100 (default 50).
       */
      list: (options?: { mailboxId?: string; limit?: number; position?: number }) =>
        callApi('email.list', [options]) as Promise<EmailSummary[]>,
      /**
       * Messages matching a search, newest first, as summaries without the
       * body: `text` (sender, recipients, subject and body, whole words),
       * `from`, `to`, `subject`, `after`/`before` (dates), `hasAttachment`,
       * in one folder with `mailboxId`. At least one condition; limit 1-50
       * (default 20).
       */
      search: (query: { text?: string; from?: string; to?: string; subject?: string; after?: string; before?: string; hasAttachment?: boolean; mailboxId?: string; limit?: number }) =>
        callApi('email.search', [query]) as Promise<EmailSummary[]>,
      /**
       * The bytes of one attachment of a message (email:blob-read, at most
       * 25 MB). `blobId` must be one of that message's attachments, e.g.
       * from an `attachment-actions` slot or onAttachmentDownload.
       */
      getAttachment: (emailId: string, blobId: string, accountId?: string) =>
        callApi('email.getAttachment', [emailId, blobId, accountId], NETWORK_API_TIMEOUT_MS) as Promise<{
          name: string; type: string; size: number; data: ArrayBuffer;
        }>,
      /** The full RFC 5322 source of a message, to save as .eml (email:blob-read, at most 25 MB). */
      getRaw: (emailId: string, accountId?: string) =>
        callApi('email.getRaw', [emailId, accountId], NETWORK_API_TIMEOUT_MS) as Promise<ArrayBuffer>,
      setKeyword: (emailId: string, keyword: string, accountId?: string) =>
        callApi('email.setKeyword', [emailId, keyword, accountId]) as Promise<void>,
      removeKeyword: (emailId: string, keyword: string, accountId?: string) =>
        callApi('email.removeKeyword', [emailId, keyword, accountId]) as Promise<void>,
      /**
       * Set (true) and clear (false) up to 20 keywords of a message in one
       * change, e.g. `{ '$assigned:b': true, '$assigned:c': false }`. A
       * message in the open list shows the change at once. Resolves to false
       * when another plugin's onBeforeEmailKeywordChange stopped it.
       */
      updateKeywords: (emailId: string, changes: Record<string, boolean>, accountId?: string) =>
        callApi('email.updateKeywords', [emailId, changes, accountId]) as Promise<boolean>,
      /**
       * Forward a message with its attachments to 1-10 addresses, without
       * the composer (email:forward). The first forward to an address asks
       * the user; resolves to { sent: false, reason: 'declined' } when they
       * say no and 'stopped' when a send check stopped it. 10 a minute.
       * Waits as long as the user takes to answer.
       */
      forward: (emailId: string, input: EmailForwardInput) =>
        callApi('email.forward', [emailId, input], 0) as Promise<EmailForwardResult>,
    },
    // A small JSON value (at most 4 KB) the plugin keeps in a mail account's
    // Inbox, shared with everyone who can open that account (Stalwart 1.0
    // metadata; it counts against the mailbox's metadata room). get needs
    // email:read, set email:write; 30 reads and 20 changes a minute.
    accountData: {
      /** `supported` is false on servers without metadata; `value` is then null. */
      get: (accountId?: string) =>
        callApi('accountData.get', [accountId], NETWORK_API_TIMEOUT_MS) as Promise<{ supported: boolean; value: unknown }>,
      /** Replace the value; null removes it. Throws where `get` says unsupported. */
      set: (accountId: string | undefined, value: unknown) =>
        callApi('accountData.set', [accountId, value], NETWORK_API_TIMEOUT_MS) as Promise<void>,
    },
    // The composer (permission: compose:open). Opens it filled in; the user
    // reviews the message and decides whether to send it.
    compose: {
      /**
       * Open the composer with these fields. On the mail page it opens in
       * place; anywhere else the app first goes to the mail page (the
       * plugin is reloaded with it). Resolves to 'opened' or 'navigating'.
       * At most 5 times a minute.
       */
      open: (message: ComposeInput) => callApi('compose.open', [message]) as Promise<'opened' | 'navigating'>,
      /**
       * Reply to the message open in the reader (`all` for reply to all),
       * starting the reply with `text`. Only the open message; resolves to
       * true when the composer opened. Shares compose.open's 5 a minute.
       */
      reply: (emailId: string, reply?: { text?: string; all?: boolean }) =>
        callApi('compose.reply', [emailId, reply]) as Promise<boolean>,
    },
    // Drafts (permission: email:write).
    drafts: {
      /**
       * Save a draft in the Drafts folder, from the user's default sender
       * address, without opening the composer. Attachments are blobs the
       * plugin uploaded with api.jmap.uploadBlob. Resolves to the draft's
       * email id. At most 10 a minute.
       */
      create: (draft: DraftInput) => callApi('drafts.create', [draft]) as Promise<string>,
    },
    // Folders (permission: email:read).
    mailboxes: {
      /** Every folder with its role, parent and message counts. */
      list: () => callApi('mailboxes.list', []) as Promise<MailboxView[]>,
    },
    // Native sidebar tag definitions. Definition reads/writes use the existing
    // settings permissions; server discovery and message counts use email:read.
    // add() never overwrites a tag that is there. update() and remove() reach
    // only the tags this plugin added, never the user's own or another
    // plugin's. reorder() requires a complete permutation of existing ids.
    keywords: {
      list: () => callApi('keywords.list', []) as Promise<PluginKeywordDefinition[]>,
      add: (definitions: PluginKeywordDefinitionInput[]) =>
        callApi('keywords.add', [definitions]) as Promise<{
          added: PluginKeywordDefinition[];
          skipped: string[];
        }>,
      /** Change the label, color or visibility of tags this plugin added; the id stays. */
      update: (definitions: PluginKeywordPatch[]) =>
        callApi('keywords.update', [definitions]) as Promise<{
          updated: PluginKeywordDefinition[];
          skipped: string[];
        }>,
      /** Delete tags this plugin added. Messages keep their keywords. */
      remove: (ids: string[]) =>
        callApi('keywords.remove', [ids]) as Promise<{
          removed: string[];
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
    // Message-list search (permission: email:read). Runs a JMAP Email
    // FilterCondition/FilterOperator the way a user's search runs: in the
    // scope picked in the search panel, shown as a chip, cleared with the
    // search. Same contract as a tab's `query`. The plugin gets no results
    // back; the list shows them.
    search: {
      run: (query: unknown, options?: { label?: string }) =>
        callApi('search.run', [query, options]) as Promise<void>,
    },
    // Calendar events (permissions: calendar:read / calendar:write). Writes
    // go through the calendar the way the user's own edits do, so other
    // plugins' hooks run and may stop them. Nothing here sends invitations,
    // updates or cancellations to participants.
    calendar: {
      /** The user's calendars. */
      listCalendars: () => callApi('calendar.listCalendars', []) as Promise<CalendarView[]>,
      /**
       * Events from `from` to `to` (at most 366 days; `2026-05-01`,
       * `2026-05-01T09:00` or `...Z`), recurring events expanded into their
       * occurrences, earliest first, at most 1000.
       */
      getEvents: (range: { from: string; to: string; calendarIds?: string[] }) =>
        callApi('calendar.getEvents', [range]) as Promise<CalendarEventView[]>,
      /** One event, or null when there is none with that id. */
      getEvent: (id: string) => callApi('calendar.getEvent', [id]) as Promise<CalendarEventView | null>,
      /** Resolves to the new event, or null when it was not created (a plugin stopped it or the server refused). */
      createEvent: (event: CalendarEventInput) =>
        callApi('calendar.createEvent', [event]) as Promise<CalendarEventView | null>,
      /** Change the given fields; times are worked out against the event's current ones. */
      updateEvent: (id: string, patch: Partial<CalendarEventInput>) =>
        callApi('calendar.updateEvent', [id, patch]) as Promise<void>,
      /** Delete an event, or one occurrence when given an occurrence's id. */
      deleteEvent: (id: string) => callApi('calendar.deleteEvent', [id]) as Promise<void>,
    },
    // Tasks (permissions: tasks:read / tasks:write), through the task list
    // the way the user's own edits go.
    tasks: {
      /** Open tasks, or every task with includeCompleted. At most 1000. */
      list: (options?: { includeCompleted?: boolean }) => callApi('tasks.list', [options]) as Promise<TaskView[]>,
      /** One task, or null. */
      get: (id: string) => callApi('tasks.get', [id]) as Promise<TaskView | null>,
      /** Resolves to the new task, or null when another plugin stopped it. */
      create: (task: TaskInput) => callApi('tasks.create', [task]) as Promise<TaskView | null>,
      /**
       * Change the given fields. `alerts`, `links` and `relatedTo` merge
       * by id: an entry given is set, one given null is removed, the rest
       * stay as they are (each written by its own JMAP patch path); null
       * for the whole map clears it.
       */
      update: (id: string, patch: Partial<TaskInput>) => callApi('tasks.update', [id, patch]) as Promise<void>,
      /** Mark a task done or not done. */
      setComplete: (id: string, complete: boolean) => callApi('tasks.setComplete', [id, complete]) as Promise<void>,
      /**
       * Dismiss one of a task's alerts at `when` (UTC, `2026-05-01T07:30:00Z`;
       * now when left out), or undo that with null. Bulwark shows no reminder
       * for a dismissed alert. Refused while the task uses its calendar's
       * default alerts (TaskView.useDefaultAlerts).
       */
      acknowledgeAlert: (id: string, alertId: string, when?: string | null) =>
        callApi('tasks.acknowledgeAlert', when === undefined ? [id, alertId] : [id, alertId, when]) as Promise<void>,
      delete: (id: string) => callApi('tasks.delete', [id]) as Promise<void>,
    },
    // Message templates (permissions: templates:read / templates:write).
    // They live with the user's settings and sync across devices.
    templates: {
      list: () => callApi('templates.list', []) as Promise<TemplateView[]>,
      /** One template, or null. */
      get: (id: string) => callApi('templates.get', [id]) as Promise<TemplateView | null>,
      /** At most 500 templates in all. An HTML body is sanitised. */
      create: (template: TemplateInput) => callApi('templates.create', [template]) as Promise<TemplateView>,
      update: (id: string, patch: Partial<TemplateInput>) =>
        callApi('templates.update', [id, patch]) as Promise<TemplateView>,
      delete: (id: string) => callApi('templates.delete', [id]) as Promise<void>,
    },
    // Sender identities. Read them with api.user.getIdentities()
    // (identity:read); change one with identity:write.
    identities: {
      /**
       * Change the name, reply-to addresses or signatures of one identity.
       * The address can't be changed. An HTML signature is sanitised like
       * one typed into Settings. Resolves to the identity as changed, or null
       * when an onBeforeIdentityChange handler stopped it.
       */
      update: (id: string, patch: IdentityPatch) =>
        callApi('identities.update', [id, patch]) as Promise<IdentityView | null>,
    },
    // Out-of-office reply (permissions: vacation:read / vacation:write).
    vacation: {
      get: () => callApi('vacation.get', []) as Promise<VacationView>,
      /** Resolves to the reply as saved, or null when another plugin stopped the change. */
      set: (vacation: VacationInput) => callApi('vacation.set', [vacation]) as Promise<VacationView | null>,
    },
    // OAuth with a third party (permission: http:fetch). Put createState()'s
    // value in the authorize URL; the code comes back through the
    // onOAuthCallback hook, to this plugin only.
    oauth: {
      createState: () => callApi('oauth.createState', []) as Promise<string>,
      getRedirectUri: () => callApi('oauth.getRedirectUri', []) as Promise<string>,
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
    /**
     * The admin's settings for this plugin (configSchema) that aren't secrets,
     * e.g. a server address. No permission needed; `type: "secret"` fields
     * are never included. Use credentials for secrets.
     */
    config: {
      get: () => callApi('plugin.getConfig', []) as Promise<Record<string, unknown>>,
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
    // `locales` map (manifest.locales) plus anything added at runtime,
    // trying `de-CH`, then `de`, then English, then the key itself, with
    // optional {placeholder} interpolation.
    i18n: {
      get locale(): string {
        return currentLocale();
      },
      getLocale: () => currentLocale(),
      get dateLocale(): string {
        return currentRegional.dateLocale;
      },
      get timeFormat(): '12h' | '24h' {
        return currentRegional.hour12 ? '12h' : '24h';
      },
      get hour12(): boolean {
        return currentRegional.hour12;
      },
      get timeZone(): string {
        return currentRegional.timeZone;
      },
      get firstDayOfWeek(): 0 | 1 | 6 {
        return currentRegional.firstDayOfWeek;
      },
      formatTime,
      formatDate,
      t(key: string, vars?: Record<string, string | number>): string {
        return interpolate(lookup(localeTables, currentLocale(), key) ?? key, vars);
      },
      /** Whether any table has `key`, for `has(k) ? t(k) : fallback`. */
      has: (key: string) => lookup(localeTables, currentLocale(), key) !== undefined,
      /** Add or override strings for one locale. */
      addTranslations(locale: string, strings: Record<string, string>): void {
        localeTables[locale] = { ...(localeTables[locale] ?? {}), ...strings };
      },
      /** Called with the new locale when the user switches language. Returns an unsubscribe function. */
      onLocaleChange: (listener: (locale: string) => void) => {
        localeListeners.add(listener);
        return () => { localeListeners.delete(listener); };
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
export function makePluginRequire(api: ReturnType<typeof buildPluginApi> | null, renderer: Renderer | null = null): (name: string) => unknown {
  const reactDom = renderer?.ReactDOM ?? backgroundReactDom;
  const known: Record<string, unknown> = {
    'react': React,
    'react-dom': reactDom,
    'react-dom/client': reactDom,
    'react/jsx-runtime': ReactJSXRuntime,
    'react/jsx-dev-runtime': ReactJSXRuntime,
  };
  if (api) known['@plugin-host'] = api;
  // The app's controls (lib/plugin-sandbox/ui-kit), so plugins draw the same
  // buttons, fields and lists as the app without bundling their own. In a
  // background frame, stand-ins with the same names.
  known['@plugin-host/ui'] = renderer?.kit ?? backgroundUiKit;
  return (name: string) => {
    if (Object.prototype.hasOwnProperty.call(known, name)) return known[name];
    throw new Error(`Plugin sandbox: module "${name}" is not available. Externalise it in your bundler or ship it bundled.`);
  };
}

// ─── Renderer (slot frames only) ─────────────────────────────

/**
 * React DOM and the UI kit. Only slot frames draw, so only they load these
 * (a separate chunk, ~350 kB to parse); a background frame gets React and
 * stand-ins. The host marks slot frames in their URL (?frame=slot) so the
 * load starts with the document, not after init.
 */
export interface Renderer {
  ReactDOM: typeof import('react-dom/client');
  kit: unknown;
  SlotPropsContext: React.Context<Record<string, unknown>>;
}

let rendererPromise: Promise<Renderer> | null = null;

export function loadRenderer(): Promise<Renderer> {
  rendererPromise ??= import('./slot-renderer')
    .then((m) => ({ ReactDOM: m.ReactDOM, kit: m.pluginUiKit, SlotPropsContext: m.SlotPropsContext }));
  return rendererPromise;
}

function evaluateBundle(code: string, api: ReturnType<typeof buildPluginApi> | null, renderer: Renderer | null = null): PluginExports {
  const mod: { exports: PluginExports } = { exports: {} };
  const requireShim = makePluginRequire(api, renderer);
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
    fn(mod, mod.exports, requireShim, React, renderer?.ReactDOM ?? backgroundReactDom, ReactJSXRuntime, console);
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
  const slotInfo: Array<{ name: SlotName; hasShouldShow: boolean; order: number; fill?: boolean; startFolded?: boolean }> = [];
  const slots = exports.slots ?? {};
  for (const [name, def] of Object.entries(slots)) {
    if (def && typeof def.component === 'function') {
      slotInfo.push({
        name: name as SlotName,
        hasShouldShow: typeof def.shouldShow === 'function',
        order: typeof def.order === 'number' ? def.order : 100,
        // A panel that fills its panel instead of growing with its content.
        ...(def.fill === true && isFillableSlot(name) ? { fill: true } : {}),
        // A panel the user opens when they want it (a chat), not on every message.
        ...(def.startFolded === true && isFillableSlot(name) ? { startFolded: true } : {}),
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

async function bootSlot(payload: SlotInit): Promise<void> {
  // Replay the host theme before first paint so the slot never flashes the UA
  // default serif font or a light-on-light/dark mismatch.
  applyHostTheme(payload.theme);

  const renderer = await loadRenderer();
  const { SlotPropsContext } = renderer;
  const api = buildPluginApi(payload.manifest);
  const exports = evaluateBundle(payload.code, api, renderer);
  pluginExports = exports;
  slotName = payload.slot;

  const slotDef = exports.slots?.[payload.slot];
  if (!slotDef || typeof slotDef.component !== 'function') {
    throw new Error(`Plugin "${payload.pluginId}" does not export slots["${payload.slot}"].component`);
  }

  const rootEl = document.getElementById('plugin-sandbox-root');
  if (!rootEl) throw new Error('Sandbox root element missing');

  // Props the host pushed while the renderer was loading replace the init ones.
  let currentProps = decodeCallbacks(propsBeforeBoot ?? payload.extraProps) as Record<string, unknown>;
  propsBeforeBoot = null;
  const Component = slotDef.component;
  const inline = isInlineSlot(payload.slot);
  // Filling its panel: the document is as tall as the frame and the slot's
  // root takes all of it; the height is the panel's, so nothing is measured.
  const fill = payload.fill === true && isFillableSlot(payload.slot);
  if (fill) {
    document.documentElement.style.height = '100%';
    document.body.style.height = '100%';
    document.body.style.overflow = 'hidden';
    rootEl.style.height = '100%';
  }

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
    const [, setSettingsVersion] = React.useState(0);
    React.useEffect(() => {
      propsListeners.add(setProps);
      // An update can land between the first render and this effect; the
      // props it replaced carry callbacks the host has already dropped.
      setProps(currentProps);
      return () => { propsListeners.delete(setProps); };
    }, []);
    // Re-render the slot when its settings change, so a component that reads
    // api.plugin.settings while rendering shows the new values.
    React.useEffect(() => {
      const bump = () => setSettingsVersion((v) => v + 1);
      settingsListeners.add(bump);
      localeListeners.add(bump);
      hostFeatureListeners.add(bump);
      return () => {
        settingsListeners.delete(bump);
        localeListeners.delete(bump);
        hostFeatureListeners.delete(bump);
      };
    }, []);
    React.useEffect(() => {
      if (!wrapRef.current || fill) return;
      const el = wrapRef.current;
      let lastHeight = -1;
      let lastWidth = -1;
      const ro = new ResizeObserver(() => {
        const rect = el.getBoundingClientRect();
        const h = Math.ceil(rect.height);
        const w = inline ? Math.ceil(rect.width) : undefined;
        if (h !== lastHeight || (w !== undefined && w !== lastWidth)) {
          lastHeight = h;
          if (w !== undefined) lastWidth = w;
          sendToHost({ type: 'slot-resize', height: h, ...(w !== undefined ? { width: w } : {}) });
        }
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, []);
    // An inline slot is measured at its natural width (max-content), not the
    // iframe's: in a toolbar row the iframe starts out narrow, and content
    // that wraps to fit it reports a narrow width back, so it never grew.
    const style = inline
      ? { display: 'inline-block', width: 'max-content', maxWidth: MAX_INLINE_SLOT_WIDTH }
      : fill ? { height: '100%' } : undefined;
    return React.createElement('div', { ref: wrapRef, style },
      React.createElement(SlotPropsContext.Provider, { value: props }, React.createElement(Component, props)));
  };

  const reactRoot = renderer.ReactDOM.createRoot(rootEl);
  reactRoot.render(React.createElement(SlotShell));
  sendToHost({ type: 'init-done', hooks: [], slots: [], shortcuts: [] });
}

// Populated by bootSlot - receives `props-update` messages.
let slotPropsUpdater: ((next: Record<string, unknown>) => void) | null = null;
/** The last props-update that arrived before bootSlot was ready for it. */
let propsBeforeBoot: Record<string, unknown> | null = null;

async function handleInit(payload: InitPayload): Promise<void> {
  if (bootDone) return;
  bootDone = true;
  mode = payload.mode;
  // Make the active locale available to plugin code (api.i18n) right away -
  // not only after the first 'locale-change' push.
  applyLocale(payload.locale, payload.regional);
  // Before the bundle runs, so activate() and shouldShow already see it.
  applyHostFeatures(payload.hostFeatures);
  try {
    if (payload.mode === 'background') {
      await bootBackground(payload);
    } else {
      await bootSlot(payload);
    }
  } catch (err) {
    sendToHost({ type: 'init-error', error: (err as Error).message ?? String(err) });
  }
}

// ─── Host message handler ────────────────────────────────────

function handleHostMessage(ev: MessageEvent): void {
  // Only the framing window, posting from our own origin, may talk to us.
  // Both were bound by `resolveHost` before this listener was installed; a
  // message never establishes them (GHSA-96cx-gx36-3g79).
  if (!parentWindow || !parentOrigin) return;
  if (ev.source !== parentWindow) return;
  if (ev.origin !== parentOrigin) return;

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
      mergeLocaleTables(msg.locales);
      applyLocale(msg.locale, msg.regional);
      break;

    case 'theme-change':
      applyHostTheme(msg.theme);
      // The host switches the iframe element's color-scheme on this, not
      // before: while the two differ the browser paints an opaque canvas.
      sendToHost({ type: 'theme-applied', dark: msg.theme.dark === true });
      break;

    case 'settings-change':
      applySettings(msg.settings ?? {});
      break;

    case 'host-change':
      applyHostFeatures(msg.features);
      break;

    case 'props-update':
      if (slotPropsUpdater) slotPropsUpdater(msg.props ?? {});
      else if (mode === 'slot') propsBeforeBoot = msg.props ?? {};
      break;

    case 'stream-chunk': {
      const entry = proxyStreams.get(msg.streamId);
      try { entry?.controller?.enqueue(new Uint8Array(msg.chunk)); } catch { /* cancelled */ }
      break;
    }

    case 'stream-end': {
      const entry = proxyStreams.get(msg.streamId);
      proxyStreams.delete(msg.streamId);
      try {
        if (msg.error) entry?.controller?.error(new Error(msg.error));
        else entry?.controller?.close();
      } catch { /* already closed */ }
      break;
    }

    case 'stream-progress':
      try { proxyStreams.get(msg.streamId)?.onProgress?.(msg.loaded, msg.total); } catch { /* plugin's own error */ }
      break;

    case 'floating-dropdown-select':
      dispatchFloatingDropdownEvent(msg.id, { type: 'select', option: msg.option });
      break;

    case 'floating-dropdown-highlight':
      dispatchFloatingDropdownEvent(msg.id, { type: 'highlight', index: msg.index });
      break;

    case 'floating-dropdown-dismiss':
      dispatchFloatingDropdownEvent(msg.id, { type: 'dismiss' });
      break;
  }
}

// ─── Entry ───────────────────────────────────────────────────

/**
 * Bind to the host and tell it the frame is ready. The sandbox document
 * (sandbox-document.ts) runs this from its script, next to an existing
 * #plugin-sandbox-root. Returns the teardown.
 */
export function startSandboxRuntime(): () => void {
  // Not framed by a same-origin host: stay inert. No listener, no ping -
  // nothing a window.open()-ing site could talk to.
  const host = resolveHost();
  if (!host) return () => {};
  if (new URLSearchParams(window.location.search).get('frame') === 'slot') void loadRenderer();
  parentWindow = host.window;
  parentOrigin = host.origin;
  initFloatingDropdownBridge(
    (msg) => sendToHost(msg),
    () => !!parentWindow,
  );
  window.addEventListener('message', handleHostMessage);
  for (const event of ACTIVITY_EVENTS) window.addEventListener(event, onUserInput, { capture: true, passive: true });
  // Initial ping, targeted at the host origin so it can only land on the
  // page that framed us. Guard at module scope so React strict mode's
  // double-invoke doesn't re-post (and so a re-post can't race with the
  // parent's init reply).
  if (!readyPosted) {
    readyPosted = true;
    const activityPort = openActivityPort();
    sendToHost({ type: 'sandbox-ready' }, activityPort ? [activityPort] : undefined);
  }
  return () => {
    window.removeEventListener('message', handleHostMessage);
    for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, onUserInput, { capture: true });
  };
}

/** The runtime as a React component, for tests that render it. */
export function SandboxRuntime(): React.JSX.Element {
  useEffect(() => startSandboxRuntime(), []);
  return <div id="plugin-sandbox-root" />;
}

// Suppress unused-variable warning when `mode` is only read for debugging.
void mode;
void slotName;
