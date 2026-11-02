import { configManager } from './config-manager';
import { deletePluginConfig } from './plugin-config';

/**
 * Drop a deleted plugin or theme from the policy lists that refer to it by
 * id. Left behind, a later upload that reuses the id would start out forced
 * on for everyone without the admin asking for it.
 */
export async function forgetExtensionInPolicy(kind: 'plugin' | 'theme', id: string): Promise<void> {
  await configManager.ensureLoaded();
  const key = kind === 'plugin' ? 'forceEnabledPlugins' : 'forceEnabledThemes';
  // Against the stored policy, so a policy save landing at the same time
  // keeps its changes.
  await configManager.updatePolicy((policy) => {
    const list = policy[key] ?? [];
    if (!list.includes(id)) return undefined;
    return { ...policy, [key]: list.filter((x) => x !== id) };
  });
}

/**
 * Everything the server keeps about an admin plugin besides its registry
 * entry: the forced flag and its config (which can hold secrets). A plugin
 * installed later under the same id starts clean.
 */
export async function cleanUpDeletedPlugin(id: string): Promise<void> {
  await forgetExtensionInPolicy('plugin', id);
  await deletePluginConfig(id);
}
