import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import {
  getPluginRegistry,
  savePlugin,
  deletePlugin as removePlugin,
  type ServerPlugin,
} from '@/lib/admin/plugin-registry';
import {
  sanitizeFrameOrigins,
  invalidateFrameOriginsCache,
} from '@/lib/admin/csp-frame-origins';

// Server-side extraction using the same validation logic
// ZIP parsing needs to happen on the server for admin-uploaded plugins
import JSZip from 'jszip';
import { MAX_PLUGIN_SIZE, ALL_PERMISSIONS, ALLOWED_PLUGIN_FILES } from '@/lib/plugin-types';

const SUSPICIOUS_JS_PATTERNS = [
  { pattern: /\beval\s*\(/g, label: 'eval()' },
  { pattern: /\bnew\s+Function\s*\(/g, label: 'new Function()' },
  { pattern: /document\.cookie/g, label: 'document.cookie' },
  { pattern: /document\.write/g, label: 'document.write' },
  { pattern: /innerHTML\s*=/g, label: 'innerHTML assignment' },
];

/**
 * GET /api/admin/plugins - List all admin-managed plugins
 */
export async function GET() {
  try {
    const result = await requireAdminAuth();
    if ('error' in result) return result.error;

    const registry = await getPluginRegistry();
    return NextResponse.json(registry.plugins, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    logger.error('Plugin list error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/admin/plugins - Upload and install a plugin ZIP
 */
export async function POST(request: NextRequest) {
  try {
    const result = await requireAdminAuth();
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

    // Extract and validate ZIP
    let zip: JSZip;
    try {
      const buffer = await file.arrayBuffer();
      zip = await JSZip.loadAsync(buffer);
    } catch {
      return NextResponse.json({ error: 'Invalid ZIP file' }, { status: 400 });
    }

    // Find root
    const entries = Object.keys(zip.files);
    const topDirs = new Set(entries.map(e => e.split('/')[0]));
    let root = '';
    if (topDirs.size === 1) {
      const dir = [...topDirs][0];
      if (zip.files[dir + '/'] || entries.some(e => e.startsWith(dir + '/'))) {
        root = dir + '/';
      }
    }

    // Read manifest
    const manifestFile = zip.file(root + 'manifest.json');
    if (!manifestFile) {
      return NextResponse.json({ error: 'Missing manifest.json' }, { status: 400 });
    }

    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(await manifestFile.async('string'));
    } catch {
      return NextResponse.json({ error: 'Invalid manifest.json' }, { status: 400 });
    }

    // Validate manifest
    const errors: string[] = [];
    if (!manifest.id || typeof manifest.id !== 'string') errors.push('Missing or invalid "id"');
    if (!manifest.name || typeof manifest.name !== 'string') errors.push('Missing or invalid "name"');
    if (!manifest.version || typeof manifest.version !== 'string') errors.push('Missing or invalid "version"');
    if (!manifest.author || typeof manifest.author !== 'string') errors.push('Missing or invalid "author"');
    if (!manifest.entrypoint || typeof manifest.entrypoint !== 'string') errors.push('Missing or invalid "entrypoint"');

    const validTypes = ['ui-extension', 'sidebar-app', 'hook'];
    if (!validTypes.includes(manifest.type as string)) {
      errors.push(`Invalid type. Must be one of: ${validTypes.join(', ')}`);
    }

    if (manifest.id && typeof manifest.id === 'string' && !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(manifest.id)) {
      errors.push('ID must be lowercase alphanumeric with hyphens, min 2 chars');
    }

    if (manifest.permissions && Array.isArray(manifest.permissions)) {
      const validPerms = new Set(ALL_PERMISSIONS as readonly string[]);
      const unknown = (manifest.permissions as string[]).filter(p => !validPerms.has(p));
      if (unknown.length > 0) errors.push(`Unknown permissions: ${unknown.join(', ')}`);
    }

    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join('; ') }, { status: 400 });
    }

    // Check file extensions
    for (const [filePath, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const ext = filePath.lastIndexOf('.') >= 0 ? filePath.slice(filePath.lastIndexOf('.')).toLowerCase() : '';
      if (ext && !ALLOWED_PLUGIN_FILES.has(ext)) {
        errors.push(`Disallowed file type: ${filePath}`);
      }
    }
    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join('; ') }, { status: 400 });
    }

    // Read entrypoint code
    const entryFile = zip.file(root + (manifest.entrypoint as string));
    if (!entryFile) {
      return NextResponse.json({ error: `Missing entrypoint: ${manifest.entrypoint}` }, { status: 400 });
    }
    const code = await entryFile.async('string');

    // Security: block plugins containing dangerous JS patterns
    const warnings: string[] = [];
    for (const { pattern, label } of SUSPICIOUS_JS_PATTERNS) {
      if (pattern.test(code)) warnings.push(`Contains ${label}`);
      pattern.lastIndex = 0;
    }
    if (warnings.length > 0) {
      return NextResponse.json(
        { error: `Plugin rejected: ${warnings.join(', ')}. These patterns are not allowed for security reasons.` },
        { status: 400 },
      );
    }

    const declaredFrameOrigins = sanitizeFrameOrigins(manifest.frameOrigins);

    const now = new Date().toISOString();
    const plugin: ServerPlugin = {
      id: manifest.id as string,
      name: manifest.name as string,
      version: manifest.version as string,
      author: manifest.author as string,
      description: (manifest.description as string) || '',
      type: manifest.type as string,
      permissions: (manifest.permissions as string[]) || [],
      entrypoint: manifest.entrypoint as string,
      enabled: true,
      ...(manifest.configSchema && typeof manifest.configSchema === 'object'
        ? { configSchema: manifest.configSchema as ServerPlugin['configSchema'] }
        : {}),
      ...(declaredFrameOrigins.length > 0
        ? { frameOrigins: declaredFrameOrigins }
        : {}),
      installedAt: now,
      updatedAt: now,
    };

    await savePlugin(plugin, code);
    invalidateFrameOriginsCache();
    await auditLog('plugin.install', { id: plugin.id, name: plugin.name, version: plugin.version, frameOrigins: declaredFrameOrigins }, ip);

    return NextResponse.json({ plugin });
  } catch (error) {
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
    const result = await requireAdminAuth();
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
    const updated = await updatePluginMeta(id, updates);
    if (!updated) {
      return NextResponse.json({ error: 'Plugin not found' }, { status: 404 });
    }

    // Enable/disable changes the set of plugins contributing frame origins.
    if (typeof updates.enabled === 'boolean' || typeof updates.forceEnabled === 'boolean') {
      invalidateFrameOriginsCache();
    }

    await auditLog('plugin.update', { id, ...updates }, ip);
    return NextResponse.json({ plugin: updated });
  } catch (error) {
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
    const result = await requireAdminAuth();
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

    invalidateFrameOriginsCache();
    await auditLog('plugin.delete', { id }, ip);
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Plugin delete error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
