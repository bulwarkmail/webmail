import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { generateAccountId } from '@/lib/account-utils';

export function getActiveAccountSlot(): number | null {
  const authState = useAuthStore.getState();
  const accountState = useAccountStore.getState();
  const activeAccountId = authState.activeAccountId ?? accountState.activeAccountId;
  const activeAccount = activeAccountId
    ? accountState.getAccountById(activeAccountId)
    : accountState.getActiveAccount();

  return typeof activeAccount?.cookieSlot === 'number' ? activeAccount.cookieSlot : null;
}

/** The cookie slots of every login in this browser, the open one first. */
export function getAccountSlotsActiveFirst(): number[] {
  const active = getActiveAccountSlot();
  const others = useAccountStore.getState().accounts
    .map((a) => a.cookieSlot)
    .filter((slot) => typeof slot === 'number' && slot !== active);
  return active === null ? others : [active, ...others];
}

export function getActiveAccountSlotHeaders(): Record<string, string> {
  const slot = getActiveAccountSlot();
  return slot === null ? {} : { 'X-JMAP-Cookie-Slot': String(slot) };
}

/**
 * Cookie-slot header for a *specific* account, not whichever one happens to
 * be focused in the UI. Needed for background/aggregated work (e.g. scanning
 * every configured account's calendars) where the active-account slot would
 * silently point the request at the wrong mailbox in multi-account setups.
 *
 * Falls back to the active slot when the account isn't registered in the
 * multi-account store (legacy single-account session).
 */
export function getAccountSlotHeadersFor(username: string, serverUrl: string): Record<string, string> {
  const account = useAccountStore.getState().getAccountById(generateAccountId(username, serverUrl));
  if (typeof account?.cookieSlot === 'number') {
    return { 'X-JMAP-Cookie-Slot': String(account.cookieSlot) };
  }
  return getActiveAccountSlotHeaders();
}