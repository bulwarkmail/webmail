import type { CredentialSpec } from '@/lib/plugin-secrets/credentials';
import { createHash, randomBytes } from 'node:crypto';
import { logger } from '@/lib/logger';
import { getStore, isSharedMode, replicaId, StoreUnavailableError } from '@/lib/shared-store';
import { announceChange } from '@/lib/shared-store/changes';
import { assertWritable, isConfigReadOnly } from './paths';
import { isStoreUnavailable } from './admin-store';
import { cacheBundle, getCachedBundle } from './bundle-cache';
import { pluginDocs, themeDocs } from './extension-store';
import { forgetVersion, purgeHistory, snapshotPlugin, snapshotTheme } from './extension-history';

// ─── Types ───────────────────────────────────────────────────

export interface PluginConfigField {
  type: 'string' | 'secret' | 'boolean' | 'number' | 'select';
  label: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  options?: { label: string; value: string }[];
  /** `type: 'string'` only: the admin form shows a full-width text box. */
  multiline?: boolean;
}

/**
 * Per-user setting field, mirrors the manifest's `settingsSchema` shape
 * (see lib/plugin-types.ts SettingFieldSchema). The server passes these
 * through unchanged so the client can render the per-user settings UI.
 */
export interface PluginSettingsField {
  type: 'boolean' | 'string' | 'number' | 'select';
  label: string;
  description?: string;
  default: unknown;
  options?: string[];
  min?: number;
  max?: number;
}

/**
 * Where an installed extension came from. Set on install; entries written
 * before this existed have none. The marketplace uses it to ask the directory
 * about updates, yanked versions and advisories for exactly the extensions
 * that came from it, and the admin UI uses it to link back to the listing.
 */
export type ExtensionSource =
  | { kind: 'marketplace'; slug: string; directoryUrl: string }
  | { kind: 'upload' };

export interface ServerPlugin {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  type: string;
  /** Requested execution tier ('untrusted' | 'privileged'). Privileged plugins
   * run in a same-origin sandbox and require admin approval + consent. */
  tier?: string;
  permissions: string[];
  entrypoint: string;
  enabled: boolean;
  forceEnabled?: boolean;
  configSchema?: Record<string, PluginConfigField>;
  settingsSchema?: Record<string, PluginSettingsField>;
  /**
   * Optional per-locale translation tables (locale -> key -> string) declared
   * in the plugin manifest. Surfaced to the sandbox so plugin code can call
   * `api.i18n.t(key)`; without it a plugin's strings stay in its hardcoded
   * default language.
   */
  locales?: Record<string, Record<string, string>>;
  installedAt: string;
  updatedAt: string;
  /**
   * Full SHA-256 hex of the bundle code (64 chars). Refreshed every save so
   * the same version re-uploaded with new code still appears as a change to
   * the client. Also doubles as the HTTP ETag for the bundle endpoint and is
   * verified by the sandbox loader on every load
   * (`lib/plugin-sandbox/bundle-integrity.ts`), so it must match the served
   * bytes exactly.
   */
  bundleHash?: string;
  /**
   * Validated CSP origins (https-only, single-origin form) the plugin may
   * embed. Merged into the host frame-src by the proxy.
   */
  frameOrigins?: string[];
  /**
   * Validated HTTPS origins the plugin may target via `api.http.fetch()`.
   * Same syntax as `frameOrigins`. Surfaced to clients via /api/plugins.
   */
  httpOrigins?: string[];
  /**
   * Same-origin `/api/*` path allowlist for `api.http.post()`. See
   * `InstalledPlugin.apiPostPaths` in `lib/plugin-types.ts`.
   */
  apiPostPaths?: string[];
  /** Credentials the plugin uses through the server proxy (no secrets here). */
  credentials?: Record<string, CredentialSpec>;
  source?: ExtensionSource;
  /**
   * The version's changelog (Markdown) from the directory, kept from a
   * marketplace install so the admin UI and the rollback history can show it
   * without the directory. Admin-only: /api/plugins doesn't send it.
   */
  changelog?: string;
}

export interface ServerTheme {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  variants: string[];
  enabled: boolean;
  forceEnabled?: boolean;
  installedAt: string;
  updatedAt: string;
  source?: ExtensionSource;
  /** The version's changelog from the directory; see ServerPlugin.changelog. */
  changelog?: string;
  /** True when a Theme API v2 skin.css is stored next to the CSS. */
  hasSkin?: boolean;
  /**
   * SHA-256 of the CSS and skin. Clients use it to notice a re-upload of
   * the same version and as a cache key on the CSS and skin URLs.
   */
  contentHash?: string;
}

interface PluginRegistry {
  plugins: ServerPlugin[];
}

interface ThemeRegistry {
  themes: ServerTheme[];
}

// ─── Storage ─────────────────────────────────────────────────
//
// Both registries, their bundles, signatures, CSS and history are
// documents of the `plugins` and `themes` collections (extension-store.ts):
// the files under C/plugins and C/themes in local mode, the shared store in
// shared mode (#1066). Every change writes the bundle (and its signature)
// before the registry entry that points at it, changes the registry with
// update() so a concurrent change of another entry stays, and then
// announces area `plugins` or `themes` so every replica drops what it
// derived from the old registry (the CSP frame origins, for one).

type RegistryKind = 'plugins' | 'themes';

interface RegistryGlobals {
  /** One change at a time per registry in this process. */
  queues: Map<string, Promise<unknown>>;
  /** Shared mode: the last registry read, served while the store is down. */
  lastGood: Map<RegistryKind, string>;
}

const GLOBAL_KEY = Symbol.for('bulwark.admin.pluginRegistry');

function registryGlobals(): RegistryGlobals {
  const g = globalThis as typeof globalThis & { [GLOBAL_KEY]?: RegistryGlobals };
  return (g[GLOBAL_KEY] ??= { queues: new Map(), lastGood: new Map() });
}

const docsFor = (kind: RegistryKind) => (kind === 'plugins' ? pluginDocs() : themeDocs());

const REGISTRY_ID = 'registry.json';

function serialize(registry: unknown): string {
  return JSON.stringify(registry, null, 2);
}

/** A registry document, or `fallback` when it is missing or doesn't parse (as a broken file always did). */
function parseRegistry<T>(kind: RegistryKind, data: Buffer | null, fallback: () => T): T {
  if (!data) return fallback();
  try {
    return JSON.parse(data.toString('utf-8')) as T;
  } catch (error) {
    logger.warn(`Failed to read the ${kind} registry`, { error: error instanceof Error ? error.message : 'Unknown error' });
    return fallback();
  }
}

/**
 * Read a registry. A store outage serves the last copy this replica read
 * (config reads keep the last good copy, plan §6); with none it throws.
 */
async function readRegistry<T>(kind: RegistryKind, fallback: () => T): Promise<T> {
  const g = registryGlobals();
  let data: Buffer | null;
  try {
    data = (await docsFor(kind).get(REGISTRY_ID))?.data ?? null;
  } catch (error) {
    if (isStoreUnavailable(error)) {
      const last = g.lastGood.get(kind);
      if (last !== undefined) return JSON.parse(last) as T;
      throw error;
    }
    logger.warn(`Failed to read the ${kind} registry`, { error: error instanceof Error ? error.message : 'Unknown error' });
    return fallback();
  }
  const registry = parseRegistry(kind, data, fallback);
  if (isSharedMode()) g.lastGood.set(kind, serialize(registry));
  return registry;
}

/** Change a registry with update(); `change` may run more than once. */
async function updateRegistry<T>(kind: RegistryKind, fallback: () => T, change: (registry: T) => boolean): Promise<void> {
  const result = await docsFor(kind).update(REGISTRY_ID, (current) => {
    const registry = parseRegistry(kind, current, fallback);
    return change(registry) ? serialize(registry) : undefined;
  });
  if (result.data && isSharedMode()) registryGlobals().lastGood.set(kind, result.data.toString('utf-8'));
}

async function readText(kind: RegistryKind, id: string): Promise<string | null> {
  const doc = await docsFor(kind).get(id);
  return doc ? doc.data.toString('utf-8') : null;
}

/** Delete a document; only a store outage counts as a failure (a file that is gone already is fine). */
async function removeDoc(kind: RegistryKind, id: string): Promise<void> {
  try {
    await docsFor(kind).delete(id);
  } catch (error) {
    if (isStoreUnavailable(error)) throw error;
  }
}

/** How long a registry lease lasts (renewed every third of it) and how long a change waits for one. */
const leaseTiming = { ttlMs: 30_000, waitMs: 15_000 };

/** Shorter lease times (tests). */
export function setRegistryLeaseTimingForTests(timing: Partial<typeof leaseTiming> | null): void {
  Object.assign(leaseTiming, timing ?? { ttlMs: 30_000, waitMs: 15_000 });
}

interface RegistryLease {
  /** Throws (StoreUnavailableError, so a 503) unless this change still holds the lease. */
  assertHeld(): Promise<void>;
}

const NO_LEASE: RegistryLease = { async assertHeld() {} };

/**
 * Changes to one registry run one after another: in this process through a
 * promise chain on globalThis (every module copy shares it), and across
 * replicas under a lease, so two installs of the same extension at once
 * can't leave one's bundle under the other's registry entry. A change that
 * can't get the lease in time is refused (503) before anything is written;
 * the lease is renewed while the change runs, and an install checks it
 * still holds it right before it writes the registry entry. The registry
 * itself is changed with update(), so other entries always stay.
 */
function withRegistryLock<T>(kind: RegistryKind, task: (lease: RegistryLease) => Promise<T>): Promise<T> {
  const queues = registryGlobals().queues;
  const locked = () => withLease(kind, task);
  const run = (queues.get(kind) ?? Promise.resolve()).then(locked, locked);
  queues.set(kind, run.catch(() => {}));
  return run;
}

async function withLease<T>(kind: RegistryKind, task: (lease: RegistryLease) => Promise<T>): Promise<T> {
  if (!isSharedMode() || isConfigReadOnly()) return task(NO_LEASE);
  const store = getStore();
  const name = `extension-registry-${kind}`;
  const holder = `${replicaId()}-${randomBytes(4).toString('hex')}`;
  const { ttlMs, waitMs } = leaseTiming;
  const deadline = Date.now() + waitMs;
  let held = await store.leases.acquire(name, holder, ttlMs);
  while (!held && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, waitMs / 4) * (1 + Math.random())));
    held = await store.leases.acquire(name, holder, ttlMs);
  }
  if (!held) {
    throw new StoreUnavailableError(`Another instance is still changing the ${kind}; nothing was changed. Try again in a moment.`);
  }
  let lost = false;
  const renew = setInterval(() => {
    store.leases.acquire(name, holder, ttlMs).then((ok) => { if (!ok) lost = true; }, () => { /* checked before the write */ });
  }, Math.max(10, Math.floor(ttlMs / 3)));
  renew.unref?.();
  const lease: RegistryLease = {
    async assertHeld() {
      if (lost || (await store.leases.holder(name)) !== holder) {
        logger.error(`Lost the lock on the ${kind} in the middle of a change; the registry was left as it was`);
        throw new StoreUnavailableError(`This instance lost the lock on the ${kind} in the middle of a change; the registry was left as it was. Try again.`);
      }
    },
  };
  try {
    return await task(lease);
  } finally {
    clearInterval(renew);
    await store.leases.release(name, holder).catch(() => {});
  }
}

/**
 * The stored bundle isn't the one the registry entry names: an install that
 * stopped between writing the bundle and the entry. Refused the same way on
 * every replica, so it is visibly broken instead of working on some.
 */
export class BundleMismatchError extends Error {
  constructor(id: string) {
    super(`The stored code of plugin ${id} does not match its registry entry (an install was interrupted). Install it again.`);
    this.name = 'BundleMismatchError';
  }
}

export function isBundleMismatch(error: unknown): boolean {
  return (error as Error | null)?.name === 'BundleMismatchError';
}

const sha256Hex = (data: string) => createHash('sha256').update(data).digest('hex');

// ─── Plugin Operations ───────────────────────────────────────

const emptyPluginRegistry = (): PluginRegistry => ({ plugins: [] });

const FULL_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Older builds wrote a 16-char SHA-256 prefix into `bundleHash`. The current
 * client-side verifyBundle requires equal-length hex (and the full digest for
 * real integrity), so any registry entry with a truncated or otherwise
 * malformed hash needs to be re-hashed from the stored bundle. If the bundle
 * is missing the hash is cleared so verifyBundle skips the check rather
 * than refusing to load.
 *
 * Returns the fixed hash per plugin id and the hash it replaces (null =
 * clear it), or null when nothing needs fixing.
 */
async function bundleHashFixes(registry: PluginRegistry): Promise<Map<string, { from: string; to: string | null }> | null> {
  const fixes = new Map<string, { from: string; to: string | null }>();
  for (const plugin of registry.plugins) {
    if (!plugin.bundleHash || FULL_HASH_RE.test(plugin.bundleHash)) continue;
    let code: string | null = null;
    try {
      code = await readText('plugins', `${plugin.id}.js`);
    } catch (error) {
      // A store outage says nothing about the bundle: try again next time.
      if (isStoreUnavailable(error)) continue;
      /* unreadable: cleared, as a missing bundle */
    }
    fixes.set(plugin.id, { from: plugin.bundleHash, to: code === null ? null : sha256Hex(code) });
  }
  return fixes.size > 0 ? fixes : null;
}

function applyHashFixes(registry: PluginRegistry, fixes: Map<string, { from: string; to: string | null }>): boolean {
  let changed = false;
  for (const plugin of registry.plugins) {
    const fix = fixes.get(plugin.id);
    // Only an entry that still has the old hash: a save in between wins.
    if (!fix || plugin.bundleHash !== fix.from) continue;
    if (fix.to) plugin.bundleHash = fix.to;
    else delete plugin.bundleHash;
    changed = true;
  }
  return changed;
}

export async function getPluginRegistry(): Promise<PluginRegistry> {
  const registry = await readRegistry('plugins', emptyPluginRegistry);
  const fixes = await bundleHashFixes(registry);
  if (fixes) {
    applyHashFixes(registry, fixes);
    // Stored with update(), so an install that lands meanwhile isn't undone.
    try { await updateRegistry('plugins', emptyPluginRegistry, (stored) => applyHashFixes(stored, fixes)); } catch { /* read-only fs ok */ }
  }
  return registry;
}

export async function getPlugin(id: string): Promise<ServerPlugin | null> {
  const registry = await getPluginRegistry();
  return registry.plugins.find(p => p.id === id) || null;
}

const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

export async function savePlugin(plugin: ServerPlugin, code: string): Promise<void> {
  await withRegistryLock('plugins', (lease) => savePluginNow(plugin, code, lease));
  await announceChange('plugins');
}

async function savePluginNow(
  plugin: ServerPlugin,
  code: string,
  lease: RegistryLease,
): Promise<void> {
  assertWritable('install plugin');
  if (!SAFE_ID_RE.test(plugin.id)) {
    throw new Error('Invalid plugin id');
  }

  const bundleHash = sha256Hex(code);
  const current = (await getPluginRegistry()).plugins.find(p => p.id === plugin.id);
  // Sign now and keep the signature with the bundle. Signing at serve time
  // would sign whatever is stored, so a bundle swapped after install would
  // still verify. Signed before anything is written: a key that can't be
  // loaded from the shared store fails the install, not half of it.
  const signature = await signBundle(plugin.id, code);

  // Keep what is about to be replaced, so the update can be undone
  // (extension-history.ts). The same bytes under the same version are not
  // a replacement worth keeping.
  if (current) {
    await forgetVersion('plugin', plugin.id, plugin.version);
    if (current.version !== plugin.version || current.bundleHash !== bundleHash) {
      const currentCode = await readText('plugins', `${plugin.id}.js`);
      if (currentCode !== null) await snapshotPlugin(current, currentCode);
    }
  }

  // The bundle and its signature first, then the registry entry pointing at them.
  const docs = pluginDocs();
  await docs.put(`${plugin.id}.js`, code);
  await storeSignature(plugin.id, signature);

  // Stamp content hash + updatedAt so clients can detect re-uploads even
  // when the manifest version hasn't changed. Preserve the original
  // installedAt across re-uploads. The full SHA-256 is required because the
  // client-side verifyBundle compares the entire digest length-checked.
  const now = new Date().toISOString();
  await lease.assertHeld();
  await updateRegistry('plugins', emptyPluginRegistry, (registry) => {
    const idx = registry.plugins.findIndex(p => p.id === plugin.id);
    const next: ServerPlugin = {
      ...plugin,
      bundleHash,
      updatedAt: now,
      installedAt: idx >= 0 ? registry.plugins[idx].installedAt : plugin.installedAt,
    };
    if (idx >= 0) {
      registry.plugins[idx] = next;
    } else {
      registry.plugins.push(next);
    }
    return true;
  });
  if (isSharedMode()) cacheBundle(bundleHash, code, signature);
}

export async function updatePluginMeta(id: string, updates: Partial<Pick<ServerPlugin, 'enabled' | 'forceEnabled'>>): Promise<ServerPlugin | null> {
  const updated = await withRegistryLock('plugins', () => updatePluginMetaNow(id, updates));
  if (updated) await announceChange('plugins');
  return updated;
}

async function updatePluginMetaNow(id: string, updates: Partial<Pick<ServerPlugin, 'enabled' | 'forceEnabled'>>): Promise<ServerPlugin | null> {
  assertWritable('update plugin metadata');
  const now = new Date().toISOString();
  let updated: ServerPlugin | null = null;
  await updateRegistry('plugins', emptyPluginRegistry, (registry) => {
    updated = null;
    const idx = registry.plugins.findIndex(p => p.id === id);
    if (idx < 0) return false;
    registry.plugins[idx] = { ...registry.plugins[idx], ...updates, updatedAt: now };
    updated = registry.plugins[idx];
    return true;
  });
  return updated;
}

export async function deletePlugin(id: string): Promise<boolean> {
  const deleted = await withRegistryLock('plugins', () => deletePluginNow(id));
  if (deleted) await announceChange('plugins');
  return deleted;
}

async function deletePluginNow(id: string): Promise<boolean> {
  assertWritable('delete plugin');
  let found = false;
  await updateRegistry('plugins', emptyPluginRegistry, (registry) => {
    const idx = registry.plugins.findIndex(p => p.id === id);
    found = idx >= 0;
    if (!found) return false;
    registry.plugins.splice(idx, 1);
    return true;
  });
  if (!found) return false;

  // Remove bundle and signature (the registry no longer points at them)
  if (SAFE_ID_RE.test(id)) {
    for (const file of [`${id}.js`, `${id}.sig`]) await removeDoc('plugins', file);
  }
  await purgeHistory('plugin', id);

  return true;
}

/** Sign a bundle; null when no key can be loaded (the plugin then can't run privileged). */
async function signBundle(id: string, code: string): Promise<string | null> {
  try {
    const { signBytes } = await import('./plugin-signing');
    return await signBytes(code);
  } catch (err) {
    if (isStoreUnavailable(err)) throw err;
    // Without a key the bundle still installs; it just can't run privileged.
    logger.warn('[plugin-registry] could not sign plugin bundle', { id, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

async function storeSignature(id: string, signature: string | null): Promise<void> {
  if (signature) await pluginDocs().put(`${id}.sig`, signature);
  else await removeDoc('plugins', `${id}.sig`);
}

/**
 * The signature made when the bundle was installed. Bundles installed before
 * signatures were stored get one on first request (trust on first use), so
 * a later change to the stored bundle stops verifying from then on.
 *
 * `bundleHash` (the registry entry's) lets shared mode answer from this
 * replica's bundle cache. Only a signature that verifies for the cached
 * code goes into it: one read while another replica was halfway through an
 * install belongs to other bytes.
 */
export async function getPluginSignature(id: string, code: string, bundleHash?: string): Promise<string | null> {
  if (!SAFE_ID_RE.test(id)) return null;
  const cached = bundleHash && isSharedMode() ? getCachedBundle(bundleHash) : undefined;
  if (cached && cached.code === code && cached.signature !== undefined) return cached.signature;
  let stored: string | null;
  try {
    stored = await readText('plugins', `${id}.sig`);
  } catch (error) {
    if (isStoreUnavailable(error)) throw error;
    stored = null;
  }
  let signature: string | null;
  if (stored !== null) {
    signature = stored.trim() || null;
  } else {
    signature = await signBundle(id, code);
    try {
      // Only if still missing: a replica that stored one first wins, and
      // its signature is what every replica serves.
      if (signature) {
        const written = await pluginDocs().put(`${id}.sig`, signature, { ifVersion: null });
        if (!written.ok) signature = written.current?.data.toString('utf-8').trim() || null;
      }
    } catch (error) {
      if (isStoreUnavailable(error)) throw error;
      // Read-only config, a full disk, a file we may not write: serve the
      // bundle unsigned rather than not at all, as before.
      logger.warn('[plugin-registry] could not store the signature of a plugin bundle; serving it unsigned', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
      signature = null;
    }
  }
  if (cached && cached.code === code && signature && (await signatureVerifies(code, signature))) cached.signature = signature;
  return signature;
}

async function signatureVerifies(code: string, signature: string): Promise<boolean> {
  try {
    const { verifyBytes } = await import('./plugin-signing');
    return await verifyBytes(code, signature);
  } catch {
    return false;
  }
}

/**
 * The stored bundle of a plugin. With `bundleHash` (the registry entry's),
 * shared mode serves it from this replica's cache once it was fetched and
 * found to match, and refuses stored bytes that don't match
 * (BundleMismatchError).
 */
export async function getPluginBundle(id: string, bundleHash?: string): Promise<string | null> {
  if (!SAFE_ID_RE.test(id)) return null;
  const useCache = !!bundleHash && isSharedMode();
  if (useCache) {
    const cached = getCachedBundle(bundleHash!);
    if (cached) return cached.code;
  }
  let code: string | null;
  try {
    code = await readText('plugins', `${id}.js`);
  } catch (error) {
    if (isStoreUnavailable(error)) throw error;
    return null;
  }
  if (code !== null && useCache && FULL_HASH_RE.test(bundleHash!)) {
    if (sha256Hex(code) !== bundleHash) {
      logger.error('[plugin-registry] stored plugin bundle does not match its registry entry', { id });
      throw new BundleMismatchError(id);
    }
    cacheBundle(bundleHash!, code);
  }
  return code;
}

// ─── Theme Operations ────────────────────────────────────────

const emptyThemeRegistry = (): ThemeRegistry => ({ themes: [] });

export async function getThemeRegistry(): Promise<ThemeRegistry> {
  return readRegistry('themes', emptyThemeRegistry);
}

export async function getTheme(id: string): Promise<ServerTheme | null> {
  const registry = await getThemeRegistry();
  return registry.themes.find(t => t.id === id) || null;
}

export async function saveTheme(theme: ServerTheme, css: string, skin: string | null = null): Promise<void> {
  await withRegistryLock('themes', (lease) => saveThemeNow(theme, css, skin, lease));
  await announceChange('themes');
}

async function saveThemeNow(
  theme: ServerTheme,
  css: string,
  skin: string | null,
  lease: RegistryLease,
): Promise<void> {
  assertWritable('install theme');
  if (!SAFE_ID_RE.test(theme.id)) {
    throw new Error('Invalid theme id');
  }

  const contentHash = createHash('sha256').update(css).update('\0').update(skin ?? '').digest('hex');
  const current = (await getThemeRegistry()).themes.find(t => t.id === theme.id);
  const cssId = `${theme.id}.css`;
  const skinId = `${theme.id}.skin.css`;

  // Keep the theme being replaced for a rollback (extension-history.ts).
  if (current) {
    await forgetVersion('theme', theme.id, theme.version);
    if (current.version !== theme.version || current.contentHash !== contentHash) {
      const currentCss = await readText('themes', cssId);
      const currentSkin = current.hasSkin ? await readText('themes', skinId) : null;
      if (currentCss !== null) await snapshotTheme(current, currentCss, currentSkin);
    }
  }

  // The CSS and skin first, then the registry entry.
  const docs = themeDocs();
  await docs.put(cssId, css);
  if (skin) {
    await docs.put(skinId, skin);
  } else {
    await removeDoc('themes', skinId);
  }
  const next: ServerTheme = { ...theme, hasSkin: !!skin, contentHash };

  await lease.assertHeld();
  await updateRegistry('themes', emptyThemeRegistry, (registry) => {
    const idx = registry.themes.findIndex(t => t.id === theme.id);
    if (idx >= 0) {
      registry.themes[idx] = next;
    } else {
      registry.themes.push(next);
    }
    return true;
  });
}

export async function updateThemeMeta(id: string, updates: Partial<Pick<ServerTheme, 'enabled' | 'forceEnabled'>>): Promise<ServerTheme | null> {
  const updated = await withRegistryLock('themes', () => updateThemeMetaNow(id, updates));
  if (updated) await announceChange('themes');
  return updated;
}

async function updateThemeMetaNow(id: string, updates: Partial<Pick<ServerTheme, 'enabled' | 'forceEnabled'>>): Promise<ServerTheme | null> {
  assertWritable('update theme metadata');
  const now = new Date().toISOString();
  let updated: ServerTheme | null = null;
  await updateRegistry('themes', emptyThemeRegistry, (registry) => {
    updated = null;
    const idx = registry.themes.findIndex(t => t.id === id);
    if (idx < 0) return false;
    registry.themes[idx] = { ...registry.themes[idx], ...updates, updatedAt: now };
    updated = registry.themes[idx];
    return true;
  });
  return updated;
}

export async function deleteTheme(id: string): Promise<boolean> {
  const deleted = await withRegistryLock('themes', () => deleteThemeNow(id));
  if (deleted) await announceChange('themes');
  return deleted;
}

async function deleteThemeNow(id: string): Promise<boolean> {
  assertWritable('delete theme');
  let found = false;
  await updateRegistry('themes', emptyThemeRegistry, (registry) => {
    const idx = registry.themes.findIndex(t => t.id === id);
    found = idx >= 0;
    if (!found) return false;
    registry.themes.splice(idx, 1);
    return true;
  });
  if (!found) return false;

  // Remove CSS and skin
  if (SAFE_ID_RE.test(id)) {
    for (const file of [`${id}.css`, `${id}.skin.css`]) await removeDoc('themes', file);
  }
  await purgeHistory('theme', id);

  return true;
}

export async function getThemeSkin(id: string): Promise<string | null> {
  if (!SAFE_ID_RE.test(id)) return null;
  return readThemeAsset(`${id}.skin.css`);
}

async function readThemeAsset(file: string): Promise<string | null> {
  try {
    return await readText('themes', file);
  } catch (error) {
    if (isStoreUnavailable(error)) throw error;
    return null;
  }
}

/**
 * CSS of every installed theme and every built-in theme, keyed by id, for
 * resolving a new theme's `extends`.
 */
export async function themeCSSResolver(): Promise<(id: string) => string | null> {
  const { BUILTIN_THEMES } = await import('@/lib/builtin-themes');
  const map = new Map<string, string>();
  for (const t of BUILTIN_THEMES) if (t.css) map.set(t.id, t.css);
  for (const t of (await getThemeRegistry()).themes) {
    const css = await getThemeCSS(t.id);
    if (css) map.set(t.id, css);
  }
  return (id) => map.get(id) ?? null;
}

export async function getThemeCSS(id: string): Promise<string | null> {
  if (!SAFE_ID_RE.test(id)) return null;
  return readThemeAsset(`${id}.css`);
}

/** Forget the registries this replica keeps for an outage (tests). */
export function resetRegistryCacheForTests(): void {
  const g = registryGlobals();
  g.lastGood.clear();
  g.queues.clear();
}
