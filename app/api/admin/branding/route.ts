import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth, getClientIP } from '@/lib/admin/session';
import { auditLog } from '@/lib/admin/audit';
import { configManager } from '@/lib/admin/config-manager';
import { assertWritable } from '@/lib/admin/paths';
import {
  parseDomainBranding,
  type DomainBrandingEntry,
  type BrandingOverrideKey,
} from '@/lib/admin/domain-branding';
import { logger } from '@/lib/logger';
import path from 'node:path';
import { configReadOnlyResponse } from '@/lib/admin/config-read-only-response';
import { brandingDocs } from '@/lib/admin/extension-store';
import type { PutResult } from '@/lib/shared-store';
import { announceChange } from '@/lib/shared-store/changes';

// Uploads live in C/branding, or the shared store in shared mode (#1066),
// and are served by /api/admin/branding/<file> from there.
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const ALLOWED_MIME_TYPES = new Set([
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

type UploadSlot = BrandingOverrideKey;

/** Slots that correspond to branding config keys */
const VALID_SLOTS = new Set<UploadSlot>([
  'faviconUrl',
  'pwaIconUrl',
  'appLogoLightUrl',
  'appLogoDarkUrl',
  'loginLogoLightUrl',
  'loginLogoDarkUrl',
  'pwaScreenshotMobileUrl',
  'pwaScreenshotDesktopUrl',
]);

const EXT_BY_MIME: Record<string, string> = {
  'image/svg+xml': '.svg',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
};

const POSSIBLE_EXTS = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico'];

// Exact hostnames only (no wildcards): wildcards can't be uploaded against
// because we'd need a real subdomain to serve the file from.
const EXACT_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function sanitizeFilename(name: string): string {
  // Strip directory traversal, keep only safe chars
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function normalizeHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.+$/, '');
}

/** Filename used to store a per-host uploaded asset. */
function domainAssetName(host: string, slot: BrandingOverrideKey, ext: string): string {
  return sanitizeFilename(`domain__${host}__${slot}${ext}`);
}

/** True if the file belongs to the given host+slot (any extension). */
function isDomainAssetFor(filename: string, host: string, slot: BrandingOverrideKey): boolean {
  const prefix = sanitizeFilename(`domain__${host}__${slot}.`);
  return filename.startsWith(prefix);
}

/** Merge a per-host update into the existing domainBranding array. */
function mergeDomainEntry(
  current: DomainBrandingEntry[],
  host: string,
  patch: Partial<DomainBrandingEntry>,
): DomainBrandingEntry[] {
  const next = current.slice();
  const idx = next.findIndex(e => e.host === host);
  if (idx === -1) {
    next.push({ host, ...patch });
  } else {
    next[idx] = { ...next[idx], ...patch };
  }
  return next;
}

/** Remove keys from a host's entry. If the entry has nothing left besides
 *  `host`, drop it entirely. */
function clearDomainKeys(
  current: DomainBrandingEntry[],
  host: string,
  keys: BrandingOverrideKey[],
): DomainBrandingEntry[] {
  const idx = current.findIndex(e => e.host === host);
  if (idx === -1) return current;
  const entry = { ...current[idx] };
  for (const key of keys) delete (entry as Record<string, unknown>)[key];
  const next = current.slice();
  if (Object.keys(entry).filter(k => k !== 'host').length === 0) {
    next.splice(idx, 1);
  } else {
    next[idx] = entry;
  }
  return next;
}

function brandingUrl(name: string, written: PutResult): string {
  return `/api/admin/branding/${name}${written.ok ? `?v=${written.version}` : ''}`;
}

/**
 * POST /api/admin/branding - Upload a branding image file
 *
 * Expects multipart/form-data with:
 *   - file: the image file
 *   - slot: which branding field this is for (e.g. "faviconUrl")
 *   - host (optional): when set, the upload is stored against the
 *     per-domain entry for that hostname instead of the global default.
 */
export async function POST(request: NextRequest) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;
    // Refuse before touching the branding dir: the config write that
    // follows would fail only after the files had already changed.
    assertWritable('change branding');

    const ip = getClientIP(request);
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const slot = formData.get('slot') as string | null;
    const rawHost = (formData.get('host') as string | null) ?? '';

    if (!file || !slot) {
      return NextResponse.json({ error: 'Missing file or slot' }, { status: 400 });
    }

    if (!VALID_SLOTS.has(slot as UploadSlot)) {
      return NextResponse.json({ error: `Invalid slot: ${slot}` }, { status: 400 });
    }

    const host = rawHost ? normalizeHost(rawHost) : '';
    if (host && !EXACT_HOST_RE.test(host)) {
      return NextResponse.json(
        { error: `Invalid host: ${rawHost} (wildcards must be configured by URL, not upload)` },
        { status: 400 },
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File too large (max 2 MB)' }, { status: 400 });
    }

    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${file.type}. Allowed: SVG, PNG, JPEG, WebP, ICO` },
        { status: 400 },
      );
    }

    const ext = EXT_BY_MIME[file.type] ?? '.png';
    const safeName = host
      ? domainAssetName(host, slot as BrandingOverrideKey, ext)
      : sanitizeFilename(`${slot}${ext}`);
    // Strip any prior asset for the same slot but a different extension so
    // the directory doesn't accumulate orphan files on re-upload.
    const docs = brandingDocs();
    for (const f of await docs.list('')) {
      if (f === safeName) continue;
      const isSame = host
        ? isDomainAssetFor(f, host, slot as BrandingOverrideKey)
        : POSSIBLE_EXTS.some(e => f === `${slot}${e}`);
      if (isSame) await docs.delete(f);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const written = await docs.put(safeName, buffer);

    // The version in the URL changes with the bytes, so browsers (which may
    // keep the file for an hour) and the rendered icons and previews pick up
    // a re-upload of the same slot and type at once.
    const servedUrl = brandingUrl(safeName, written);
    await configManager.ensureLoaded();

    if (host) {
      // Built on the stored list, so a save of another domain at the same
      // time (here or on another instance) stays.
      await configManager.updateAdminConfig<unknown>('domainBranding', (current) =>
        mergeDomainEntry(parseDomainBranding(current), host, { [slot]: servedUrl }), []);
    } else {
      await configManager.setAdminConfig({ [slot]: servedUrl });
    }

    await announceChange('branding');
    await auditLog('branding_upload', {
      slot,
      host: host || undefined,
      filename: safeName,
      size: file.size,
      mimeType: file.type,
    }, ip);

    return NextResponse.json({ url: servedUrl, filename: safeName });
  } catch (error) {
    const readOnly = configReadOnlyResponse(error);
    if (readOnly) return readOnly;
    logger.error('Branding upload error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/branding - Remove an uploaded branding file
 *
 * Expects JSON body: { slot: string, host?: string }
 *
 * When `host` is provided, only the per-domain asset for that host+slot is
 * removed (and the override in `domainBranding[host][slot]` is cleared).
 * Otherwise the global asset and config override are removed.
 */
export async function DELETE(request: NextRequest) {
  try {
    const result = await requireAdminAuth(request);
    if ('error' in result) return result.error;
    // Refuse before touching the branding dir: the config write that
    // follows would fail only after the files had already changed.
    assertWritable('change branding');

    const ip = getClientIP(request);
    const body = await request.json().catch(() => ({})) as { slot?: string; host?: string };
    const slot = body.slot;
    const rawHost = body.host ?? '';

    if (!slot || !VALID_SLOTS.has(slot as UploadSlot)) {
      return NextResponse.json({ error: 'Invalid or missing slot' }, { status: 400 });
    }

    const host = rawHost ? normalizeHost(rawHost) : '';
    if (host && !EXACT_HOST_RE.test(host)) {
      return NextResponse.json({ error: `Invalid host: ${rawHost}` }, { status: 400 });
    }

    const docs = brandingDocs();
    let removed = false;
    for (const f of await docs.list('')) {
      const isSame = host
        ? isDomainAssetFor(f, host, slot as BrandingOverrideKey)
        : POSSIBLE_EXTS.some(e => f === `${slot}${e}`);
      if (isSame) {
        await docs.delete(f);
        removed = true;
      }
    }

    await configManager.ensureLoaded();
    if (host) {
      await configManager.updateAdminConfig<unknown>('domainBranding', (current) =>
        clearDomainKeys(parseDomainBranding(current), host, [slot as BrandingOverrideKey]), []);
    } else {
      await configManager.removeAdminOverride(slot);
    }

    await announceChange('branding');
    await auditLog('branding_delete', { slot, host: host || undefined, fileRemoved: removed }, ip);

    return NextResponse.json({ success: true });
  } catch (error) {
    const readOnly = configReadOnlyResponse(error);
    if (readOnly) return readOnly;
    logger.error('Branding delete error', { error: error instanceof Error ? error.message : 'Unknown error' });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
