import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/admin/session';
import { logger } from '@/lib/logger';
import { getPluginRegistry } from '@/lib/admin/plugin-registry';
import { IMPLICIT_PERMISSIONS } from '@/lib/plugin-types';
import {
  APP_VERSION,
  DirectoryError,
  askDirectoryAbout,
  directoryJson,
  getDirectoryChannel,
  getDirectoryUrl,
  directoryOff,
  DIRECTORY_OFF_MESSAGE,
  installedExtensions,
  v2Url,
  type DirectoryAdvisory,
  type DirectoryChangelogEntry,
  type DirectoryVersion,
} from '@/lib/admin/marketplace-directory';

export interface UpdatesAnswer {
  /** `changelogs` is missing from directories older than 2026-10-30; `changelog` is then the offered version's alone. */
  /** `addedPermissions` is what the directory lists against what's installed; the install itself reads the bundle. */
  updates: Array<DirectoryVersion & { slug: string; currentVersion: string; changelog: string | null; changelogs?: DirectoryChangelogEntry[]; addedPermissions?: string[] }>;
  yanked: Array<{ slug: string; version: string; reason: string | null; at: string }>;
  deprecated: Array<{ slug: string; message: string | null; replacement: string | null }>;
  suspended: string[];
  advisories: DirectoryAdvisory[];
  unknown: string[];
}

const EMPTY: UpdatesAnswer = { updates: [], yanked: [], deprecated: [], suspended: [], advisories: [], unknown: [] };

/**
 * GET /api/admin/marketplace/updates
 *
 * Asks the directory about every installed extension that came from it (or
 * predates the record of where it came from): newer versions this Bulwark
 * can run, versions the publisher withdrew, deprecations, suspensions and
 * security advisories. Also lists what is installed, so the marketplace can
 * show the "Installed" view from one request.
 */
export async function GET(request: NextRequest) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;

    const installed = await installedExtensions();
    const list = [...installed].map(([id, e]) => ({ id, ...e }));
    const ask = list.filter((e) => askDirectoryAbout(e.source)).map((e) => ({ slug: e.id, version: e.version }));

    // The installed list is still useful with the official directory off (#903).
    if (await directoryOff()) {
      return NextResponse.json(
        { installed: list, ...EMPTY, directoryUrl: null, channel: getDirectoryChannel(), appVersion: APP_VERSION || null, error: DIRECTORY_OFF_MESSAGE },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const directoryUrl = await getDirectoryUrl();
    const channel = getDirectoryChannel();
    let answer: UpdatesAnswer = EMPTY;
    let error: string | null = null;
    if (ask.length > 0) {
      try {
        const res = await directoryJson<{ data: UpdatesAnswer }>(v2Url(directoryUrl, '/updates'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appVersion: APP_VERSION || undefined, channel, installed: ask }),
        });
        answer = { ...EMPTY, ...res.data };
        const { plugins } = await getPluginRegistry();
        const held = new Map(plugins.map((p) => [p.id, new Set<string>(p.permissions ?? [])]));
        const implicit = new Set<string>(IMPLICIT_PERMISSIONS);
        answer.updates = answer.updates.map((u) => ({
          ...u,
          addedPermissions: (u.permissions ?? []).filter((p) => !implicit.has(p) && !(held.get(u.slug)?.has(p) ?? true)),
        }));
      } catch (err) {
        // The installed list is still useful without the directory; say what
        // went wrong instead of failing the whole view.
        error = err instanceof DirectoryError ? err.message : 'Could not reach the extension directory';
        logger.warn('Marketplace updates check failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    return NextResponse.json(
      { installed: list, ...answer, directoryUrl, channel, appVersion: APP_VERSION || null, error },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    logger.error('Marketplace updates error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Failed to check for updates' }, { status: 500 });
  }
}
