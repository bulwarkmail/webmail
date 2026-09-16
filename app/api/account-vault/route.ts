import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { configManager } from '@/lib/admin/config-manager';
import { hasSessionSecret } from '@/lib/auth/session-secret';
import { readStalwartAuthContextFromStore } from '@/lib/stalwart/auth-context';
import { assertBasicAuthMatchesUsername, verifyJmapAuth } from '@/lib/auth/verify-jmap-auth';
import { parseJmapServers, resolveTrustedJmapUrl } from '@/lib/admin/jmap-servers';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import {
  normalizeVaultOwner, parseVaultEnvelope, parseVaultId, parseVaultName, vaultIdentity, VAULT_MAX_BYTES, type VaultOwner,
} from '@/lib/account-vault';
import { deleteVault, listVaults, saveVault, VaultConflict, VaultLimit } from '@/lib/account-vault-storage';

export const runtime = 'nodejs';
const reply = (data: unknown, status = 200) => NextResponse.json(data, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});
async function enabled(): Promise<boolean> {
  await configManager.ensureLoaded();
  return configManager.get<boolean>('settingsSyncEnabled', false) && hasSessionSecret()
    && !configManager.get<boolean>('oauthOnly', false);
}
function ownerFrom(request: NextRequest): VaultOwner {
  return normalizeVaultOwner({ username: request.headers.get('x-vault-username') || '', serverUrl: request.headers.get('x-vault-server') || '' });
}
const isRevision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Deliberately readable before mail login: the archive password is the read key.
 * Only archive names and ciphertext are returned, and no permissive CORS is set.
 */
export async function GET(request: NextRequest) {
  if (!await enabled()) return reply({ error: 'disabled' }, 404);
  let owner;
  try { owner = ownerFrom(request); } catch { return reply({ error: 'invalid_archive' }, 400); }
  try { return reply({ vaults: await listVaults(owner) }); }
  catch { return reply({ error: 'storage_failed' }, 500); }
}

async function verifyOwner(owner: VaultOwner): Promise<boolean> {
  const store = await cookies();
  for (let slot = 0; slot < MAX_ACCOUNT_SLOTS; slot++) {
    const ctx = readStalwartAuthContextFromStore(store, slot);
    if (!ctx) continue;
    try { if (vaultIdentity(ctx) !== vaultIdentity(owner)) continue; }
    catch { continue; }
    // Existing session cookies can be minted without upstream verification for
    // trusted servers. Verify live credentials here before authorizing a write.
    assertBasicAuthMatchesUsername(ctx.authHeader, owner.username);
    if (!ctx.authHeader.startsWith('Basic ')) return false;
    const trusted = resolveTrustedJmapUrl(owner.serverUrl,
      configManager.get<string>('jmapServerUrl', ''),
      parseJmapServers(configManager.get<unknown>('jmapServers', [])));
    await verifyJmapAuth(owner.serverUrl, ctx.authHeader, { trusted: !!trusted });
    return true;
  }
  return false;
}

/** Writes and deletes: verified owner session plus a size-bounded JSON body. */
async function authorizedBody(request: NextRequest): Promise<{ owner: VaultOwner; body: Record<string, unknown> } | NextResponse> {
  if (!await enabled()) return reply({ error: 'disabled' }, 404);
  if (!request.headers.get('content-type')?.startsWith('application/json')
    || request.headers.get('sec-fetch-site') === 'cross-site') return reply({ error: 'forbidden' }, 403);
  let owner;
  try { owner = ownerFrom(request); } catch { return reply({ error: 'invalid_archive' }, 400); }
  try { if (!await verifyOwner(owner)) return reply({ error: 'owner_signin_required' }, 403); }
  catch { return reply({ error: 'owner_signin_required' }, 403); }

  // Bound the actual streamed body, not merely the caller's Content-Length.
  const reader = request.body?.getReader();
  if (!reader) return reply({ error: 'invalid_archive' }, 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > VAULT_MAX_BYTES) { await reader.cancel(); return reply({ error: 'invalid_archive' }, 413); }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply({ error: 'invalid_archive' }, 400);
    return { owner, body };
  } catch { return reply({ error: 'invalid_archive' }, 400); }
  finally { reader.releaseLock(); }
}

function storageError(err: unknown) {
  if (err instanceof VaultConflict) return reply({ error: 'conflict' }, 409);
  if (err instanceof VaultLimit) return reply({ error: 'archive_limit' }, 409);
  return reply({ error: 'storage_failed' }, 500);
}

/** `id: null` creates a new archive; an existing id replaces that archive if `revision` still matches. */
export async function PUT(request: NextRequest) {
  const auth = await authorizedBody(request);
  if (auth instanceof NextResponse) return auth;
  const { owner, body } = auth;
  let envelope, id, name;
  try {
    envelope = parseVaultEnvelope(body.envelope);
    id = body.id === null ? null : parseVaultId(body.id);
    if (body.revision !== null && !isRevision(body.revision)) throw new Error('invalid_archive');
  } catch { return reply({ error: 'invalid_archive' }, 400); }
  try { name = parseVaultName(body.name); } catch { return reply({ error: 'invalid_name' }, 400); }
  try { return reply({ vault: await saveVault(owner, id, name, envelope, body.revision) }); }
  catch (err) { return storageError(err); }
}

/** Needs the owner session, not the archive password, so a forgotten password can be recovered from. */
export async function DELETE(request: NextRequest) {
  const auth = await authorizedBody(request);
  if (auth instanceof NextResponse) return auth;
  const { owner, body } = auth;
  let id;
  try {
    id = parseVaultId(body.id);
    if (!isRevision(body.revision)) throw new Error('invalid_archive');
  } catch { return reply({ error: 'invalid_archive' }, 400); }
  try { await deleteVault(owner, id, body.revision); return reply({ deleted: true }); }
  catch (err) { return storageError(err); }
}
