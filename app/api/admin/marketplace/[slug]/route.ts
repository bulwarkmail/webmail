import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/admin/session';
import { logger } from '@/lib/logger';
import { openPackage, readManifest, readText } from '@/lib/extension-package';
import { configManager } from '@/lib/admin/config-manager';
import { checkBundleSignature, type SignatureCheck } from '@/lib/admin/directory-keys';
import { RELEASE_VERSION } from '@/lib/release-version';
import {
  APP_VERSION,
  DirectoryError,
  compatQuery,
  directoryJson,
  getDirectoryChannel,
  getDirectoryUrl,
  historyFor,
  installedExtensions,
  installedStateOf,
  readBundleBytes,
  toListing,
  v2Url,
  type DirectoryDetail,
  type DirectoryVersion,
} from '@/lib/admin/marketplace-directory';
import { MAX_PLUGIN_SIZE, MAX_THEME_SIZE } from '@/lib/plugin-types';

const MAX_PREVIEW_SOURCE_LEN = 100_000;

/** A version row as the detail page renders it. */
function versionRow(v: DirectoryVersion) {
  return {
    version: v.version,
    channel: v.channel,
    publishedAt: v.publishedAt,
    minAppVersion: v.minAppVersion,
    maxAppVersion: v.maxAppVersion,
    permissions: v.permissions ?? [],
    size: v.size,
    sha256: v.sha256,
    yanked: v.yanked,
    changelog: v.changelog ?? null,
    downloads: v.downloads ?? 0,
    signed: !!v.signature,
    commit: v.provenance?.source?.commit ?? null,
  };
}

/**
 * GET /api/admin/marketplace/[slug]?version=
 *
 * Everything the preview page shows for one extension: the directory's
 * listing, every version it has (withdrawn ones included, so an installed
 * version that was withdrawn is shown as such), the bundle of the version
 * being previewed (its manifest and a capped source listing, after the
 * signature check), what is installed here, and the versions this server
 * still keeps for a rollback.
 *
 * `version` picks the version to preview - an install link from the
 * directory names one. Without it, or when the directory no longer has it,
 * the newest version this Bulwark can run is previewed.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;

    const { slug } = await params;
    const requested = request.nextUrl.searchParams.get('version');
    if (requested && !RELEASE_VERSION.test(requested)) {
      return NextResponse.json({ error: 'Invalid version' }, { status: 400 });
    }

    const directoryUrl = await getDirectoryUrl();
    const channel = getDirectoryChannel();

    // 1. Listing and every version, from the directory.
    let detail: DirectoryDetail;
    let versions: DirectoryVersion[];
    try {
      const base = `/extensions/${encodeURIComponent(slug)}`;
      [detail, versions] = await Promise.all([
        directoryJson<{ data: DirectoryDetail }>(v2Url(directoryUrl, base, compatQuery())).then((r) => r.data),
        directoryJson<{ data: DirectoryVersion[] }>(
          v2Url(directoryUrl, `${base}/versions`, { include: channel === 'beta' ? 'yanked,beta' : 'yanked' }),
        ).then((r) => r.data ?? []),
      ]);
    } catch (err) {
      if (err instanceof DirectoryError) {
        return NextResponse.json(
          { error: err.status === 404 ? 'Extension not found' : err.message },
          { status: err.status === 404 ? 404 : 502 },
        );
      }
      throw err;
    }

    const type: 'plugin' | 'theme' = detail.type === 'theme' ? 'theme' : 'plugin';

    // 2. Which version to preview.
    const requestedRow = requested ? versions.find((v) => v.version === requested) ?? null : null;
    const preview = requestedRow ?? detail.latest ?? detail.newest ?? versions[0] ?? null;

    // 3. Pull that bundle so the admin sees what is actually inside.
    let manifest: Record<string, unknown> | null = null;
    let sourcePreview: { name: string; content: string; truncated: boolean } | null = null;
    let bundleError: string | null = null;
    let bundleSize = 0;
    let signature: SignatureCheck | null = null;

    if (preview) {
      try {
        const bundleUrl = v2Url(
          directoryUrl,
          `/extensions/${encodeURIComponent(slug)}/versions/${encodeURIComponent(preview.version)}/bundle`,
        );
        const bundleRes = await fetch(bundleUrl.toString(), { signal: AbortSignal.timeout(30000) });

        if (!bundleRes.ok) {
          bundleError = `Bundle download failed (${bundleRes.status})`;
        } else {
          const buffer = await readBundleBytes(bundleRes, type === 'theme' ? MAX_THEME_SIZE : MAX_PLUGIN_SIZE);
          bundleSize = buffer.byteLength;
          signature = await checkBundleSignature({
            directoryUrl,
            configuredRootKeys: configManager.get<string>('extensionDirectoryRootKeys'),
            slug,
            version: preview.version,
            kind: type,
            bytes: buffer,
            headers: bundleRes.headers,
          });
          // Opening the preview must not inflate an arbitrary bundle in
          // full: every read goes through the capped package reader.
          const pkg = await openPackage(buffer, type);
          try {
            manifest = await readManifest(pkg);
          } catch (err) {
            bundleError = err instanceof Error ? err.message : 'Invalid manifest.json in bundle';
          }

          if (manifest) {
            const name = type === 'theme'
              ? 'theme.css'
              : (typeof manifest.entrypoint === 'string' && manifest.entrypoint) || 'index.js';
            const content = await readText(pkg, name);
            if (content !== null) {
              sourcePreview = {
                name,
                content: content.length > MAX_PREVIEW_SOURCE_LEN
                  ? content.slice(0, MAX_PREVIEW_SOURCE_LEN)
                  : content,
                truncated: content.length > MAX_PREVIEW_SOURCE_LEN,
              };
            }
          }
        }
      } catch (err) {
        bundleError = err instanceof Error ? err.message : 'Failed to read bundle';
      }
    } else {
      bundleError = 'Extension has no published version';
    }

    // 4. What is installed here, and what this server still keeps.
    const installed = await installedExtensions();
    const state = installedStateOf(installed, slug, type);
    const history = await historyFor(type, slug);

    return NextResponse.json(
      {
        extension: {
          ...toListing(detail, state),
          longDescription: detail.longDescription ?? null,
          newestVersion: detail.newest?.version ?? null,
          newestMinAppVersion: detail.newest?.minAppVersion ?? null,
          versions: versions.map(versionRow),
          screenshots: detail.screenshots ?? [],
          themePreviews: detail.themePreviews ?? [],
          advisories: detail.advisories ?? [],
          permissionDetails: detail.permissions ?? [],
          source: detail.source,
          createdAt: detail.createdAt ?? null,
          updatedAt: detail.updatedAt ?? null,
        },
        preview: preview
          ? { version: preview.version, channel: preview.channel, yanked: preview.yanked, minAppVersion: preview.minAppVersion, maxAppVersion: preview.maxAppVersion }
          : null,
        // The version an install link asked for, when the directory no
        // longer has it; the page says so instead of silently showing another.
        requestedVersionMissing: requested && !requestedRow ? requested : null,
        bundle: {
          manifest,
          source: sourcePreview,
          size: bundleSize,
          error: bundleError,
          signature,
        },
        ...state,
        history,
        channel,
        appVersion: APP_VERSION || null,
        directoryUrl,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    logger.error('Marketplace preview error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return NextResponse.json(
      { error: 'Failed to load preview' },
      { status: 502 },
    );
  }
}
