import { getPlugin } from '@/lib/admin/plugin-registry';
import { listApprovals } from '@/lib/admin/plugin-approvals';
import type { CredentialSpec, UserCredentialSpec } from './credentials';

/**
 * The user-scope credential `credentialId` as the manifest of `pluginId`
 * declares it, when this server knows that manifest: an installed (registry)
 * plugin, or a user-uploaded package an admin approved.
 *
 * The connect dialog and the proxy used to take the plugin id at its word,
 * so any signed-in user could store a credential under a made-up plugin id
 * and relay requests through the server to any origin with it, and a
 * plugin could reach for a credential declared by none. A credential is
 * only ever for a plugin the server can name, and only on the server the
 * manifest fixes, when it fixes one.
 */
export async function declaredUserCredential(pluginId: string, credentialId: string): Promise<UserCredentialSpec | null> {
  return (await declaringPlugin(pluginId, credentialId))?.spec ?? null;
}

/** {@link declaredUserCredential} with the name of the plugin that declares it. */
export async function declaringPlugin(pluginId: string, credentialId: string): Promise<{ name: string; spec: UserCredentialSpec } | null> {
  const plugin = await getPlugin(pluginId);
  const fromRegistry = (plugin as { credentials?: Record<string, CredentialSpec> } | null)?.credentials?.[credentialId];
  if (plugin && plugin.enabled && fromRegistry?.scope === 'user') return { name: plugin.name, spec: fromRegistry };
  if (plugin) return null;
  for (const entry of await listApprovals()) {
    if (entry.pluginId !== pluginId || entry.status !== 'approved') continue;
    const spec = entry.manifest.credentials?.[credentialId];
    if (spec?.scope === 'user') return { name: entry.manifest.name ?? pluginId, spec };
  }
  return null;
}
