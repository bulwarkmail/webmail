import path from 'node:path';
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import type { ImportStep } from '../import';
import type { ExportStep } from '../export';
import { getStore, type CollectionOptions } from '../index';
import { localCollection } from '../local';
import {
  BRANDING_COLLECTION,
  DIRECTORY_KEYRINGS_ID,
  PLUGIN_APPROVALS_COLLECTION,
  PLUGIN_CONFIG_COLLECTION,
  PLUGINS_COLLECTION,
  THEMES_COLLECTION,
  brandingOptions,
  directoryKeyringsOptions,
  pluginApprovalsOptions,
  pluginConfigOptions,
  pluginsOptions,
  themesOptions,
} from '@/lib/admin/extension-store';
import { ADMIN_STATE_COLLECTION } from '@/lib/admin/admin-store';
import { SHARED_KEY_NAME } from '@/lib/admin/plugin-signing';
import { ensureConfigDir, getConfigDir, getConfigPath, isConfigReadOnly } from '@/lib/admin/paths';

/**
 * Part `ext` of the import (#1066): installed plugins and themes (registry,
 * bundles, signatures, CSS, kept history), plugin config, plugin approvals
 * and the packages sent with them, the plugin signing key, the directory
 * keyring dates and the branding uploads of a single-instance install.
 * Reads the local files as local mode does and writes only what the shared
 * store doesn't hold yet. With ADMIN_CONFIG_READONLY the config-dir
 * collections are the mounted files on every replica, so nothing of them is
 * copied (the put finds the file already there).
 */

interface Part {
  name: string;
  options: CollectionOptions;
  /** The ids of this part on disk. */
  localIds(): Promise<string[]>;
  /** The ids of this part in the shared store. */
  sharedIds(): Promise<string[]>;
}

/** A collection with a folder of its own: every file in it. */
function folderPart(name: string, options: CollectionOptions, only: (id: string) => boolean = () => true): Part {
  return {
    name,
    options,
    localIds: async () => (await localCollection(name, options).list()).filter(only),
    sharedIds: async () => (await getStore().collection(name, options).list()).filter(only),
  };
}

const APPROVALS_FILE = 'plugin-approvals.json';
const isApprovalId = (id: string) => id === APPROVALS_FILE || /^plugin-approvals\/[^/]+\.zip$/.test(id);

/**
 * plugin-approvals.json and plugin-approvals/<id>-<hash>.zip live in C
 * itself, so only those two places are read: a folder elsewhere in C that
 * can't be read must not fail the import.
 */
const approvalsPart: Part = {
  name: PLUGIN_APPROVALS_COLLECTION,
  options: pluginApprovalsOptions,
  async localIds() {
    const ids: string[] = [];
    if (await localCollection(PLUGIN_APPROVALS_COLLECTION, pluginApprovalsOptions).get(APPROVALS_FILE)) ids.push(APPROVALS_FILE);
    let names: string[] = [];
    try {
      names = await readdir(path.join(getConfigDir(), 'plugin-approvals'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const name of names.sort()) if (isApprovalId(`plugin-approvals/${name}`)) ids.push(`plugin-approvals/${name}`);
    return ids;
  },
  sharedIds: async () => (await getStore().collection(PLUGIN_APPROVALS_COLLECTION, pluginApprovalsOptions).list('plugin-approvals')).filter(isApprovalId),
};

const PARTS: Part[] = [
  folderPart(PLUGINS_COLLECTION, pluginsOptions),
  folderPart(THEMES_COLLECTION, themesOptions),
  folderPart(PLUGIN_CONFIG_COLLECTION, pluginConfigOptions, (id) => id.endsWith('.json') && !id.includes('/')),
  approvalsPart,
  folderPart(BRANDING_COLLECTION, brandingOptions, (id) => !id.includes('/')),
];

function importPart(part: Part): ImportStep {
  return {
    name: part.name,
    async run() {
      const local = localCollection(part.name, part.options);
      const shared = getStore().collection(part.name, part.options);
      let written = 0;
      for (const id of await part.localIds()) {
        const doc = await local.get(id);
        if (!doc) continue;
        if ((await shared.put(id, doc.data, { ifVersion: null })).ok) written++;
      }
      return written;
    },
  };
}

export const steps: ImportStep[] = [
  ...PARTS.map(importPart),
  {
    name: 'directory-keyrings',
    async run() {
      const doc = await localCollection(ADMIN_STATE_COLLECTION, directoryKeyringsOptions).get(DIRECTORY_KEYRINGS_ID);
      if (!doc) return 0;
      const shared = getStore().collection(ADMIN_STATE_COLLECTION, directoryKeyringsOptions);
      return (await shared.put(DIRECTORY_KEYRINGS_ID, doc.data, { ifVersion: null })).ok ? 1 : 0;
    },
  },
  {
    // The generated key in C/plugin-signing.key, so bundles signed before
    // the move keep verifying. PLUGIN_SIGNING_KEY_FILE, when set, still wins
    // over the stored key on every replica.
    name: 'plugin-signing-key',
    async run() {
      let pem: string;
      try {
        pem = await readFile(getConfigPath('plugin-signing.key'), 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
      }
      if (!pem.includes('-----BEGIN PRIVATE KEY-----')) return 0;
      return (await getStore().kv.set(SHARED_KEY_NAME, pem, { ifAbsent: true })) ? 1 : 0;
    },
  },
];

/**
 * The way back for one part: the local files become what the store holds.
 * Files of this part the store doesn't hold are removed first (an
 * uninstalled plugin's config, which may hold secrets, a stale signature,
 * pruned history, packages of requests long gone), then every document is
 * written, the registry last so it never points at a file not written yet.
 */
function exportPart(part: Part): ExportStep {
  return {
    name: part.name,
    async run() {
      // Read-only config is the mounted files on every replica already.
      if (isConfigReadOnly()) return 0;
      const shared = getStore().collection(part.name, part.options);
      const local = localCollection(part.name, part.options);
      const held = await part.sharedIds();
      const keep = new Set(held);
      for (const id of await part.localIds()) if (!keep.has(id)) await local.delete(id);
      const ordered = [...held.filter((id) => id !== 'registry.json'), ...held.filter((id) => id === 'registry.json')];
      let written = 0;
      for (const id of ordered) {
        const doc = await shared.get(id);
        if (!doc) continue;
        await local.put(id, doc.data);
        written++;
      }
      return written;
    },
  };
}

/**
 * The way back (SHARED_STORE_EXPORT, lib/shared-store/export.ts): the same
 * items from the store into the local layout. Run after the admin-state
 * export, so directory-keyrings.json ends up owner-only as local mode
 * writes it. The stored signing key replaces a key file on the volume, as
 * every other file of the same name is replaced: the exported signatures
 * were made with it.
 */
export const exportSteps: ExportStep[] = [
  ...PARTS.map(exportPart),
  {
    name: 'directory-keyrings',
    async run() {
      const doc = await getStore().collection(ADMIN_STATE_COLLECTION, directoryKeyringsOptions).get(DIRECTORY_KEYRINGS_ID);
      if (!doc) return 0;
      await localCollection(ADMIN_STATE_COLLECTION, directoryKeyringsOptions).put(DIRECTORY_KEYRINGS_ID, doc.data);
      return 1;
    },
  },
  {
    name: 'plugin-signing-key',
    async run() {
      if (isConfigReadOnly()) return 0;
      const pem = await getStore().kv.get(SHARED_KEY_NAME);
      if (!pem) return 0;
      await ensureConfigDir();
      const file = getConfigPath('plugin-signing.key');
      await writeFile(file, pem, { encoding: 'utf-8', mode: 0o600 });
      await chmod(file, 0o600).catch(() => {});
      return 1;
    },
  },
];
