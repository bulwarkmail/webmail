import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { configManager } from '@/lib/admin/config-manager';
import { hasSessionSecret } from '@/lib/auth/session-secret';
import { readStalwartAuthContextFromStore } from '@/lib/stalwart/auth-context';
import { assertBasicAuthMatchesUsername, verifyJmapAuth } from '@/lib/auth/verify-jmap-auth';
import { parseJmapServers, resolveTrustedJmapUrl } from '@/lib/admin/jmap-servers';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { normalizeVaultOwner, parseVaultEnvelope, vaultIdentity, VAULT_MAX_BYTES, type VaultOwner } from '@/lib/account-vault';
import { loadVault, saveVault, VaultConflict } from '@/lib/account-vault-storage';

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

/** Deliberately readable before mail login: the archive password is the read key.
 * No plaintext metadata or credentials are returned, and no permissive CORS is set.
 */
export async function GET(request: NextRequest) {
  if (!await enabled()) return reply({ error: 'disabled' }, 404);
  let owner;
  try { owner = ownerFrom(request); } catch { return reply({ error: 'invalid_archive' }, 400); }
  try { return reply({ vault: await loadVault(owner) }); }
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

export async function PUT(request: NextRequest) {
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
    const envelope = parseVaultEnvelope(body.envelope);
    if (body.revision !== null && (typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision))) {
      return reply({ error: 'invalid_archive' }, 400);
    }
    try { return reply({ vault: await saveVault(owner, envelope, body.revision) }); }
    catch (err) { return reply({ error: err instanceof VaultConflict ? 'conflict' : 'storage_failed' }, err instanceof VaultConflict ? 409 : 500); }
  } catch { return reply({ error: 'invalid_archive' }, 400); }
  finally { reader.releaseLock(); }
}
