import { logger } from '@/lib/logger';
import { isSharedMode } from '@/lib/shared-store';
import { assertWritable } from './paths';
import { isStoreUnavailable } from './admin-store';
import { pluginConfigDocs } from './extension-store';

/**
 * Admin config of each plugin (C/plugin-config/<id>.json, or the shared
 * store in shared mode, #1066). Changes go through update(), so two admins
 * setting different keys at once both keep theirs, on one instance or
 * several.
 */

const fileOf = (pluginId: string) => `${pluginId}.json`;

/** Shared mode: the last config read per plugin, served while the store is down. */
const LAST_GOOD_KEY = Symbol.for('bulwark.admin.pluginConfig.lastGood');
function lastGood(): Map<string, string> {
  const g = globalThis as typeof globalThis & { [LAST_GOOD_KEY]?: Map<string, string> };
  return (g[LAST_GOOD_KEY] ??= new Map());
}

function parseConfig(pluginId: string, data: Buffer | null): Record<string, unknown> {
  if (!data) return {};
  try {
    return JSON.parse(data.toString('utf-8'));
  } catch (error) {
    logger.warn(`Failed to read plugin config for ${pluginId}`, {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return {};
  }
}

/**
 * Get all config for a plugin.
 */
export async function getPluginConfig(pluginId: string): Promise<Record<string, unknown>> {
  let data: Buffer | null;
  try {
    data = (await pluginConfigDocs().get(fileOf(pluginId)))?.data ?? null;
  } catch (error) {
    if (isStoreUnavailable(error)) {
      const last = lastGood().get(pluginId);
      if (last !== undefined) return JSON.parse(last);
      throw error;
    }
    logger.warn(`Failed to read plugin config for ${pluginId}`, {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return {};
  }
  const config = parseConfig(pluginId, data);
  if (isSharedMode()) lastGood().set(pluginId, JSON.stringify(config));
  return config;
}

async function changeConfig(pluginId: string, change: (config: Record<string, unknown>) => void): Promise<void> {
  const result = await pluginConfigDocs().update(fileOf(pluginId), (current) => {
    const config = parseConfig(pluginId, current);
    change(config);
    // The last key gone: the file goes too.
    return Object.keys(config).length === 0 ? null : JSON.stringify(config, null, 2);
  });
  if (isSharedMode()) lastGood().set(pluginId, result.data ? result.data.toString('utf-8') : '{}');
}

/**
 * Set a single config key for a plugin.
 */
export async function setPluginConfig(pluginId: string, key: string, value: unknown): Promise<void> {
  assertWritable('update plugin config');
  await changeConfig(pluginId, (config) => {
    config[key] = value;
  });
}

/** Remove all stored config, secrets included, when a plugin is deleted. */
export async function deletePluginConfig(pluginId: string): Promise<void> {
  assertWritable('delete plugin config');
  try {
    await pluginConfigDocs().delete(fileOf(pluginId));
  } catch (error) {
    // None stored is fine; a store outage is not.
    if (isStoreUnavailable(error)) throw error;
  }
  lastGood().delete(pluginId);
}

/**
 * Delete a single config key for a plugin.
 */
export async function deletePluginConfigKey(pluginId: string, key: string): Promise<void> {
  assertWritable('delete plugin config key');
  await changeConfig(pluginId, (config) => {
    delete config[key];
  });
}
