import { apiFetch } from '@/lib/browser-navigation';
import { IS_LITE } from '@/lib/lite';
import { generateAccountId, getMaxAccounts } from '@/lib/account-utils';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
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

/**
 * This browser's accounts as the archive keeps them. With `includePasswords`,
 * an account signed in here with a plain password carries it; tokens and
 * accounts not signed in carry nothing.
 */
export function collectAccounts(includePasswords = false): ArchivedAccount[] {
  const auth = useAuthStore.getState();
  return useAccountStore.getState().accounts.map(a => {
    const entry: ArchivedAccount = { username: a.username, serverUrl: a.serverUrl, label: a.label, avatarColor: a.avatarColor };
    const password = includePasswords && a.authMode === 'basic' ? auth.getClientForAccount(a.id)?.getBasicPassword() : null;
    if (password) entry.password = password;
    return entry;
  });
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

/**
 * Restores the list, then signs in one by one to the accounts saved with a
 * password that are not signed in here yet. An account whose password no
 * longer works keeps waiting for a sign-in by hand.
 */
export async function restoreArchive(archived: ArchivedAccount[], rememberMe: boolean) {
  const result = restoreAccounts(archived);
  let signedIn = 0, signInFailed = 0;
  for (const entry of archived) {
    if (!entry.password) continue;
    const id = generateAccountId(entry.username, entry.serverUrl);
    const account = useAccountStore.getState().getAccountById(id);
    if (!account || account.authMode !== 'basic' || useAuthStore.getState().getClientForAccount(id)) continue;
    if (await useAuthStore.getState().signInRestoredAccount(id, entry.password, rememberMe)) signedIn++;
    else signInFailed++;
  }
  const waiting = archived.filter(e => useAccountStore.getState()
    .getAccountById(generateAccountId(e.username, e.serverUrl))?.awaitingSignIn).length;
  return { ...result, signedIn, signInFailed, waiting };
}
