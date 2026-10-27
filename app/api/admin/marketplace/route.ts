import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { auditLog } from '@/lib/admin/audit';
import { logger } from '@/lib/logger';
import {
  savePlugin,
  saveTheme,
  getPlugin,
  getTheme,
  themeCSSResolver,
  type ServerPlugin,
  type ServerTheme,
} from '@/lib/admin/plugin-registry';
import { invalidateFrameOriginsCache } from '@/lib/admin/csp-frame-origins';
import {
  EXTENSION_ID_RE,
  EXTENSION_VERSION_RE,
  ExtensionPackageError,
  readPluginPackage,
  readThemePackage,
  suspiciousCode,
} from '@/lib/extension-package';
import { configManager } from '@/lib/admin/config-manager';
import { checkBundleSignature } from '@/lib/admin/directory-keys';
import { configReadOnlyResponse } from '@/lib/admin/config-read-only-response';
import { compareVersions } from '@/lib/version-compare';
import { RELEASE_VERSION } from '@/lib/release-version';
import {
  APP_VERSION,
  DirectoryError,
  compatQuery,
  directoryJson,
  getDirectoryChannel,
  getDirectoryUrl,
  installedExtensions,
  installedStateOf,
  readBundleBytes,
  toListing,
  v2Url,
  type DirectorySummary,
  type DirectoryVersion,
} from '@/lib/admin/marketplace-directory';
import { MAX_PLUGIN_SIZE, MAX_THEME_SIZE } from '@/lib/plugin-types';
import { createHash } from 'node:crypto';

/** Query parameters the UI may pass on to the directory's list endpoint. */
const FORWARDED = ['q', 'type', 'pluginType', 'tag', 'author', 'sort', 'order', 'page', 'perPage', 'featured'] as const;

/**
 * GET /api/admin/marketplace - Browse the extension directory
 *
 * Proxies the directory's `/api/v2/extensions` with this Bulwark's version
 * and channel, so the version offered for each extension is one this
 * install can run, and marks what is already installed.
 */
export async function GET(request: NextRequest) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;

    const directoryUrl = await getDirectoryUrl();
    const query: Record<string, string | undefined> = {};
    for (const key of FORWARDED) {
      const value = request.nextUrl.searchParams.get(key);
      if (value) query[key] = value;
    }

    const data = await directoryJson<{ data: DirectorySummary[]; meta: { page: number; perPage: number; total: number } }>(
      v2Url(directoryUrl, '/extensions', { ...query, ...compatQuery() }),
    );
    const installed = await installedExtensions();

    return NextResponse.json(
      {
        data: (data.data ?? []).map((ext) => toListing(ext, installedStateOf(installed, ext.slug, ext.type))),
        meta: data.meta,
        channel: getDirectoryChannel(),
        appVersion: APP_VERSION || null,
        directoryUrl,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof DirectoryError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    logger.error('Marketplace search error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Failed to connect to extension directory' }, { status: 502 });
  }
}

/**
 * POST /api/admin/marketplace - Install one version of an extension
 * Body: { slug: string, version: string, type: 'plugin' | 'theme', force?: boolean }
 *
 * The version is looked up on the directory first. A version the publisher
 * withdrew ("yanked") is refused with 409 unless `force` is set - the admin
 * UI asks before sending that. A version this Bulwark is too old or too new
 * for is refused outright. Then the bundle is downloaded, its directory
 * signature checked, and it is installed under the directory slug, keeping
 * the enabled and forced flags of whatever was installed before. The replaced
 * version stays on disk for a rollback (lib/admin/extension-history.ts).
 */
export async function POST(request: NextRequest) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;

    const ip = getClientIP(request);
    const { slug, version, type, force } = await request.json();

    if (!slug || !version || !type) {
      return NextResponse.json({ error: 'Missing slug, version, or type' }, { status: 400 });
    }

    if (type !== 'plugin' && type !== 'theme') {
      return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
    }

    // The version goes into a URL, the registry and the history directory
    // name; anything but a version string breaks the next update of the
    // extension (dirNameFor throws on a non-string) and is echoed to the UI.
    if (typeof version !== 'string' || !EXTENSION_VERSION_RE.test(version)) {
      return NextResponse.json({ error: 'Invalid version: must look like 1.2.3' }, { status: 400 });
    }

    // An older release than the installed one is refused unless the admin
    // insists (`force`, the same confirm step as for a withdrawn version):
    // a directory, or someone in the path to it, that lists an old,
    // vulnerable release as the latest must not have an "update" quietly
    // install it.
    if (force !== true) {
      const installed = type === 'theme' ? await getTheme(slug) : await getPlugin(slug);
      if (installed && EXTENSION_VERSION_RE.test(installed.version) && compareVersions(version, installed.version) < 0) {
        return NextResponse.json(
          {
            error: `Version ${version} is older than the installed ${installed.version}.`,
            downgrade: { installedVersion: installed.version },
          },
          { status: 409 },
        );
      }
    }

    // The slug becomes a file name and the registry key; it must be a plain id.
    if (typeof slug !== 'string' || !EXTENSION_ID_RE.test(slug)) {
      return NextResponse.json(
        { error: 'Invalid id: must be lowercase alphanumeric with hyphens, min 2 chars' },
        { status: 400 },
      );
    }
    if (typeof version !== 'string' || !RELEASE_VERSION.test(version)) {
      return NextResponse.json({ error: 'Invalid version: must look like 1.2.3' }, { status: 400 });
    }

    const directoryUrl = await getDirectoryUrl();
    const versionPath = `/extensions/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}`;

    // 1. What the directory says about this version.
    let meta: DirectoryVersion;
    try {
      meta = (await directoryJson<{ data: DirectoryVersion }>(v2Url(directoryUrl, versionPath))).data;
    } catch (err) {
      if (err instanceof DirectoryError && err.status === 404) {
        return NextResponse.json({ error: `Version ${version} of "${slug}" is not in the directory` }, { status: 404 });
      }
      throw err;
    }

    if (meta.yanked && force !== true) {
      const reason = meta.yanked.reason ? `: ${meta.yanked.reason}` : '';
      return NextResponse.json(
        {
          error: `Version ${version} was withdrawn by its publisher${reason}. Pick another version, or install it anyway.`,
          yanked: meta.yanked,
        },
        { status: 409 },
      );
    }
    if (APP_VERSION && meta.minAppVersion && compareVersions(APP_VERSION, meta.minAppVersion) < 0) {
      return NextResponse.json(
        { error: `Needs Bulwark ${meta.minAppVersion} or later (this is ${APP_VERSION})` },
        { status: 400 },
      );
    }
    if (APP_VERSION && meta.maxAppVersion && compareVersions(APP_VERSION, meta.maxAppVersion) > 0) {
      return NextResponse.json(
        { error: `Version ${version} supports Bulwark up to ${meta.maxAppVersion} (this is ${APP_VERSION})` },
        { status: 400 },
      );
    }

    // 2. The bundle itself, from the same directory (never from a URL the
    //    directory handed back).
    const bundleRes = await fetch(v2Url(directoryUrl, `${versionPath}/bundle`).toString(), {
      signal: AbortSignal.timeout(30000),
    });

    if (!bundleRes.ok) {
      return NextResponse.json(
        { error: `Failed to download bundle: ${bundleRes.status}` },
        { status: 502 }
      );
    }

    const buffer = await readBundleBytes(bundleRes, type === 'theme' ? MAX_THEME_SIZE : MAX_PLUGIN_SIZE);
    const now = new Date().toISOString();

    // The directory signs every bundle it approves; refuse one whose
    // signature is missing or wrong before looking inside it.
    const signature = await checkBundleSignature({
      directoryUrl,
      configuredRootKeys: configManager.get<string>('extensionDirectoryRootKeys'),
      slug,
      version,
      kind: type,
      bytes: buffer,
      headers: bundleRes.headers,
    });
    if (signature.status === 'invalid') {
      logger.warn('Marketplace bundle refused: signature check failed', { slug, version, reason: signature.reason });
      return NextResponse.json({ error: `Refused: ${signature.reason}` }, { status: 400 });
    }
    // Without root keys (a self-hosted directory) the listing's hash is the
    // only check that the bytes are the ones the directory meant.
    if (meta.sha256 && createHash('sha256').update(new Uint8Array(buffer)).digest('hex') !== meta.sha256) {
      return NextResponse.json({ error: 'Refused: the downloaded bundle does not match what the directory lists' }, { status: 502 });
    }

    const source = { kind: 'marketplace' as const, slug, directoryUrl };
    const installExtras = {
      signature: signature.status,
      channel: meta.channel,
      yanked: meta.yanked,
    };

    if (type === 'theme') {
      const read = await readThemePackage(buffer, { resolveExtends: await themeCSSResolver() });
      if (!read.valid || !read.manifest) {
        return NextResponse.json({ error: read.errors.join('; ') }, { status: 400 });
      }
      const manifest = read.manifest;
      // The slug is what the admin picked and what install status is keyed
      // on. A bundle that names another id would install over whatever
      // already uses that id, keeping its enabled and force-enabled state.
      if (manifest.id !== slug) {
        return NextResponse.json(
          { error: `Bundle id "${String(manifest.id)}" does not match the directory entry "${slug}"` },
          { status: 400 },
        );
      }
      const resolvedId = slug;
      const { css, skin, warnings } = read;

      const existingTheme = await getTheme(resolvedId);
      const isUpdate = existingTheme !== null;

      const theme: ServerTheme = {
        id: resolvedId,
        name: manifest.name || slug,
        // Prefer the directory-published version (what we requested) over
        // manifest.version. Publishers sometimes forget to bump the version
        // inside the bundle's manifest.json; trusting it would make the
        // update never appear to "stick" — the registry would keep showing
        // the older version even after a successful update.
        version: version || manifest.version,
        author: manifest.author || 'Unknown',
        description: manifest.description || '',
        variants: manifest.variants,
        enabled: existingTheme?.enabled ?? true,
        ...(existingTheme?.forceEnabled !== undefined
          ? { forceEnabled: existingTheme.forceEnabled }
          : {}),
        installedAt: existingTheme?.installedAt ?? now,
        updatedAt: now,
        source,
      };

      await saveTheme(theme, css, skin);
      await auditLog(
        isUpdate ? 'marketplace.update_theme' : 'marketplace.install_theme',
        {
          id: theme.id,
          name: theme.name,
          version: theme.version,
          slug,
          signature: signature.status,
          ...(meta.yanked ? { yanked: true } : {}),
          ...(isUpdate ? { previousVersion: existingTheme.version } : {}),
        },
        ip,
      );

      return NextResponse.json({ success: true, theme, warnings, updated: isUpdate, previousVersion: existingTheme?.version ?? null, ...installExtras });
    }

    // Plugin installation
    let pkg;
    try {
      pkg = await readPluginPackage(buffer, {
        appVersion: process.env.NEXT_PUBLIC_APP_VERSION,
        expectedId: slug,
      });
    } catch (err) {
      if (err instanceof ExtensionPackageError) {
        // Same wording the admin UI already shows for an id mismatch.
        const message = err.message.replace(/Package id "([^"]*)" does not match "([^"]*)"/, 'Bundle id "$1" does not match the directory entry "$2"');
        return NextResponse.json({ error: message }, { status: 400 });
      }
      throw err;
    }
    const { manifest, code } = pkg;

    // Block plugins with dangerous JS patterns
    const suspicious = suspiciousCode(code);
    if (suspicious.length > 0) {
      return NextResponse.json(
        { error: `Plugin rejected: contains ${suspicious.join(', ')}. These patterns are not allowed for security reasons.` },
        { status: 400 },
      );
    }

    const existingPlugin = await getPlugin(slug);
    const isUpdate = existingPlugin !== null;

    const plugin: ServerPlugin = {
      id: slug,
      name: manifest.name,
      // See theme branch: trust the directory-published version, not
      // manifest.version, so updates actually stick in the registry.
      version: version || manifest.version,
      author: manifest.author,
      description: manifest.description,
      type: manifest.type,
      ...(manifest.tier === 'privileged' ? { tier: 'privileged' } : {}),
      permissions: manifest.permissions,
      entrypoint: manifest.entrypoint,
      enabled: existingPlugin?.enabled ?? true,
      ...(existingPlugin?.forceEnabled !== undefined
        ? { forceEnabled: existingPlugin.forceEnabled }
        : {}),
      installedAt: existingPlugin?.installedAt ?? now,
      updatedAt: now,
      ...(manifest.configSchema ? { configSchema: manifest.configSchema } : {}),
      ...(manifest.settingsSchema ? { settingsSchema: manifest.settingsSchema } : {}),
      ...(manifest.frameOrigins ? { frameOrigins: manifest.frameOrigins } : {}),
      ...(manifest.httpOrigins ? { httpOrigins: manifest.httpOrigins } : {}),
      ...(manifest.apiPostPaths ? { apiPostPaths: manifest.apiPostPaths } : {}),
      ...(manifest.locales ? { locales: manifest.locales } : {}),
      ...(manifest.credentials ? { credentials: manifest.credentials } : {}),
      source,
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
        frameOrigins: plugin.frameOrigins ?? [],
        httpOrigins: plugin.httpOrigins ?? [],
        apiPostPaths: plugin.apiPostPaths ?? [],
        signature: signature.status,
        ...(meta.yanked ? { yanked: true } : {}),
        ...(isUpdate ? { previousVersion: existingPlugin.version } : {}),
      },
      ip,
    );

    return NextResponse.json({ success: true, plugin, warnings: pkg.warnings, updated: isUpdate, previousVersion: existingPlugin?.version ?? null, ...installExtras });
  } catch (error) {
    const readOnly = configReadOnlyResponse(error);
    if (readOnly) return readOnly;
    if (error instanceof DirectoryError) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    logger.error('Marketplace install error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Installation failed' }, { status: 500 });
  }
}
