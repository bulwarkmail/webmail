import { NextRequest, NextResponse } from 'next/server';
import { canSeeInstanceDetails } from '@/lib/auth/instance-details';
import { getPluginRegistry, getThemeRegistry } from '@/lib/admin/plugin-registry';
import { listDevPlugins } from '@/lib/admin/plugin-dev';
import { configManager } from '@/lib/admin/config-manager';
import { logger } from '@/lib/logger';
import { storeUnavailableResponse } from '@/lib/admin/store-unavailable-response';
import { isNoThirdPartyTrafficOn } from '@/lib/admin/third-party-mode';
import { pluginAllowedInMode } from '@/lib/outgoing-hosts';

/**
 * GET /api/plugins - Public endpoint for clients to discover server-managed plugins & themes
 *
 * Returns all enabled plugins and themes so the client can sync them to IndexedDB.
 * No admin auth required - this is how regular users receive plugins/themes -
 * but a session is: the list names the plugins and the hosts they may reach,
 * and the client only syncs after signing in.
 */
export async function GET(request: NextRequest) {
  if (!(await canSeeInstanceDetails(request))) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  try {
    await configManager.ensureLoaded();
    const policy = configManager.getPolicy();
    const policyForceEnabledIds = new Set(policy.forceEnabledPlugins || []);

    const [pluginRegistry, themeRegistry, devEntries] = await Promise.all([
      getPluginRegistry(),
      getThemeRegistry(),
      listDevPlugins(),
    ]);

    // Dev plugins win on id collision so a developer can shadow an installed
    // plugin without uninstalling it first.
    const devIds = new Set(devEntries.map(e => e.plugin.id));
    const installedEnabled = pluginRegistry.plugins.filter(p => p.enabled && !devIds.has(p.id));
    // Plugins that declare network access never reach a browser while the
    // server must stay off outside hosts (#903); the rest run as usual, and
    // so do those that reach only servers the admin entered for them.
    const noThirdParty = await isNoThirdPartyTrafficOn();

    const plugins = [
      ...devEntries.map(e => ({ ...e.plugin, dev: true })),
      ...installedEnabled.map(p => ({ ...p, dev: false })),
    ].filter(p => !noThirdParty || pluginAllowedInMode(p)).map(p => ({
      id: p.id,
      name: p.name,
      version: p.version,
      author: p.author,
      description: p.description,
      type: p.type,
      // Requested execution tier; clients gate the same-origin privileged
      // sandbox on this (plus signature + approval + consent).
      tier: p.tier,
      permissions: p.permissions,
      entrypoint: p.entrypoint,
      // Policy is the canonical source for force-enable. The per-plugin field
      // can drift for dev plugins (manifest always loads forceEnabled:false)
      // and during pending policy saves; OR'ing here unifies the signal so
      // the client's auto-enable path triggers consistently.
      forceEnabled: p.forceEnabled || policyForceEnabledIds.has(p.id),
      // Content hash + updatedAt let clients detect re-uploads even when
      // the manifest version is unchanged.
      bundleHash: p.bundleHash,
      updatedAt: p.updatedAt,
      // Marks plugins loaded from PLUGIN_DEV_DIR. Surface in UI as a badge.
      dev: p.dev,
      // Surface so clients can enforce api.http.fetch origin allowlists.
      httpOrigins: p.httpOrigins,
      // Surface so clients can enforce api.http.post path allowlists.
      apiPostPaths: p.apiPostPaths,
      // Which credentials the plugin may use through the proxy; no secrets.
      credentials: p.credentials,
      // Per-user settings schema, captured from the manifest at upload/load
      // time so the client can render the settings UI without re-parsing.
      settingsSchema: p.settingsSchema,
      // Plugin-declared i18n tables, so the sandbox can localize plugin
      // strings via api.i18n.t().
      locales: p.locales,
    }));

    // Only serve enabled themes
    const themes = themeRegistry.themes
      .filter(t => t.enabled)
      .map(t => ({
        id: t.id,
        name: t.name,
        version: t.version,
        author: t.author,
        description: t.description,
        variants: t.variants,
        forceEnabled: t.forceEnabled || false,
        hasSkin: t.hasSkin || false,
        contentHash: t.contentHash,
      }));

    return NextResponse.json(
      { plugins, themes },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const unavailable = storeUnavailableResponse(error);
    if (unavailable) return unavailable;
    logger.error('Plugin list error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
