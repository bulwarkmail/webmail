import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/admin/session';
import { configManager } from '@/lib/admin/config-manager';
import { isConfigReadOnly } from '@/lib/admin/paths';
import { getPluginRegistry } from '@/lib/admin/plugin-registry';
import { noThirdPartyTrafficState } from '@/lib/admin/third-party-mode';
import { listReachableHosts } from '@/lib/admin/reachable-hosts';
import { pluginAllowedInMode, pluginDeclaresNetwork } from '@/lib/outgoing-hosts';
import { adminEnteredOrigins } from '@/lib/plugin-secrets/proxy';
import type { CredentialSpec } from '@/lib/plugin-secrets/credentials';
import { OUTGOING_HOSTS } from '@/lib/admin/outgoing-hosts-registry';
import { logger } from '@/lib/logger';

/**
 * GET /api/admin/outgoing-hosts - the "no third-party traffic" switch with
 * where its value comes from, the built-in outside hosts it turns off, the
 * admin-configured hosts that stay reachable, and the installed plugins it
 * refuses (#903). Organisation > Security renders this; the switch itself is
 * saved through PATCH /api/admin/config like every other config key.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdminAuth(request);
    if ('error' in auth) return auth.error;

    await configManager.ensureLoaded();
    const state = noThirdPartyTrafficState();
    const policy = configManager.getPolicy();
    const registry = await getPluginRegistry().catch(() => ({ plugins: [] }));
    const enabled = registry.plugins.filter((plugin) => plugin.enabled);
    // Plugins that run in the mode with the servers the admin entered for
    // them; their manifest-fixed servers (Google Safe Browsing) stay off.
    const modePlugins = enabled.filter((plugin) => pluginDeclaresNetwork(plugin) && pluginAllowedInMode(plugin));
    const pluginHosts = await Promise.all(modePlugins.map(async (plugin) => ({
      id: plugin.id,
      name: plugin.name,
      origins: await adminEnteredOrigins(plugin.id).catch(() => [] as string[]),
      fixed: [...new Set(Object.values((plugin as { credentials?: Record<string, CredentialSpec> }).credentials ?? {})
        .flatMap((spec) => (spec.origin ? [new URL(spec.origin).host] : [])))],
    })));

    return NextResponse.json(
      {
        noThirdPartyTraffic: state.on,
        source: state.source,
        // The panel can't turn it off when the environment pins it on, and
        // can't change it at all on a read-only config.
        readOnly: isConfigReadOnly(),
        envLocked: state.source === 'env',
        builtIn: OUTGOING_HOSTS,
        reachable: listReachableHosts({ get: (key) => configManager.get(key), policy, env: process.env, plugins: pluginHosts }),
        networkPlugins: enabled
          .filter((plugin) => pluginDeclaresNetwork(plugin) && !pluginAllowedInMode(plugin))
          .map((plugin) => ({ id: plugin.id, name: plugin.name })),
        partlyOffPlugins: pluginHosts
          .filter((plugin) => plugin.fixed.length > 0)
          .map(({ id, name, fixed }) => ({ id, name, hosts: fixed })),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    logger.error('Outgoing hosts read error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
