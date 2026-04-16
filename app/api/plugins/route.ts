import { NextResponse } from 'next/server';
import { getPluginRegistry, getThemeRegistry } from '@/lib/admin/plugin-registry';
import { logger } from '@/lib/logger';

/**
 * GET /api/plugins - Public endpoint for clients to discover server-managed plugins & themes
 *
 * Returns all enabled plugins and themes so the client can sync them to IndexedDB.
 * No admin auth required - this is how regular users receive plugins/themes.
 */
export async function GET() {
  try {
    const [pluginRegistry, themeRegistry] = await Promise.all([
      getPluginRegistry(),
      getThemeRegistry(),
    ]);

    // Only serve enabled plugins
    const plugins = pluginRegistry.plugins
      .filter(p => p.enabled)
      .map(p => ({
        id: p.id,
        name: p.name,
        version: p.version,
        author: p.author,
        description: p.description,
        type: p.type,
        permissions: p.permissions,
        entrypoint: p.entrypoint,
        forceEnabled: p.forceEnabled || false,
        settingsSchema: undefined, // Will be read from the bundle's manifest
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
      }));

    return NextResponse.json(
      { plugins, themes },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    logger.error('Plugin list error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
