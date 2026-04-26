import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import {
  savePlugin,
  saveTheme,
  getPluginRegistry,
  getThemeRegistry,
  type ServerPlugin,
  type ServerTheme,
} from '@/lib/admin/plugin-registry';
import {
  sanitizeFrameOrigins,
  invalidateFrameOriginsCache,
} from '@/lib/admin/csp-frame-origins';
import JSZip from 'jszip';
import { MAX_PLUGIN_SIZE, MAX_THEME_SIZE, ALL_PERMISSIONS, ALLOWED_PLUGIN_FILES } from '@/lib/plugin-types';
import { sanitizeThemeCSS, validateThemeCSSSafety } from '@/lib/theme-loader';

const DIRECTORY_URL = process.env.EXTENSION_DIRECTORY_URL || 'http://localhost:3001';

/**
 * GET /api/admin/marketplace - Search/browse the extension directory
 * Proxies to the extension directory API
 */
export async function GET(request: NextRequest) {
  try {
    const result = await requireAdminAuth();
    if ('error' in result) return result.error;

    const { searchParams } = request.nextUrl;
    const url = new URL('/api/v1/extensions', DIRECTORY_URL);

    // Forward all search params
    for (const [key, value] of searchParams.entries()) {
      url.searchParams.set(key, value);
    }

    const res = await fetch(url.toString(), {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: 'Failed to fetch from extension directory' },
        { status: 502 }
      );
    }

    const data = await res.json();

    // Enrich with install status
    const [pluginRegistry, themeRegistry] = await Promise.all([
      getPluginRegistry(),
      getThemeRegistry(),
    ]);

    const installedPlugins = new Set(pluginRegistry.plugins.map(p => p.id));
    const installedThemes = new Set(themeRegistry.themes.map(t => t.id));

    if (data.data) {
      data.data = data.data.map((ext: Record<string, unknown>) => ({
        ...ext,
        installed: ext.type === 'theme'
          ? installedThemes.has(ext.slug as string)
          : installedPlugins.has(ext.slug as string),
      }));
    }

    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    logger.error('Marketplace search error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Failed to connect to extension directory' }, { status: 502 });
  }
}

/**
 * POST /api/admin/marketplace - Install an extension from the directory
 * Body: { slug: string, version: string, type: 'plugin' | 'theme' }
 */
export async function POST(request: NextRequest) {
  try {
    const result = await requireAdminAuth();
    if ('error' in result) return result.error;

    const ip = getClientIP(request);
    const { slug, version, type } = await request.json();

    if (!slug || !version || !type) {
      return NextResponse.json({ error: 'Missing slug, version, or type' }, { status: 400 });
    }

    if (type !== 'plugin' && type !== 'theme') {
      return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
    }

    // Download the bundle from the directory
    const bundleUrl = new URL(`/api/v1/bundle/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`, DIRECTORY_URL);
    const bundleRes = await fetch(bundleUrl.toString(), {
      signal: AbortSignal.timeout(30000),
    });

    if (!bundleRes.ok) {
      return NextResponse.json(
        { error: `Failed to download bundle: ${bundleRes.status}` },
        { status: 502 }
      );
    }

    const buffer = await bundleRes.arrayBuffer();
    const maxSize = type === 'theme' ? MAX_THEME_SIZE : MAX_PLUGIN_SIZE;

    if (buffer.byteLength > maxSize) {
      return NextResponse.json(
        { error: `Bundle exceeds ${type === 'theme' ? '1 MB' : '5 MB'} size limit` },
        { status: 400 }
      );
    }

    // Parse the ZIP
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(buffer);
    } catch {
      return NextResponse.json({ error: 'Invalid ZIP file from directory' }, { status: 400 });
    }

    // Find root directory
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
      return NextResponse.json({ error: 'Bundle missing manifest.json' }, { status: 400 });
    }

    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(await manifestFile.async('string'));
    } catch {
      return NextResponse.json({ error: 'Invalid manifest.json in bundle' }, { status: 400 });
    }

    const now = new Date().toISOString();

    if (type === 'theme') {
      // Read theme.css
      const cssFile = zip.file(root + 'theme.css');
      if (!cssFile) {
        return NextResponse.json({ error: 'Theme bundle missing theme.css' }, { status: 400 });
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

      const theme: ServerTheme = {
        id: (manifest.id as string) || slug,
        name: (manifest.name as string) || slug,
        version: (manifest.version as string) || version,
        author: (manifest.author as string) || 'Unknown',
        description: (manifest.description as string) || '',
        variants: (manifest.variants as string[]) || ['light', 'dark'],
        enabled: true,
        installedAt: now,
        updatedAt: now,
      };

      await saveTheme(theme, css);
      await auditLog('marketplace.install_theme', { id: theme.id, name: theme.name, version: theme.version, slug }, ip);

      return NextResponse.json({ success: true, theme, warnings });
    } else {
      // Plugin installation
      // Read entrypoint JS
      const entrypoint = (manifest.entrypoint as string) || 'index.js';
      const jsFile = zip.file(root + entrypoint);
      if (!jsFile) {
        return NextResponse.json({ error: `Bundle missing entrypoint: ${entrypoint}` }, { status: 400 });
      }

      const code = await jsFile.async('string');

      // Block plugins with dangerous JS patterns
      const DANGEROUS_JS_PATTERNS = [
        { pattern: /\beval\s*\(/g, label: 'eval()' },
        { pattern: /\bnew\s+Function\s*\(/g, label: 'new Function()' },
        { pattern: /document\.cookie/g, label: 'document.cookie' },
        { pattern: /document\.write/g, label: 'document.write' },
        { pattern: /innerHTML\s*=/g, label: 'innerHTML assignment' },
      ];
      const dangerousFindings: string[] = [];
      for (const { pattern, label } of DANGEROUS_JS_PATTERNS) {
        if (pattern.test(code)) dangerousFindings.push(label);
        pattern.lastIndex = 0;
      }
      if (dangerousFindings.length > 0) {
        return NextResponse.json(
          { error: `Plugin rejected: contains ${dangerousFindings.join(', ')}. These patterns are not allowed for security reasons.` },
          { status: 400 },
        );
      }

      // Validate permissions
      const permissions = Array.isArray(manifest.permissions) ? manifest.permissions as string[] : [];
      const validPerms = new Set(ALL_PERMISSIONS as readonly string[]);
      const unknownPerms = permissions.filter(p => !validPerms.has(p));

      const warnings: string[] = [];
      if (unknownPerms.length > 0) {
        warnings.push(`Unknown permissions: ${unknownPerms.join(', ')}`);
      }

      // Plugins may declare iframe origins they need for embedded content.
      // Anything that doesn't pass strict origin validation is silently
      // dropped — the plugin still installs, but those origins are not
      // added to the host CSP.
      const declaredFrameOrigins = sanitizeFrameOrigins(manifest.frameOrigins);
      const droppedFrameOrigins = Array.isArray(manifest.frameOrigins)
        ? (manifest.frameOrigins as unknown[]).filter(
            (v) => typeof v !== 'string' || !declaredFrameOrigins.includes(v),
          )
        : [];
      if (droppedFrameOrigins.length > 0) {
        warnings.push(
          `Ignored invalid frameOrigins: ${droppedFrameOrigins.join(', ')}`,
        );
      }

      const plugin: ServerPlugin = {
        id: (manifest.id as string) || slug,
        name: (manifest.name as string) || slug,
        version: (manifest.version as string) || version,
        author: (manifest.author as string) || 'Unknown',
        description: (manifest.description as string) || '',
        type: (manifest.type as string) || 'hook',
        permissions,
        entrypoint,
        enabled: true,
        installedAt: now,
        updatedAt: now,
        ...(declaredFrameOrigins.length > 0
          ? { frameOrigins: declaredFrameOrigins }
          : {}),
      };

      await savePlugin(plugin, code);
      invalidateFrameOriginsCache();
      await auditLog('marketplace.install_plugin', { id: plugin.id, name: plugin.name, version: plugin.version, slug, frameOrigins: declaredFrameOrigins }, ip);

      return NextResponse.json({ success: true, plugin, warnings });
    }
  } catch (error) {
    logger.error('Marketplace install error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Installation failed' }, { status: 500 });
  }
}
