import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import {
  savePlugin,
  saveTheme,
  getPlugin,
  getTheme,
  getPluginRegistry,
  getThemeRegistry,
  type ServerPlugin,
  type ServerTheme,
} from '@/lib/admin/plugin-registry';
import {
  sanitizeFrameOrigins,
  sanitizeHttpOrigins,
  sanitizeApiPostPaths,
  invalidateFrameOriginsCache,
} from '@/lib/admin/csp-frame-origins';
import JSZip from 'jszip';
import { MAX_PLUGIN_SIZE, MAX_THEME_SIZE, ALL_PERMISSIONS } from '@/lib/plugin-types';
import { sanitizeThemeCSS, validateThemeCSSSafety } from '@/lib/theme-loader';
import { configManager } from '@/lib/admin/config-manager';

async function getDirectoryUrl(): Promise<string> {
  await configManager.ensureLoaded();
  return configManager.get<string>('extensionDirectoryUrl') || 'https://extensions.bulwarkmail.org';
}

/**
 * GET /api/admin/marketplace - Search/browse the extension directory
 * Proxies to the extension directory API
 */
export async function GET(request: NextRequest) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;

    const directoryUrl = await getDirectoryUrl();
    const { searchParams } = request.nextUrl;
    const url = new URL('/api/v1/extensions', directoryUrl);

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

    const installedPluginVersions = new Map(
      pluginRegistry.plugins.map(p => [p.id, p.version] as const),
    );
    const installedThemeVersions = new Map(
      themeRegistry.themes.map(t => [t.id, t.version] as const),
    );

    const fileUrl = (path: unknown): string | null =>
      typeof path === 'string' && path
        ? new URL(`/api/v1/files/${path}`, directoryUrl).toString()
        : null;

    if (data.data) {
      data.data = data.data.map((ext: Record<string, unknown>) => {
        const slug = ext.slug as string;
        const installedVersion = ext.type === 'theme'
          ? installedThemeVersions.get(slug) ?? null
          : installedPluginVersions.get(slug) ?? null;
        return {
          ...ext,
          iconUrl: fileUrl(ext.iconPath),
          bannerUrl: fileUrl(ext.bannerPath),
          installed: installedVersion !== null,
          installedVersion,
        };
      });
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
    const result = await requireAdminAuth(request);
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
    const directoryUrl = await getDirectoryUrl();
    const bundleUrl = new URL(`/api/v1/bundle/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`, directoryUrl);
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

    // Resolve and strictly validate the id used as a filename. Marketplace
    // bundles are authored by a third-party publisher; without this an id
    // like "../../foo" causes savePlugin/saveTheme to write outside the
    // plugins/themes dir via path.join.
    const resolvedId = typeof manifest.id === 'string' && manifest.id ? manifest.id : slug;
    if (typeof resolvedId !== 'string' || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(resolvedId)) {
      return NextResponse.json(
        { error: 'Invalid id: must be lowercase alphanumeric with hyphens, min 2 chars' },
        { status: 400 },
      );
    }

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

      const existingTheme = await getTheme(resolvedId);
      const isUpdate = existingTheme !== null;

      const theme: ServerTheme = {
        id: resolvedId,
        name: (manifest.name as string) || slug,
        // Prefer the directory-published version (what we requested) over
        // manifest.version. Publishers sometimes forget to bump the version
        // inside the bundle's manifest.json; trusting it would make the
        // update never appear to "stick" — the registry would keep showing
        // the older version even after a successful update.
        version: version || (manifest.version as string),
        author: (manifest.author as string) || 'Unknown',
        description: (manifest.description as string) || '',
        variants: (manifest.variants as string[]) || ['light', 'dark'],
        enabled: existingTheme?.enabled ?? true,
        ...(existingTheme?.forceEnabled !== undefined
          ? { forceEnabled: existingTheme.forceEnabled }
          : {}),
        installedAt: existingTheme?.installedAt ?? now,
        updatedAt: now,
      };

      await saveTheme(theme, css);
      await auditLog(
        isUpdate ? 'marketplace.update_theme' : 'marketplace.install_theme',
        {
          id: theme.id,
          name: theme.name,
          version: theme.version,
          slug,
          ...(isUpdate ? { previousVersion: existingTheme.version } : {}),
        },
        ip,
      );

      return NextResponse.json({ success: true, theme, warnings, updated: isUpdate });
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
      // dropped - the plugin still installs, but those origins are not
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

      const declaredHttpOrigins = sanitizeHttpOrigins(manifest.httpOrigins);
      const droppedHttpOrigins = Array.isArray(manifest.httpOrigins)
        ? (manifest.httpOrigins as unknown[]).filter(
            (v) => typeof v !== 'string' || !declaredHttpOrigins.includes(v),
          )
        : [];
      if (droppedHttpOrigins.length > 0) {
        warnings.push(
          `Ignored invalid httpOrigins: ${droppedHttpOrigins.join(', ')}`,
        );
      }

      const declaredApiPostPaths = sanitizeApiPostPaths(manifest.apiPostPaths);
      const droppedApiPostPaths = Array.isArray(manifest.apiPostPaths)
        ? (manifest.apiPostPaths as unknown[]).filter(
            (v) => typeof v !== 'string' || !declaredApiPostPaths.includes(v),
          )
        : [];
      if (droppedApiPostPaths.length > 0) {
        warnings.push(
          `Ignored invalid apiPostPaths: ${droppedApiPostPaths.join(', ')}`,
        );
      }

      const existingPlugin = await getPlugin(resolvedId);
      const isUpdate = existingPlugin !== null;

      const plugin: ServerPlugin = {
        id: resolvedId,
        name: (manifest.name as string) || slug,
        // See theme branch: trust the directory-published version, not
        // manifest.version, so updates actually stick in the registry.
        version: version || (manifest.version as string),
        author: (manifest.author as string) || 'Unknown',
        description: (manifest.description as string) || '',
        type: (manifest.type as string) || 'hook',
        ...(manifest.tier === 'privileged' ? { tier: 'privileged' } : {}),
        permissions,
        entrypoint,
        enabled: existingPlugin?.enabled ?? true,
        ...(existingPlugin?.forceEnabled !== undefined
          ? { forceEnabled: existingPlugin.forceEnabled }
          : {}),
        installedAt: existingPlugin?.installedAt ?? now,
        updatedAt: now,
        ...(manifest.configSchema && typeof manifest.configSchema === 'object'
          ? { configSchema: manifest.configSchema as ServerPlugin['configSchema'] }
          : {}),
        ...(manifest.settingsSchema && typeof manifest.settingsSchema === 'object'
          ? { settingsSchema: manifest.settingsSchema as ServerPlugin['settingsSchema'] }
          : {}),
        ...(declaredFrameOrigins.length > 0
          ? { frameOrigins: declaredFrameOrigins }
          : {}),
        ...(declaredHttpOrigins.length > 0
          ? { httpOrigins: declaredHttpOrigins }
          : {}),
        ...(declaredApiPostPaths.length > 0
          ? { apiPostPaths: declaredApiPostPaths }
          : {}),
      };

      await savePlugin(plugin, code);
      invalidateFrameOriginsCache();
      await auditLog(
        isUpdate ? 'marketplace.update_plugin' : 'marketplace.install_plugin',
        {
          id: plugin.id,
          name: plugin.name,
          version: plugin.version,
          slug,
          frameOrigins: declaredFrameOrigins,
          httpOrigins: declaredHttpOrigins,
          apiPostPaths: declaredApiPostPaths,
          ...(isUpdate ? { previousVersion: existingPlugin.version } : {}),
        },
        ip,
      );

      return NextResponse.json({ success: true, plugin, warnings, updated: isUpdate });
    }
  } catch (error) {
    logger.error('Marketplace install error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Installation failed' }, { status: 500 });
  }
}
