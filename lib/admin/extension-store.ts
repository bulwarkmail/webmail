import path from 'node:path';
import { getStore, type CollectionOptions, type DocCollection } from '@/lib/shared-store';
import { ADMIN_STATE_COLLECTION } from './admin-store';
import { getConfigDir, getStateDir } from './paths';

/**
 * Where plugins, themes, their history and config, plugin approvals,
 * directory keyrings and branding uploads live (#1066). Local mode: the
 * files of 1.19, byte for byte (same dirs, names and modes). Shared mode:
 * the shared store under the same ids; collections marked configDir come
 * from the mounted files when ADMIN_CONFIG_READONLY is set.
 */

const fixedTmpName = (target: string) => `${target}.tmp`;

/**
 * C/plugins: `registry.json`, `<id>.js`, `<id>.sig`, and
 * `history/<id>/<version>/{entry.json,bundle.js}` (extension-history.ts).
 */
export const PLUGINS_COLLECTION = 'plugins';
export const pluginsOptions: CollectionOptions = {
  local: { dir: () => path.join(getConfigDir(), 'plugins') },
  configDir: true,
};

/**
 * C/themes: `registry.json`, `<id>.css`, `<id>.skin.css`, and
 * `history/<id>/<version>/{entry.json,theme.css,skin.css}`.
 */
export const THEMES_COLLECTION = 'themes';
export const themesOptions: CollectionOptions = {
  local: { dir: () => path.join(getConfigDir(), 'themes') },
  configDir: true,
};

/** C/plugin-config/<plugin id>.json, written through `<file>.tmp` as before. */
export const PLUGIN_CONFIG_COLLECTION = 'plugin-config';
export const pluginConfigOptions: CollectionOptions = {
  local: { dir: () => path.join(getConfigDir(), 'plugin-config'), tmpName: fixedTmpName },
  configDir: true,
};

/**
 * C/plugin-approvals.json and the packages users sent along,
 * C/plugin-approvals/<plugin id>-<hash>.zip. Ids are paths under C.
 */
export const PLUGIN_APPROVALS_COLLECTION = 'plugin-approvals';
export const pluginApprovalsOptions: CollectionOptions = {
  local: { dir: () => getConfigDir(), tmpName: fixedTmpName },
  configDir: true,
};

/** C/branding/<slot>.<ext> and the per-domain uploads. */
export const BRANDING_COLLECTION = 'branding';
export const brandingOptions: CollectionOptions = {
  local: { dir: () => path.join(getConfigDir(), 'branding') },
  configDir: true,
};

/**
 * S/directory-keyrings.json: part of the admin state collection in the
 * shared store, owner-only on disk as before.
 */
export const DIRECTORY_KEYRINGS_ID = 'directory-keyrings.json';
export const directoryKeyringsOptions: CollectionOptions = {
  local: { dir: () => getStateDir(), mode: 0o600 },
};

export function pluginDocs(): DocCollection {
  return getStore().collection(PLUGINS_COLLECTION, pluginsOptions);
}

export function themeDocs(): DocCollection {
  return getStore().collection(THEMES_COLLECTION, themesOptions);
}

export function pluginConfigDocs(): DocCollection {
  return getStore().collection(PLUGIN_CONFIG_COLLECTION, pluginConfigOptions);
}

export function pluginApprovalDocs(): DocCollection {
  return getStore().collection(PLUGIN_APPROVALS_COLLECTION, pluginApprovalsOptions);
}

export function brandingDocs(): DocCollection {
  return getStore().collection(BRANDING_COLLECTION, brandingOptions);
}

export function directoryKeyringDocs(): DocCollection {
  return getStore().collection(ADMIN_STATE_COLLECTION, directoryKeyringsOptions);
}
