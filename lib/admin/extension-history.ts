/**
 * Previously installed versions of admin plugins and themes, kept so an
 * update that turns out broken can be undone without the directory.
 *
 * Before `savePlugin`/`saveTheme` overwrites an installed extension with a
 * different version (or different bytes of the same version), the files that
 * are about to be replaced are copied here:
 *
 *   <config>/plugins/history/<id>/<version>/entry.json   the registry entry
 *   <config>/plugins/history/<id>/<version>/bundle.js    the code
 *   <config>/themes/history/<id>/<version>/entry.json
 *   <config>/themes/history/<id>/<version>/theme.css
 *   <config>/themes/history/<id>/<version>/skin.css      when the theme had one
 *
 * `KEEP` entries are kept per extension, oldest first out. Uninstalling an
 * extension removes its history: a later install under the same id starts
 * clean, like its config and policy do (extension-cleanup.ts).
 *
 * A rollback is an ordinary save of the snapshot through `savePlugin` or
 * `saveTheme`, so it is signed and hashed like any install, the version being
 * replaced is snapshotted in turn (a rollback can be rolled back), and the
 * current enabled/forced flags are kept. The snapshot's hash is checked
 * before it is restored: a history file edited on disk is refused rather
 * than installed for every user.
 *
 * The files are documents of the `plugins` and `themes` collections
 * (extension-store.ts) under `history/<id>/<version>/`: the paths above in
 * local mode, the shared store in shared mode (#1066).
 */

import { readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { logger } from '@/lib/logger';
import { isSharedMode, type DocCollection } from '@/lib/shared-store';
import { isStoreUnavailable } from './admin-store';
import { pluginDocs, pluginsOptions, themeDocs, themesOptions } from './extension-store';
import type { ServerPlugin, ServerTheme } from './plugin-registry';

export type ExtensionKind = 'plugin' | 'theme';

/** How many previous versions are kept per extension. */
export const KEEP = 5;

export interface HistoryEntry {
  version: string;
  /** When this version was replaced, not when it was installed. */
  savedAt: string;
  /** SHA-256 of the bundle (plugins) or css + skin (themes). */
  contentHash: string;
  source?: ServerPlugin['source'];
  /** The kept version's changelog, when it came from the marketplace with one. */
  changelog?: string;
}

const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/** The extension's history folder: a document id prefix, without the trailing slash. */
function historyRoot(id: string): string {
  if (!SAFE_ID_RE.test(id)) throw new Error('Invalid extension id');
  return `history/${id}`;
}

const docsOf = (kind: ExtensionKind): DocCollection => (kind === 'plugin' ? pluginDocs() : themeDocs());
const localDir = (kind: ExtensionKind): string => (kind === 'plugin' ? pluginsOptions : themesOptions).local.dir();

async function readText(kind: ExtensionKind, id: string): Promise<string | null> {
  try {
    const doc = await docsOf(kind).get(id);
    return doc ? doc.data.toString('utf-8') : null;
  } catch (error) {
    if (isStoreUnavailable(error)) throw error;
    return null;
  }
}

/**
 * Remove a history folder. Local mode: `rm -r` of the folder, as before.
 * Shared mode: entry.json first, so no reader sees a kept version without
 * its files, then the rest.
 */
async function removeFolder(kind: ExtensionKind, folder: string): Promise<void> {
  if (!isSharedMode()) {
    await rm(path.join(localDir(kind), ...folder.split('/')), { recursive: true, force: true });
    return;
  }
  const docs = docsOf(kind);
  const ids = await docs.list(`${folder}/`);
  const entry = `${folder}/entry.json`;
  for (const id of [...ids.filter((i) => i === entry), ...ids.filter((i) => i !== entry)]) await docs.delete(id);
}

/**
 * A version becomes one directory name. Published versions are `1.2.3` or
 * `1.2.3-beta.1`; anything else (an uploaded theme can call itself what it
 * likes) is reduced to that alphabet. The exact string lives in entry.json.
 */
function dirNameFor(version: string): string {
  const safe = version.replace(/[^0-9A-Za-z.-]/g, '_').replace(/^\.+/, '_').slice(0, 64);
  return safe || '_';
}

function hashOf(parts: Array<string | null | undefined>): string {
  const h = createHash('sha256');
  parts.forEach((p, i) => {
    if (i > 0) h.update('\0');
    h.update(p ?? '');
  });
  return h.digest('hex');
}

interface StoredEntry extends HistoryEntry {
  kind: ExtensionKind;
  entry: ServerPlugin | ServerTheme;
}

async function readEntry(kind: ExtensionKind, dir: string): Promise<StoredEntry | null> {
  const text = await readText(kind, `${dir}/entry.json`);
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as StoredEntry;
    if (!raw || typeof raw.version !== 'string' || typeof raw.savedAt !== 'string' || !raw.entry) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * The version folders under an extension's history. Local mode reads the
 * one directory, as before (listing the collection would walk every file
 * under C/plugins on each install).
 */
async function versionFolders(kind: ExtensionKind, root: string): Promise<string[]> {
  if (!isSharedMode()) {
    return readdir(path.join(localDir(kind), ...root.split('/')));
  }
  const names = new Set<string>();
  for (const docId of await docsOf(kind).list(`${root}/`)) {
    const name = docId.slice(root.length + 1).split('/')[0];
    if (name) names.add(name);
  }
  return [...names];
}

async function readAll(kind: ExtensionKind, id: string): Promise<Array<StoredEntry & { dir: string }>> {
  const root = historyRoot(id);
  let names: string[];
  try {
    names = await versionFolders(kind, root);
  } catch (error) {
    if (isStoreUnavailable(error)) throw error;
    return [];
  }
  const out: Array<StoredEntry & { dir: string }> = [];
  for (const name of names) {
    const dir = `${root}/${name}`;
    const entry = await readEntry(kind, dir);
    if (entry) out.push({ ...entry, dir });
  }
  // Newest replacement first.
  out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
  return out;
}

async function prune(kind: ExtensionKind, id: string): Promise<void> {
  const all = await readAll(kind, id);
  for (const stale of all.slice(KEEP)) {
    await removeFolder(kind, stale.dir);
  }
  // Folders without a readable entry.json (a copy that was cut short) are
  // never listed or restored; sweep them so they don't pile up.
  const root = historyRoot(id);
  const listed = new Set(all.map((e) => e.dir));
  for (const name of await versionFolders(kind, root).catch(() => [] as string[])) {
    if (!listed.has(`${root}/${name}`)) await removeFolder(kind, `${root}/${name}`);
  }
}

/**
 * What the admin lists say about the kept versions: the versions, most
 * recently replaced first, and the changelog of each that has one.
 */
export function keptVersions(history: HistoryEntry[]): { previousVersions: string[]; previousChangelogs: Record<string, string> } {
  return {
    previousVersions: history.map((h) => h.version),
    previousChangelogs: Object.fromEntries(history.filter((h) => h.changelog).map((h) => [h.version, h.changelog!])),
  };
}

/** The versions kept for an extension, most recently replaced first. */
export async function listHistory(kind: ExtensionKind, id: string): Promise<HistoryEntry[]> {
  if (!SAFE_ID_RE.test(id)) return [];
  return (await readAll(kind, id)).map(({ version, savedAt, contentHash, source, entry }) => ({
    version,
    savedAt,
    contentHash,
    ...(source ? { source } : {}),
    ...(typeof entry.changelog === 'string' ? { changelog: entry.changelog } : {}),
  }));
}

/**
 * Keep the plugin that is about to be overwritten. Called by the registry
 * inside its write lock, with the entry and code currently installed.
 */
export async function snapshotPlugin(current: ServerPlugin, code: string): Promise<void> {
  const dir = `${historyRoot(current.id)}/${dirNameFor(current.version)}`;
  const stored: StoredEntry = {
    kind: 'plugin',
    version: current.version,
    savedAt: new Date().toISOString(),
    contentHash: hashOf([code]),
    ...(current.source ? { source: current.source } : {}),
    entry: current,
  };
  const docs = docsOf('plugin');
  await docs.put(`${dir}/bundle.js`, code);
  await docs.put(`${dir}/entry.json`, JSON.stringify(stored, null, 2));
  await prune('plugin', current.id);
}

/** Same for a theme: its registry entry, CSS and skin. */
export async function snapshotTheme(current: ServerTheme, css: string, skin: string | null): Promise<void> {
  const dir = `${historyRoot(current.id)}/${dirNameFor(current.version)}`;
  const stored: StoredEntry = {
    kind: 'theme',
    version: current.version,
    savedAt: new Date().toISOString(),
    contentHash: hashOf([css, skin]),
    ...(current.source ? { source: current.source } : {}),
    entry: current,
  };
  const docs = docsOf('theme');
  await docs.put(`${dir}/theme.css`, css);
  if (skin !== null) await docs.put(`${dir}/skin.css`, skin);
  else await docs.delete(`${dir}/skin.css`);
  await docs.put(`${dir}/entry.json`, JSON.stringify(stored, null, 2));
  await prune('theme', current.id);
}

/**
 * Drop the kept copy of one version. The registry calls this for the version
 * being installed: the live copy is the authoritative one now, and a
 * rollback should not offer what is already installed. (A re-install of the
 * same version with other bytes keeps the old bytes: the registry snapshots
 * after forgetting.)
 */
export async function forgetVersion(kind: ExtensionKind, id: string, version: string): Promise<void> {
  if (!SAFE_ID_RE.test(id)) return;
  for (const kept of await readAll(kind, id)) {
    if (kept.version === version) await removeFolder(kind, kept.dir);
  }
}

/** Forget every kept version of an extension (on uninstall). */
export async function purgeHistory(kind: ExtensionKind, id: string): Promise<void> {
  if (!SAFE_ID_RE.test(id)) return;
  try {
    await removeFolder(kind, historyRoot(id));
  } catch (err) {
    logger.warn('[extension-history] could not remove history', { kind, id, error: err instanceof Error ? err.message : String(err) });
  }
}

export class HistoryError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message);
    this.name = 'HistoryError';
  }
}

async function find(kind: ExtensionKind, id: string, version: string) {
  const match = (await readAll(kind, id)).find((e) => e.version === version);
  if (!match) throw new HistoryError(`No kept copy of ${id} ${version} on this server`, 404);
  return match;
}

export interface RestoredPlugin { kind: 'plugin'; entry: ServerPlugin; code: string }
export interface RestoredTheme { kind: 'theme'; entry: ServerTheme; css: string; skin: string | null }

/**
 * Read a kept version back, checking it is the one that was saved. The
 * caller installs it through the registry so it is signed and hashed like a
 * fresh install; `enabled`/`forceEnabled` are taken from what is installed
 * now, since a rollback is about the code, not about who sees it.
 */
export type Restored<K extends ExtensionKind> = K extends 'plugin' ? RestoredPlugin : RestoredTheme;

export async function readHistoryEntry<K extends ExtensionKind>(kind: K, id: string, version: string): Promise<Restored<K>> {
  const stored = await find(kind, id, version);
  const damaged = () => new HistoryError(`The kept copy of ${id} ${version} does not match what was saved; it was not restored`, 409);
  if (kind === 'plugin') {
    const code = await readText(kind, `${stored.dir}/bundle.js`);
    if (code === null || hashOf([code]) !== stored.contentHash) throw damaged();
    const restored: RestoredPlugin = { kind: 'plugin', entry: stored.entry as ServerPlugin, code };
    return restored as Restored<K>;
  }
  const css = await readText(kind, `${stored.dir}/theme.css`);
  const skin = await readText(kind, `${stored.dir}/skin.css`);
  if (css === null || hashOf([css, skin]) !== stored.contentHash) throw damaged();
  const restored: RestoredTheme = { kind: 'theme', entry: stored.entry as ServerTheme, css, skin };
  return restored as Restored<K>;
}
