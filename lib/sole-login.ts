import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';

// Message, folder and conversation ids repeat across logins, so a link, an
// address or a stored tab that names no login says nothing about whose item
// it means once more than one login is around.

/** Whether more than one login is in the account list, signed out entries included. */
export function severalLogins(): boolean {
  return useAccountStore.getState().accounts.length > 1;
}

/**
 * The login an item that names none belongs to: the only login there is,
 * else none. Signed-out entries of the account list count too: the item may
 * be one of theirs.
 */
export function soleLogin(): string | undefined {
  const active = useAuthStore.getState().activeAccountId ?? undefined;
  return severalLogins() ? undefined : active;
}
