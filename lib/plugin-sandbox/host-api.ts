// Host-side implementations of the sandboxed plugin API. Every method gates
// on `plugin.permissions` BEFORE doing the underlying work, and only returns
// structured-cloneable data back to the iframe.

import type { InstalledPlugin, Permission } from '../plugin-types';
import { IMPLICIT_PERMISSIONS } from '../plugin-types';
import { toast as appToast } from '@/stores/toast-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { apiFetch } from '../browser-navigation';
import { awaitDialog, awaitPrompt, type PromptField } from './host-dialog';
import { fileStorage } from '../plugin-storage';
import { generateUUID } from '../utils';

/**
 * Methods only callable from the privileged (same-origin) tier. These expose
 * raw message bytes and raw submission, which an untrusted null-origin plugin
 * must never reach. Enforced in `dispatchApiCall` IN ADDITION to the per-method
 * permission gate.
 */
const PRIVILEGED_ONLY_METHODS = new Set<string>([
  'jmap.fetchBlob',
  'jmap.sendRaw',
  'upfiles.get',
  'webauthn.getOrCreate',
  'upfiles.set',
]);

const PERM_PER_METHOD: Record<string, Permission | null> = {
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
  'jmap.sendRaw': 'email:raw-send',
  // uploaded files (privileged-tier only) : 
  // Used only to get a file before it is uploaded to alterate it. 
  // To just read, use jmap.fetchBlob.
  'upfiles.get' : 'email:blob-write',
  'upfiles.save' : 'email:blob-write',
  'webauthn.getOrCreate': 'crypto:full',
  // admin
  'admin.getConfig': 'admin:config',
  'admin.getAllConfig': 'admin:config',
  'admin.setConfig': 'admin:config',
  'admin.deleteConfig': 'admin:config',
  // ui - any plugin can ask the host to render a modal or open a URL.
  'ui.confirm': null,
  'ui.alert': null,
  'ui.prompt': null,
  'ui.rerenderEmail': null,
  'ui.openExternalUrl': null,
};

function hasPermission(plugin: InstalledPlugin, perm: Permission): boolean {
  if ((IMPLICIT_PERMISSIONS as readonly string[]).includes(perm)) return true;
  if (!plugin.permissions.includes(perm)) return false;
  // Defense-in-depth: even if the manifest declares a permission, the host
  // refuses the API call unless an admin has marked the plugin as managed,
  // or the user has explicitly granted it via the consent dialog.
  if (plugin.managed) return true;
  return (plugin.grantedPermissions ?? []).includes(perm);
}

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

const STORAGE_PREFIX = (pluginId: string) => `plugin:${pluginId}:`;

function storageGet(pluginId: string, key: string): unknown {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(STORAGE_PREFIX(pluginId) + key);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function storageSet(pluginId: string, key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_PREFIX(pluginId) + key, JSON.stringify(value));
}
function storageRemove(pluginId: string, key: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(STORAGE_PREFIX(pluginId) + key);
}
function storageKeys(pluginId: string): string[] {
  if (typeof window === 'undefined') return [];
  const prefix = STORAGE_PREFIX(pluginId);
  const out: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k?.startsWith(prefix)) out.push(k.slice(prefix.length));
  }
  return out;
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

async function doHttpPost(plugin: InstalledPlugin, path: string, body: unknown): Promise<{ ok: boolean; status: number; data: unknown }> {
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
  const { client } = useAuthStore.getState();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (client) {
    headers['Authorization'] = client.getAuthHeader();
    headers['X-JMAP-Username'] = client.getUsername();
  }
  const res = await apiFetch(url.pathname + url.search, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

// ─── http.fetch (cross-origin, manifest-allowlisted) ──────────

interface PluginFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer | ArrayBufferView | null;
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
  // Sandboxed plugin can't hold a Response object across the boundary, so
  // we read the body once and return it as text + arrayBuffer (base64).
  const headers: Record<string, string> = {};
  res.headers.forEach((val, key) => { headers[key.toLowerCase()] = val; });
  const buf = await res.arrayBuffer();
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
async function doJmapFetchBlob(blobId: string, opts?: { name?: string; type?: string }): Promise<Uint8Array> {
  if (typeof blobId !== 'string' || !blobId) throw new Error('jmap.fetchBlob: blobId required');
  const { client } = useAuthStore.getState();
  if (!client) throw new Error('jmap.fetchBlob: no active session');
  const buf = await client.fetchBlobArrayBuffer(blobId, opts?.name, opts?.type);
  return new Uint8Array(buf);
}

/**
 * Submit a fully-formed raw RFC822 message (e.g. one a plugin has signed and/or
 * encrypted) via the host's raw-send path, which also files it into Sent. The
 * plugin passes raw bytes; the host wraps them in a Blob.
 */
async function doJmapSendRaw(
  rawBytes: ArrayBuffer | ArrayBufferView,
  identityId: string,
  opts?: { delayedUntil?: string; envelopeRecipients?: string[] },
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

// ─── WebAuthn (privileged tier) ─────────────────────────────────────────────

// This salt acts as a constant context identifier for key derivation.
// While hardcoded, security is maintained because the WebAuthn PRF extension 
// mixes this salt with the device's unique, hardware-bound private key.
// Changing this string will result in a completely different derived secret.
const PRF_SALT = new TextEncoder().encode("bulwark-plugins-v1");

/**
 * Retrieves or creates a WebAuthn passkey and extracts its PRF secret.
 * This secret is typically used as a local master encryption key.
 */
async function doGetOrCreatePRF(
    masterCredentialIdBytes: number[] | undefined, 
    name?: string, 
    displayName?: string
): Promise<{ credentialId: number[]; prfSecret: number[] } | string> {
    
    // ─── CASE 1: Credential already exists (Authentication) ──────────────────
    if (masterCredentialIdBytes && masterCredentialIdBytes.length > 0) {
      const credentialId = new Uint8Array(masterCredentialIdBytes).buffer;
      
      // Request an assertion (login) while evaluating the PRF salt
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [{ type: "public-key", id: credentialId }],
          userVerification: "required", // Required to ensure user presence & intent (biometrics/PIN)
          extensions: { prf: { eval: { first: PRF_SALT } } } as any
        }
      }) as PublicKeyCredential;

      // Extract the derived symmetric key from the authenticator's output
      const outputs = assertion.getClientExtensionResults();
      const prfSecret = (outputs as any).prf?.results?.first;
      if (!prfSecret) return 'Cannot get PRF secret from existing credential.';

      return {
        credentialId: masterCredentialIdBytes,
        prfSecret: Array.from(new Uint8Array(prfSecret))
      };
    }
    
    // ─── CASE 2: No masterCredentialIdBytes passed, create a new key (Registration) ──────────
    else if (name && displayName) {
      // Create the new passkey credential
      const credential = await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { name: "Bulwark Webmail", id: window.location.hostname },
          user: {
            id: crypto.getRandomValues(new Uint8Array(16)),
            name: name,
            displayName: displayName
          },
          // Supported cryptographic algorithms
          pubKeyCredParams: [
            { type: "public-key" as const, alg: -7 },   // ES256 (Recommended)
            { type: "public-key" as const, alg: -257 }  // RS256 (Compatibility fallback)
          ],
          authenticatorSelection: {
            authenticatorAttachment: "platform", // Forces the use of hardware/OS-bound passkeys (TouchID, Windows Hello, etc.)
            userVerification: "required"
          },
          extensions: { prf: {} } as any // Request PRF extension support from the authenticator
        }
      }) as PublicKeyCredential;
      
      const outputs = credential.getClientExtensionResults();

      // Ensure the authenticator successfully enabled and supports the PRF extension
      const isPrfEnabled = (outputs as any).prf?.enabled;
      if (!isPrfEnabled) {
        return 'The authenticator does not support or has rejected the PRF extension.';
      }
      
      // Note: Since many authenticators do not return the PRF evaluation results 
      // directly during creation, we immediately run an assertion (get) to fetch the initial secret.
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [{
            type: "public-key",
            id: credential.rawId
          }],
          userVerification: "required",
          extensions: {
            prf: { eval: { first: PRF_SALT } }
          } as any
        }
      }) as PublicKeyCredential;

      const assertionOutputs = assertion.getClientExtensionResults();

      const prfSecret = (assertionOutputs as any).prf?.results?.first;
      if (!prfSecret) {
        return 'Cannot get PRF secret from existing credential.';
      }

      return {
        credentialId: Array.from(new Uint8Array(credential.rawId)),
        prfSecret: Array.from(new Uint8Array(prfSecret))
      };
    }
    
    // ─── CASE 3: Insufficient parameters provided ───────────────────────────
    else {
      throw new Error("Provide name and display name if you want to create a new PRF.");
    }
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

// ─── admin config (same as before) ────────────────────────────

async function adminGetAll(pluginId: string): Promise<Record<string, unknown>> {
  const res = await apiFetch(`/api/admin/plugins/${encodeURIComponent(pluginId)}/config`);
  if (!res.ok) return {};
  return res.json();
}
async function adminGet(pluginId: string, key: string): Promise<unknown> {
  const all = await adminGetAll(pluginId);
  return all[key] ?? null;
}
async function adminSet(pluginId: string, key: string, value: unknown): Promise<void> {
  await apiFetch(`/api/admin/plugins/${encodeURIComponent(pluginId)}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
}
async function adminDelete(pluginId: string, key: string): Promise<void> {
  await apiFetch(`/api/admin/plugins/${encodeURIComponent(pluginId)}/config`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
}

// ─── Dispatcher ──────────────────────────────────────────────

/** Resolves an api-request method against the per-plugin permissions. */
export async function dispatchApiCall(
  plugin: InstalledPlugin,
  method: string,
  args: unknown[],
  opts?: { privileged?: boolean },
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
    if (!hasPermission(plugin, requiredPerm)) {
      throw new Error(`Plugin "${plugin.id}" lacks permission "${requiredPerm}"`);
    }
  } else if (!(method in PERM_PER_METHOD)) {
    throw new Error(`Unknown API method "${method}"`);
  }

  switch (method) {
    case 'storage.get': return storageGet(plugin.id, args[0] as string);
    case 'storage.set': storageSet(plugin.id, args[0] as string, args[1]); return undefined;
    case 'storage.remove': storageRemove(plugin.id, args[0] as string); return undefined;
    case 'storage.keys': return storageKeys(plugin.id);

    case 'toast.success': appToast.success(String(args[0] ?? '')); return undefined;
    case 'toast.error':   appToast.error(String(args[0] ?? '')); return undefined;
    case 'toast.info':    appToast.info(String(args[0] ?? '')); return undefined;
    case 'toast.warning': appToast.warning(String(args[0] ?? '')); return undefined;

    case 'http.post':  return doHttpPost(plugin, args[0] as string, args[1]);
    case 'http.fetch': return doHttpFetch(plugin, args[0] as string, args[1] as PluginFetchInit | undefined);

    case 'jmap.fetchBlob': return doJmapFetchBlob(args[0] as string, args[1] as { name?: string; type?: string } | undefined);
    case 'jmap.sendRaw':   return doJmapSendRaw(
      args[0] as ArrayBuffer | ArrayBufferView,
      args[1] as string,
      args[2] as { delayedUntil?: string; envelopeRecipients?: string[] } | undefined,
    );
    case 'upfiles.get' : return getFile(args[0] as string);
    case 'upfiles.save' : return saveFile(args[0] as string, args[1] as File);
    case 'webauthn.getOrCreate': return doGetOrCreatePRF(args[0] as number[] | undefined, args[1] as string | undefined, args[2] as string | undefined);

    case 'admin.getConfig':    return adminGet(plugin.id, args[0] as string);
    case 'admin.getAllConfig': return adminGetAll(plugin.id);
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
    case 'ui.rerenderEmail': {
      // Re-run the onRenderEmailBody hook for the currently open message. Used
      // by crypto plugins after they change decryption state (e.g. an S/MIME key
      // was just unlocked) so the body re-decrypts without a full reload — which
      // would wipe the in-memory session keys.
      window.dispatchEvent(new CustomEvent('plugin:rerender-email'));
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

    default:
      throw new Error(`Unhandled method "${method}"`);
  }
}

// ─── Cleanup hook for unloading plugins ───────────────────────

export { cancelForPlugin as cancelPluginDialogs } from './host-dialog';
