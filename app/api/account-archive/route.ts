import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { configManager } from '@/lib/admin/config-manager';
import { hasSessionSecret } from '@/lib/auth/session-secret';
import { readStalwartAuthContextFromStore } from '@/lib/stalwart/auth-context';
import { assertBasicAuthMatchesUsername, verifyJmapAuth } from '@/lib/auth/verify-jmap-auth';
import { parseJmapServers, resolveTrustedJmapUrl } from '@/lib/admin/jmap-servers';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { archiveIdentity, parseArchiveEnvelope, ARCHIVE_MAX_BYTES, type ArchiveOwner } from '@/lib/account-archive';
import { deleteArchive, loadArchive, saveArchive } from '@/lib/account-archive-storage';

export const runtime = 'nodejs';

const reply = (data: unknown, status = 200) => NextResponse.json(data, {
  status, headers: { 'Cache-Control': 'no-store' },
});

/**
 * The owner whose archive this request may touch, or the response refusing it.
 *
 * A session cookie alone is not enough: cookies for admin-configured servers
 * can outlive the credential inside them. So the credential in the matching
 * slot is checked against the mail server on every call, and listing is held
 * to the same rule as writing, since the ciphertext is what an offline
 * password guess would need.
 */
async function verifiedOwner(request: NextRequest): Promise<ArchiveOwner | NextResponse> {
  await configManager.ensureLoaded();
  if (!configManager.getPolicy().features.accountArchiveEnabled || !hasSessionSecret()) return reply({ error: 'disabled' }, 404);
  const denied = reply({ error: 'owner_signin_required' }, 403);
  let claimed: string;
  try {
    claimed = archiveIdentity({
      username: request.headers.get('x-archive-username') ?? '',
      serverUrl: request.headers.get('x-archive-server') ?? '',
    });
  } catch { return denied; }
  const store = await cookies();
  for (let slot = 0; slot < MAX_ACCOUNT_SLOTS; slot++) {
    const ctx = readStalwartAuthContextFromStore(store, slot);
    if (!ctx) continue;
    try { if (archiveIdentity(ctx) !== claimed) continue; } catch { continue; }
    try {
      // The cookie's own username, not the header's: the two may differ in case.
      assertBasicAuthMatchesUsername(ctx.authHeader, ctx.username);
      const trusted = resolveTrustedJmapUrl(ctx.serverUrl,
        configManager.get<string>('jmapServerUrl', ''),
        parseJmapServers(configManager.get<unknown>('jmapServers', [])));
      await verifyJmapAuth(ctx.serverUrl, ctx.authHeader, { trusted: !!trusted });
    } catch { return denied; }
    return { username: ctx.accountName ?? ctx.username, serverUrl: ctx.serverUrl };
  }
  return denied;
}

export async function GET(request: NextRequest) {
  const owner = await verifiedOwner(request);
  if (owner instanceof NextResponse) return owner;
  try { return reply({ envelope: await loadArchive(owner) }); }
  catch { return reply({ error: 'storage_failed' }, 500); }
}

export async function PUT(request: NextRequest) {
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  const owner = await verifiedOwner(request);
  if (owner instanceof NextResponse) return owner;
  if (Number(request.headers.get('content-length') ?? 0) > ARCHIVE_MAX_BYTES) return reply({ error: 'too_large' }, 413);
  let envelope;
  try {
    const text = await request.text();
    if (text.length > ARCHIVE_MAX_BYTES) return reply({ error: 'too_large' }, 413);
    envelope = parseArchiveEnvelope((JSON.parse(text) as { envelope?: unknown })?.envelope);
  } catch { return reply({ error: 'invalid_archive' }, 400); }
  try { await saveArchive(owner, envelope); return reply({ ok: true }); }
  catch { return reply({ error: 'storage_failed' }, 500); }
}

export async function DELETE(request: NextRequest) {
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  const owner = await verifiedOwner(request);
  if (owner instanceof NextResponse) return owner;
  try { await deleteArchive(owner); return reply({ ok: true }); }
  catch { return reply({ error: 'storage_failed' }, 500); }
}
