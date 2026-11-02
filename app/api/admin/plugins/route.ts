import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import { storeUnavailableResponse } from '@/lib/admin/store-unavailable-response';
import {
  getPlugin,
  getPluginRegistry,
  savePlugin,
  deletePlugin as removePlugin,
  type ServerPlugin,
} from '@/lib/admin/plugin-registry';
import { listDevPlugins } from '@/lib/admin/plugin-dev';
import { invalidateFrameOriginsCache } from '@/lib/admin/csp-frame-origins';
import { cleanUpDeletedPlugin } from '@/lib/admin/extension-cleanup';
import { keptVersions, listHistory } from '@/lib/admin/extension-history';
import { ExtensionPackageError, readPluginPackage, suspiciousCode } from '@/lib/extension-package';
import { MAX_PLUGIN_SIZE } from '@/lib/plugin-types';
import { configReadOnlyResponse } from '@/lib/admin/config-read-only-response';

/**
 * GET /api/admin/plugins - List all admin-managed plugins
 */
export async function GET(request: NextRequest) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;

    const [registry, devEntries] = await Promise.all([
      getPluginRegistry(),
      listDevPlugins(),
    ]);

    // Dev plugins win on id collision so admins see what users actually load.
    const devIds = new Set(devEntries.map(e => e.plugin.id));
    const merged = [
      ...devEntries.map(e => ({ ...e.plugin, dev: true as const, ...keptVersions([]) })),
      ...(await Promise.all(registry.plugins
        .filter(p => !devIds.has(p.id))
        .map(async p => ({
          ...p,
          dev: false as const,
          ...keptVersions(await listHistory('plugin', p.id).catch(() => [])),
        })))),
    ];
    return NextResponse.json(merged, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const unavailable = storeUnavailableResponse(error);
    if (unavailable) return unavailable;
    logger.error('Plugin list error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/admin/plugins - Upload and install a plugin ZIP
 */
export async function POST(request: NextRequest) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;

    const ip = getClientIP(request);
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'Missing file' }, { status: 400 });
    }

    if (file.size > MAX_PLUGIN_SIZE) {
      return NextResponse.json({ error: 'Plugin ZIP exceeds 5 MB size limit' }, { status: 400 });
    }

    let pkg;
    try {
      pkg = await readPluginPackage(await file.arrayBuffer(), {
        appVersion: process.env.NEXT_PUBLIC_APP_VERSION,
      });
    } catch (err) {
      if (err instanceof ExtensionPackageError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
    const { manifest, code } = pkg;

    // Admin uploads reach every user, so the patterns a user upload only
    // warns about are refused here.
    const suspicious = suspiciousCode(code);
    if (suspicious.length > 0) {
      return NextResponse.json(
        { error: `Plugin rejected: contains ${suspicious.join(', ')}. These patterns are not allowed for security reasons.` },
        { status: 400 },
      );
    }

    // A new upload of an installed plugin is an update: keep whether the
    // admin had it enabled or forced instead of switching it on for everyone.
    const existing = await getPlugin(manifest.id);
    const now = new Date().toISOString();
    const plugin: ServerPlugin = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      author: manifest.author,
      description: manifest.description,
      type: manifest.type,
      ...(manifest.tier === 'privileged' ? { tier: 'privileged' } : {}),
      permissions: manifest.permissions,
      entrypoint: manifest.entrypoint,
      enabled: existing?.enabled ?? true,
      ...(existing?.forceEnabled !== undefined ? { forceEnabled: existing.forceEnabled } : {}),
      ...(manifest.configSchema ? { configSchema: manifest.configSchema } : {}),
      ...(manifest.settingsSchema ? { settingsSchema: manifest.settingsSchema } : {}),
      ...(manifest.locales ? { locales: manifest.locales } : {}),
      ...(manifest.frameOrigins ? { frameOrigins: manifest.frameOrigins } : {}),
      ...(manifest.httpOrigins ? { httpOrigins: manifest.httpOrigins } : {}),
      ...(manifest.apiPostPaths ? { apiPostPaths: manifest.apiPostPaths } : {}),
      ...(manifest.credentials ? { credentials: manifest.credentials } : {}),
      installedAt: now,
      updatedAt: now,
      source: { kind: 'upload' },
    };
    const declaredFrameOrigins = plugin.frameOrigins ?? [];
    const declaredHttpOrigins = plugin.httpOrigins ?? [];
    const declaredApiPostPaths = plugin.apiPostPaths ?? [];

    await savePlugin(plugin, code);
    invalidateFrameOriginsCache();
    await auditLog('plugin.install', { id: plugin.id, name: plugin.name, version: plugin.version, frameOrigins: declaredFrameOrigins, httpOrigins: declaredHttpOrigins, apiPostPaths: declaredApiPostPaths }, ip);

    return NextResponse.json({ plugin, warnings: pkg.warnings });
  } catch (error) {
    const readOnly = configReadOnlyResponse(error);
    if (readOnly) return readOnly;
    logger.error('Plugin install error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/plugins - Update plugin metadata (enable/disable)
 * Body: { id: string, enabled: boolean }
 */
export async function PATCH(request: NextRequest) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;

    const ip = getClientIP(request);
    const { id, enabled, forceEnabled } = await request.json();

    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'Missing plugin id' }, { status: 400 });
    }
    if (typeof enabled !== 'boolean' && typeof forceEnabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled or forceEnabled must be a boolean' }, { status: 400 });
    }

    const updates: { enabled?: boolean; forceEnabled?: boolean } = {};
    if (typeof enabled === 'boolean') updates.enabled = enabled;
    if (typeof forceEnabled === 'boolean') updates.forceEnabled = forceEnabled;

    const { updatePluginMeta } = await import('@/lib/admin/plugin-registry');
    let updated = await updatePluginMeta(id, updates);
    if (!updated) {
      // Dev plugins (PLUGIN_DEV_DIR) aren't in the persisted registry, but
      // forceEnabled is canonical-stored in policy.forceEnabledPlugins on the
      // client. Skip the registry write and return the live dev plugin so the
      // policy save path can proceed.
      const devEntries = await listDevPlugins();
      const devEntry = devEntries.find(e => e.plugin.id === id);
      if (!devEntry) {
        return NextResponse.json({ error: 'Plugin not found' }, { status: 404 });
      }
      updated = { ...devEntry.plugin, ...updates };
    }

    // Enable/disable changes the set of plugins contributing frame origins.
    if (typeof updates.enabled === 'boolean' || typeof updates.forceEnabled === 'boolean') {
      invalidateFrameOriginsCache();
    }

    await auditLog('plugin.update', { id, ...updates }, ip);
    return NextResponse.json({ plugin: updated });
  } catch (error) {
    const readOnly = configReadOnlyResponse(error);
    if (readOnly) return readOnly;
    logger.error('Plugin update error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/plugins - Remove a plugin
 * Body: { id: string }
 */
export async function DELETE(request: NextRequest) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;

    const ip = getClientIP(request);
    const { id } = await request.json();

    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'Missing plugin id' }, { status: 400 });
    }

    const removed = await removePlugin(id);
    if (!removed) {
      return NextResponse.json({ error: 'Plugin not found' }, { status: 404 });
    }
    await cleanUpDeletedPlugin(id);

    invalidateFrameOriginsCache();
    await auditLog('plugin.delete', { id }, ip);
    return NextResponse.json({ success: true });
  } catch (error) {
    const readOnly = configReadOnlyResponse(error);
    if (readOnly) return readOnly;
    logger.error('Plugin delete error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
