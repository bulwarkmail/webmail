import { apiFetch } from '@/lib/browser-navigation';
import { generateAccountId } from '@/lib/account-utils';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { normalizeVaultOwner, vaultIdentity, type VaultContents, type VaultEnvelope, type VaultOwner, type VaultRecord } from './account-vault';

function headers(owner: VaultOwner): Record<string, string> {
  const normalized = normalizeVaultOwner(owner);
  return { 'x-vault-username': normalized.username, 'x-vault-server': normalized.serverUrl };
}

export async function fetchVault(owner: VaultOwner): Promise<VaultRecord | null> {
  const res = await apiFetch('/api/account-vault', { headers: headers(owner), cache: 'no-store' });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'storage_failed');
  return body.vault;
}

export async function putVault(owner: VaultOwner, envelope: VaultEnvelope, revision: string | null): Promise<VaultRecord> {
  const res = await apiFetch('/api/account-vault', { method: 'PUT',
    headers: { ...headers(owner), 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope, revision }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'storage_failed');
  return body.vault;
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
