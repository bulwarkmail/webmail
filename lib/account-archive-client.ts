import { apiFetch } from '@/lib/browser-navigation';
import { IS_LITE } from '@/lib/lite';
import { generateAccountId, getMaxAccounts } from '@/lib/account-utils';
import { useAccountStore } from '@/stores/account-store';
import type { ArchiveEnvelope, ArchiveOwner, ArchivedAccount } from './account-archive';

async function request(owner: ArchiveOwner, init: RequestInit = {}): Promise<{ envelope?: ArchiveEnvelope | null }> {
  // The archive lives on this app's server; the static Lite build has none.
  if (IS_LITE) throw new Error('disabled');
  const res = await apiFetch('/api/account-archive', {
    cache: 'no-store', ...init,
    headers: {
      'x-archive-username': owner.username, 'x-archive-server': owner.serverUrl,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : 'storage_failed');
  return body;
}

export async function fetchArchive(owner: ArchiveOwner): Promise<ArchiveEnvelope | null> {
  return (await request(owner)).envelope ?? null;
}
export async function putArchive(owner: ArchiveOwner, envelope: ArchiveEnvelope): Promise<void> {
  await request(owner, { method: 'PUT', body: JSON.stringify({ envelope }) });
}
export async function removeArchive(owner: ArchiveOwner): Promise<void> {
  await request(owner, { method: 'DELETE' });
}

/** This browser's accounts as the archive keeps them: no credentials of any kind. */
export function collectAccounts(): ArchivedAccount[] {
  return useAccountStore.getState().accounts.map(a => ({
    username: a.username, serverUrl: a.serverUrl, label: a.label, avatarColor: a.avatarColor,
  }));
}

/**
 * Adds the archived accounts this browser lacks, each waiting for its own
 * sign-in, and gives the ones it has their archived label and colour.
 */
export function restoreAccounts(archived: ArchivedAccount[]): { added: number; updated: number; skipped: number } {
  const store = useAccountStore.getState();
  let added = 0, updated = 0, skipped = 0;
  for (const entry of archived) {
    const id = generateAccountId(entry.username, entry.serverUrl);
    if (store.getAccountById(id)) {
      store.updateAccount(id, { label: entry.label, avatarColor: entry.avatarColor });
      updated++;
      continue;
    }
    if (useAccountStore.getState().accounts.length >= getMaxAccounts()) { skipped++; continue; }
    store.addAccount({
      username: entry.username, serverUrl: entry.serverUrl, authMode: 'basic', rememberMe: false,
      label: entry.label, displayName: entry.label, email: entry.username, lastLoginAt: 0,
      isConnected: false, hasError: true, isDefault: false, awaitingSignIn: true,
    });
    store.updateAccount(id, { avatarColor: entry.avatarColor });
    added++;
  }
  return { added, updated, skipped };
}
