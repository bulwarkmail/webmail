import { apiFetch } from '@/lib/browser-navigation';
import { generateAccountId } from '@/lib/account-utils';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { normalizeVaultOwner, vaultIdentity, type VaultContents, type VaultEnvelope, type VaultOwner, type VaultRecord } from './account-vault';

function headers(owner: VaultOwner): Record<string, string> {
  const normalized = normalizeVaultOwner(owner);
  return { 'x-vault-username': normalized.username, 'x-vault-server': normalized.serverUrl };
}

async function request(owner: VaultOwner, init: RequestInit = {}) {
  const res = await apiFetch('/api/account-vault', { cache: 'no-store', ...init,
    headers: { ...headers(owner), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'storage_failed');
  return body;
}

/** All archives saved by this owner, sorted by name. */
export async function fetchVaults(owner: VaultOwner): Promise<VaultRecord[]> {
  return (await request(owner)).vaults;
}

/** `archive.id === null` creates a new archive. */
export async function putVault(owner: VaultOwner, archive: { id: string | null; name: string; revision: string | null }, envelope: VaultEnvelope): Promise<VaultRecord> {
  return (await request(owner, { method: 'PUT', body: JSON.stringify({ ...archive, envelope }) })).vault;
}

export async function deleteVault(owner: VaultOwner, archive: { id: string; revision: string }): Promise<void> {
  await request(owner, { method: 'DELETE', body: JSON.stringify({ id: archive.id, revision: archive.revision }) });
}

/** Snapshot basic accounts, optionally including live credentials. */
export function collectVault(owner: VaultOwner, includePasswords = true): VaultContents {
  const { accounts, defaultAccountId } = useAccountStore.getState();
  const basic = accounts.filter(a => a.authMode === 'basic');
  const entries = basic.map(account => {
    const metadata = { ...normalizeVaultOwner(account), label: account.label, avatarColor: account.avatarColor };
    if (!includePasswords) return metadata;
    const client = useAuthStore.getState().getClientForAccount(account.id);
    const auth = client?.getAuthHeader();
    if (!auth?.startsWith('Basic ')) throw new Error('accounts_disconnected');
    const decoded = atob(auth.slice(6));
    const colon = decoded.indexOf(':');
    if (colon < 0 || decoded.slice(0, colon) !== account.username) throw new Error('accounts_disconnected');
    return { ...metadata, password: decoded.slice(colon + 1) };
  });
  if (!entries.some(a => vaultIdentity(a) === vaultIdentity(owner))) throw new Error('owner_signin_required');
  return { owner: normalizeVaultOwner(owner), accounts: entries,
    defaultAccountId: entries.some(a => generateAccountId(a.username, a.serverUrl) === defaultAccountId) ? defaultAccountId : null };
}
