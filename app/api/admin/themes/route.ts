import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import {
  getThemeRegistry,
  saveTheme,
  deleteTheme as removeTheme,
  type ServerTheme,
} from '@/lib/admin/plugin-registry';

import JSZip from 'jszip';
import { MAX_THEME_SIZE } from '@/lib/plugin-types';
import { sanitizeThemeCSS, validateThemeCSSSafety } from '@/lib/theme-loader';

/**
 * GET /api/admin/themes - List all admin-managed themes
 */
export async function GET() {
  try {
    const result = await requireAdminAuth();
    if ('error' in result) return result.error;

    const registry = await getThemeRegistry();
    return NextResponse.json(registry.themes, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    logger.error('Theme list error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/admin/themes - Upload and install a theme ZIP
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

    if (file.size > MAX_THEME_SIZE) {
      return NextResponse.json({ error: 'Theme ZIP exceeds 1 MB size limit' }, { status: 400 });
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

    if (manifest.type !== 'theme') {
      errors.push(`Expected type "theme", got "${manifest.type}"`);
    }

    if (manifest.id && typeof manifest.id === 'string' && !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(manifest.id)) {
      errors.push('ID must be lowercase alphanumeric with hyphens, min 2 chars');
    }

    if (!manifest.variants || !Array.isArray(manifest.variants) || manifest.variants.length === 0) {
      errors.push('Missing or empty "variants" array');
    } else {
      const valid = manifest.variants.every((v: unknown) => v === 'light' || v === 'dark');
      if (!valid) errors.push('Variants must be "light" or "dark"');
    }

    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join('; ') }, { status: 400 });
    }

    // Read theme.css
    const cssFile = zip.file(root + 'theme.css');
    if (!cssFile) {
      return NextResponse.json({ error: 'Missing theme.css' }, { status: 400 });
    }

    let css = await cssFile.async('string');

    // Validate and sanitize CSS
    const warnings: string[] = [];
    const safety = validateThemeCSSSafety(css);
    if (!safety.valid) {
      const sanitized = sanitizeThemeCSS(css);
      css = sanitized.css;
      warnings.push(...sanitized.warnings);
    }

    const now = new Date().toISOString();
    const theme: ServerTheme = {
      id: manifest.id as string,
      name: manifest.name as string,
      version: manifest.version as string,
      author: manifest.author as string,
      description: (manifest.description as string) || '',
      variants: manifest.variants as string[],
      enabled: true,
      installedAt: now,
      updatedAt: now,
    };

    await saveTheme(theme, css);
    await auditLog('theme.install', { id: theme.id, name: theme.name, version: theme.version, warnings }, ip);

    return NextResponse.json({ theme, warnings });
  } catch (error) {
    logger.error('Theme install error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * PATCH /api/admin/themes - Update theme metadata (enable/disable)
 * Body: { id: string, enabled: boolean }
 */
export async function PATCH(request: NextRequest) {
  try {
    const result = await requireAdminAuth();
    if ('error' in result) return result.error;

    const ip = getClientIP(request);
    const { id, enabled, forceEnabled } = await request.json();

    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'Missing theme id' }, { status: 400 });
    }
    if (typeof enabled !== 'boolean' && typeof forceEnabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled or forceEnabled must be a boolean' }, { status: 400 });
    }

    const updates: { enabled?: boolean; forceEnabled?: boolean } = {};
    if (typeof enabled === 'boolean') updates.enabled = enabled;
    if (typeof forceEnabled === 'boolean') updates.forceEnabled = forceEnabled;

    const { updateThemeMeta } = await import('@/lib/admin/plugin-registry');
    const updated = await updateThemeMeta(id, updates);
    if (!updated) {
      return NextResponse.json({ error: 'Theme not found' }, { status: 404 });
    }

    await auditLog('theme.update', { id, ...updates }, ip);
    return NextResponse.json({ theme: updated });
  } catch (error) {
    logger.error('Theme update error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/themes - Remove a theme
 * Body: { id: string }
 */
export async function DELETE(request: NextRequest) {
  try {
    const result = await requireAdminAuth();
    if ('error' in result) return result.error;

    const ip = getClientIP(request);
    const { id } = await request.json();

    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: 'Missing theme id' }, { status: 400 });
    }

    const removed = await removeTheme(id);
    if (!removed) {
      return NextResponse.json({ error: 'Theme not found' }, { status: 404 });
    }

    await auditLog('theme.delete', { id }, ip);
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Theme delete error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
