// Host-side implementations of the sandboxed plugin API. Every method gates
// on `plugin.permissions` BEFORE doing the underlying work, and only returns
// structured-cloneable data back to the iframe.

import type { AppInfoView, InstalledPlugin, Permission } from '../plugin-types';
import { fetchConfig } from '@/hooks/use-config';
import { IS_LITE } from '../lite';
import { doAppGetSettings, doAppSearchSettings } from './host-api-app';
import { mayOfferSlot, pluginHasPermission } from './permissions';
import { proxyAccounts, proxyCancel, proxyConnect, proxyDisconnect, proxyFetch, type StreamSink } from './proxy-client';
import { checkActions, isActionSurface, setPluginActions } from './actions';
import { checkDayLabels, setDayLabels } from './day-labels';
import { refreshRowBadges } from './row-badges';
import { checkPages, setPluginPages } from './pages';
import { toast as appToast } from '@/stores/toast-store';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { claimLegacyPluginStorage, pluginStoragePrefix } from './storage-scope';
import { useIdentityStore } from '@/stores/identity-store';
import { useEmailStore } from '@/stores/email-store';
import { useFilterStore } from '@/stores/filter-store';
import { useMessageListTabsStore } from '@/stores/message-list-tabs-store';
import {
  KEYWORD_PALETTE,
  useSettingsStore,
  type KeywordDefinition,
  type KeywordVisibility,
} from '@/stores/settings-store';
import type { MessageListTabsConfig } from '../plugin-types';
import { apiFetch, getPathPrefix, withBasePath } from '../browser-navigation';
import { createOAuthState } from '../plugin-oauth';
import { reportUploadProgress } from '../upload-progress';
import { DEFAULT_KEYWORD_SCAN_LIMIT } from '../jmap/client';
import { isServerSetKeyword } from '../jmap/server-keywords';
import { suggestKeywordColor } from '../keyword-discovery';
import { MAX_KEYWORD_LENGTH } from '../keyword-nesting';
import { KEYWORD_PREFIX } from '../thread-utils';
import { DEFAULT_SEARCH_FILTERS, normalizePluginFilter } from '../jmap/search-utils';
import { awaitDialog, awaitPrompt, awaitCustomDialog, type PromptField } from './host-dialog';
import { fileStorage } from '../plugin-storage';
import { generateUUID } from '../utils';
import { AddressBook, ContactCard, Identity } from '../jmap/types';
import { EncryptionAtRestConfig, PublicKeyInfo, PublicKeyInput, useAccountSecurityStore } from '@/stores/account-security-store';
import {
  doCalendarCreateEvent, doCalendarDeleteEvent, doCalendarGetEvent, doCalendarGetEvents,
  doCalendarListCalendars, doCalendarUpdateEvent, doTasksCreate, doTasksDelete, doTasksGet,
  doTasksList, doTasksSetComplete, doTasksUpdate,
} from './host-api-calendar';
import {
  doIdentitiesUpdate, doTemplatesCreate, doTemplatesDelete, doTemplatesGet, doTemplatesList,
  doTemplatesUpdate, doVacationGet, doVacationSet,
} from './host-api-settings';
import {
  doEmailArchive, doEmailGet, doEmailGetAttachment, doEmailGetRaw, doEmailList, doEmailMove, doEmailSearch, doMailboxesList,
} from './host-api-mail';
import { MAX_PLUGIN_FETCH_BYTES, readFileName, readMediaType, sessionClient } from './host-api-input';
import { doComposeOpen, doComposeReply, doDraftsCreate } from './host-api-compose';
import { doNotificationsShow } from './host-api-notify';
import { setSectionTitle } from './section-titles';
import { requestPanel } from './panel-requests';
import { doComposerAttach, doComposerGetBody, doComposerGetSelection, doComposerReplaceBody, doComposerReplaceSelection } from './host-api-composer';

/**
 * Methods only callable from the privileged (same-origin) tier. These expose
 * raw message bytes and raw submission, which an untrusted null-origin plugin
 * must never reach. Enforced in `dispatchApiCall` IN ADDITION to the per-method
 * permission gate.
 */
const PRIVILEGED_ONLY_METHODS = new Set<string>([
  'jmap.fetchBlob',
  // NOTE: jmap.uploadBlob is deliberately NOT here. The composer's
  // `composer-attachment-source` slot is built for untrusted plugins that
  // upload a file (from cloud storage, say) and hand the blob id to onAttach.
  'jmap.sendRaw',
  'jmap.submitRaw',
  'jmap.importRaw',
  // NOTE: upfiles.get is deliberately NOT tier-gated. It reads back a file the
  // user just attached in this session - not arbitrary message bytes from the
  // server (those stay behind jmap.fetchBlob above). Note that the id is not a
  // secret from the plugin: onBeforeBlobUpload hands it to every registered
  // handler, so any untrusted plugin granted email:blob-read can read the
  // bytes of every file the user attaches. That grant is what the consent
  // dialog for email:blob-read now says out loud.
  'crypto.getWebAuthn',
  'crypto.createWebAuthn',
  'crypto.getPublicKeys',
  'crypto.createPublicKey',
  'crypto.removePublicKey',
  'crypto.getEncryptionAtRest',
  'crypto.setEncryptionAtRest',
  'crypto.getPublicKeyFromWKD',
  // Replacing the bytes of a file the user is about to send is strictly more
  // dangerous than reading them, so the write stays privileged-only.
  // This entry used to read `upfiles.set`, which matches no dispatched method
  // and therefore gated nothing - the dispatcher calls it `upfiles.save`.
  'upfiles.save',
]);

export const PERM_PER_METHOD: Readonly<Record<string, Permission | null>> = {
  // storage is unscoped by the manifest - implicit.
  'storage.get': null,
  'storage.set': null,
  'storage.remove': null,
  'storage.keys': null,
  // toast / log don't need a permission (anyone can show a toast).
  'toast.success': null,
  'toast.error': null,
  'toast.info': null,
  'toast.warning': null,
  // http
  'http.post': 'http:post',
  'http.fetch': 'http:fetch',
  // jmap (privileged-tier only; see PRIVILEGED_ONLY_METHODS)
  'jmap.fetchBlob': 'email:blob-read',
  'jmap.uploadBlob': 'email:blob-write',
  'jmap.sendRaw': 'email:raw-send',
  'jmap.submitRaw': 'email:raw-send',
  'jmap.importRaw': 'email:raw-send',
  // Narrow read-only JMAP facade. This intentionally does not expose an
  // arbitrary request primitive that could turn email:read into Email/set.
  'jmap.getKeywords': 'email:read',
  // Replace one message's complete keyword map. Kept separate from the raw
  // request surface so email:write authorizes exactly this mutation.
  'jmap.setKeywords': 'email:write',
  'jmap.setKeyword': 'email:write',
  'jmap.removeKeyword': 'email:write',
  // uploaded files :
  // upfiles.get reads back a just-attached file (see onBeforeBlobUpload) and
  // is a read - it sits behind email:blob-read. To read a stored message
  // blob, use jmap.fetchBlob. upfiles.save rewrites the staged file: it stays
  // behind email:blob-write AND the privileged tier.
  'upfiles.get' : 'email:blob-read',
  'upfiles.save' : 'email:blob-write',
  'crypto.getWebAuthn': 'crypto:full',
  'crypto.createWebAuthn' : 'crypto:full',
  'crypto.getPublicKeys': 'crypto:full',
  'crypto.createPublicKey': 'crypto:full',
  'crypto.removePublicKey': 'crypto:full',
  'crypto.getEncryptionAtRest': 'crypto:full',
  'crypto.setEncryptionAtRest': 'crypto:full',
  'crypto.getPublicKeyFromWKD': 'crypto:full',
  // contact
  'contact.get': 'contacts:read',
  'contact.update': 'contacts:write',
  'contact.create': 'contacts:write',
  'contact.search': 'contacts:read',
  'contact.list': 'contacts:read',
  'contact.delete': 'contacts:write',
  // addressbook
  'addressbook.list': 'contacts:read',
  'addressbook.create': 'contacts:write',
  // user
  'user.getAccounts': 'account:read',
  'user.getIdentities': 'identity:read',
  // The IANA zone the app shows times in (Settings or the browser's).
  'user.getTimeZone': null,
  // The app's name and version: nothing about the user.
  'app.getInfo': null,
  // Where a setting is: the app's own texts, nothing about the user.
  'app.searchSettings': null,
  // The user's preferences (layout, formats, reading and sending behaviour).
  'app.getSettings': 'settings:read',
  'user.logout': 'auth:emit',
  // admin
  'admin.getConfig': 'admin:config',
  'admin.getAllConfig': 'admin:config',
  'admin.setConfig': 'admin:config',
  'admin.deleteConfig': 'admin:config',
  // The admin's non-secret settings for the calling plugin (a server
  // address, a switch). Secrets stay on the server.
  'plugin.getConfig': null,
  // ui - any plugin can ask the host to render a modal or open a URL.
  'ui.confirm': null,
  'ui.alert': null,
  'ui.prompt': null,
  'ui.openDialog': null,
  'ui.rerenderEmail': null,
  'ui.rerenderFetchedEmails': null,
  'ui.openExternalUrl': null,
  'ui.downloadFile': 'ui:download-file',
  // email keyword mutations
  'email.setKeyword': 'email:write',
  'email.removeKeyword': 'email:write',
  // Native keyword definitions are a deliberately narrow settings API: a
  // plugin can read definitions, append missing ones, or reorder the complete
  // existing set, but cannot overwrite or remove user-managed tags.
  // Discovery/counts reveal mail metadata and therefore use email:read rather
  // than a settings permission.
  'keywords.list': 'settings:read',
  'keywords.add': 'settings:write',
  'keywords.update': 'settings:write',
  'keywords.remove': 'settings:write',
  'keywords.reorder': 'settings:write',
  'keywords.discover': 'email:read',
  'keywords.getCounts': 'email:read',
  'keywords.refreshCounts': 'email:read',
  // message-list category tabs
  'tabs.set': 'ui:message-list-tabs',
  'tabs.clear': 'ui:message-list-tabs',
  'tabs.getState': 'ui:message-list-tabs',
  'tabs.refreshCounts': 'ui:message-list-tabs',
  // categorize rewrites message keywords, so it needs the write permission
  // (a tabs-only plugin can still render tabs without it).
  'tabs.categorize': 'email:write',
  // message-list search: the plugin never sees the results, but it decides
  // which messages the list shows.
  'search.run': 'email:read',
  // OAuth with a third party: a state value bound to this plugin, and the
  // redirect URI the provider sends the user back to.
  'oauth.createState': 'http:fetch',
  'oauth.getRedirectUri': 'http:fetch',
  // Requests with a credential, through the server (lib/plugin-secrets).
  'proxy.fetch': 'http:proxy',
  'proxy.cancel': 'http:proxy',
  'proxy.connect': 'http:proxy',
  'proxy.accounts': 'http:proxy',
  'proxy.disconnect': 'http:proxy',
  // Buttons and menu entries drawn by the host; the surface's own
  // permission is checked per call (see the slot catalogue).
  'ui.setActions': null,
  // Ask the rows again for onEmailListItemRender badges (rate limited).
  'ui.refreshRowBadges': null,
  'ui.setDayLabels': 'ui:calendar-action',
  'ui.setPages': 'ui:app-page',
  'ui.setSectionTitle': 'ui:sidebar-widget',
  // Open, close or toggle the panel the plugin's slot sits in; the panel's
  // own permission is checked per call (see the slot catalogue).
  'ui.setPanel': null,
  // sieve (delivery-time classification)
  'sieve.isSupported': 'filters:read',
  'sieve.getActiveScript': 'filters:read',
  'sieve.validateScript': 'filters:write',
  'sieve.regenerate': 'filters:write',
  // calendar events. Reads go to the server; writes go through the calendar
  // store so its plugin hooks run. None of them sends invitations.
  'calendar.listCalendars': 'calendar:read',
  'calendar.getEvents': 'calendar:read',
  'calendar.getEvent': 'calendar:read',
  'calendar.createEvent': 'calendar:write',
  'calendar.updateEvent': 'calendar:write',
  'calendar.deleteEvent': 'calendar:write',
  // tasks
  'tasks.list': 'tasks:read',
  'tasks.get': 'tasks:read',
  'tasks.create': 'tasks:write',
  'tasks.update': 'tasks:write',
  'tasks.setComplete': 'tasks:write',
  'tasks.delete': 'tasks:write',
  // message templates
  'templates.list': 'templates:read',
  'templates.get': 'templates:read',
  'templates.create': 'templates:write',
  'templates.update': 'templates:write',
  'templates.delete': 'templates:write',
  // sender identities: name, reply-to and signatures, never the address
  'identities.update': 'identity:write',
  // out-of-office reply
  'vacation.get': 'vacation:read',
  'vacation.set': 'vacation:write',
  // reading mail: one message with its text, a page of a folder, the folders
  'email.get': 'email:read',
  'email.list': 'email:read',
  'email.search': 'email:read',
  'mailboxes.list': 'email:read',
  // The bytes of one attachment of a given message, or of the message
  // itself. Unlike jmap.fetchBlob these only reach blobs of a message the
  // plugin names, so the untrusted tier may call them.
  'email.getAttachment': 'email:blob-read',
  'email.getRaw': 'email:blob-read',
  // Moving messages between the account's folders, archive included.
  'email.move': 'email:write',
  'email.archive': 'email:write',
  // Open the composer filled in; the user still decides whether to send.
  'compose.open': 'compose:open',
  // Reply to the message open in the reader, with text to start from.
  'compose.reply': 'compose:open',
  // Save a draft without opening the composer. Nothing is sent.
  'drafts.create': 'email:write',
  // A system notification (or a toast), naming the plugin, 5 a minute.
  'notifications.show': 'ui:notifications',
  // The message being written, in a composer that handed the plugin its id.
  'composer.getBody': 'compose:read',
  'composer.getSelection': 'compose:read',
  'composer.replaceSelection': 'compose:write',
  'composer.replaceBody': 'compose:write',
  // Attach a file the plugin uploaded (jmap.uploadBlob).
  'composer.attach': 'email:blob-write',
};

// ─── Cross-origin allow-list (mirrors lib/plugin-api.ts) ──────

function originMatchesAllowlist(url: URL, allowlist: string[]): boolean {
  if (url.protocol !== 'https:') return false;
  for (const entry of allowlist) {
    let parsed: URL;
    try { parsed = new URL(entry.replace('*.', '')); } catch { continue; }
    if (parsed.protocol !== 'https:') continue;
    const port = url.port || '';
    const expectedPort = parsed.port || '';
    if (port !== expectedPort) continue;
    if (entry.includes('*.')) {
      const suffix = '.' + parsed.hostname.toLowerCase();
      const host = url.hostname.toLowerCase();
      if (host.endsWith(suffix)) {
        const prefix = host.slice(0, host.length - suffix.length);
        if (prefix.length > 0 && !prefix.includes('.')) return true;
      }
    } else if (url.hostname.toLowerCase() === parsed.hostname.toLowerCase()) {
      return true;
    }
  }
  return false;
}

// ─── Per-plugin storage namespace ─────────────────────────────

/** The signed-in account's namespace; see storage-scope.ts. */
function storagePrefix(pluginId: string): string {
  const accountId = useAccountStore.getState().activeAccountId;
  if (!accountId) return pluginStoragePrefix(pluginId, 'signed-out');
  claimLegacyPluginStorage(pluginId, accountId);
  return pluginStoragePrefix(pluginId, accountId);
}

function storageGet(pluginId: string, key: string): unknown {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(storagePrefix(pluginId) + key);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
/**
 * What one plugin may keep per account in localStorage. The host's own
 * stores (sign-in, settings) live in the same 5-10 MB browser quota, so a
 * plugin that filled it would break them.
 */
export const PLUGIN_STORAGE_QUOTA_BYTES = 1024 * 1024;

function storageSet(pluginId: string, key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  if (typeof key !== 'string' || key.length === 0 || key.length > 256) {
    throw new Error('storage.set: key must be a string of 1-256 characters');
  }
  const prefix = storagePrefix(pluginId);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('storage.set: value is not JSON-serialisable');
  let used = 0;
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (!k?.startsWith(prefix) || k === prefix + key) continue;
    used += k.length + (window.localStorage.getItem(k)?.length ?? 0);
  }
  // UTF-16 code units, which is what browsers count against the quota.
  if (used + prefix.length + key.length + serialized.length > PLUGIN_STORAGE_QUOTA_BYTES) {
    throw new Error(`Plugin storage is full (${Math.round(PLUGIN_STORAGE_QUOTA_BYTES / 1024)} KB per account)`);
  }
  window.localStorage.setItem(prefix + key, serialized);
}
function storageRemove(pluginId: string, key: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(storagePrefix(pluginId) + key);
}
function storageKeys(pluginId: string): string[] {
  if (typeof window === 'undefined') return [];
  const prefix = storagePrefix(pluginId);
  const out: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k?.startsWith(prefix)) out.push(k.slice(prefix.length));
  }
  return out;
}

// ─── user ─────────────────────────────────────────────────────
interface AccountResponse {
  id: string;
  label: string;
  serverUrl: string;
  username: string;
  displayName: string;
  email: string;
  avatarColor: string;
  isConnected: boolean;
  isDefault: boolean;
  isActive: boolean;
}
function doUserGetAccounts(): AccountResponse[] {
  const state = useAccountStore.getState();
  const activeAccountId = state.activeAccountId;

  // we remove sensitive fields from the account entries before returning to the plugin
  // we add a new field isActive to indicate which account is currently active
  const accounts = state.accounts.map((account) => ({
    id: account.id,
    label: account.label,
    serverUrl: account.serverUrl,
    username: account.username,
    displayName: account.displayName,
    email: account.email,
    avatarColor: account.avatarColor,
    isConnected: account.isConnected,
    isDefault: account.isDefault,
    isActive: account.id === activeAccountId,
  }));

  return accounts;
}

function doUserGetIdentities(): Identity[] {
  return useIdentityStore.getState().identities;
}

async function doUserLogout(): Promise<void>{
  return useAuthStore.getState().logout();
}

// ─── http.post (same-origin /api/*) ───────────────────────────

/**
 * Returns true iff `path` is permitted by the plugin's `apiPostPaths`
 * allowlist. Entries are either exact paths (must equal `path`) or prefixes
 * that end with `/` (`path` must start with the entry).
 */
function isApiPostPathAllowed(path: string, allowlist: readonly string[]): boolean {
  for (const entry of allowlist) {
    if (typeof entry !== 'string' || !entry.startsWith('/api/')) continue;
    if (entry.endsWith('/')) {
      if (path === entry || path.startsWith(entry)) return true;
    } else if (path === entry) {
      return true;
    }
  }
  return false;
}

/**
 * Same-origin routes no plugin may POST to, whatever its `apiPostPaths`
 * lists: they act with the user's full credentials (the JMAP passthrough,
 * WebDAV, CalDAV), change sign-in, admin or plugin state, or belong to the
 * setup wizard. A plugin talks to its own sidecar routes instead.
 *
 * Listed by their segment under `/api/`, not as `/api/...` strings: the Lite
 * build reads every such string in a client chunk as an endpoint the browser
 * calls and refuses the ones it has no stand-in for (scripts/lite/verify.mjs).
 */
const PLUGIN_POST_DENIED_ROUTES = new Set([
  'account',
  'account-archive',
  'admin',
  'auth',
  'caldav',
  // The user's agenda, a server-side fetch of any URL, and a third-party
  // relay: each is data or reach a plugin gets only through its own
  // permission-gated API, not through a POST with the user's cookies.
  'calendar-agenda',
  'dev-jmap',
  'fetch-ical',
  'plugin-approval-status',
  // Another plugin's connected accounts and admin keys: the proxy injects
  // the credential named in the query string, whichever plugin asks.
  'plugin-proxy',
  'plugin-secrets',
  'plugins',
  'push',
  'settings',
  'setup',
  'system',
  'translate',
  'webdav',
  'wopi',
]);

/**
 * Checked on the path the router will see: decoded once and with repeated
 * slashes collapsed, so `/api/%61dmin/...` cannot pass for something else.
 */
export function isPluginPostDenied(pathname: string): boolean {
  let routePath: string;
  try {
    routePath = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  routePath = routePath.replace(/\/{2,}/g, '/');
  if (!routePath.startsWith('/api/')) return false;
  return PLUGIN_POST_DENIED_ROUTES.has(routePath.slice('/api/'.length).split('/')[0]);
}

interface PluginHttpPostOptions {
  headers?: Record<string, string>;
  /**
   * Staged-attachment file id (the one `onBeforeBlobUpload` handed to the
   * plugin) to report byte-level upload progress for. Only meaningful on a
   * `Blob`/`File` body. Progress goes to the host-side registry the composer
   * listens on (`lib/upload-progress.ts`), never back into the sandbox, so
   * the attachment chip can show a real percentage while a plugin offloads
   * the file. Reports for an id the composer isn't tracking are dropped.
   */
  progressFileId?: string;
}

/**
 * Namespace a plugin must use for its own upload metadata headers. Anything
 * outside it (and `Content-Type`) is refused, so a plugin can never reach the
 * credential headers the host attaches to the request.
 */
const PLUGIN_HEADER_PREFIX = 'x-plugin-';

function applyPluginUploadHeaders(
  provided: Record<string, string> | undefined,
  target: Record<string, string>,
): void {
  for (const [name, value] of Object.entries(provided ?? {})) {
    const lower = name.toLowerCase();
    if (lower !== 'content-type' && !lower.startsWith(PLUGIN_HEADER_PREFIX)) {
      throw new Error(
        `Header ${name} is not allowed on a binary plugin upload (use Content-Type or an X-Plugin-* header)`,
      );
    }
    target[name] = String(value);
  }
}

async function doHttpPost(
  plugin: InstalledPlugin,
  path: string,
  body: unknown,
  options?: PluginHttpPostOptions,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  if (typeof path !== 'string' || !path.startsWith('/api/')) {
    throw new Error('path must start with /api/');
  }
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin) {
    throw new Error('path must resolve to the same origin');
  }
  // Per-plugin path allow-list. Comparison is on the pathname only (query
  // strings don't widen the surface, so we ignore them here).
  const allow = plugin.apiPostPaths ?? [];
  if (allow.length === 0) {
    throw new Error(`Plugin "${plugin.id}" has no apiPostPaths declared`);
  }
  if (!isApiPostPathAllowed(url.pathname, allow)) {
    throw new Error(`Path ${url.pathname} not in plugin apiPostPaths allowlist`);
  }
  if (isPluginPostDenied(url.pathname)) {
    throw new Error(`Path ${url.pathname} is not available to plugins`);
  }
  const { client } = useAuthStore.getState();
  const headers: Record<string, string> = {};
  let requestBody: BodyInit;

  if (body instanceof Blob) {
    // Binary upload: the plugin owns Content-Type and any X-Plugin-* metadata
    // the receiving route needs. Stock behaviour for every other body type is
    // unchanged - it is still serialized as JSON.
    applyPluginUploadHeaders(options?.headers, headers);
    const hasContentType = Object.keys(headers).some(h => h.toLowerCase() === 'content-type');
    if (!hasContentType && body.type) {
      headers['Content-Type'] = body.type;
    }
    requestBody = body;
  } else {
    headers['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }

  // Applied last so plugin-supplied headers can never override credentials.
  if (client) {
    headers['Authorization'] = client.getAuthHeader();
    headers['X-JMAP-Username'] = client.getUsername();
  }

  // Progress requires XMLHttpRequest: fetch() exposes no upload progress
  // events (request streaming is Chrome-only), and the JMAP client's blob
  // upload already made the same trade for the same reason (#333). Callers
  // that don't ask for progress keep the fetch path untouched.
  if (body instanceof Blob && options?.progressFileId !== undefined) {
    const fileId = options.progressFileId;
    if (typeof fileId !== 'string' || fileId.length === 0 || fileId.length > 128) {
      throw new Error('progressFileId must be a non-empty string of at most 128 characters');
    }
    return xhrPost(url.pathname + url.search, headers, body, (loaded, total) =>
      reportUploadProgress(fileId, loaded, total),
    );
  }

  const res = await apiFetch(url.pathname + url.search, {
    method: 'POST',
    headers,
    body: requestBody,
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

/**
 * POST via XMLHttpRequest so `xhr.upload.onprogress` can report transferred
 * bytes. Same shape of result as the fetch path in `doHttpPost`; the path is
 * prefixed exactly like `apiFetch` does for a same-origin `/api/*` path.
 */
function xhrPost(
  path: string,
  headers: Record<string, string>,
  body: Blob,
  onProgress: (loaded: number, total: number) => void,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', getPathPrefix() + path);
    for (const [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      let data: unknown = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* non-JSON body */ }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
    };
    xhr.onerror = () => reject(new Error('Network error during plugin upload'));
    xhr.ontimeout = () => reject(new Error('Plugin upload timed out'));
    xhr.send(body);
  });
}

// ─── http.fetch (cross-origin, manifest-allowlisted) ──────────

interface PluginFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer | ArrayBufferView | null;
}

// The http.fetch body is copied across postMessage twice (text and bytes);
// MAX_PLUGIN_FETCH_BYTES (host-api-input.ts) caps it like every other body
// the host hands a plugin.
export { MAX_PLUGIN_FETCH_BYTES };

async function readCapped(res: Response, limit: number): Promise<ArrayBuffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    void res.body?.cancel().catch(() => {});
    throw new Error(`Response is larger than ${limit} bytes`);
  }
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      void reader.cancel().catch(() => {});
      throw new Error(`Response is larger than ${limit} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

async function doHttpFetch(plugin: InstalledPlugin, rawUrl: string, init?: PluginFetchInit) {
  if (typeof rawUrl !== 'string') throw new Error('url must be a string');
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error('url must be absolute https://'); }
  const allowlist = plugin.httpOrigins ?? [];
  if (allowlist.length === 0) {
    throw new Error(`Plugin "${plugin.id}" has no httpOrigins declared`);
  }
  if (!originMatchesAllowlist(url, allowlist)) {
    throw new Error(`Origin ${url.origin} not in plugin httpOrigins allowlist`);
  }
  const safeHeaders: Record<string, string> = {};
  if (init?.headers) {
    for (const [k, v] of Object.entries(init.headers)) {
      const lower = k.toLowerCase();
      if (lower === 'cookie' || lower === 'x-jmap-username') continue;
      safeHeaders[k] = v;
    }
  }
  const res = await fetch(url.toString(), {
    method: init?.method ?? 'GET',
    headers: safeHeaders,
    body: (init?.body ?? undefined) as BodyInit | undefined,
    credentials: 'omit',
    mode: 'cors',
    redirect: 'follow',
  });
  // fetch() can't stop at a cross-origin redirect and still tell us where it
  // was going, so it follows, and the plugin only gets the answer if the
  // last hop is still allowlisted. The request carries the webmail origin,
  // so a host that trusts that origin in CORS would otherwise answer it.
  if (res.url) {
    let finalUrl: URL | null = null;
    try { finalUrl = new URL(res.url); } catch { /* opaque */ }
    if (!finalUrl || !originMatchesAllowlist(finalUrl, allowlist)) {
      void res.body?.cancel().catch(() => {});
      throw new Error(`Request was redirected to ${finalUrl?.origin ?? 'an unknown origin'}, which is not in plugin httpOrigins allowlist`);
    }
  }
  // Sandboxed plugin can't hold a Response object across the boundary, so
  // we read the body once and return it as text + arrayBuffer (base64).
  const headers: Record<string, string> = {};
  res.headers.forEach((val, key) => { headers[key.toLowerCase()] = val; });
  const buf = await readCapped(res, MAX_PLUGIN_FETCH_BYTES);
  let text: string | null = null;
  try { text = new TextDecoder('utf-8', { fatal: false }).decode(buf); } catch { text = null; }
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    headers,
    bodyText: text,
    bodyBytes: new Uint8Array(buf),
  };
}

// ─── jmap (privileged tier) ───────────────────────────────────

/**
 * Fetch the raw bytes of a blob by id, using the host's authenticated JMAP
 * client. The plugin decides WHICH blobId to fetch (e.g. a pkcs7-mime part, or
 * the full RFC822 message blob) and runs its own detection; the host only
 * exposes the byte-fetch primitive. Returns a Uint8Array (structured-cloneable
 * across the postMessage boundary).
 */
async function doJmapFetchBlob(blobId: string, opts?: { name?: string; type?: string, rangeHeader?: number }): Promise<Uint8Array> {
  if (typeof blobId !== 'string' || !blobId) throw new Error('jmap.fetchBlob: blobId required');
  const { client } = useAuthStore.getState();
  if (!client) throw new Error('jmap.fetchBlob: no active session');
  const buf = await client.fetchBlobArrayBuffer(blobId, opts?.name, opts?.type, undefined, opts?.rangeHeader);
  return new Uint8Array(buf);
}

/** Largest blob a plugin may upload when the server names no limit of its own. */
export const MAX_PLUGIN_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * jmap.uploadBlob: bytes from the plugin, checked like the attachment refs a
 * plugin hands the composer (readBlobRefs): a real file name, a media type,
 * and no more than the server accepts (its maxSizeUpload, or 50 MB when it
 * names none).
 */
async function doJmapUploadBlob(content: unknown, name: unknown, type: unknown): Promise<{ blobId: string; size: number; type: string; }> {
  const method = 'jmap.uploadBlob';
  const bytes = content instanceof Uint8Array ? content
    : content instanceof ArrayBuffer ? new Uint8Array(content)
    : null;
  if (!bytes) throw new Error(`${method}: content must be a Uint8Array or ArrayBuffer`);
  const fileName = readFileName(name, method, 'name');
  const mediaType = readMediaType(type, method, 'type');
  const client = sessionClient(method);
  const serverLimit = client.getMaxSizeUpload();
  const limit = serverLimit > 0 ? serverLimit : MAX_PLUGIN_UPLOAD_BYTES;
  if (bytes.byteLength > limit) {
    throw new Error(`${method}: content is ${bytes.byteLength} bytes, more than the ${limit} bytes allowed`);
  }
  const file = new File([bytes as BlobPart], fileName, { type: mediaType });
  return await client.uploadBlob(file);
}

interface JmapSubmitRawOptions {
  delayedUntil?: string;
  envelopeRecipients?: string[];
}

/**
 * Submit a fully-formed raw RFC822 message (e.g. one a plugin has signed and/or
 * encrypted) via the host's raw-send path, which also files it into Sent. The
 * plugin passes raw bytes; the host wraps them in a Blob.
 */
async function doJmapSendRaw(
  rawBytes: ArrayBuffer | ArrayBufferView,
  identityId: string,
  opts?: JmapSubmitRawOptions,
): Promise<unknown> {
  if (typeof identityId !== 'string' || !identityId) throw new Error('jmap.sendRaw: identityId required');
  const { client } = useAuthStore.getState();
  if (!client) throw new Error('jmap.sendRaw: no active session');
  const view = rawBytes instanceof ArrayBuffer
    ? new Uint8Array(rawBytes)
    : new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  // Copy into a fresh ArrayBuffer-backed array so the Blob part is definitely
  // ArrayBuffer (not SharedArrayBuffer) — also detaches from the caller's view.
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  const blob = new Blob([copy.buffer], { type: 'message/rfc822' });
  return useEmailStore.getState().sendRawEmail(
    client,
    blob,
    identityId,
    opts?.delayedUntil,
    opts?.envelopeRecipients,
  );
}


/**
 * submit a fully-formed raw RFC822 message without putting it in sent box. 
 */
async function doJmapSubmitRaw(
  rawBytes: ArrayBuffer | ArrayBufferView,
  identityId: string,
  opts?: JmapSubmitRawOptions,
): Promise<unknown> {
  if (typeof identityId !== 'string' || !identityId) {
    throw new Error('jmap.submitRaw: identityId required');
  }

  const { client } = useAuthStore.getState();
  if (!client) {
    throw new Error('jmap.submitRaw: no active session');
  }

  const view = rawBytes instanceof ArrayBuffer
    ? new Uint8Array(rawBytes)
    : new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  const blob = new Blob([copy.buffer], { type: 'message/rfc822' });

  return client.submitRawEmail(
    blob,
    identityId,
    opts?.delayedUntil,
    opts?.envelopeRecipients,
  );
}

interface JmapImportRawOptions {
  keywords?: Record<string, boolean>;
  accountId?: string;
}

/**
 * Import a fully-formed raw RFC822 message into the user's mailbox.
 */
async function doJmapImportRaw(
  rawBytes: ArrayBuffer | ArrayBufferView,
  mailboxRoles: string[],
  opts?: JmapImportRawOptions,
): Promise<string> {

  const { client } = useAuthStore.getState();
  if (!client) {
    throw new Error('jmap.importRaw: no active session');
  }
  let mailboxIds: Record<string, boolean> = {};

    const mailboxes = await client.getMailboxes();
    for (const role of mailboxRoles) {
      const mailbox = mailboxes.find(mb => mb.role === role);
      if (!mailbox) {
        throw new Error(`Mailbox with role "${role}" not found`);
      }
      mailboxIds[mailbox.id] = true;
    }

    if (Object.keys(mailboxIds).length === 0) {
      throw new Error('No valid mailboxes found for the specified roles');
    }
  const view = rawBytes instanceof ArrayBuffer
    ? new Uint8Array(rawBytes)
    : new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  const blob = new Blob([copy.buffer], { type: 'message/rfc822' });

  // Stalwart 1.0 sets the attachment keyword an imported message deserves and
  // keeps any other it is given: a `$hasattachment` from the plugin would make
  // `hasAttachment` true for a message without attachments.
  const keywords = opts?.keywords
    ? Object.fromEntries(Object.entries(opts.keywords).filter(([keyword]) => !isServerSetKeyword(keyword)))
    : undefined;

  return client.importRawEmail(
    blob,
    mailboxIds,
    keywords,
    opts?.accountId,
  );
}

async function doContactSearch(query: string): Promise<ContactCard[]> {
    const { client } = useAuthStore.getState();
  if (!client) {
    throw new Error('contact.search: no active session');
  }
  return await client.searchContacts(query);
}

async function doContactGet(contactId: string): Promise<ContactCard | null> {
    const { client } = useAuthStore.getState();
  if (!client) {
    throw new Error('contact.get: no active session');
  }
  return await client.getContact(contactId);
}

async function doContactUpdate(id: string, contact: Partial<ContactCard>): Promise<void> {
    const { client } = useAuthStore.getState();
  if (!client) {
    throw new Error('contact.update: no active session');
  }

  await client.updateContact(id, contact);
}

async function doContactCreate(contact: ContactCard): Promise<ContactCard> {
    const { client } = useAuthStore.getState();
      if (!client) {
    throw new Error('contact.create: no active session');
  }

  return await client.createContact(contact);
}

async function doContactList(addressBookId?: string): Promise<ContactCard[]> {
  const { client } = useAuthStore.getState();
  if (!client) {
    throw new Error('contact.list: no active session');
  }
  // Propagate failures: a plugin must not mistake an outage for an empty
  // address book.
  return await client.getContacts(addressBookId, { throwOnError: true });
}

async function doContactDelete(contactId: string): Promise<void> {
  const { client } = useAuthStore.getState();
  if (!client) {
    throw new Error('contact.delete: no active session');
  }
  await client.deleteContact(contactId);
}

async function doAddressBookList(): Promise<AddressBook[]> {
  const { client } = useAuthStore.getState();
  if (!client) {
    throw new Error('addressbook.list: no active session');
  }
  // Propagate failures so plugins can tell "no books" from a failed fetch
  // (see #730).
  return await client.getAddressBooks({ throwOnError: true });
}

async function doAddressBookCreate(name: string): Promise<AddressBook> {
  const { client } = useAuthStore.getState();
  if (!client) {
    throw new Error('addressbook.create: no active session');
  }
  return await client.createAddressBook(name);
}

// ─── Crypto (privileged tier) ─────────────────────────────────────────────

type PRFResult = 
  | { success: true; credentialId: number[]; prfSecret: number[] }
  | { success: false; reason: 'NEEDS_USER_ACTION'; credentialId: number[] }
  | { success: false; reason: string };

/**
 * Retrieves the PRF secret for an existing credential (Authentication).
 * Must be called directly inside a user interaction handler (e.g., click event).
 */
async function doGetPRF(
    masterCredentialIdBytes: number[],
    pluginId: string,
): Promise<{ credentialId: number[]; prfSecret: number[] } | string> {
  const PRF_SALT = new TextEncoder().encode("bulwark-plugins-v1" + pluginId);
  const rpId = window.location.hostname;
  const credentialId = new Uint8Array(masterCredentialIdBytes);

  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: rpId,
      allowCredentials: [{ type: "public-key", id: credentialId }],
      userVerification: "required",
      extensions: { prf: { eval: { first: PRF_SALT } } }
    }
  }) as PublicKeyCredential;

  const outputs = assertion.getClientExtensionResults();
  const prfSecret = outputs.prf?.results?.first;
  if (!prfSecret) return 'Cannot get PRF secret from credential.';

  return {
    credentialId: masterCredentialIdBytes,
    prfSecret: Array.from(new Uint8Array(prfSecret as ArrayBuffer))
  };
}

/**
 * Creates a WebAuthn passkey and attempts to extract its PRF secret (Registration).
 * If the authenticator returns the secret during creation, it completes in one step.
 * If Safari/iOS creates the key without evaluating PRF at creation time, it returns
 * `NEEDS_USER_ACTION` so UI can prompt for a second click (user gesture) before calling `doGetPRFSecret`.
 */
async function doCreatePRF(
    pluginId: string,
    name: string, 
    displayName: string,
): Promise<PRFResult> {
  const PRF_SALT = new TextEncoder().encode("bulwark-plugins-v1" + pluginId);
  const rpId = window.location.hostname;

  try {
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: "Bulwark Webmail", id: rpId },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: name,
          displayName: displayName
        },
        pubKeyCredParams: [
          { type: "public-key" as const, alg: -7 },   // ES256
          { type: "public-key" as const, alg: -257 }  // RS256
        ],
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "required"
        },
        extensions: { 
          prf: { eval: { first: PRF_SALT } } 
        }
      }
    }) as PublicKeyCredential;

    const outputs = credential.getClientExtensionResults();
    const prfSecret = outputs.prf?.results?.first;
    const credentialId = Array.from(new Uint8Array(credential.rawId));

    // Case 1: PRF evaluated during creation (1-click flow for supporting platforms)
    if (prfSecret) {
      return {
        success: true,
        credentialId,
        prfSecret: Array.from(new Uint8Array(prfSecret as ArrayBuffer))
      };
    }

    // Case 2: Key created, but authenticators require a separate get() call.
    // Returning 'NEEDS_USER_ACTION' allows the UI to request a fresh user gesture.
    return {
      success: false,
      reason: 'NEEDS_USER_ACTION',
      credentialId
    };

  } catch (err: any) {
    return { 
      success: false, 
      reason: err.message || 'Error creating PRF key' 
    };
  }
}

async function getPublicKeys(): Promise<PublicKeyInfo[]> {
  const store = useAccountSecurityStore.getState();
  await store.fetchPublicKeys();
  return store.publicKeys;
}
async function doCreatePublicKey(input: PublicKeyInput): Promise<string> {
  const store = useAccountSecurityStore.getState();
  return await store.createPublicKey(input);
}
async function doRemovePublicKey(keyId: string): Promise<void> {
  const store = useAccountSecurityStore.getState();
  return await store.removePublicKey(keyId);
}
async function doGetEncryptionAtRest(): Promise<EncryptionAtRestConfig> {
  const store = useAccountSecurityStore.getState();
  await store.fetchCryptoInfo();
  return store.encryptionConfig;
}
async function doSetEncryptionAtRest(config: EncryptionAtRestConfig): Promise<void> {
  const store = useAccountSecurityStore.getState();
  return await store.updateEncryptionAtRest(config);
}

// ----doGetPublicKeyFromWKD----------

// (RFC 6186 / z-base-32 spec)
const ZBASE32_ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769';

function zBase32Encode(buffer: Uint8Array): string {
  let bits = 0;
  let value = 0;
  const output: string[] = [];

  for (let i = 0; i < buffer.length; i++) {
    // Shift existing bits left by 8 and append the new byte
    value = (value << 8) | buffer[i];
    bits += 8;

    // Extract all complete 5-bit chunks from MSB to LSB
    while (bits >= 5) {
      bits -= 5;
      output.push(ZBASE32_ALPHABET[(value >>> bits) & 31]);
    }

    // Keep only the remaining unread bits (< 5) to prevent 32-bit integer overflow
    value &= (1 << bits) - 1;
  }

  // Handle remaining trailing bits (1 to 4 bits left)
  if (bits > 0) {
    // Left-pad with zeros to complete the final 5-bit character
    output.push(ZBASE32_ALPHABET[(value << (5 - bits)) & 31]);
  }

  return output.join('');
}

/**
 * Generates the WKD hash (SHA-1 in z-base-32) from the local-part.
 * RFC 9292: Lowercase in UTF-8 before hashing.
 */
export async function getWkdHash(localPart: string): Promise<string> {
  // NFC normalization + lowercasing
  const normalizedLocal = localPart.normalize('NFC').toLowerCase();

  // Explicit TextEncoder usage to guarantee UTF-8 bytes. WebCrypto, not
  // Node's crypto: importing that pulled a ~330 KB polyfill into the client.
  const utf8Bytes = new TextEncoder().encode(normalizedLocal);
  const sha1 = await crypto.subtle.digest('SHA-1', utf8Bytes);

  return zBase32Encode(new Uint8Array(sha1));
}

/**
 * Validates OpenPGP key format (Binary mandatory for WKD, ASCII tolerated).
 */
function isValidPgpKey(data: ArrayBuffer): { isValid: boolean, type: 'ARMORED' | 'BINARY' } {
  const bytes = new Uint8Array(data);
  if (bytes.length < 5) return { isValid: false, type: 'BINARY' };

  // Safe ASCII-Armored detection against binary decoding errors
  const textHead = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 200));
  if (textHead.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----')) return { isValid: true, type: 'ARMORED' };

  // Binary validation (RFC 4880 + RFC 9580)
  const firstByte = bytes[0];
  if ((firstByte & 0x80) === 0) return { isValid: false, type: 'BINARY' }; // Bit 7 must always be 1

  const isOldFormat = (firstByte & 0x40) === 0;
  const tag = isOldFormat ? (firstByte >> 2) & 0x0f : firstByte & 0x3f;

  // Tag 6 = Public-Key Packet, Tag 14 = Public-Subkey Packet
  return { isValid: tag === 6 || tag === 14, type: 'BINARY' };
}

export interface WkdResult {
  status: 'FOUND' | 'NOT_FOUND' | 'ERROR';
  rawKey?: ArrayBuffer;
  error?: string;
  type?: 'ARMORED' | 'BINARY';
}

export async function doGetPublicKeyFromWKD(email: string): Promise<WkdResult> {
  const cleanEmail = email.trim();
  const atIndex = cleanEmail.lastIndexOf('@');
  
  if (atIndex <= 0 || atIndex === cleanEmail.length - 1) {
    return { status: 'ERROR', error: 'Invalid email address' };
  }

  const localPart = cleanEmail.slice(0, atIndex);
  const domain = cleanEmail.slice(atIndex + 1).toLowerCase();
  // The domain goes into a URL; anything but a host name would change where
  // the request goes (a@evil.example/x?).
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
    return { status: 'ERROR', error: 'Invalid email address' };
  }
  const hash = await getWkdHash(localPart);

  const urls = [
    `https://openpgpkey.${domain}/.well-known/openpgpkey/hu/${hash}?l=${encodeURIComponent(localPart)}`,
    `https://${domain}/.well-known/openpgpkey/hu/${hash}?l=${encodeURIComponent(localPart)}`
  ];

  for (const url of urls) {
    try {
      // 5-second request timeout controller
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, {
        method: 'GET',
        credentials: 'omit',
        headers: { 'Accept': 'application/pgp-keys' },
        cache: 'no-cache',
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        // Size limitation protection (e.g., max 2 MB)
        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > 2 * 1024 * 1024) {
          continue; 
        }

        const buffer = await response.arrayBuffer();

        const pgpKeyResult = isValidPgpKey(buffer);
        if (pgpKeyResult.isValid) {
          return { status: 'FOUND', rawKey: buffer, type: pgpKeyResult.type };
        }
      }
    } catch {
      // Network error, timeout, : move to next URL
      continue;
    }
  }

  return { status: 'NOT_FOUND' };
}

// ─── Uploaded files in IndexedDB (privileged tier) ──────────────────────────

async function getFile(fileID:string): Promise<File | null> {
  return await fileStorage.getFile(fileID)
}

async function saveFile(formerFileID:string, file: File): Promise<string> {
  const fileId = generateUUID();
  await fileStorage.saveFile(fileId, file);
  await fileStorage.deleteFile(formerFileID);
  return fileId;
}

// ─── Download files generated by the plugin. This is not user's files or attachments ──────────────────────────
// File types a plugin may not hand the user: programs, scripts, and
// documents a browser opens as an active page.
const BLOCKED_DOWNLOAD_EXTENSIONS = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'hta', 'jar',
  'lnk', 'app', 'dmg', 'pkg', 'sh', 'command', 'html', 'htm', 'xhtml', 'shtml', 'svg', 'mhtml', 'xml',
]);
const BLOCKED_DOWNLOAD_TYPES = /^(text\/html|application\/xhtml|image\/svg|application\/(x-)?javascript|text\/javascript|application\/x-msdownload|application\/xml|text\/xml)/i;

/** A file name that can't carry a path, control characters or a hidden extension. */
export function safeDownloadName(name: unknown): string {
  const raw = typeof name === 'string' ? name : '';
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
  return cleaned || 'download';
}

async function downloadFile(args: { content: string | ArrayBuffer | Uint8Array; filename: string; contentType?: string }): Promise<void> {
  const { content } = args;
  const filename = safeDownloadName(args.filename);
  const contentType = typeof args.contentType === 'string' && args.contentType ? args.contentType : 'application/octet-stream';
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : '';
  if (BLOCKED_DOWNLOAD_EXTENSIONS.has(ext) || BLOCKED_DOWNLOAD_TYPES.test(contentType)) {
    throw new Error(`ui.downloadFile: ${ext ? `.${ext} files` : contentType} can't be downloaded from a plugin`);
  }
  if (typeof content !== 'string' && !(content instanceof ArrayBuffer) && !(content instanceof Uint8Array)) {
    throw new Error('ui.downloadFile: content must be a string or bytes');
  }
  const url = URL.createObjectURL(new Blob([content as BlobPart], { type: contentType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoking at once can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ─── Email keyword mutations ──────────────────────────────────

// Syntactic JMAP keyword check (RFC 5788 charset, conservative). Semantics
// (reserved keywords for category tabs) are enforced by the tabs store.
const PLUGIN_KEYWORD_RE = /^[a-z0-9$][a-z0-9$_.:-]{0,127}$/i;

function assertPluginKeyword(keyword: unknown): string {
  if (typeof keyword !== 'string' || !PLUGIN_KEYWORD_RE.test(keyword)) {
    throw new Error(`Invalid JMAP keyword "${String(keyword)}"`);
  }
  // Stalwart 1.0 derives hasAttachment from these; adding or removing one
  // would misreport the message.
  if (isServerSetKeyword(keyword)) {
    throw new Error(`JMAP keyword "${keyword}" is set by the server`);
  }
  return keyword;
}

function assertPluginKeywords(value: unknown): Record<string, true> {
  if (!isPlainObject(value)) {
    throw new Error('jmap.setKeywords: keywords must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_PLUGIN_KEYWORD_DEFINITIONS) {
    throw new Error(`jmap.setKeywords: at most ${MAX_PLUGIN_KEYWORD_DEFINITIONS} keywords are allowed`);
  }
  const keywords: Record<string, true> = {};
  for (const [keyword, enabled] of entries) {
    assertPluginKeyword(keyword);
    if (enabled !== true) {
      throw new Error(`jmap.setKeywords: keyword "${keyword}" must be true; omit it to remove it`);
    }
    keywords[keyword] = true;
  }
  return keywords;
}

function assertEmailId(value: unknown, method: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${method}: emailId is required`);
  }
  return value;
}

function assertOptionalAccountId(value: unknown, method: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${method}: accountId must be a non-empty string`);
  }
  return value;
}

function requireClient() {
  const { client } = useAuthStore.getState();
  if (!client) throw new Error('No active session');
  return client;
}

// ─── Native keyword definitions ──────────────────────────────

const MAX_PLUGIN_KEYWORD_DEFINITIONS = 500;
const MAX_PLUGIN_KEYWORD_LABEL_LENGTH = 255;
const VALID_VISIBILITIES = new Set<KeywordVisibility>(['show', 'hide', 'unread']);

type PluginKeywordDefinitionInput = Omit<KeywordDefinition, 'color'> & { color?: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** RFC 8621 keyword syntax, applied to the complete `$label:<id>` value. */
function isValidKeywordDefinitionId(id: string): boolean {
  const keyword = KEYWORD_PREFIX + id;
  if (id.length === 0 || keyword.length > MAX_KEYWORD_LENGTH) return false;
  for (let i = 0; i < keyword.length; i++) {
    const code = keyword.charCodeAt(i);
    if (
      code < 0x21 || code > 0x7e ||
      code === 0x28 || code === 0x29 || code === 0x7b || code === 0x7d ||
      code === 0x5d || code === 0x25 || code === 0x2a || code === 0x22 || code === 0x5c
    ) {
      return false;
    }
  }
  return true;
}

/** The fields of a definition a plugin may set; keywords.update sends only the ones it changes. */
type PluginKeywordPatch = Pick<KeywordDefinition, 'id'> &
  Partial<Pick<KeywordDefinition, 'label' | 'color' | 'visibility'>>;

function assertKeywordFields(
  value: unknown,
  index: number,
  method: 'keywords.add' | 'keywords.update',
): PluginKeywordPatch {
  if (!isPlainObject(value)) {
    throw new Error(`${method}: definitions[${index}] must be an object`);
  }

  const id = value.id;
  const label = value.label;
  const color = value.color;
  const visibility = value.visibility;

  if (typeof id !== 'string' || !isValidKeywordDefinitionId(id)) {
    throw new Error(`${method}: definitions[${index}].id is not a valid JMAP label id`);
  }
  // add needs a label; update leaves an omitted one as it is.
  if (
    (label !== undefined || method === 'keywords.add') &&
    (typeof label !== 'string' || label.trim().length === 0 ||
      label.length > MAX_PLUGIN_KEYWORD_LABEL_LENGTH)
  ) {
    throw new Error(
      `${method}: definitions[${index}].label must be 1-${MAX_PLUGIN_KEYWORD_LABEL_LENGTH} characters`,
    );
  }
  if (
    color !== undefined &&
    (typeof color !== 'string' || !Object.prototype.hasOwnProperty.call(KEYWORD_PALETTE, color))
  ) {
    throw new Error(`${method}: definitions[${index}].color is not in the keyword palette`);
  }
  if (visibility !== undefined && !VALID_VISIBILITIES.has(visibility as KeywordVisibility)) {
    throw new Error(`${method}: definitions[${index}].visibility is invalid`);
  }

  return {
    id,
    ...(typeof label === 'string' ? { label: label.trim() } : {}),
    ...(color === undefined ? {} : { color }),
    ...(visibility === undefined ? {} : { visibility: visibility as KeywordVisibility }),
  };
}

function assertKeywordDefinition(value: unknown, index: number): PluginKeywordDefinitionInput {
  const { label, ...rest } = assertKeywordFields(value, index, 'keywords.add');
  // assertKeywordFields requires the label for add.
  return { ...rest, label: label as string };
}

function assertKeywordPatch(value: unknown, index: number): PluginKeywordPatch {
  const patch = assertKeywordFields(value, index, 'keywords.update');
  if (patch.label === undefined && patch.color === undefined && patch.visibility === undefined) {
    throw new Error(`keywords.update: definitions[${index}] changes nothing; give a label, color or visibility`);
  }
  return patch;
}

function assertKeywordDefinitionArray(value: unknown): PluginKeywordDefinitionInput[] {
  if (!Array.isArray(value)) throw new Error('keywords.add: definitions must be an array');
  if (value.length > MAX_PLUGIN_KEYWORD_DEFINITIONS) {
    throw new Error(`keywords.add: at most ${MAX_PLUGIN_KEYWORD_DEFINITIONS} definitions may be added at once`);
  }
  return value.map(assertKeywordDefinition);
}

function assertKeywordPatchArray(value: unknown): PluginKeywordPatch[] {
  if (!Array.isArray(value)) throw new Error('keywords.update: definitions must be an array');
  if (value.length > MAX_PLUGIN_KEYWORD_DEFINITIONS) {
    throw new Error(`keywords.update: at most ${MAX_PLUGIN_KEYWORD_DEFINITIONS} definitions may be updated at once`);
  }
  return value.map(assertKeywordPatch);
}

function assertKeywordIdArray(value: unknown, method: string): string[] {
  if (
    !Array.isArray(value) || value.length > MAX_PLUGIN_KEYWORD_DEFINITIONS ||
    value.some((id) => typeof id !== 'string')
  ) {
    throw new Error(`${method}: ids must be an array of at most ${MAX_PLUGIN_KEYWORD_DEFINITIONS} strings`);
  }
  return value;
}

function doKeywordsList(): KeywordDefinition[] {
  return useSettingsStore.getState().emailKeywords.map((keyword) => ({ ...keyword }));
}

/** Whether keywords.update and keywords.remove may touch this definition: only the plugin's own. */
function isOwnKeyword(plugin: InstalledPlugin, keyword: KeywordDefinition): boolean {
  return keyword.addedBy === plugin.id;
}

function doKeywordsAdd(plugin: InstalledPlugin, value: unknown): { added: KeywordDefinition[]; skipped: string[] } {
  const definitions = assertKeywordDefinitionArray(value);
  const existing = useSettingsStore.getState().emailKeywords;
  const known = new Set(existing.map((keyword) => keyword.id.toLowerCase()));
  const takenColors = new Set(existing.map((keyword) => keyword.color));
  const added: KeywordDefinition[] = [];
  const skipped: string[] = [];

  for (const definition of definitions) {
    const foldedId = definition.id.toLowerCase();
    if (known.has(foldedId)) {
      skipped.push(definition.id);
      continue;
    }
    known.add(foldedId);
    const color = definition.color ?? suggestKeywordColor(definition.id, takenColors);
    takenColors.add(color);
    added.push({ ...definition, color, addedBy: plugin.id });
  }

  if (added.length > 0) {
    // One atomic append keeps concurrent plugin calls from partially
    // overwriting the list and triggers the normal persist/settings-sync path.
    useSettingsStore.setState((state) => ({
      emailKeywords: [...state.emailKeywords, ...added],
    }));
  }

  return { added: added.map((keyword) => ({ ...keyword })), skipped };
}

function doKeywordsUpdate(plugin: InstalledPlugin, value: unknown): { updated: KeywordDefinition[]; skipped: string[] } {
  const patches = assertKeywordPatchArray(value);
  const byId = new Map(patches.map((patch) => [patch.id.toLowerCase(), patch]));
  let updated: KeywordDefinition[] = [];

  // Read and write in one functional update, as reorder does, so a concurrent
  // settings write is not overwritten by a list built from an older state.
  useSettingsStore.setState((state) => {
    updated = [];
    const emailKeywords = state.emailKeywords.map((keyword) => {
      const patch = isOwnKeyword(plugin, keyword) ? byId.get(keyword.id.toLowerCase()) : undefined;
      if (!patch) return keyword;
      // The id is what the messages carry, so it never changes here.
      const next = { ...keyword, ...patch, id: keyword.id };
      updated.push(next);
      return next;
    });
    return updated.length > 0 ? { emailKeywords } : state;
  });

  const done = new Set(updated.map((keyword) => keyword.id.toLowerCase()));
  const skipped = patches.filter((patch) => !done.has(patch.id.toLowerCase())).map((patch) => patch.id);
  return { updated: updated.map((keyword) => ({ ...keyword })), skipped };
}

function doKeywordsRemove(plugin: InstalledPlugin, value: unknown): { removed: string[]; skipped: string[] } {
  const ids = assertKeywordIdArray(value, 'keywords.remove');
  const wanted = new Set(ids.map((id) => id.toLowerCase()));
  let removed: string[] = [];

  // Drops the definitions only, as Settings → Tags does; the keywords on
  // messages stay (jmap.setKeywords removes those, with email:write).
  useSettingsStore.setState((state) => {
    removed = [];
    const emailKeywords = state.emailKeywords.filter((keyword) => {
      const drop = isOwnKeyword(plugin, keyword) && wanted.has(keyword.id.toLowerCase());
      if (drop) removed.push(keyword.id);
      return !drop;
    });
    return removed.length > 0 ? { emailKeywords } : state;
  });

  const done = new Set(removed.map((id) => id.toLowerCase()));
  return { removed, skipped: ids.filter((id) => !done.has(id.toLowerCase())) };
}

function doKeywordsReorder(value: unknown, rawOptions?: unknown): KeywordDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error('keywords.reorder: ids must be an array');
  }
  if (value.some((id) => typeof id !== 'string')) {
    throw new Error('keywords.reorder: ids must contain only strings');
  }
  if (rawOptions !== undefined && !isPlainObject(rawOptions)) {
    throw new Error('keywords.reorder: options must be an object');
  }
  const options = rawOptions as Record<string, unknown> | undefined;
  if (options && Object.keys(options).some((key) => key !== 'caseSensitive')) {
    throw new Error('keywords.reorder: options contains an unknown property');
  }
  if (options?.caseSensitive !== undefined && typeof options.caseSensitive !== 'boolean') {
    throw new Error('keywords.reorder: options.caseSensitive must be a boolean');
  }
  const caseSensitive = options?.caseSensitive === true;
  const normalizeId = (id: string) => caseSensitive ? id : id.toLowerCase();
  let result: KeywordDefinition[] = [];

  // Validate and reorder against the state being replaced. Keeping the read
  // inside the functional update prevents a concurrent settings write from
  // being overwritten by a reorder built from an older label list.
  useSettingsStore.setState((state) => {
    const existing = state.emailKeywords;
    if (value.length !== existing.length) {
      throw new Error('keywords.reorder: ids must contain every existing label exactly once');
    }

    const byId = new Map(existing.map((keyword) => [normalizeId(keyword.id), keyword]));
    if (byId.size !== existing.length) {
      throw new Error('keywords.reorder: existing label ids are not unique');
    }

    const seen = new Set<string>();
    const reordered: KeywordDefinition[] = [];
    for (const id of value as string[]) {
      const normalizedId = normalizeId(id);
      if (seen.has(normalizedId)) {
        throw new Error(`keywords.reorder: duplicate label id: ${id}`);
      }
      const keyword = byId.get(normalizedId);
      if (!keyword) {
        throw new Error(`keywords.reorder: unknown label id: ${id}`);
      }
      seen.add(normalizedId);
      reordered.push(keyword);
    }

    // Reuse the existing definitions verbatim so ordering cannot change a
    // label's name, colour, visibility, id casing, or any future metadata.
    result = reordered;
    return { emailKeywords: reordered };
  });
  return result.map((keyword) => ({ ...keyword }));
}

function assertKeywordIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_PLUGIN_KEYWORD_DEFINITIONS) {
    throw new Error(`keywords.getCounts: ids must be an array of at most ${MAX_PLUGIN_KEYWORD_DEFINITIONS} strings`);
  }
  if (value.some((id) => typeof id !== 'string' || !isValidKeywordDefinitionId(id))) {
    throw new Error('keywords.getCounts: ids contains an invalid label id');
  }
  return value as string[];
}

function doKeywordsGetCounts(value?: unknown): Record<string, { total: number; unread: number }> {
  const ids = assertKeywordIds(value);
  const counts = useEmailStore.getState().tagCounts;
  if (!ids) {
    return Object.fromEntries(
      Object.entries(counts).map(([id, count]) => [id, { ...count }]),
    );
  }

  const selected: Record<string, { total: number; unread: number }> = {};
  for (const id of ids) {
    const count = counts[id];
    if (count) selected[id] = { ...count };
  }
  return selected;
}

function keywordDiscoveryOptions(value: unknown, method: string): { limit: number } | undefined {
  if (value !== undefined && !isPlainObject(value)) {
    throw new Error(`${method}: options must be an object`);
  }
  const rawLimit = value?.limit;
  if (
    rawLimit !== undefined &&
    (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > DEFAULT_KEYWORD_SCAN_LIMIT)
  ) {
    throw new Error(`${method}: limit must be an integer from 1 to ${DEFAULT_KEYWORD_SCAN_LIMIT}`);
  }
  return rawLimit === undefined ? undefined : { limit: rawLimit };
}

async function doJmapGetKeywords(value?: unknown) {
  return requireClient().getKeywords(keywordDiscoveryOptions(value, 'jmap.getKeywords'));
}

async function doKeywordsDiscover(value?: unknown) {
  const scan = await requireClient().discoverKeywords(keywordDiscoveryOptions(value, 'keywords.discover'));
  // Stalwart 1.0 puts an attachment keyword on every message. Nobody applied
  // it, and the plugin keyword API refuses to set or remove it.
  return {
    ...scan,
    keywords: Object.fromEntries(Object.entries(scan.keywords).filter(([keyword]) => !isServerSetKeyword(keyword))),
  };
}

async function doKeywordsRefreshCounts(): Promise<Record<string, { total: number; unread: number }>> {
  await useEmailStore.getState().fetchTagCounts(requireClient());
  return doKeywordsGetCounts();
}

// ─── Message-list category tabs ───────────────────────────────

/**
 * Resolve the currently viewed mailbox to its JMAP id + owning account, the
 * same way email-store's fetchEmails does (shared mailboxes use namespaced
 * store ids).
 */
function resolveSelectedMailboxForQuery(): { jmapMailboxId: string; accountId?: string } | null {
  const { selectedMailbox, mailboxes } = useEmailStore.getState();
  if (!selectedMailbox) return null;
  const mailbox = mailboxes.find((mb) => mb.id === selectedMailbox);
  if (!mailbox) return null;
  return {
    jmapMailboxId: mailbox.originalId || mailbox.id,
    accountId: mailbox.isShared ? mailbox.accountId : undefined,
  };
}

async function doTabsRefreshCounts(): Promise<Record<string, number>> {
  const client = requireClient();
  const resolved = resolveSelectedMailboxForQuery();
  if (!resolved) return {};
  await useMessageListTabsStore.getState().refreshCounts(client, resolved.jmapMailboxId, resolved.accountId);
  return useMessageListTabsStore.getState().tabCounts;
}

async function doTabsCategorize(emailIds: unknown, tabId: unknown): Promise<boolean> {
  if (!Array.isArray(emailIds) || emailIds.some((id) => typeof id !== 'string')) {
    throw new Error('tabs.categorize: emailIds must be a string array');
  }
  if (typeof tabId !== 'string') throw new Error('tabs.categorize: tabId must be a string');
  const client = requireClient();
  const moved = await useMessageListTabsStore.getState().categorizeEmails(client, emailIds as string[], tabId);
  if (moved) void doTabsRefreshCounts().catch(() => { /* counts refresh is best-effort */ });
  return moved;
}

// ─── Message-list search ──────────────────────────────────────

const MAX_SEARCH_LABEL_LENGTH = 64;

/**
 * Run a plugin's JMAP Email filter as the message-list search (#1024). It
 * replaces the current search like a user's search does, keeps the scope
 * picked in the search panel, and shows up as a removable chip.
 */
async function doSearchRun(plugin: InstalledPlugin, query: unknown, options: unknown): Promise<void> {
  const filter = normalizePluginFilter('search.run: query', query);
  if (Object.keys(filter).length === 0) throw new Error('search.run: query must not be empty');
  const rawLabel = options && typeof options === 'object' ? (options as { label?: unknown }).label : undefined;
  if (rawLabel !== undefined && typeof rawLabel !== 'string') {
    throw new Error('search.run: label must be a string');
  }
  const label = (rawLabel?.trim() || plugin.name).slice(0, MAX_SEARCH_LABEL_LENGTH);

  const client = requireClient();
  const store = useEmailStore.getState();
  store.setSearchQuery('');
  store.setSearchFilters({
    ...DEFAULT_SEARCH_FILTERS,
    pluginFilter: { pluginId: plugin.id, label, filter },
  });
  await store.advancedSearch(client);
}

// ─── Sieve (delivery-time classification) ─────────────────────

async function doSieveGetActiveScript(): Promise<{ id: string; name: string; content: string } | null> {
  const client = requireClient();
  if (!client.supportsSieve()) return null;
  const scripts = await client.getSieveScripts();
  const active = scripts.find((s) => s.isActive);
  if (!active) return null;
  const content = await client.getSieveScriptContent(active.blobId);
  return { id: active.id, name: active.name, content };
}

/**
 * Re-generate and re-upload the account's active Sieve script through the
 * filter store, which runs the filterHooks.onSieveScriptGenerate transform -
 * the supported way for a plugin to install/update its managed section
 * (e.g. the inbox-category classifier) without clobbering user filters.
 */
async function doSieveRegenerate(): Promise<void> {
  const client = requireClient();
  if (!client.supportsSieve()) throw new Error('Sieve is not supported by this server');
  const filterStore = useFilterStore.getState();
  // Sync from the server first: a background plugin may call this before the
  // filters settings page has ever populated the store.
  await filterStore.fetchFilters(client);
  await useFilterStore.getState().saveFilters(client);
}

// ─── admin config (same as before) ────────────────────────────

async function adminGetAll(pluginId: string): Promise<Record<string, unknown>> {
  const res = await apiFetch(`/api/admin/plugins/${encodeURIComponent(pluginId)}/config`);
  if (!res.ok) return {};
  return res.json();
}
/** The app a plugin runs in: product, the administrator's name for it, version, edition. */
async function doAppGetInfo(): Promise<AppInfoView> {
  let config: Awaited<ReturnType<typeof fetchConfig>> | null = null;
  try { config = await fetchConfig(); } catch { config = null; }
  return {
    product: 'Bulwark Mail',
    name: config?.appName || 'Webmail',
    version: process.env.NEXT_PUBLIC_APP_VERSION || '',
    edition: IS_LITE ? 'lite' : 'full',
    stalwartFeatures: config?.stalwartFeaturesEnabled ?? true,
    demoMode: config?.demoMode ?? false,
  };
}

/** The zone the app shows times in: the user's choice, else the browser's. */
function userTimeZone(): string {
  const setting = useSettingsStore.getState().timeZone;
  if (typeof setting === 'string' && setting && setting !== 'auto') return setting;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** The admin's settings for this plugin that aren't secrets (any user may read them). */
async function publicConfig(pluginId: string): Promise<Record<string, unknown>> {
  const res = await apiFetch(`/api/admin/plugins/${encodeURIComponent(pluginId)}/config?public=1`);
  if (!res.ok) return {};
  return res.json();
}
async function adminGet(pluginId: string, key: string): Promise<unknown> {
  const all = await adminGetAll(pluginId);
  return all[key] ?? null;
}
async function adminSet(pluginId: string, key: string, value: unknown): Promise<void> {
  await expectOk('admin.setConfig', apiFetch(`/api/admin/plugins/${encodeURIComponent(pluginId)}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  }));
}

/** A failed admin config write used to look like success to the plugin. */
async function expectOk(method: string, request: Promise<Response>): Promise<void> {
  const res = await request;
  if (!res.ok) {
    throw new Error(res.status === 401 || res.status === 403
      ? `${method}: only an administrator can change this plugin's admin settings`
      : `${method} failed (HTTP ${res.status})`);
  }
}
async function adminDelete(pluginId: string, key: string): Promise<void> {
  await expectOk('admin.deleteConfig', apiFetch(`/api/admin/plugins/${encodeURIComponent(pluginId)}/config`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  }));
}

// ─── Toasts ──────────────────────────────────────────────────

const MAX_TOAST_LENGTH = 300;
const TOASTS_PER_TEN_SECONDS = 5;
const recentToasts = new Map<string, number[]>();

function toastText(value: unknown): string {
  const text = String(value ?? '');
  return text.length > MAX_TOAST_LENGTH ? text.slice(0, MAX_TOAST_LENGTH - 1) + '…' : text;
}

/** A plugin may show a few toasts; past that they are dropped, not queued. */
function mayToast(pluginId: string): boolean {
  const now = Date.now();
  const recent = (recentToasts.get(pluginId) ?? []).filter((t) => now - t < 10_000);
  if (recent.length >= TOASTS_PER_TEN_SECONDS) {
    recentToasts.set(pluginId, recent);
    return false;
  }
  recent.push(now);
  recentToasts.set(pluginId, recent);
  return true;
}

// ─── Dispatcher ──────────────────────────────────────────────

/** Resolves an api-request method against the per-plugin permissions. */
export async function dispatchApiCall(
  plugin: InstalledPlugin,
  method: string,
  args: unknown[],
  opts?: { privileged?: boolean; sink?: StreamSink },
): Promise<unknown> {
  // Tier gate: privileged-only methods are refused for untrusted (null-origin)
  // instances even if the permission is somehow present. Defence-in-depth on
  // top of the load-time tier resolution.
  if (PRIVILEGED_ONLY_METHODS.has(method) && !opts?.privileged) {
    throw new Error(`Method "${method}" requires the privileged plugin tier`);
  }

  // Permission gate
  const requiredPerm = PERM_PER_METHOD[method];
  if (requiredPerm !== undefined && requiredPerm !== null) {
    if (!pluginHasPermission(plugin, requiredPerm)) {
      throw new Error(`Plugin "${plugin.id}" lacks permission "${requiredPerm}"`);
    }
  } else if (!(method in PERM_PER_METHOD)) {
    throw new Error(`Unknown API method "${method}"`);
  }

  switch (method) {
    case 'proxy.fetch': return proxyFetch(plugin, args, opts?.sink ?? null);
    case 'proxy.cancel': proxyCancel(plugin, args[0]); return undefined;
    case 'proxy.connect': return proxyConnect(plugin, args);
    case 'proxy.accounts': return proxyAccounts(plugin);
    case 'proxy.disconnect': return proxyDisconnect(plugin, args);

    case 'ui.setActions': {
      const surface = args[0];
      if (typeof surface !== 'string' || !isActionSurface(surface)) throw new Error(`"${String(surface)}" is not a surface that takes actions`);
      if (!mayOfferSlot(plugin, surface)) throw new Error(`Plugin "${plugin.id}" may not add actions to "${surface}"`);
      setPluginActions(plugin.id, plugin.name, surface, checkActions(args[1]));
      return undefined;
    }
    case 'ui.refreshRowBadges': refreshRowBadges(); return undefined;
    case 'ui.setDayLabels': setDayLabels(plugin.id, plugin.name, checkDayLabels(args[0])); return undefined;
    case 'ui.setPages': setPluginPages(plugin.id, plugin.name, checkPages(args[0])); return undefined;
    case 'ui.setSectionTitle': setSectionTitle(plugin.id, args[0]); return undefined;
    case 'ui.setPanel': {
      const slot = args[0];
      if (typeof slot !== 'string' || !mayOfferSlot(plugin, slot)) throw new Error(`Plugin "${plugin.id}" may not open the panel "${String(slot)}"`);
      return requestPanel(plugin.id, slot, args[1], args[2]);
    }

    case 'storage.get': return storageGet(plugin.id, args[0] as string);
    case 'storage.set': storageSet(plugin.id, args[0] as string, args[1]); return undefined;
    case 'storage.remove': storageRemove(plugin.id, args[0] as string); return undefined;
    case 'storage.keys': return storageKeys(plugin.id);

    case 'toast.success': if (mayToast(plugin.id)) appToast.success(toastText(args[0])); return undefined;
    case 'toast.error':   if (mayToast(plugin.id)) appToast.error(toastText(args[0])); return undefined;
    case 'toast.info':    if (mayToast(plugin.id)) appToast.info(toastText(args[0])); return undefined;
    case 'toast.warning': if (mayToast(plugin.id)) appToast.warning(toastText(args[0])); return undefined;

    case 'http.post':  return doHttpPost(plugin, args[0] as string, args[1], args[2] as PluginHttpPostOptions | undefined);
    case 'http.fetch': return doHttpFetch(plugin, args[0] as string, args[1] as PluginFetchInit | undefined);

    case 'jmap.fetchBlob': return doJmapFetchBlob(args[0] as string, args[1] as { name?: string; type?: string, rangeHeader?: number } | undefined);
    case 'jmap.uploadBlob': return doJmapUploadBlob(args[0], args[1], args[2]);
    case 'jmap.sendRaw':   return doJmapSendRaw(
      args[0] as ArrayBuffer | ArrayBufferView,
      args[1] as string,
      args[2] as { delayedUntil?: string; envelopeRecipients?: string[] } | undefined,
    );
    case 'jmap.submitRaw': return doJmapSubmitRaw(
      args[0] as ArrayBuffer | ArrayBufferView,
      args[1] as string,
      args[2] as { delayedUntil?: string; envelopeRecipients?: string[] } | undefined,
    );
    case 'jmap.importRaw': return doJmapImportRaw(
      args[0] as ArrayBuffer | ArrayBufferView,
      args[1] as string[],
      args[2] as { keywords?: Record<string, boolean>; accountId?: string } | undefined,
    );
    case 'jmap.getKeywords': return doJmapGetKeywords(args[0]);
    case 'jmap.setKeywords': {
      const emailId = assertEmailId(args[0], 'jmap.setKeywords');
      const accountId = assertOptionalAccountId(args[2], 'jmap.setKeywords');
      const keywords = assertPluginKeywords(args[1]);
      await requireClient().updateEmailKeywords(emailId, keywords, accountId);
      return undefined;
    }
    case 'jmap.setKeyword': {
      const emailId = assertEmailId(args[0], 'jmap.setKeyword');
      const keyword = assertPluginKeyword(args[1]);
      const accountId = assertOptionalAccountId(args[2], 'jmap.setKeyword');
      await requireClient().setKeyword(emailId, keyword, accountId);
      return undefined;
    }
    case 'jmap.removeKeyword': {
      const emailId = assertEmailId(args[0], 'jmap.removeKeyword');
      const keyword = assertPluginKeyword(args[1]);
      const accountId = assertOptionalAccountId(args[2], 'jmap.removeKeyword');
      await requireClient().removeKeyword(emailId, keyword, accountId);
      return undefined;
    }
    case 'upfiles.get' : return getFile(args[0] as string);
    case 'upfiles.save' : return saveFile(args[0] as string, args[1] as File);

    // The PRF salt is derived from the calling plugin's id, never from an
    // argument: otherwise one plugin could ask for another plugin's secret.
    case 'crypto.createWebAuthn': return doCreatePRF(plugin.id, args[1] as string, args[2] as string);
    case 'crypto.getWebAuthn': return doGetPRF(args[0] as number[], plugin.id);
    case 'crypto.getPublicKeys': return getPublicKeys();
    case 'crypto.createPublicKey': return doCreatePublicKey(args[0] as PublicKeyInput);
    case 'crypto.removePublicKey': return doRemovePublicKey(args[0] as string);
    case 'crypto.getEncryptionAtRest': return doGetEncryptionAtRest();
    case 'crypto.setEncryptionAtRest': return doSetEncryptionAtRest(args[0] as EncryptionAtRestConfig);
    case 'crypto.getPublicKeyFromWKD': return doGetPublicKeyFromWKD(args[0] as string);


    case 'contact.get': return doContactGet(args[0] as string);
    case 'contact.update': return doContactUpdate(args[0] as string, args[1] as Partial<ContactCard>);
    case 'contact.create': return doContactCreate(args[0] as ContactCard);
    case 'contact.search': return doContactSearch(args[0] as string);
    case 'contact.list': return doContactList(args[0] as string | undefined);
    case 'contact.delete': return doContactDelete(args[0] as string);
    
    case 'addressbook.list': return doAddressBookList();
    case 'addressbook.create': return doAddressBookCreate(args[0] as string);

    case 'user.getAccounts':   return doUserGetAccounts();
    case 'user.getIdentities': return doUserGetIdentities();
    case 'user.getTimeZone': return userTimeZone();
    case 'app.getInfo': return doAppGetInfo();
    case 'app.searchSettings': return doAppSearchSettings(args[0], args[1]);
    case 'app.getSettings': return doAppGetSettings();
    case 'user.logout' : return doUserLogout();

    case 'admin.getConfig':    return adminGet(plugin.id, args[0] as string);
    case 'admin.getAllConfig': return adminGetAll(plugin.id);
    case 'plugin.getConfig':   return publicConfig(plugin.id);
    case 'admin.setConfig':    await adminSet(plugin.id, args[0] as string, args[1]); return undefined;
    case 'admin.deleteConfig': await adminDelete(plugin.id, args[0] as string); return undefined;

    case 'ui.confirm': {
      const opts = (args[0] ?? {}) as { title?: string; message?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean };
      return awaitDialog({
        pluginId: plugin.id,
        kind: 'confirm',
        title: String(opts.title ?? plugin.name ?? 'Confirm'),
        message: String(opts.message ?? ''),
        confirmLabel: typeof opts.confirmLabel === 'string' ? opts.confirmLabel : undefined,
        cancelLabel: typeof opts.cancelLabel === 'string' ? opts.cancelLabel : undefined,
        danger: !!opts.danger,
      });
    }
    case 'ui.alert': {
      const opts = (args[0] ?? {}) as { title?: string; message?: string; confirmLabel?: string };
      await awaitDialog({
        pluginId: plugin.id,
        kind: 'alert',
        title: String(opts.title ?? plugin.name ?? 'Notice'),
        message: String(opts.message ?? ''),
        confirmLabel: typeof opts.confirmLabel === 'string' ? opts.confirmLabel : undefined,
      });
      return undefined;
    }
    case 'ui.prompt': {
      const opts = (args[0] ?? {}) as { title?: string; message?: string; confirmLabel?: string; cancelLabel?: string; fields?: PromptField[] };
      const fields: PromptField[] = Array.isArray(opts.fields)
        ? opts.fields.map((f) => ({
            name: String(f.name),
            label: String(f.label),
            type: f.type === 'password' ? 'password' : 'text',
            placeholder: typeof f.placeholder === 'string' ? f.placeholder : undefined,
            required: !!f.required,
          }))
        : [];
      return awaitPrompt({
        pluginId: plugin.id,
        kind: 'prompt',
        title: String(opts.title ?? plugin.name ?? 'Enter details'),
        message: String(opts.message ?? ''),
        confirmLabel: typeof opts.confirmLabel === 'string' ? opts.confirmLabel : undefined,
        cancelLabel: typeof opts.cancelLabel === 'string' ? opts.cancelLabel : undefined,
        fields,
      });
    }
    case 'ui.openDialog': {
      // Renders one of THIS plugin's own slots inside PluginDialogHost's
      // real app-root overlay, instead of a fixed confirm/prompt form - see
      // the 'plugin-dialog' SlotName / host-dialog.ts comments for why this
      // exists (a small toolbar/row slot can't show a large custom UI).
      const opts = (args[0] ?? {}) as { title?: string; slot?: string; extraProps?: Record<string, unknown>; width?: number };
      if (!opts.slot || typeof opts.slot !== 'string') {
        throw new Error('ui.openDialog requires a "slot" name');
      }
      return awaitCustomDialog({
        pluginId: plugin.id,
        title: String(opts.title ?? plugin.name ?? ''),
        message: '',
        slot: opts.slot,
        extraProps: (opts.extraProps && typeof opts.extraProps === 'object') ? opts.extraProps : {},
        width: typeof opts.width === 'number' ? opts.width : undefined,
      });
    }
    case 'ui.rerenderEmail': {
      // Re-run the onRenderEmailBody hook for the currently open message. Used
      // by crypto plugins after they change decryption state (e.g. an S/MIME key
      // was just unlocked) so the body re-decrypts without a full reload — which
      // would wipe the in-memory session keys.
      window.dispatchEvent(new CustomEvent('plugin:rerender-email'));
      return undefined;
    }
    case 'ui.rerenderFetchedEmails': {
      // Re-run the onEmailsFetched hook for the currently shown message list. 
      // Used by crypto plugins after they change decryption state s
      // so the preview or others properties re-decrypts without a full reload.
      window.dispatchEvent(new CustomEvent('plugin:rerender-fetched-emails'));
      return undefined;
    }
    case 'ui.openExternalUrl': {
      const url = String(args[0] ?? '');
      // Only http(s) - the sandbox should not be able to navigate the host
      // anywhere internal, nor open javascript:/data:/file: schemes.
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new Error('ui.openExternalUrl: invalid URL'); }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`ui.openExternalUrl: ${parsed.protocol} not allowed`);
      }
      // Always open in a new tab; plugins must not be able to navigate the
      // host window (_self/_top/_parent) to an attacker-controlled origin.
      window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
      return undefined;
    }
    case 'ui.downloadFile': {
      const opts = args[0] as { content: string | ArrayBuffer | Uint8Array; filename: string; contentType?: string };
      return downloadFile(opts ?? { content: '', filename: '' });
    }

    case 'email.setKeyword': {
      const emailId = assertEmailId(args[0], 'email.setKeyword');
      const keyword = assertPluginKeyword(args[1]);
      const accountId = assertOptionalAccountId(args[2], 'email.setKeyword');
      await requireClient().setKeyword(emailId, keyword, accountId);
      return undefined;
    }
    case 'email.removeKeyword': {
      const emailId = assertEmailId(args[0], 'email.removeKeyword');
      const keyword = assertPluginKeyword(args[1]);
      const accountId = assertOptionalAccountId(args[2], 'email.removeKeyword');
      await requireClient().removeKeyword(emailId, keyword, accountId);
      return undefined;
    }

    case 'keywords.list': return doKeywordsList();
    case 'keywords.add': return doKeywordsAdd(plugin, args[0]);
    case 'keywords.update': return doKeywordsUpdate(plugin, args[0]);
    case 'keywords.remove': return doKeywordsRemove(plugin, args[0]);
    case 'keywords.reorder': return doKeywordsReorder(args[0], args[1]);
    case 'keywords.discover': return doKeywordsDiscover(args[0]);
    case 'keywords.getCounts': return doKeywordsGetCounts(args[0]);
    case 'keywords.refreshCounts': return doKeywordsRefreshCounts();

    case 'tabs.set': {
      // validateTabsConfig (inside registerTabs) throws a developer-readable
      // error that surfaces as the api.tabs.set rejection in the sandbox.
      useMessageListTabsStore.getState().registerTabs(plugin.id, args[0] as MessageListTabsConfig);
      return undefined;
    }
    case 'tabs.clear': {
      useMessageListTabsStore.getState().clearTabs(plugin.id);
      return undefined;
    }
    case 'tabs.getState': {
      const { tabs, activeTabId, tabCounts } = useMessageListTabsStore.getState();
      return { tabs, activeTabId, tabCounts };
    }
    case 'tabs.refreshCounts': return doTabsRefreshCounts();
    case 'tabs.categorize': return doTabsCategorize(args[0], args[1]);

    case 'search.run': return doSearchRun(plugin, args[0], args[1]);

    case 'oauth.createState': return createOAuthState(plugin.id);
    case 'oauth.getRedirectUri': {
      const locale = (globalThis as unknown as { __APP_LOCALE__?: string }).__APP_LOCALE__ || 'en';
      return `${window.location.origin}${withBasePath(`/${encodeURIComponent(locale)}/plugins/oauth/callback`)}`;
    }

    case 'sieve.isSupported': {
      const { client } = useAuthStore.getState();
      return !!client?.supportsSieve();
    }
    case 'sieve.getActiveScript': return doSieveGetActiveScript();
    case 'sieve.validateScript': {
      if (typeof args[0] !== 'string') throw new Error('sieve.validateScript: content must be a string');
      return requireClient().validateSieveScript(args[0]);
    }
    case 'sieve.regenerate': {
      await doSieveRegenerate();
      return undefined;
    }

    case 'calendar.listCalendars': return doCalendarListCalendars();
    case 'calendar.getEvents': return doCalendarGetEvents(args[0]);
    case 'calendar.getEvent': return doCalendarGetEvent(args[0]);
    case 'calendar.createEvent': return doCalendarCreateEvent(args[0], plugin.id);
    case 'calendar.updateEvent': return doCalendarUpdateEvent(args[0], args[1]);
    case 'calendar.deleteEvent': return doCalendarDeleteEvent(args[0]);

    case 'tasks.list': return doTasksList(args[0]);
    case 'tasks.get': return doTasksGet(args[0]);
    case 'tasks.create': return doTasksCreate(args[0]);
    case 'tasks.update': return doTasksUpdate(args[0], args[1]);
    case 'tasks.setComplete': return doTasksSetComplete(args[0], args[1]);
    case 'tasks.delete': return doTasksDelete(args[0]);

    case 'templates.list': return doTemplatesList();
    case 'templates.get': return doTemplatesGet(args[0]);
    case 'templates.create': return doTemplatesCreate(args[0]);
    case 'templates.update': return doTemplatesUpdate(args[0], args[1]);
    case 'templates.delete': doTemplatesDelete(args[0]); return undefined;

    case 'identities.update': return doIdentitiesUpdate(args[0], args[1]);

    case 'vacation.get': return doVacationGet();
    case 'vacation.set': return doVacationSet(args[0]);

    case 'email.get': return doEmailGet(args[0], args[1]);
    case 'email.list': return doEmailList(args[0]);
    case 'email.search': return doEmailSearch(args[0]);
    case 'mailboxes.list': return doMailboxesList();
    case 'email.getAttachment': return doEmailGetAttachment(args[0], args[1], args[2]);
    case 'email.getRaw': return doEmailGetRaw(args[0], args[1]);
    case 'email.move': return doEmailMove(plugin.id, args[0], args[1]);
    case 'email.archive': return doEmailArchive(plugin.id, args[0]);

    case 'compose.open': return doComposeOpen(plugin, args[0]);
    case 'compose.reply': return doComposeReply(plugin, args[0], args[1]);
    case 'drafts.create': return doDraftsCreate(plugin, args[0]);

    case 'notifications.show': return doNotificationsShow(plugin, args[0]);

    case 'composer.getBody': return doComposerGetBody(plugin, args[0]);
    case 'composer.getSelection': return doComposerGetSelection(plugin, args[0]);
    case 'composer.replaceSelection': return doComposerReplaceSelection(plugin, args[0], args[1], args[2]);
    case 'composer.replaceBody': return doComposerReplaceBody(plugin, args[0], args[1]);
    case 'composer.attach': return doComposerAttach(plugin, args[0], args[1]);

    default:
      throw new Error(`Unhandled method "${method}"`);
  }
}

// ─── Cleanup hook for unloading plugins ───────────────────────

export { cancelForPlugin as cancelPluginDialogs } from './host-dialog';
