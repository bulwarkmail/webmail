import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import { HistoryError, readHistoryEntry } from '@/lib/admin/extension-history';
import { getPlugin, getTheme, savePlugin, saveTheme } from '@/lib/admin/plugin-registry';
import { invalidateFrameOriginsCache } from '@/lib/admin/csp-frame-origins';
import { configReadOnlyResponse } from '@/lib/admin/config-read-only-response';
import { EXTENSION_ID_RE } from '@/lib/extension-package';
import { devicePolicyPluginRefusal } from '@/lib/desktop/server-policy';

/**
 * POST /api/admin/extensions/[kind]/[id]/rollback
 * Body: { version: string }
 *
 * Puts a previously installed version back from the server's own copy
 * (lib/admin/extension-history.ts). The directory is not involved, so this
 * works offline and for versions the directory has since withdrawn. The
 * extension keeps whether it is enabled or forced; only the code and the
 * manifest-derived fields go back to what that version had.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;

    const ip = getClientIP(request);
    const { kind, id } = await params;
    if (kind !== 'plugin' && kind !== 'theme') {
      return NextResponse.json({ error: 'Unknown extension kind' }, { status: 400 });
    }
    if (!EXTENSION_ID_RE.test(id)) return NextResponse.json({ error: 'Invalid extension id' }, { status: 400 });
    if (kind === 'plugin') {
      const refused = devicePolicyPluginRefusal(id);
      if (refused) return refused;
    }

    const body = await request.json().catch(() => ({}));
    const version = typeof body?.version === 'string' ? body.version.trim() : '';
    if (!version || version.length > 64) {
      return NextResponse.json({ error: 'Missing version' }, { status: 400 });
    }

    const now = new Date().toISOString();

    if (kind === 'plugin') {
      const current = await getPlugin(id);
      if (!current) return NextResponse.json({ error: 'Plugin not found' }, { status: 404 });
      if (current.version === version) {
        return NextResponse.json({ error: `Version ${version} is already installed` }, { status: 409 });
      }
      const kept = await readHistoryEntry('plugin', id, version);
      const plugin = {
        ...kept.entry,
        id,
        enabled: current.enabled,
        ...(current.forceEnabled !== undefined ? { forceEnabled: current.forceEnabled } : {}),
        defaultOff: current.defaultOff === true ? true : undefined,
        installedAt: current.installedAt,
        updatedAt: now,
      };
      await savePlugin(plugin, kept.code);
      invalidateFrameOriginsCache();
      await auditLog('plugin.rollback', { id, from: current.version, to: version }, ip);
      const saved = await getPlugin(id);
      return NextResponse.json({ success: true, plugin: saved ?? plugin });
    }

    const current = await getTheme(id);
    if (!current) return NextResponse.json({ error: 'Theme not found' }, { status: 404 });
    if (current.version === version) {
      return NextResponse.json({ error: `Version ${version} is already installed` }, { status: 409 });
    }
    const kept = await readHistoryEntry('theme', id, version);
    const theme = {
      ...kept.entry,
      id,
      enabled: current.enabled,
      ...(current.forceEnabled !== undefined ? { forceEnabled: current.forceEnabled } : {}),
      installedAt: current.installedAt,
      updatedAt: now,
    };
    await saveTheme(theme, kept.css, kept.skin);
    await auditLog('theme.rollback', { id, from: current.version, to: version }, ip);
    const saved = await getTheme(id);
    return NextResponse.json({ success: true, theme: saved ?? theme });
  } catch (error) {
    if (error instanceof HistoryError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const readOnly = configReadOnlyResponse(error);
    if (readOnly) return readOnly;
    logger.error('Extension rollback error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Rollback failed' }, { status: 500 });
  }
}
