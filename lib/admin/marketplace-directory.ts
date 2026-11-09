/**
 * The extension directory as the marketplace routes see it.
 *
 * Everything the webmail asks the directory goes through `/api/v2`
 * (lib/api/v2.ts in the directory): list, detail, versions, bundle and the
 * updates check. The URL is the admin's `extensionDirectoryUrl` setting; the
 * channel decides whether pre-releases are offered.
 *
 * The directory's answers are mapped here into the shapes the admin UI
 * renders, so the routes and the pages agree on names and the directory's own
 * field names stay in one file.
 */

import { configManager } from './config-manager';
import { getPluginRegistry, getThemeRegistry, type ExtensionSource } from './plugin-registry';
import { listHistory, type HistoryEntry } from './extension-history';
import { isNoThirdPartyTrafficOn } from './third-party-mode';
import { isBuiltInHost } from '@/lib/outgoing-hosts';

export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || '';

export type Channel = 'stable' | 'beta';

export async function getDirectoryUrl(): Promise<string> {
  await configManager.ensureLoaded();
  const url = configManager.get<string>('extensionDirectoryUrl') || 'https://extensions.bulwarkmail.org';
  // Defense in depth: the routes ask directoryOff() first and answer 403.
  if (isBuiltInHost(url) && await isNoThirdPartyTrafficOn()) throw new DirectoryError(DIRECTORY_OFF_MESSAGE, 403);
  return url;
}

export const DIRECTORY_OFF_MESSAGE =
  'The official extension directory is off: this server does not contact outside services (NO_THIRD_PARTY_TRAFFIC). Point EXTENSION_DIRECTORY_URL at a self-hosted directory to use the marketplace.';

/**
 * Whether the marketplace must not ask its directory: the no-third-party
 * mode is on and the directory is the official one (#903). A self-hosted
 * directory is the deployment's own and stays reachable.
 */
export async function directoryOff(): Promise<boolean> {
  await configManager.ensureLoaded();
  const url = configManager.get<string>('extensionDirectoryUrl') || 'https://extensions.bulwarkmail.org';
  return isBuiltInHost(url) && await isNoThirdPartyTrafficOn();
}

export function getDirectoryChannel(): Channel {
  return configManager.get<string>('extensionDirectoryChannel') === 'beta' ? 'beta' : 'stable';
}

/** A `/api/v2/...` URL on the directory; `path` starts with a slash. */
export function v2Url(directoryUrl: string, path: string, query: Record<string, string | undefined> = {}): URL {
  const url = new URL(`/api/v2${path}`, directoryUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, value);
  }
  return url;
}

/** The query every catalogue request carries so the directory filters for this Bulwark. */
export function compatQuery(): Record<string, string | undefined> {
  return { appVersion: APP_VERSION || undefined, channel: getDirectoryChannel() };
}

export class DirectoryError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'DirectoryError';
  }
}

/** GET JSON from the directory; a non-2xx answer becomes a DirectoryError with its status. */
export async function directoryJson<T>(url: URL, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 10_000, ...rest } = init;
  const res = await fetch(url.toString(), {
    ...rest,
    headers: { Accept: 'application/json', ...(rest.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let message = `Directory request failed (${res.status})`;
    try {
      const body = await res.json();
      if (typeof body?.error?.message === 'string') message = body.error.message;
      else if (typeof body?.error === 'string') message = body.error;
    } catch { /* keep the status message */ }
    throw new DirectoryError(message, res.status);
  }
  return res.json() as Promise<T>;
}

/**
 * The bytes of a bundle download, refused once they pass `maxBytes` (the
 * package size limit). Reading the whole answer first let a directory, or
 * anyone in the path to it, stream until the server ran out of memory.
 */
export async function readBundleBytes(res: Response, maxBytes: number): Promise<ArrayBuffer> {
  const tooLarge = () => new DirectoryError(`The bundle is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`, 413);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
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

// ─── Directory shapes (lib/api/views.ts in the directory) ──────────────────

export interface DirectoryVersion {
  version: string;
  channel: Channel;
  publishedAt: string | null;
  minAppVersion: string | null;
  maxAppVersion: string | null;
  permissions: string[];
  size: number;
  sha256: string;
  yanked: { at: string; reason: string | null } | null;
  downloadUrl: string;
  /** Only on the full view (`/versions`, `/versions/{v}`). */
  changelog?: string | null;
  /** Whether the changelog has a Security or Breaking heading (directories since 2026-10-30). */
  notes?: { security: boolean; breaking: boolean };
  downloads?: number;
  signature?: { keyId: string } | null;
  provenance?: { source: { host: string; repo: string | null; commit: string | null } } | null;
}

/** One version's notes in an update: every version between the installed one and the offered one has one. */
export interface DirectoryChangelogEntry {
  version: string;
  publishedAt: string | null;
  changelog: string | null;
  notes: { security: boolean; breaking: boolean };
}

export interface DirectoryAuthor {
  login: string;
  name: string;
  avatarUrl: string | null;
  verified: boolean;
  organization: boolean;
  url: string;
}

export interface DirectoryAdvisory {
  id: string;
  extension: string;
  affected: string;
  fixedIn: string | null;
  severity: string;
  summary: string;
  details: string | null;
  publishedAt: string | null;
  withdrawn: boolean;
  /** Only in the updates answer. */
  installedVersion?: string;
}

export interface DirectorySummary {
  slug: string;
  name: string;
  type: 'plugin' | 'theme';
  pluginType: string | null;
  description: string;
  tags: string[];
  license: string | null;
  featured: boolean;
  status: string;
  iconUrl: string | null;
  bannerUrl: string | null;
  author: DirectoryAuthor | null;
  latest: DirectoryVersion | null;
  downloads: number;
  rating: { average: number; count: number };
  deprecated: { at: string; message: string | null; replacement: string | null } | null;
  source: { host: string; repo: string | null; subpath: string | null };
  url: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface DirectoryDetail extends DirectorySummary {
  longDescription: string | null;
  newest: DirectoryVersion | null;
  versions: DirectoryVersion[];
  screenshots: Array<{ url: string; altText: string | null }>;
  themePreviews: Array<{ variant: 'light' | 'dark'; url: string; colors: Record<string, string> | null }>;
  advisories: DirectoryAdvisory[];
  permissions: Array<{ id: string; title: string; body: string; highRisk: boolean }>;
}

// ─── What the admin UI renders ─────────────────────────────────────────────

export interface InstalledState {
  installed: boolean;
  installedVersion: string | null;
  installedSource: ExtensionSource | null;
}

export interface MarketplaceListing extends InstalledState {
  slug: string;
  name: string;
  type: 'plugin' | 'theme';
  pluginType: string | null;
  description: string;
  tags: string[];
  license: string | null;
  featured: boolean;
  /** `approved`, `archived` or `suspended` (listed extensions are never pending). */
  status: string;
  iconUrl: string | null;
  bannerUrl: string | null;
  author: { displayName: string; githubLogin: string; avatarUrl: string | null; verified: boolean; organization: boolean } | null;
  totalDownloads: number;
  rating: { average: number; count: number };
  deprecated: DirectorySummary['deprecated'];
  /** The version the directory offers this Bulwark, or null if none fits. */
  latest: DirectoryVersion | null;
  /** Kept for the card: the offered version's number and requirement. */
  latestVersion: string | null;
  minAppVersion: string | null;
  permissions: string[];
  /** The directory's own page for this extension. */
  directoryUrl: string;
}

export function toListing(ext: DirectorySummary, state: InstalledState): MarketplaceListing {
  return {
    slug: ext.slug,
    name: ext.name,
    type: ext.type,
    pluginType: ext.pluginType ?? null,
    description: ext.description,
    tags: ext.tags ?? [],
    license: ext.license ?? null,
    featured: !!ext.featured,
    status: ext.status ?? 'approved',
    iconUrl: ext.iconUrl ?? null,
    bannerUrl: ext.bannerUrl ?? null,
    author: ext.author
      ? {
          displayName: ext.author.name,
          githubLogin: ext.author.login,
          avatarUrl: ext.author.avatarUrl ?? null,
          verified: !!ext.author.verified,
          organization: !!ext.author.organization,
        }
      : null,
    totalDownloads: ext.downloads ?? 0,
    rating: ext.rating ?? { average: 0, count: 0 },
    deprecated: ext.deprecated ?? null,
    latest: ext.latest ?? null,
    latestVersion: ext.latest?.version ?? null,
    minAppVersion: ext.latest?.minAppVersion ?? null,
    permissions: ext.latest?.permissions ?? [],
    directoryUrl: ext.url,
    ...state,
  };
}

/** Every admin-installed extension, keyed by id, with what the marketplace needs to know. */
export async function installedExtensions(): Promise<Map<string, { kind: 'plugin' | 'theme'; name: string; version: string; source: ExtensionSource | null; enabled: boolean }>> {
  const [plugins, themes] = await Promise.all([getPluginRegistry(), getThemeRegistry()]);
  const out = new Map<string, { kind: 'plugin' | 'theme'; name: string; version: string; source: ExtensionSource | null; enabled: boolean }>();
  for (const p of plugins.plugins) out.set(p.id, { kind: 'plugin', name: p.name, version: p.version, source: p.source ?? null, enabled: p.enabled });
  for (const t of themes.themes) if (!out.has(t.id)) out.set(t.id, { kind: 'theme', name: t.name, version: t.version, source: t.source ?? null, enabled: t.enabled });
  return out;
}

export function installedStateOf(
  installed: Awaited<ReturnType<typeof installedExtensions>>,
  slug: string,
  type: 'plugin' | 'theme',
): InstalledState {
  const entry = installed.get(slug);
  if (!entry || entry.kind !== type) return { installed: false, installedVersion: null, installedSource: null };
  return { installed: true, installedVersion: entry.version, installedSource: entry.source };
}

/**
 * Whether an installed extension is one the directory should be asked about.
 * Entries from before `source` was recorded have none; they were almost all
 * marketplace installs, and the directory answers "unknown" for a slug it
 * does not list, so including them costs nothing.
 */
export function askDirectoryAbout(source: ExtensionSource | null): boolean {
  return source === null || source.kind === 'marketplace';
}

export async function historyFor(kind: 'plugin' | 'theme', id: string): Promise<HistoryEntry[]> {
  try {
    return await listHistory(kind, id);
  } catch {
    return [];
  }
}
