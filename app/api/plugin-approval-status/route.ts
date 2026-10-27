import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { configManager } from '@/lib/admin/config-manager';
import { cookies } from 'next/headers';
import { decryptSession } from '@/lib/auth/crypto';
import { sessionCookieName } from '@/lib/auth/session-cookie';
import { readStalwartAuthContextFromStore } from '@/lib/stalwart/auth-context';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { logger } from '@/lib/logger';
import {
  ApprovalLimitError,
  getApprovalStatus,
  requestApproval,
  saveApprovalBundle,
  type ApprovalEntry,
} from '@/lib/admin/plugin-approvals';
import { ExtensionPackageError, packageHash, readPluginPackage } from '@/lib/extension-package';
import { MAX_PLUGIN_SIZE } from '@/lib/plugin-types';

/**
 * GET /api/plugin-approval-status?pluginId=X&bundleHash=Y
 *
 * Any logged-in user may query the server-side approval state for a plugin
 * they want to enable. The client uses this BEFORE running `enablePlugin`
 * when the `requirePluginApproval` policy is set.
 *
 * POST same path with the plugin ZIP as multipart `file` creates a pending
 * approval entry (or returns the existing one) for the package hash the
 * server computes, and keeps the ZIP for the admin to review.
 */

async function resolveUsername(): Promise<string | null> {
  const cookieStore = await cookies();
  for (let slot = 0; slot < MAX_ACCOUNT_SLOTS; slot++) {
    // The context first: a token sign-in may have claimed a bare name, and
    // only the context knows the account it resolved to.
    const ctx = readStalwartAuthContextFromStore(cookieStore, slot);
    if (ctx?.username) return ctx.accountName ?? ctx.username;
    const token = cookieStore.get(sessionCookieName(slot))?.value;
    if (token) {
      const sess = decryptSession(token);
      if (sess?.username) return sess.username;
    }
  }
  return null;
}

// The largest package plus room for the multipart framing around it.
const MAX_UPLOAD_BYTES = MAX_PLUGIN_SIZE + 64 * 1024;

function isValidId(s: unknown): s is string {
  return typeof s === 'string' && /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(s) && s.length <= 64;
}
function isValidHash(s: unknown): s is string {
  return typeof s === 'string' && /^[a-f0-9]{16,128}$/i.test(s);
}

export async function GET(request: NextRequest) {
  try {
    const username = await resolveUsername();
    if (!username) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    const pluginId = request.nextUrl.searchParams.get('pluginId');
    const bundleHash = request.nextUrl.searchParams.get('bundleHash');
    if (!isValidId(pluginId) || !isValidHash(bundleHash)) {
      return NextResponse.json({ error: 'invalid pluginId or bundleHash' }, { status: 400 });
    }
    const status = await getApprovalStatus(pluginId, bundleHash);
    return NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    logger.error('plugin-approval-status GET', { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  // CSRF gate (GHSA-9mvj-98f5-9q6g): this handler acts with the caller's
  // session cookie, which SameSite=Lax still sends from a same-site page.
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  try {
    const username = await resolveUsername();
    if (!username) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

    // Only take packages while users may install their own plugins and
    // those need review (GHSA-qc44-275p-gqw9): otherwise nobody asked for
    // the queue, and every request still stores a ZIP on disk.
    await configManager.ensureLoaded();
    const { features } = configManager.getPolicy();
    if (!features.pluginsEnabled || !features.pluginsUploadEnabled || !features.requirePluginApproval) {
      return NextResponse.json({ error: 'Plugin approval requests are turned off' }, { status: 403 });
    }

    // formData() buffers the whole body; refuse what can't be a package first.
    if (Number(request.headers.get('content-length') ?? 0) > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: 'Plugin package too large' }, { status: 413 });
    }

    // The request carries the package itself. The admin reviews the code
    // and manifest the server read from it, and the approval is pinned to
    // the hash the server computed, not to anything the client claims.
    let file: File | null = null;
    try {
      const form = await request.formData();
      const value = form.get('file');
      file = value instanceof File ? value : null;
    } catch { /* not multipart */ }
    if (!file) {
      return NextResponse.json({ error: 'Send the plugin ZIP as "file"' }, { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());

    let pkg;
    try {
      pkg = await readPluginPackage(bytes, { appVersion: process.env.NEXT_PUBLIC_APP_VERSION });
    } catch (err) {
      if (err instanceof ExtensionPackageError) return NextResponse.json({ error: err.message }, { status: 400 });
      throw err;
    }
    const { manifest, code } = pkg;
    const hash = await packageHash(manifest, code);

    const snapshot: ApprovalEntry['manifest'] = {
      name: manifest.name,
      version: manifest.version,
      author: manifest.author,
      description: manifest.description,
      permissions: manifest.permissions,
      httpOrigins: manifest.httpOrigins,
      apiPostPaths: manifest.apiPostPaths,
      ...(manifest.credentials ? { credentials: manifest.credentials } : {}),
    };

    let entry: ApprovalEntry;
    try {
      entry = await requestApproval(manifest.id, hash, snapshot, username);
    } catch (err) {
      if (err instanceof ApprovalLimitError) return NextResponse.json({ error: err.message }, { status: 429 });
      throw err;
    }
    if (entry.status === 'pending') await saveApprovalBundle(manifest.id, hash, bytes);
    return NextResponse.json({
      pluginId: manifest.id,
      bundleHash: hash,
      status: entry.status,
      requestedAt: entry.requestedAt,
      decidedAt: entry.decidedAt,
    });
  } catch (err) {
    logger.error('plugin-approval-status POST', { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
