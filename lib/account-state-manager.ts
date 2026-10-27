/**
 * Manages per-account state snapshots for fast switching.
 * When user switches from Account A → B, we snapshot A's store state
 * into memory, clear stores, then restore B's cached state.
 */

import { useEmailStore } from '@/stores/email-store';
import { useContactStore } from '@/stores/contact-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useFilterStore } from '@/stores/filter-store';
import { DEFAULT_SEARCH_FILTERS } from '@/lib/jmap/search-utils';
import { useIdentityStore } from '@/stores/identity-store';
import { useVacationStore } from '@/stores/vacation-store';
import { useFileStore } from '@/stores/file-store';
import { clearContactPhotoCache } from '@/lib/contact-photo-cache';
import { bumpStoreEpoch } from '@/lib/store-epoch';
import { useAccountSecurityStore } from '@/stores/account-security-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Minimal snapshot shapes - we only capture what we need
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StoreSnapshot = Record<string, any>;

interface AccountSnapshot {
  email: StoreSnapshot;
  contact: StoreSnapshot;
  calendar: StoreSnapshot;
  filter: StoreSnapshot;
  identity: StoreSnapshot;
  vacation: StoreSnapshot;
}

const cache = new Map<string, AccountSnapshot>();

/** Capture current store states for the given account */
export function snapshotAccount(accountId: string): void {
  const emailState = useEmailStore.getState();
  const contactState = useContactStore.getState();
  const calendarState = useCalendarStore.getState();
  const filterState = useFilterStore.getState();
  const identityState = useIdentityStore.getState();
  const vacationState = useVacationStore.getState();

  // Copy the captured collections so the snapshot is decoupled from the live
  // store: a later in-place mutation (e.g. an array push/splice, or stamping
  // fields onto a shared email object) must not retroactively corrupt a
  // snapshot taken earlier.
  cache.set(accountId, {
    email: {
      emails: [...emailState.emails],
      mailboxes: [...emailState.mailboxes],
      selectedEmail: emailState.selectedEmail,
      selectedMailbox: emailState.selectedMailbox,
      searchQuery: emailState.searchQuery,
      quota: emailState.quota ? { ...emailState.quota } : emailState.quota,
      // The list is drawn sorted by listOrder, so the rows need the order they
      // were fetched in: without it a restored "unread first" page showed by
      // date and jumped when the refresh landed. The sync state lets that
      // refresh ask only for what changed instead of re-reading the page.
      listOrder: emailState.listOrder,
      emailListSync: emailState.emailListSync,
      threadEmailCounts: new Map(emailState.threadEmailCounts),
    },
    contact: {
      contacts: [...contactState.contacts],
      addressBooks: [...contactState.addressBooks],
      supportsSync: contactState.supportsSync,
    },
    calendar: {
      calendars: [...calendarState.calendars],
      events: [...calendarState.events],
      selectedCalendarIds: [...calendarState.selectedCalendarIds],
      calendarSelectionChosen: calendarState.calendarSelectionChosen,
      knownCalendarIds: calendarState.knownCalendarIds,
      viewMode: calendarState.viewMode,
      supportsCalendar: calendarState.supportsCalendar,
    },
    filter: {
      rules: [...filterState.rules],
      isSupported: filterState.isSupported,
    },
    identity: {
      identities: [...identityState.identities],
      preferredPrimaryId: identityState.preferredPrimaryId,
    },
    vacation: {
      isEnabled: vacationState.isEnabled,
      isSupported: vacationState.isSupported,
    },
  });
}

/**
 * Restore cached store states for the given account. Returns false if no cache
 * exists.
 *
 * The snapshot only captures a subset of each store's fields (the loaded data),
 * so we reset every store to its baseline first. Without this, fields outside
 * the captured subset (e.g. email selection, loading flags, tag counts) would
 * carry over from whatever account was active, leaking state across accounts.
 * `setState` merges, so the captured fields are then layered back on top.
 */
export function restoreAccount(accountId: string): boolean {
  const snapshot = cache.get(accountId);
  if (!snapshot) return false;

  clearAllStores();

  useEmailStore.setState(snapshot.email);
  useContactStore.setState(snapshot.contact);
  useCalendarStore.setState(snapshot.calendar);
  useFilterStore.setState(snapshot.filter);
  useIdentityStore.setState(snapshot.identity);
  useVacationStore.setState(snapshot.vacation);

  return true;
}

/** Clear all stores (used before restoring a different account) */
export function clearAllStores(): void {
  // In-flight fetches of the outgoing account must not land in the stores
  // the next account is about to fill.
  bumpStoreEpoch();
  useEmailStore.setState({
    emails: [],
    mailboxes: [],
    selectedEmail: null,
    selectedMailbox: '',
    isLoading: false,
    error: null,
    searchQuery: '',
    quota: null,
    isPushConnected: false,
    lastPushUpdate: null,
    newEmailNotification: null,
    selectedEmailKeys: new Set<string>(),
    hasMoreEmails: false,
    totalEmails: 0,
    expandedThreadIds: new Set<string>(),
    threadEmailsCache: new Map(),
    isLoadingThread: null,
    selectedKeyword: null,
    tagCounts: {},
    listOrder: [],
    listHold: null,
    emailListSync: null,
    threadEmailCounts: new Map(),
    searchFilters: { ...DEFAULT_SEARCH_FILTERS },
    isAdvancedSearchOpen: false,
  });
  useIdentityStore.getState().clearIdentities();
  useContactStore.getState().clearContacts();
  // Downloaded contact photos are object URLs keyed by blobId; revoke them
  // with the contacts they belong to.
  clearContactPhotoCache();
  useVacationStore.getState().clearState();
  useCalendarStore.getState().clearState();
  useFilterStore.getState().clearState();
  // 2FA state, app passwords and API keys are the account's own: left in
  // place, the page shows them for the next account and "Remove" sends
  // their ids there.
  useAccountSecurityStore.getState().clearState();
  // The Files drive is account-scoped like every store above, but unlike them
  // it lives in a global store that outlives the FilesApp component. If we
  // don't reset it here, the previous account's client + resources linger in
  // memory and resurface (stale) whenever the drive is opened after a switch -
  // even when FilesApp wasn't mounted at switch time (the common case: switch
  // from the mail view, then navigate to Files). Clearing centrally makes the
  // reset happen on every switch path, not just the one the component observes.
  useFileStore.getState().clearClient();
}

/**
 * Drops what the mail list still shows of a login that was signed out while
 * another one stays active: the login's folder, when the Pro sidebar had it
 * open (`viewingAccountId`), for the active login's Inbox, and the login's
 * rows of a list that mixes accounts. Without the login's client every
 * action on those rows fell back to the active login's, where the same ids
 * name other messages: deleting them deleted the active login's mail.
 */
export function forgetAccountRows(accountId: string, activeClient: IJMAPClient | null): void {
  const state = useEmailStore.getState();
  if (state.viewingAccountId === accountId) {
    const inbox = state.mailboxes.find((m) => m.role === 'inbox' && !m.isShared);
    state.selectAccountMailbox(null, inbox?.id ?? '');
    useEmailStore.setState({ emails: [] });
    if (activeClient && inbox) void useEmailStore.getState().fetchEmails(activeClient, inbox.id);
    return;
  }
  const gone = (email: { sourceClientAccountId?: string } | null) => email?.sourceClientAccountId === accountId;
  if (!state.emails.some(gone) && !gone(state.selectedEmail)) return;
  useEmailStore.setState((s) => ({
    emails: s.emails.filter((email) => !gone(email)),
    selectedEmail: gone(s.selectedEmail) ? null : s.selectedEmail,
    // emailKeyFor: "<login>/<account>:<id>".
    selectedEmailKeys: new Set([...s.selectedEmailKeys].filter((key) => !key.startsWith(`${accountId}/`))),
  }));
}

/** Evict cached state for one account */
export function evictAccount(accountId: string): void {
  cache.delete(accountId);
}

/** Evict all cached states */
export function evictAll(): void {
  cache.clear();
}
