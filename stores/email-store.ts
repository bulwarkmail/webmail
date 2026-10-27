import { ArchiveEmailsError } from "@/lib/jmap/archive-error";
import { RescheduleRestoredError } from "@/lib/jmap/reschedule-error";
import { create } from "zustand";
import { Email, Mailbox, StateChange, ScheduledEmail, SendEmailResult, isUnifiedMailboxId, isCrossViewId } from "@/lib/jmap/types";
import type { UnifiedMailboxRole, CrossView } from "@/lib/jmap/types";
import type { IJMAPClient, SearchEmailsResult } from "@/lib/jmap/client-interface";
import { jmapErrorFailedIds } from "@/lib/jmap/jmap-error";
import type { MessagePriority } from "@/lib/message-priority";
import { withSearchSnippets, type DeferredSnippetBatch } from "@/lib/search-snippet";
import { afterRequestDispatch } from "@/lib/after-request-dispatch";
import { useSettingsStore, getMessageListOrderFor } from "@/stores/settings-store";
import { isMailboxMuted } from "@/lib/notification-mutes";
import { useCalendarStore } from "@/stores/calendar-store";
import { orderKeywords, placeHeldRows, sanitizeSortLevels, type HeldKeywords, type SortLevel } from "@/lib/message-list-order";
import { SearchFilters, DEFAULT_SEARCH_FILTERS, buildJMAPFilter, isFilterEmpty, textFilter } from "@/lib/jmap/search-utils";
import { emailHooks } from "@/lib/plugin-hooks";
import { scheduleAutoMarkAsRead } from "@/lib/mark-as-read-delay";
import { allowEmailMove, createMailboxWithHooks, emitEmailMove, idsFromSelectionKeys, keywordChangeLists, mailboxToView, quotaToView } from "@/lib/plugin-mail-hooks";
import { emailSummary, emailToReadView } from "@/lib/plugin-projection";
import { resolveThreadRoute } from "@/lib/thread-routing";
import { emailKeyFor, threadKeyFor, threadIdFromKey, KEYWORD_PREFIX, KEYWORD_PREFIX_LEGACY } from "@/lib/thread-utils";
import { provideSearchResults, type ProvidedSearchResult } from "@/lib/plugin-search-results";
import { positionsByAccount, fetchUnifiedEmails, fetchUnifiedMailboxCounts, searchUnifiedEmails, advancedSearchUnifiedEmails, fetchCrossViewEmails, searchCrossViewEmails, advancedSearchCrossViewEmails, fetchTagEmails, trashAndJunkIds, searchAcrossAccounts, advancedSearchAcrossAccounts, getCrossUnreadTotal, dedupeUnifiedAccounts, unifiedServerKey, type AcrossAccountsSearchOptions, type UnifiedAccountClient, type UnifiedMailboxCounts } from "@/lib/unified-mailbox";
import { defaultSearchScopeFor, isAllFoldersSearchScope, SEARCH_SCOPE_ALL_FOLDERS } from "@/lib/search-scope-folders";
import { useAuthStore } from "@/stores/auth-store";
import { pathNamesMailFolder } from "@/lib/deep-links";
import { currentStoreEpoch } from "@/lib/store-epoch";
import { folderListKey, forgetFolderLists, rememberFolderList, rememberedFolderList, type FolderList } from "@/lib/folder-list-cache";
import { keywordPointer } from "@/lib/jmap/patch-pointer";
import { useAccountStore } from "@/stores/account-store";
import { useMessageListTabsStore } from "@/stores/message-list-tabs-store";
import { SendCancelledCleanupError } from "@/lib/send-failure-message";
import type { StorageQuota } from "@/lib/quota";
import { isArchiveActionEnabled } from "@/lib/archive-gate";
import {
  READ_FILTER, UNREAD_FILTER, UNREAD_SECTION_SIZE, andFilters, isUnreadFirstView, mergeUnreadSection,
  sectionFromUnreadRows, unreadSectionRowCount, withoutReached, type UnreadSection,
} from "@/lib/unread-first";

type ScheduledSubmissionMetadata = {
  submissionId: string;
  sendAt: string;
  identityId: string;
  undoStatus: 'pending' | 'final' | 'canceled';
  /** Owning JMAP account when the submission lives in a shared account. */
  accountId?: string;
};

const VIRTUAL_SCHEDULED_MAILBOX_ID = '__scheduled__';

type PendingUndoSend = {
  submissionId: string;
  emailId?: string;
  identityId?: string;
  sendAt: string;
  isSmime: boolean;
  /** Local account that owns the submission, when the message was sent from
   *  an identity belonging to a non-active account (#461). */
  localAccountId?: string;
  /** JMAP account holding the submission — the shared account when the message
   *  was sent from a shared identity (#874). Distinct from localAccountId,
   *  which selects *which login's client* to talk to. */
  submissionAccountId?: string;
};

/** Drop the matching emails from a key-based selection. */
function dropFromSelection(
  state: { emails: Email[]; selectedEmailKeys: Set<string> },
  matches: (email: Email) => boolean,
): Set<string> {
  const next = new Set(state.selectedEmailKeys);
  for (const email of state.emails) if (matches(email)) next.delete(emailKeyFor(email));
  return next;
}

/**
 * The emails behind a key-based selection, each once. Looks in the list and in
 * the loaded members of expanded threads: a thread member ticked in a folder
 * view may live in another folder and so never be a list row.
 */
export function resolveSelectedEmails(state: {
  emails: Email[];
  threadEmailsCache: Map<string, Email[]>;
  selectedEmailKeys: Set<string>;
}): Email[] {
  const { selectedEmailKeys } = state;
  if (selectedEmailKeys.size === 0) return [];
  const found = new Map<string, Email>();
  const visit = (email: Email) => {
    const key = emailKeyFor(email);
    if (selectedEmailKeys.has(key) && !found.has(key)) found.set(key, email);
  };
  state.emails.forEach(visit);
  for (const members of state.threadEmailsCache.values()) members.forEach(visit);
  return [...found.values()];
}

/** Enough of an email to key a selection by its owning account. */
type SelectableEmail = Pick<Email, 'id' | 'sourceClientAccountId' | 'sourceAccountId'>;

/**
 * Explicit messages for a batch action, instead of the list selection. A
 * filter rule applied to a folder reaches messages the list never loaded, so
 * they cannot be routed by the list's source stamps.
 */
export interface BatchActionTarget {
  emailIds: string[];
  /** The login client that reaches the messages. */
  client: IJMAPClient;
  /** JMAP account the messages belong to. */
  accountId?: string;
}

interface EmailStore {
  emails: Email[];
  mailboxes: Mailbox[];
  /**
   * Mailbox caches keyed by accountId. Populated for every connected account
   * when the Pro shell is active so the sidebar can render per-account groups
   * Thunderbird-style. The active account's mailboxes still live in
   * `mailboxes` for back-compat with the single-account view.
   */
  accountMailboxes: Record<string, Mailbox[]>;
  /**
   * When set, the mail view is reading from this account instead of the
   * global active one. `null` means "use the global active account" - i.e.
   * the standard single-account behavior. Selecting a folder under a
   * non-active account in the Pro sidebar updates this without changing
   * `useAuthStore.activeAccountId`.
   */
  viewingAccountId: string | null;
  selectedEmail: Email | null;
  selectedMailbox: string;
  isLoading: boolean;
  isLoadingEmail: boolean; // Track when a full email is being fetched
  isLoadingMore: boolean; // Track when loading more emails (pagination)
  error: string | null;
  searchQuery: string;
  quota: StorageQuota | null;
  processingReadStatus: Set<string>; // Track emails being marked as read/unread
  selectedEmailKeys: Set<string>; // Track selected emails for batch operations
  // Emails the user just read (unread view) or unstarred (starred view) that
  // should stay visible in that self-filtering cross view until it is re-opened,
  // instead of vanishing on the next push refresh. In a folder sorted on a
  // keyword (#718): the open conversation's rows and the held ones (listHold),
  // kept although a read/star/tag change moved them past the loaded part of
  // the server order. Cleared on navigation.
  retainedInViewIds: Set<string>;
  hasMoreEmails: boolean; // Track if more emails are available to load
  totalEmails: number; // Total number of emails in the current mailbox/query
  // The configured message-list order the current folder view was fetched
  // with (#718); empty for chronological. Thread grouping mirrors it.
  listOrder: SortLevel[];
  // Whether the list keeps the server's order for listOrder's sender and
  // subject levels: a folder of an account whose server collates them itself
  // (Stalwart 1.0, see JMAPClient.keepsServerTextOrder). Otherwise thread
  // grouping re-sorts them on the client, as the fetch did per page.
  listKeepsServerTextOrder: boolean;
  // The list row opened last and the keywords its messages had then. Its
  // messages sort by those, so reading one in an "unread first" list leaves
  // the row where it was clicked; opening another row releases it. Cleared
  // on navigation.
  listHold: ListHold | null;
  isPushConnected: boolean; // Track if push notifications are connected
  lastPushUpdate: number | null; // Timestamp of last push update
  // Delta sync (RFC 8620 §5.2). The Email collection state the plain
  // single-folder list (`emails`) was last synced at, with the folder it was
  // loaded for; null whenever the list holds anything else (search, tag,
  // category tab, unified/cross view). A push is then resolved with
  // Email/changes against this state instead of re-querying the first page.
  emailListSync: EmailListSync | null;
  // Mountain View's "Unread first" inbox (lib/unread-first.ts): which rows of
  // `emails` are the Unread section's. Null in every other view.
  unreadSection: UnreadSection | null;
  // Mailbox collection state per JMAP account the sidebar list was last
  // synced at, so a Mailbox push can be resolved with Mailbox/changes.
  mailboxSyncStates: Record<string, string>;
  newEmailNotification: Email | null; // New email notification for toast

  // Thread expansion state
  // Thread state is keyed by the account-scoped thread key (threadKeyFor), not
  // the bare JMAP id: in aggregate views the same id names unrelated threads
  // in different accounts. Same for threadEmailCounts below.
  expandedThreadIds: Set<string>;
  threadEmailsCache: Map<string, Email[]>;
  isLoadingThread: string | null;
  // Full thread email counts (from Thread/get across all folders)
  threadEmailCounts: Map<string, number>;

  // Keyword/tag filter
  selectedKeyword: string | null;
  tagCounts: Record<string, { total: number; unread: number }>;

  // Advanced search state
  searchFilters: SearchFilters;
  // Folder the search is scoped to; "" means all folders. Deliberately kept
  // separate from selectedMailbox so that opening the search panel inside a
  // folder does not silently narrow the search to it, and so an explicit
  // choice survives navigating the mail list (#788).
  searchMailboxId: string;
  // Set when a folder's unread count scoped the search to that folder: the
  // scope then moves with the open folder, the way the search itself does
  // (#553). A scope picked in the dropdown or a filter reset clears it.
  searchScopeFollowsFolder: boolean;
  isAdvancedSearchOpen: boolean;
  searchAbortController: AbortController | null;
  /** Plugins' results from elsewhere for the search running (onProvideSearchResults), drawn above its list. */
  externalSearchResults: ProvidedSearchResult[];

  // Unified mailbox state
  // Bumped by any action that changes which mailbox/keyword/unified view is
  // active. fetchUnifiedEmails/fetchCrossView capture it before their async
  // fetch and check it on return, so a late-resolving fetch from a view the
  // user already navigated away from can't stomp the newer view's state (#1102).
  // Callers that await before starting one of those fetches check it with
  // captureViewToken().
  viewToken: number;
  isUnifiedView: boolean;
  unifiedRole: UnifiedMailboxRole | null;
  // Cross-account view ('unread' | 'starred' | 'all') when active; null for the
  // per-role unified views. Mutually exclusive with unifiedRole; both run under
  // isUnifiedView.
  crossView: CrossView | null;
  unifiedErrors: Map<string, string>; // accountId -> error message
  // Unified-section sidebar badges. These are NOT an independent source of
  // truth: they are a pure projection of the live per-account mailbox lists
  // (`mailboxes` + `accountMailboxes`) over the last-known unified scope
  // (`unifiedScope`). Recomputed automatically whenever those lists change (see
  // the store subscription below), so optimistic delete/move/markRead patches and
  // push-driven mailbox refreshes flow into the badges without a server round
  // trip. (#281 follow-up: single source of truth for unified counters.)
  unifiedCounts: UnifiedMailboxCounts[];
  // Unread total across the cross-view included folders (badge for unread/all).
  crossUnreadCount: number;
  // The account/folder structure (which accounts, role mailboxes, cross-include
  // selection) that the unified badges are projected over. Set by
  // refreshUnifiedCounts/refreshCrossCounts from the freshly-built
  // UnifiedAccountClient[]. The COUNTER values it carries are ignored at
  // projection time - live counters are read from `mailboxes`/`accountMailboxes`
  // instead - so a stale snapshot here only affects structure, never numbers.
  unifiedScope: UnifiedAccountClient[];

  // Scheduled send state
  scheduledEmails: ScheduledEmail[];
  scheduledEmailIds: Set<string>;
  /** By login, account and email id (scheduledEmailKey). */
  scheduledSubmissionByEmailId: Map<string, ScheduledSubmissionMetadata>;
  scheduledTotal: number;
  scheduledHasMore: boolean;
  scheduledNextPosition: number;
  /** Pending scheduled-send counts per JMAP account (server-side, all pages). */
  scheduledTotalByAccount: Record<string, number>;
  isLoadingScheduled: boolean;
  isScheduledView: boolean;
  /**
   * When set, the scheduled view is narrowed to one JMAP account — the shared
   * account whose "Scheduled" row was clicked. null = the combined view.
   */
  scheduledAccountScope: string | null;
  pendingUndoSend: PendingUndoSend | null;

  setEmails: (emails: Email[]) => void;
  setMailboxes: (mailboxes: Mailbox[]) => void;
  /** Cache or update the mailbox list for a specific account. */
  setAccountMailboxes: (accountId: string, mailboxes: Mailbox[]) => void;
  /** Wipe the per-account mailbox cache (e.g. on logout). */
  clearAccountMailboxes: () => void;
  setViewingAccount: (accountId: string | null) => void;
  /**
   * Atomic version of (setViewingAccount + selectMailbox). Pass `null` for
   * the active account; pass an accountId to view a non-active account's
   * folder without changing the global active account.
   */
  selectAccountMailbox: (accountId: string | null, mailboxId: string) => void;
  /**
   * Fetch mailboxes via the supplied client and store them under
   * `accountMailboxes[accountId]`. Used by the Pro shell to populate the
   * sidebar's per-account groups for every connected account. With
   * `clientAccountId`, `accountId` is a JMAP account reached through that
   * login, and the list is also stored as that source's (sourceMailboxes).
   */
  fetchAccountMailboxes: (client: IJMAPClient, accountId: string, clientAccountId?: string) => Promise<void>;
  selectEmail: (email: Email | null) => void;
  /**
   * Shows a list row in the viewer while its body is on its way: selects it
   * and marks the body loading in one store write, so the click renders once.
   * Plugins hear onEmailOpen only from finishOpenEmail, with the full message:
   * a row has no body, headers or attachments to show them.
   */
  beginOpenEmail: (row: Email) => void;
  /** The fetched message replaces the row beginOpenEmail showed (one write). */
  finishOpenEmail: (email: Email) => void;
  /** The fetch failed: back to what was open before, without the loading state. */
  abandonOpenEmail: (previous: Email | null) => void;
  /** Holds a list row in place (see listHold); `rowKey` as from listRowKey. */
  holdListRow: (rowKey: string) => void;
  selectMailbox: (mailboxId: string) => void;
  setLoading: (loading: boolean) => void;
  setLoadingEmail: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setSearchQuery: (query: string) => void;
  setQuota: (quota: StorageQuota | null) => void;
  selectKeyword: (keyword: string | null) => void;
  fetchTagCounts: (client: IJMAPClient) => Promise<void>;
  /** Take the email, not its id: the id alone collides across accounts. */
  toggleEmailSelection: (email: SelectableEmail) => void;
  selectRangeEmails: (target: SelectableEmail) => void;
  /**
   * Shift+Arrow (and Shift+J/K): grow or shrink the selection by one row,
   * from the open or last ticked message, like a desktop mail client. (#992)
   */
  extendSelection: (direction: 1 | -1) => void;
  lastSelectedEmailKey: string | null;
  /**
   * The moving end of a keyboard range and the anchor it was taken from.
   * Only valid while the anchor is still lastSelectedEmailKey.
   */
  selectionFocus: { anchor: string; focus: string } | null;
  /**
   * The message list's rows in screen order, each with the keys a click on it
   * selects. Shift-click ranges walk these, so a thread is in a range only
   * when its row is, not whenever one of its messages falls between the two
   * ends by date. (#1230)
   */
  listRows: ListRow[] | null;
  setListRows: (rows: ListRow[] | null) => void;
  selectAllEmails: () => void;
  clearSelection: () => void;

  // JMAP operations
  fetchMailboxes: (client: IJMAPClient) => Promise<void>;
  fetchEmails: (client: IJMAPClient, mailboxId?: string, opts?: { background?: boolean }) => Promise<void>;
  // Eager post-login bootstrap: fires mailboxes/quota/emails so the round-trips
  // overlap with Next's soft-nav + home-page hydration. Safe to call multiple
  // times; later calls are no-ops while a prior one is in flight.
  prefetchInitialData: (client: IJMAPClient) => Promise<void>;
  loadMoreEmails: (client: IJMAPClient) => Promise<void>;
  /** `ownerAccountId`: the JMAP account a link names for the message (#1351). */
  fetchEmailContent: (client: IJMAPClient, emailId: string, ownerAccountId?: string) => Promise<Email | null>;
  fetchQuota: (client: IJMAPClient) => Promise<void>;
  sendEmail: (client: IJMAPClient, to: string[], subject: string, body: string, cc?: string[], bcc?: string[], identityId?: string, fromEmail?: string, draftId?: string, fromName?: string, htmlBody?: string, attachments?: Array<{ blobId: string; name: string; type: string; size: number; disposition?: 'attachment' | 'inline'; cid?: string }>, inReplyTo?: string[], references?: string[], delayedUntil?: string, envelopeMailFrom?: string, options?: { requestReadReceipt?: boolean; requestDsn?: boolean; requireTls?: boolean; priority?: MessagePriority; localAccountId?: string; draftAccountId?: string }) => Promise<SendEmailResult>;
  sendRawEmail: (client: IJMAPClient, rawMimeBlob: Blob, identityId: string, delayedUntil?: string, envelopeRecipients?: string[]) => Promise<SendEmailResult>;
  /** `emailKey` (emailKeyFor of the row) picks the right row when the id repeats across accounts. */
  deleteEmail: (client: IJMAPClient, emailId: string, forceDelete?: boolean, emailKey?: string) => Promise<boolean>;
  /** `emailKey` (emailKeyFor of the row) picks the right row when the id repeats across accounts. */
  markAsRead: (client: IJMAPClient, emailId: string, read: boolean, emailKey?: string) => Promise<boolean>;
  /** `emailKey` (emailKeyFor of the row) picks the right row when the id repeats across accounts. */
  moveToMailbox: (client: IJMAPClient, emailId: string, mailboxId: string, emailKey?: string) => Promise<boolean>;
  /**
   * Move a single email, routing across the account boundary when the
   * destination folder is owned by a different JMAP account (a delegated/shared
   * mailbox, or a different connected account) — the "Move to" context-menu
   * equivalent of what drag-and-drop already does. Falls back to the plain
   * single-account `moveToMailbox` when source and destination share an account.
   */
  moveToMailboxCrossAware: (client: IJMAPClient, emailId: string, mailboxId: string, emailKey?: string) => Promise<boolean>;
  /**
   * `destLocalAccountId`: the login whose folder list `mailboxId` is from (a
   * drop target in the multi-account sidebar); by default the active one's.
   * `rows`: the rows that were dragged. Only a list that mixes accounts needs
   * them: an id alone can name rows of several accounts there.
   */
  moveEmailsToMailbox: (client: IJMAPClient, emailIds: string[], mailboxId: string, destLocalAccountId?: string | null, rows?: Email[]) => Promise<boolean>;
  /** `emailKey` (emailKeyFor of the row) picks the right row when the id repeats across accounts. */
  moveThreadToMailbox: (client: IJMAPClient, emailId: string, mailboxId: string, emailKey?: string) => Promise<boolean>;
  /**
   * Take messages out of the open folder only, leaving them in their other
   * folders (#615). Acts on those of `emails` that removalFolder and
   * canRemoveFromFolder allow; resolves false when none qualify or a plugin
   * said no.
   */
  removeFromMailbox: (client: IJMAPClient, emails: Email[]) => Promise<boolean>;
  /**
   * Move emails across JMAP accounts. JMAP has no native cross-account move,
   * so for each email we fetch the source's raw RFC822 blob, import it into
   * the destination account's target mailbox, then delete the original.
   * `emailIdsBySource` maps each source accountId to the emails it owns;
   * pass the active account's id explicitly (no `__default__` sentinel).
   * `destMailboxId` is the raw JMAP id on the destination server (not the
   * `accountId:mailboxId` namespace used for shared folders).
   * `destJmapAccountId` overrides the destination client's primary account
   * for the import — used when dropping into a delegated/shared mailbox that
   * is owned by a different JMAP account but accessed through the same
   * client (i.e. there is no separate connected client for the owner).
   * `sourceJmapAccountId` is the mirror image for the source side: when the
   * emails live in a delegated/shared mailbox accessed through the source
   * client, the copy/delete must target the owner's JMAP account rather than
   * the source client's primary one.
   * `options.keepOriginal` turns the move into a copy: the originals stay in
   * place and in the current view.
   */
  crossAccountMoveEmails: (
    emailIdsBySource: Map<string, string[]>,
    destAccountId: string,
    destMailboxId: string,
    destJmapAccountId?: string,
    sourceJmapAccountId?: string,
    options?: { keepOriginal?: boolean },
  ) => Promise<boolean>;
  /**
   * Copy emails into a folder of another connected account, keeping the
   * originals. `destAccountId` is the destination login (AccountEntry.id) and
   * `destMailboxId` the raw JMAP id of one of its own folders. Emails are
   * grouped by the login and JMAP account they live in, then copied through
   * crossAccountMoveEmails with `keepOriginal`.
   */
  /** Pass emails rather than ids where you have them: an id alone can name another account's namesake. */
  copyEmailsToAccount: (emails: Array<string | Email>, destAccountId: string, destMailboxId: string) => Promise<void>;
  searchEmails: (client: IJMAPClient, query: string) => Promise<void>;
  /**
   * Runs the search held in searchQuery/searchFilters. `transformed` is the
   * query and filters onSearch already returned for this search (searchEmails
   * hands over when a plugin added filters), so plugins are not asked twice.
   */
  advancedSearch: (client: IJMAPClient, transformed?: { query: string; filters: SearchFilters }) => Promise<void>;
  setSearchFilters: (filters: Partial<SearchFilters>) => void;
  setSearchMailboxId: (mailboxId: string) => void;
  scopeSearchToOpenFolder: () => void;
  clearSearchFilters: () => void;
  toggleAdvancedSearch: () => void;
  /** `emailKey` (emailKeyFor of the row) picks the right row when the id repeats across accounts. */
  toggleStar: (client: IJMAPClient, emailId: string, emailKey?: string) => Promise<boolean>;
  /** `emailKey` (emailKeyFor of the row) picks the right row when the id repeats across accounts. */
  setEmailKeywords: (client: IJMAPClient, emailId: string, keywords: Record<string, boolean>, emailKey?: string) => Promise<boolean>;
  /**
   * Set (true) or clear (false) just the named keywords. Every other keyword
   * is left as the server has it.
   */
  patchEmailKeywords: (client: IJMAPClient, emailId: string, changes: Record<string, boolean>, emailKey?: string) => Promise<boolean>;
  /**
   * `source`: the login and account the message was read in, taken where the
   * reply, forward or receipt started. By the time it is sent another folder
   * may be open, with another account's message under the same id.
   */
  markEmailKeyword: (client: IJMAPClient, emailId: string, keyword: string, source?: EmailWriteSource) => Promise<void>;
  /** `emailKey` (emailKeyFor of the row) picks the right row when the id repeats across accounts. */
  setEmailKeywordsLocal: (emailId: string, keywords: Record<string, boolean>, emailKey?: string) => void;

  // Batch operations
  /** Acts on the selection, or on `target`'s messages when given. */
  batchMarkAsRead: (client: IJMAPClient, read: boolean, target?: BatchActionTarget) => Promise<boolean>;
  /**
   * Put a tag on, or take it off, every selected message. Their other tags
   * and keywords stay as they are, and so does the selection, so several
   * tags can be applied in a row. Rejects when a write fails. (#1077)
   */
  batchSetTag: (client: IJMAPClient, tagId: string, add: boolean) => Promise<boolean>;
  batchDelete:(client: IJMAPClient, permanent?: boolean) => Promise<boolean>;
  /**
   * Acts on the selection, or on `target`'s messages when given; with a
   * target, `mailboxId` is the destination's JMAP id in that account.
   */
  batchMoveToMailbox: (client: IJMAPClient, mailboxId: string, target?: BatchActionTarget) => Promise<boolean>;
  batchArchive: (client: IJMAPClient) => Promise<boolean>;

  // Spam operations
  // For unified-view emails the undo must hit the same account: `accountId` is the
  // owning JMAP account (passed to JMAP), `sourceClientAccountId` is the login the
  // email is reachable through (used to pick the right client). (#281)
  spamUndoCache: Map<string, { emailId: string; originalMailboxId: string; accountId?: string; sourceClientAccountId?: string }>;
  /** `emailKey` (emailKeyFor of the row) picks the right row when the id repeats across accounts. */
  markAsSpam: (client: IJMAPClient, emailId: string, emailKey?: string) => Promise<boolean>;
  /** `emailKey` (emailKeyFor of the row) picks the right row when the id repeats across accounts. */
  undoSpam: (client: IJMAPClient, emailId: string, emailKey?: string) => Promise<boolean>;
  batchMarkAsSpam: (client: IJMAPClient, emailIds: string[]) => Promise<boolean>;
  batchUndoSpam: (client: IJMAPClient, emailIds: string[]) => Promise<boolean>;

  // Push notification handlers
  setPushConnected: (connected: boolean) => void;
  handleStateChange: (change: StateChange, client: IJMAPClient) => Promise<void>;
  /**
   * Resolve an Email push for the current list with Email/changes: drop
   * destroyed rows, re-fetch and patch updated ones in place, and only fall
   * back to a full first-page refresh (returns false) when mail entered the
   * view, the delta is too large, or the view is not a plain folder list.
   */
  applyEmailDelta: (client: IJMAPClient, newState: string) => Promise<boolean>;
  /**
   * Resolve a Mailbox push with Mailbox/changes: re-fetch only the folders
   * reported as updated (typically just their counters) and patch them into
   * the sidebar list. Returns false when a full refetch is needed (folders
   * created/destroyed, unknown sync state, delta unavailable).
   */
  applyMailboxDelta: (client: IJMAPClient, changed: StateChange['changed']) => Promise<boolean>;
  refreshCurrentMailbox: (client: IJMAPClient) => Promise<void>;
  handleNewEmailNotification: (email: Email) => void;
  clearNewEmailNotification: () => void;

  // Thread expansion actions
  toggleThreadExpansion: (threadKey: string) => void;
  fetchThreadEmails: (client: IJMAPClient, threadKey: string) => Promise<Email[]>;
  collapseAllThreads: () => void;
  updateThreadCache: (threadId: string, emails: Email[]) => void;
  fetchThreadEmailCounts: (client: IJMAPClient) => Promise<void>;
  markThreadAsRead: (client: IJMAPClient, threadKey: string) => Promise<void>;
  /**
   * Marks an expanded thread read the way the reading pane marks a message:
   * following `markAsReadDelay` (never / instantly / after a delay). A delayed
   * mark is dropped when the thread is collapsed first.
   */
  autoMarkExpandedThreadAsRead: (client: IJMAPClient, threadKey: string) => void;
  /**
   * Drops a still-pending delayed mark for the thread, without collapsing it.
   * Used when the user moves on to a message outside that thread.
   */
  cancelAutoMarkThreadAsRead: (threadKey: string) => void;

  // Mailbox management
  createMailbox: (client: IJMAPClient, name: string, parentId?: string, accountId?: string) => Promise<boolean>;
  renameMailbox: (client: IJMAPClient, mailboxId: string, name: string) => Promise<boolean>;
  deleteMailbox: (client: IJMAPClient, mailboxId: string, options?: { removeEmails?: boolean }) => Promise<boolean>;
  setMailboxRole: (client: IJMAPClient, mailboxId: string, role: string | null) => Promise<void>;
  reorderMailboxes: (client: IJMAPClient, orderedIds: string[]) => Promise<void>;
  moveMailbox: (client: IJMAPClient, mailboxId: string, newParentId: string | null, orderedSiblingIds?: string[]) => Promise<void>;
  /** Reparents several folders at once; resolves with the ids the server refused. */
  moveMailboxes: (client: IJMAPClient, mailboxIds: string[], newParentId: string | null) => Promise<string[]>;
  emptyMailbox: (client: IJMAPClient, mailboxId: string) => Promise<boolean>;
  /** How many messages were marked read; null when a plugin stopped it. */
  markMailboxAsRead: (client: IJMAPClient, mailboxId: string) => Promise<number | null>;
  /** Every unread message in the account; null when a plugin stopped it. */
  markAllMailboxesAsRead: (client: IJMAPClient) => Promise<number | null>;

  // Unified mailbox operations
  fetchUnifiedEmails: (accounts: UnifiedAccountClient[], role: UnifiedMailboxRole) => Promise<void>;
  loadMoreUnifiedEmails: (accounts: UnifiedAccountClient[]) => Promise<void>;
  refreshUnifiedCounts: (accounts: UnifiedAccountClient[]) => Promise<void>;
  exitUnifiedView: () => void;
  // Cross-account view operations (unread / starred / all)
  fetchCrossView: (accounts: UnifiedAccountClient[], view: CrossView) => Promise<void>;
  refreshCrossCounts: (accounts: UnifiedAccountClient[]) => void;

  fetchScheduledEmails: (client: IJMAPClient) => Promise<void>;
  loadMoreScheduledEmails: (client: IJMAPClient) => Promise<void>;
  cancelScheduledEmail: (client: IJMAPClient, submissionId: string, emailId?: string) => Promise<void>;
  cancelScheduledEmailForEdit: (client: IJMAPClient, email: ScheduledEmail | Email) => Promise<Email | null>;
  /** `accountId`: the row's scheduledAccountId. Submission ids repeat across accounts. */
  rescheduleScheduledEmail: (client: IJMAPClient, submissionId: string, emailId: string, identityId: string, delayedUntil: string, accountId?: string) => Promise<SendEmailResult>;
  cancelUndoSend: (client: IJMAPClient, pending: PendingUndoSend) => Promise<Email | null>;
  clearPendingUndoSend: () => void;
  refreshScheduledMetadata: (client: IJMAPClient) => Promise<void>;
  setScheduledView: (isScheduledView: boolean, accountScope?: string | null) => void;

  // Mock data for demo
  loadMockData: () => void;
}

// Helper: compute the next email to select when removing one from the list
function getNextSelectedEmailAfterRemoval(state: { emails: Email[]; selectedEmail: Email | null }, removedEmailIds: Set<string>): Email | null {
  if (!state.selectedEmail || !removedEmailIds.has(state.selectedEmail.id)) {
    return state.selectedEmail;
  }

  const idx = state.emails.findIndex(e => e.id === state.selectedEmail?.id);
  if (idx === -1) return null;

  for (let nextIndex = idx + 1; nextIndex < state.emails.length; nextIndex++) {
    const candidate = state.emails[nextIndex];
    if (!removedEmailIds.has(candidate.id)) {
      return candidate;
    }
  }

  for (let prevIndex = idx - 1; prevIndex >= 0; prevIndex--) {
    const candidate = state.emails[prevIndex];
    if (!removedEmailIds.has(candidate.id)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Matches the list row a single-email action is about. Email ids repeat across
 * accounts, so in a merged view (unified inbox, tags) the bare id also matches
 * the other account's namesake: deleting one row moved or hid the other as
 * well (#857). With the row's `emailKeyFor` key only that row matches.
 */
function singleEmailMatcher(emailId: string, emailKey?: string): (email: Email) => boolean {
  return emailKey ? (email) => emailKeyFor(email) === emailKey : (email) => email.id === emailId;
}

/** getNextSelectedEmail for the one row `isRemoved` matches. */
function getNextSelectedEmailAfterRemovingRow(
  state: { emails: Email[]; selectedEmail: Email | null },
  isRemoved: (email: Email) => boolean,
): Email | null {
  const selected = state.selectedEmail;
  if (!selected || !isRemoved(selected)) return selected;

  const selectedKey = emailKeyFor(selected);
  let idx = state.emails.findIndex(e => emailKeyFor(e) === selectedKey);
  if (idx === -1) idx = state.emails.findIndex(e => e.id === selected.id);
  if (idx === -1) return null;

  for (let nextIndex = idx + 1; nextIndex < state.emails.length; nextIndex++) {
    if (!isRemoved(state.emails[nextIndex])) return state.emails[nextIndex];
  }
  for (let prevIndex = idx - 1; prevIndex >= 0; prevIndex--) {
    if (!isRemoved(state.emails[prevIndex])) return state.emails[prevIndex];
  }
  return null;
}

function annotateScheduledEmails(
  emails: Email[],
  scheduledSubmissionByEmailId: Map<string, ScheduledSubmissionMetadata>
): Email[] {
  if (scheduledSubmissionByEmailId.size === 0) return emails;
  return emails.map(email => annotateScheduledEmail(email, scheduledSubmissionByEmailId));
}

/**
 * Key of a scheduled send in `scheduledSubmissionByEmailId`: the login and the
 * JMAP account of the message, and its id. Email ids repeat across accounts,
 * so by the bare id a row of another account got the badge, and its Send now,
 * Reschedule and Cancel acted on this message's submission.
 */
function scheduledEmailKey(clientAccountId: string | undefined, accountId: string | undefined, emailId: string): string {
  return `${clientAccountId ?? ''}|${accountId ?? ''}|${emailId}`;
}

/** The scheduled sends `client` listed, by scheduledEmailKey. */
function scheduledSubmissionMap(client: IJMAPClient, emails: ScheduledEmail[]): Map<string, ScheduledSubmissionMetadata> {
  const auth = useAuthStore.getState();
  const login = [...auth.getAllConnectedClients()].find(([, c]) => c === client)?.[0] ?? auth.activeAccountId ?? undefined;
  return new Map(emails.map(email => [scheduledEmailKey(login, email.scheduledAccountId ?? client.getAccountId(), email.id), {
    submissionId: email.emailSubmissionId,
    sendAt: email.scheduledSendAt,
    identityId: email.scheduledIdentityId,
    undoStatus: email.scheduledUndoStatus,
    accountId: email.scheduledAccountId,
  }]));
}

function annotateScheduledEmail(
  email: Email,
  scheduledSubmissionByEmailId: Map<string, ScheduledSubmissionMetadata>
): Email {
  // The row's login and account: its stamps, else the folder on screen.
  const { client, clientAccountId, accountId } = resolveEmailBlobContext(email, useAuthStore.getState().client);
  const scheduled = scheduledSubmissionByEmailId.get(scheduledEmailKey(clientAccountId, accountId ?? client?.getAccountId(), email.id));
  if (!scheduled) return email;
  return {
    ...email,
    scheduledSendAt: scheduled.sendAt,
    emailSubmissionId: scheduled.submissionId,
    scheduledIdentityId: scheduled.identityId,
    scheduledUndoStatus: scheduled.undoStatus,
    scheduledAccountId: scheduled.accountId,
    isScheduled: true,
  };
}

/** One scheduled send: submission and email ids repeat across accounts. */
function isSameScheduledSend(a: ScheduledEmail, b: ScheduledEmail): boolean {
  return a.emailSubmissionId === b.emailSubmissionId && a.scheduledAccountId === b.scheduledAccountId;
}

function shouldClearPendingUndoSend(pending: PendingUndoSend | null, scheduledEmails: ScheduledEmail[]): boolean {
  if (!pending) return false;
  const pendingSendTime = new Date(pending.sendAt).getTime();
  if (Number.isFinite(pendingSendTime) && pendingSendTime <= Date.now()) return true;
  const scheduledEmail = scheduledEmails.find(email => email.emailSubmissionId === pending.submissionId);
  return scheduledEmail?.scheduledUndoStatus !== undefined && scheduledEmail.scheduledUndoStatus !== 'pending';
}

/**
 * When the mail view is showing a non-active account (Pro shell's
 * Thunderbird-style sidebar), redirect read/write operations to that
 * account's JMAP client and mailbox cache. Returns the passed-in values
 * unchanged for the standard single-account flow.
 *
 * Compose/send still routes through the caller's client (the active
 * account), since identity binding for cross-account sending is a separate
 * concern.
 */
// ---------------------------------------------------------------------------
// In-flight refresh coalescing
//
// One push event fans out into the same refreshes back to back: a drop
// handler's refreshCurrentMailbox and the push echo's, fetchMailboxes for the
// Mailbox change, fetchTagCounts, fetchThreadEmailCounts - and every open tab
// repeats the set. Stalwart caps parallel requests per user
// (maxConcurrentRequests, default 4) and refuses the surplus with
// jmap:error:limit, which used to blank the sidebar's folder tree (#780).
//
// Callers that arrive while a run is in flight share its promise, and at most
// ONE follow-up run is queued so a caller whose state change postdates the
// in-flight request still ends up seeing fresh data. Keyed per client so two
// accounts' refreshes never collapse into each other.
// ---------------------------------------------------------------------------
type InFlightRefresh = { promise: Promise<void>; rerun: boolean };
const inFlightRefreshes = new WeakMap<object, Map<string, InFlightRefresh>>();

/**
 * Drafts and Sent of the account a submission belongs to. A message sent or
 * scheduled from a shared or group identity lives in that account, so
 * restoring it to Drafts must use that account's Drafts - the store's own
 * list is the login account's (plus shared mailboxes under namespaced ids).
 */
async function submissionMailboxes(
  client: IJMAPClient,
  storeMailboxes: Mailbox[],
  accountId: string | undefined,
): Promise<{ draftsMailbox?: Mailbox; sentMailbox?: Mailbox }> {
  const ownAccount = !accountId || accountId === client.getAccountId();
  const mailboxes = ownAccount
    ? (storeMailboxes.length > 0 ? storeMailboxes : await client.getMailboxes()).filter(mb => !mb.isShared)
    : await client.getMailboxes(accountId);
  return {
    draftsMailbox: mailboxes.find(mb => mb.role === 'drafts'),
    sentMailbox: mailboxes.find(mb => mb.role === 'sent'),
  };
}

function coalesceRefresh(client: IJMAPClient, key: string, run: () => Promise<void>): Promise<void> {
  let byKey = inFlightRefreshes.get(client);
  if (!byKey) {
    byKey = new Map();
    inFlightRefreshes.set(client, byKey);
  }
  const existing = byKey.get(key);
  if (existing) {
    existing.rerun = true;
    return existing.promise;
  }
  const entry: InFlightRefresh = { promise: Promise.resolve(), rerun: false };
  const registry = byKey;
  entry.promise = (async () => {
    try {
      await run();
      while (entry.rerun) {
        entry.rerun = false;
        await run();
      }
    } finally {
      registry.delete(key);
    }
  })();
  registry.set(key, entry);
  return entry.promise;
}

/** See EmailStore.listHold. */
export interface ListHold {
  rowKey: string;
  keywords: HeldKeywords;
}

/**
 * The list row an email is shown in: its thread, or the email itself when the
 * list is not threaded - the same key EmailList groups by.
 */
export function listRowKey(email: Email, isScheduledView: boolean): string {
  return useSettingsStore.getState().disableThreading || isScheduledView ? email.id : threadKeyFor(email);
}

/** Delta-sync baseline of the plain folder list (see EmailStore.emailListSync). */
export interface EmailListSync {
  /** Email collection state the list was last synced at. */
  state: string;
  /** JMAP account the folder belongs to (owner account for a shared folder). */
  accountId: string;
  /** Store id of the folder the list shows (namespaced for shared folders). */
  mailboxId: string;
}

// Upper bound on the ids one Email/changes delta may report before the list
// is re-queried instead: past this a first-page fetch is cheaper than
// resolving every id. Also passed as `maxChanges`, so the server signals
// `hasMoreChanges` rather than returning a huge delta.
const EMAIL_DELTA_MAX_CHANGES = 200;
// Ids outside the loaded list (created, or updated elsewhere) that are
// resolved to see whether they entered the folder; more than this and the
// refresh path is used directly.
const EMAIL_DELTA_MAX_CANDIDATES = 50;

let emailDeltaQueue: Promise<void> = Promise.resolve();

type StoreGet = () => EmailStore;
type StoreSet = (partial: Partial<EmailStore> | ((state: EmailStore) => Partial<EmailStore>)) => void;

/** Whether this folder view is Mountain View's "Unread first" inbox. */
function unreadFirstFor(
  mailbox: Mailbox | undefined,
  s: Pick<EmailStore, 'selectedKeyword' | 'searchQuery' | 'searchFilters' | 'isUnifiedView'>,
): boolean {
  const { interfaceLayout, mvInboxType } = useSettingsStore.getState();
  return isUnreadFirstView({
    interfaceLayout,
    mvInboxType,
    mailboxRole: mailbox?.role,
    otherView: !!s.selectedKeyword || !!s.searchQuery || !isFilterEmpty(s.searchFilters) || s.isUnifiedView,
  });
}

/**
 * What a folder's query ANDs in: the open category tab's filter, and read
 * mail only in the "Unread first" inbox, whose unread mail is the section's.
 */
function folderListFilter(
  mailbox: Mailbox | undefined,
  s: Pick<EmailStore, 'selectedKeyword' | 'searchQuery' | 'searchFilters' | 'isUnifiedView'>,
): Record<string, unknown> | null {
  const categoryFilter = useMessageListTabsStore.getState().getCategoryFilter(mailbox?.role);
  return andFilters(categoryFilter, unreadFirstFor(mailbox, s) ? READ_FILTER : null);
}

/** The newest unread mail of the folder, for the "Unread first" inbox. */
async function loadUnreadSection(client: IJMAPClient, mailbox: Mailbox, get: StoreGet): Promise<{ emails: Email[]; total: number }> {
  const effectiveClient = resolveActionClient(client);
  const accountId = mailbox.isShared ? mailbox.accountId : undefined;
  const categoryFilter = useMessageListTabsStore.getState().getCategoryFilter(mailbox.role);
  const result = await effectiveClient.getEmails(
    mailbox.originalId || mailbox.id,
    accountId,
    UNREAD_SECTION_SIZE,
    0,
    undefined,
    true,
    andFilters(categoryFilter, UNREAD_FILTER) ?? undefined,
    [],
  );
  const emails = await emailHooks.onEmailsFetched.transform(result.emails);
  return { emails: annotateScheduledEmails(emails, get().scheduledSubmissionByEmailId), total: result.total };
}

function notifyNewInboxMail(client: IJMAPClient, mailbox: Mailbox, email: Email, get: StoreGet) {
  // A muted Inbox (or account) stays quiet in the app too (#1169).
  const accountId = mailbox.accountId || resolveActionClient(client).getAccountId();
  const muted = isMailboxMuted(
    useSettingsStore.getState().notificationMutes, accountId, mailbox.originalId || mailbox.id,
  );
  if (!muted) get().handleNewEmailNotification(email);
}

function applyUnreadSection(get: StoreGet, set: StoreSet, mailboxId: string, loaded: { emails: Email[]; total: number }) {
  const { emails, unreadSection, selectedEmail } = get();
  const merged = mergeUnreadSection(emails, unreadSection, loaded.emails, selectedEmail ? threadKeyFor(selectedEmail) : null);
  set({ emails: merged.emails, unreadSection: { mailboxId, ids: merged.ids, total: loaded.total } });
}

/**
 * After a local read/star/tag change: re-query a folder list sorted on one of
 * the changed keywords (#718). The change moves the row at once, possibly past
 * the end of what is loaded, but nothing moves the rows from beyond it up -
 * reading the top unread mail over and over ran out of unread mail after the
 * first page while more waited on the server.
 */
function refillAfterKeywordChange(get: StoreGet, client: IJMAPClient, changed: Iterable<string>): void {
  const s = get();
  if (s.isUnifiedView || s.isScheduledView || s.selectedKeyword || s.searchQuery || !isFilterEmpty(s.searchFilters)) return;
  const sortKeywords = orderKeywords(s.listOrder);
  if (![...changed].some((keyword) => sortKeywords.includes(keyword))) return;
  void s.refreshCurrentMailbox(client);
}

async function applyEmailDeltaNow(client: IJMAPClient, newState: string | null, get: StoreGet, set: StoreSet): Promise<boolean> {
  const s = get();
  const sync = s.emailListSync;
  if (!sync) return false;
  // Anything but the plain folder list the baseline was taken for is
  // refreshed the old way: a server-side filter (search, tag, category tab)
  // cannot be re-evaluated from a list of changed ids, and the unified /
  // cross-account views fan out over several accounts.
  if (
    s.isUnifiedView ||
    s.isScheduledView ||
    s.selectedKeyword ||
    s.searchQuery ||
    !isFilterEmpty(s.searchFilters) ||
    s.selectedMailbox !== sync.mailboxId
  ) {
    return false;
  }
  const mailboxes = resolveActionMailboxes();
  const mailbox = mailboxes.find((mb) => mb.id === sync.mailboxId);
  if (folderListFilter(mailbox, s)) return false;
  const effectiveClient = resolveActionClient(client);
  if (!effectiveClient.getEmailChanges) return false;
  // The push carries the state we already hold (our own Email/set raised it,
  // or a duplicate notification): nothing to do, and no request either. A
  // null newState (a folder repainted from memory) only the server can judge.
  if (newState !== null && sync.state === newState) return true;

  const accountArg = mailbox?.isShared ? mailbox.accountId : undefined;
  const delta = await effectiveClient.getEmailChanges(sync.state, accountArg, EMAIL_DELTA_MAX_CHANGES);
  if (!delta || delta.hasMoreChanges) return false;

  const listIds = new Set(s.emails.map((e) => e.id));
  const destroyedInList = delta.destroyed.filter((id) => listIds.has(id));
  const updatedInList = delta.updated.filter((id) => listIds.has(id));
  // Ids we don't show may have entered the folder (new mail, a move into it,
  // an undelete). Resolve them; if any lands here, the first page must be
  // re-queried so it is inserted at its sorted position and the new-mail
  // notification fires as before.
  const candidates = [...delta.created, ...delta.updated.filter((id) => !listIds.has(id))];
  if (candidates.length > EMAIL_DELTA_MAX_CANDIDATES) return false;
  if (candidates.length > 0) {
    const arrived = await effectiveClient.getSomeEmails(candidates, accountArg);
    if (arrived.some((e) => e.mailboxIds?.[sync.mailboxId])) return false;
  }

  const removed = new Set(destroyedInList);
  const updatedEmails = updatedInList.length > 0 ? await effectiveClient.getSomeEmails(updatedInList, accountArg) : [];
  const updatedById = new Map(updatedEmails.map((e) => [e.id, e]));
  // Another client changed the read/star/tag state a keyword order (#718)
  // sorts on: the row may now belong past the loaded part of the list and an
  // unloaded one in its place, which patching rows in place cannot show.
  const sortKeywords = orderKeywords(s.listOrder);
  if (sortKeywords.length > 0) {
    const localById = new Map(s.emails.map((e) => [e.id, e]));
    const moved = updatedEmails.some((fresh) => {
      const local = localById.get(fresh.id);
      return local && sortKeywords.some((k) => !!local.keywords?.[k] !== !!fresh.keywords?.[k]);
    });
    if (moved) return false;
  }
  for (const id of updatedInList) {
    const fresh = updatedById.get(id);
    // Gone from the folder (moved/deleted) or gone entirely since the delta.
    if (!fresh || !fresh.mailboxIds?.[sync.mailboxId]) removed.add(id);
  }
  const replacements = await emailHooks.onEmailsFetched.transform(
    [...updatedById.values()].filter((e) => !removed.has(e.id)),
  );
  const replacementById = new Map(
    annotateScheduledEmails(replacements, get().scheduledSubmissionByEmailId).map((e) => [e.id, e]),
  );

  // Nothing on the page changed: advance the baseline and leave the list be,
  // rather than hand it a new array that renders the same rows again.
  if (removed.size === 0 && replacementById.size === 0) {
    set((state) => ({
      emailListSync: state.emailListSync?.mailboxId === sync.mailboxId ? { ...sync, state: delta.newState } : state.emailListSync,
    }));
    return true;
  }

  // Re-read the list: the requests above may have overlapped a user action.
  const current = get().emails;
  const next = current
    .filter((e) => !removed.has(e.id))
    .map((e) => replacementById.get(e.id) ?? e);
  const changedThreadIds = new Set<string>();
  for (const e of current) {
    if (removed.has(e.id) || replacementById.has(e.id)) changedThreadIds.add(threadKeyFor(e));
  }
  for (const e of replacementById.values()) changedThreadIds.add(threadKeyFor(e));

  set((state) => {
    const threadEmailsCache = new Map(state.threadEmailsCache);
    for (const tid of changedThreadIds) threadEmailsCache.delete(tid);
    const totalEmails = Math.max(state.totalEmails - (current.length - next.length), next.length);
    // A total below the rows shown is one the server did not give (#1364).
    const totalKnown = state.totalEmails >= current.length;
    return {
      emails: next,
      totalEmails,
      hasMoreEmails: state.hasMoreEmails && (!totalKnown || next.length < totalEmails),
      threadEmailsCache,
      emailListSync: state.emailListSync?.mailboxId === sync.mailboxId ? { ...sync, state: delta.newState } : state.emailListSync,
    };
  });
  return true;
}

// ─── New mail for plugins (onNewEmailReceived) ───────────────────────────────
//
// A message is new mail when Email/changes reports it as created and it sits
// in the Inbox. A move into the Inbox (undo spam, a drag, unarchive) keeps
// its id and shows up as updated, and the initial load is the baseline, so
// neither is reported. The check runs on its own baseline, independent of
// whichever folder or view is open.

/** Email state per JMAP account up to which new mail was reported. */
const newMailBaselines = new Map<string, string>();
/** Recently reported ids, so an overlapping delta never reports one twice. */
const reportedNewMail: string[] = [];
let newMailQueue: Promise<void> = Promise.resolve();
const NEW_MAIL_MAX_PAGES = 5;

function reportNewInboxMail(client: IJMAPClient, accountId: string, pushedState: string, seedState: string | undefined, get: StoreGet): Promise<void> {
  const run = async () => {
    const since = newMailBaselines.get(accountId) ?? seedState;
    // Nobody listens: keep the baseline current so a plugin that starts
    // listening later is not handed old mail.
    if (emailHooks.onNewEmailReceived.size === 0 || !client.getEmailChanges || !since) {
      newMailBaselines.set(accountId, pushedState);
      return;
    }
    if (since === pushedState) return;
    const created: string[] = [];
    let state = since;
    for (let page = 0; page < NEW_MAIL_MAX_PAGES; page++) {
      const delta = await client.getEmailChanges(state, undefined, EMAIL_DELTA_MAX_CHANGES);
      if (!delta) {
        // The baseline is too old for the server; start over from here.
        newMailBaselines.set(accountId, pushedState);
        return;
      }
      created.push(...delta.created);
      state = delta.newState;
      if (!delta.hasMoreChanges) break;
    }
    newMailBaselines.set(accountId, state);
    const fresh = created.filter(id => !reportedNewMail.includes(id));
    if (fresh.length === 0) return;
    const inbox = get().mailboxes.find(mb => mb.role === 'inbox' && !mb.isShared);
    if (!inbox) return;
    const inboxIds = [inbox.id, inbox.originalId].filter((id): id is string => !!id);
    const emails = await client.getSomeEmails(fresh);
    for (const email of emails) {
      if (email.keywords?.$draft || !inboxIds.some(id => email.mailboxIds?.[id])) continue;
      reportedNewMail.push(email.id);
      if (reportedNewMail.length > 500) reportedNewMail.shift();
      void emailHooks.onNewEmailReceived.emit(emailSummary(email));
    }
  };
  const next = newMailQueue.then(run, run).catch((error) => {
    console.error('Failed to check for new mail:', error);
  });
  newMailQueue = next;
  return next;
}

/** Let plugins change a search before it runs (onSearch); keeps what they return only when it is usable. */
async function transformSearch(query: string, filters: SearchFilters): Promise<{ query: string; filters: SearchFilters }> {
  const out = await emailHooks.onSearch.transform({ query, filters: { ...filters } }) as { query?: unknown; filters?: unknown } | null;
  return {
    query: typeof out?.query === 'string' ? out.query : query,
    filters: out?.filters && typeof out.filters === 'object'
      ? { ...DEFAULT_SEARCH_FILTERS, ...(out.filters as Partial<SearchFilters>) }
      : filters,
  };
}

/** Overlapping state-change runs share one syncing/idle cycle (onSyncStateChange). */
let syncRuns = 0;

function resolveActionClient(passedClient: IJMAPClient): IJMAPClient {
  const viewingId = useEmailStore.getState().viewingAccountId;
  if (!viewingId) return passedClient;
  const c = useAuthStore.getState().getClientForAccount(viewingId);
  return c ?? passedClient;
}

/**
 * The client of the login a row is stamped with. Never another login's once
 * that one is gone: its ids name other messages there.
 */
function stampedClient(clientAccountId: string): IJMAPClient {
  const client = useAuthStore.getState().getClientForAccount(clientAccountId);
  if (!client) throw new Error('Not connected');
  return client;
}

/**
 * Thrown by archive actions when no archive folder exists in the target
 * account. Callers map it to the translated
 * `email_viewer.archive_mailbox_not_found` toast; a silent return left the
 * user with a shortcut/button that did nothing. (#578)
 */
export class ArchiveMailboxNotFoundError extends Error {
  constructor() {
    super('Archive mailbox not found - cannot archive email');
    this.name = 'ArchiveMailboxNotFoundError';
  }
}

/**
 * Puts a message whose send was cancelled back in Drafts, out of Sent, where
 * the send filed it as soon as the submission was created.
 *
 * `accountId` is the account the message was sent from. Mail sent from a
 * group or shared identity lives in that account, beside its submission, and
 * goes back to that account's Drafts. Email ids repeat across accounts, so the
 * user's own account may hold an unrelated message under the same id.
 */
async function restoreSentToDraft(client: IJMAPClient, known: Mailbox[], emailId: string, accountId?: string): Promise<void> {
  const { draftsMailbox, sentMailbox } = await submissionMailboxes(client, known, accountId);
  if (!draftsMailbox) return;
  const draftsId = draftsMailbox.originalId || draftsMailbox.id;
  const sentId = sentMailbox?.originalId || sentMailbox?.id;
  if (accountId) {
    await client.restoreEmailToDraft(emailId, draftsId, sentId, accountId);
  } else {
    await client.restoreEmailToDraft(emailId, draftsId, sentId);
  }
}

/**
 * Archive folder for a single-email or batch archive.
 *
 * `accountId` pins the owning account (unified view). Otherwise the selected
 * mailbox decides: a shared/group folder scopes the lookup to its owner, an own
 * folder to non-shared mailboxes. The user's own Archive is listed first in the
 * merged own+shared list, so an unscoped `find` would pair the shared owner's
 * accountId with a foreign mailbox id and Stalwart rejects the move. (#889)
 */
export function findArchiveMailbox(
  mailboxes: Mailbox[],
  selectedMailboxId: string | null | undefined,
  accountId?: string,
): Mailbox | undefined {
  const viewMailbox = mailboxes.find(m => m.id === selectedMailboxId);
  const scopeId = accountId ?? (viewMailbox?.isShared ? viewMailbox.accountId : undefined);
  const isArchive = (m: Mailbox) => m.role === 'archive' || m.name.toLowerCase() === 'archive';
  return mailboxes.find(m =>
    isArchive(m) && (scopeId ? m.accountId === scopeId : !m.isShared)
  );
}

/**
 * Archive folder for the action, created when the account has none.
 *
 * Stalwart's default folder set has no archive-role mailbox, so on a fresh
 * account the Archive button and shortcut only raised the not-found toast.
 * The folder is created in the account the action targets (see
 * findArchiveMailbox) with the `archive` role, so the sidebar shows it under
 * its translated name and other clients recognise it. `refresh` reloads the
 * mailbox list so the caller gets the store's own object (namespaced id,
 * `originalId`) rather than the bare one Mailbox/set returned. (#578)
 */
export async function ensureArchiveMailbox(opts: {
  client: IJMAPClient;
  mailboxes: Mailbox[];
  selectedMailboxId: string | null | undefined;
  accountId?: string;
  refresh: () => Promise<Mailbox[]>;
}): Promise<Mailbox | null> {
  // The admin turned the Archive action off (#1257): never archive, never create the folder.
  if (!isArchiveActionEnabled()) return null;
  const existing = findArchiveMailbox(opts.mailboxes, opts.selectedMailboxId, opts.accountId);
  if (existing) return existing;

  const viewMailbox = opts.mailboxes.find(m => m.id === opts.selectedMailboxId);
  const scopeId = opts.accountId ?? (viewMailbox?.isShared ? viewMailbox.accountId : undefined);
  const mailCapability = opts.client.getAccountCapability?.('urn:ietf:params:jmap:mail', scopeId) as
    { mayCreateTopLevelMailbox?: boolean } | undefined;
  // Only an explicit account-level denial prevents creating the root Archive.
  // Existing Archives (and their year/month child folders) are unaffected.
  if (mailCapability?.mayCreateTopLevelMailbox === false) throw new ArchiveMailboxNotFoundError();
  // null: a plugin refused the new folder (and said why).
  if (!(await createMailboxWithHooks(opts.client, 'Archive', undefined, scopeId, { role: 'archive' }))) return null;

  const created = findArchiveMailbox(await opts.refresh(), opts.selectedMailboxId, opts.accountId);
  if (!created) throw new ArchiveMailboxNotFoundError();
  return created;
}

/**
 * JMAP accountId for opening an email that carries no source stamps.
 *
 * Normally the selected folder decides: a shared/group folder's owner, else
 * the account's own (undefined). During an unscoped ("All folders") search
 * the hits come from the primary account even while a shared folder is
 * selected, so deriving the owner from that folder asks the wrong account and
 * `getEmail` returns nothing. In that case the caller's own account is used.
 * (#923) Since #1082 the unscoped search stamps its hits with their source
 * account (own or shared), so this only decides for the rare unstamped row,
 * e.g. one a plugin added to the results.
 */
export function resolveUnstampedEmailAccountId(opts: {
  mailboxes: Mailbox[];
  selectedMailbox: string | null | undefined;
  searchActive: boolean;
  searchMailboxId: string;
}): string | undefined {
  if (opts.searchActive && isAllFoldersSearchScope(opts.searchMailboxId)) return undefined;
  const mailbox = opts.mailboxes.find(mb => mb.id === opts.selectedMailbox);
  return mailbox?.isShared ? mailbox.accountId : undefined;
}

function mailboxesInView(state: Pick<EmailStore, 'viewingAccountId' | 'accountMailboxes' | 'mailboxes'>): Mailbox[] {
  if (state.viewingAccountId) {
    return state.accountMailboxes[state.viewingAccountId] ?? state.mailboxes;
  }
  return state.mailboxes;
}

function resolveActionMailboxes(): Mailbox[] {
  return mailboxesInView(useEmailStore.getState());
}

/** Resolve blobs from the message's source, or the folder being browsed. */
/** One row of the message list: its own key and the keys selecting it selects. */
export interface ListRow {
  key: string;
  members: string[];
}

/** The row a key belongs to: the row it names, else the first row holding it. */
function findListRow(rows: ListRow[], key: string): number {
  const own = rows.findIndex((row) => row.key === key);
  return own !== -1 ? own : rows.findIndex((row) => row.members.includes(key));
}

export interface EmailBlobContext {
  client: IJMAPClient | null;
  accountId?: string;
  clientAccountId?: string;
}

/** The login and JMAP account (undefined: the login's own) a message is in. */
export type EmailWriteSource = Pick<EmailBlobContext, 'clientAccountId' | 'accountId'>;

export function resolveEmailBlobContext(
  email: Pick<Email, 'sourceClientAccountId' | 'sourceAccountId'> | null,
  passedClient: IJMAPClient | null,
): EmailBlobContext {
  const state = useEmailStore.getState();
  const auth = useAuthStore.getState();
  const clientAccountId = email?.sourceClientAccountId ?? state.viewingAccountId ?? undefined;
  // A stamped login must never fall back to another account: blob ids can collide.
  const client = clientAccountId
    ? auth.getClientForAccount(clientAccountId) ?? null
    : passedClient;
  const accountId = email?.sourceAccountId ?? resolveUnstampedEmailAccountId({
    mailboxes: mailboxesInView(state),
    selectedMailbox: state.selectedMailbox,
    searchActive: !!state.searchQuery || !isFilterEmpty(state.searchFilters),
    searchMailboxId: state.searchMailboxId,
  });
  return {
    client,
    accountId,
    clientAccountId: clientAccountId ?? (client === auth.client ? auth.activeAccountId ?? undefined : undefined),
  };
}

/** The login and account of a row in the view on screen now (resolveEmailBlobContext). */
export function emailWriteSource(email: Pick<Email, 'sourceClientAccountId' | 'sourceAccountId'>, passedClient: IJMAPClient | null): EmailWriteSource {
  const { clientAccountId, accountId } = resolveEmailBlobContext(email, passedClient);
  return { clientAccountId, accountId };
}

/**
 * What a link to a row in the view on screen names besides its id, as ids
 * repeat across accounts and logins (#1351): the JMAP account when it is not
 * the login's own, the login when it is not the active one.
 */
export function emailLinkSource(email: Pick<Email, 'sourceClientAccountId' | 'sourceAccountId'>): { ownerAccountId: string | null; loginId: string | null } {
  const auth = useAuthStore.getState();
  const { client, accountId, clientAccountId } = resolveEmailBlobContext(email, auth.client);
  return {
    ownerAccountId: accountId && accountId !== client?.getAccountId() ? accountId : null,
    loginId: clientAccountId && clientAccountId !== auth.activeAccountId ? clientAccountId : null,
  };
}

// List requests can finish after navigation. Never apply an old folder/tag
// response (or error) to the view the user has since selected.
/**
 * The plain folder list on screen and the key it is remembered under (see
 * lib/folder-list-cache). Null while the rows showing belong to no folder
 * list - a search, a tag, a unified view, or a folder still loading.
 */
let shownFolderList: { key: string; mailboxId: string; pageSize: number } | null = null;

/**
 * The initial data load login() started for this client (prefetchInitialData):
 * the promise while it runs, 'done' (once) after it loaded the mailboxes and a page.
 * The mail view's own bootstrap joins or skips it rather than sending the
 * same Mailbox/get, folder page and tag counts a second time.
 */
export function pendingInitialData(client: IJMAPClient): Promise<void> | 'done' | undefined {
  const target = client as IJMAPClient & { __prefetchPromise?: Promise<void>; __initialDataLoaded?: boolean };
  if (target.__prefetchPromise) return target.__prefetchPromise;
  // Good for the one bootstrap that follows the login; any later one (an
  // account switch back to this client) refreshes as before.
  if (!target.__initialDataLoaded) return undefined;
  delete target.__initialDataLoaded;
  return 'done';
}

/** What a folder's list is remembered as (see lib/folder-list-cache). */
function folderListState(s: EmailStore): FolderList {
  return {
    emails: s.emails,
    totalEmails: s.totalEmails,
    hasMoreEmails: s.hasMoreEmails,
    sync: s.emailListSync,
    threadEmailCounts: s.threadEmailCounts,
  };
}

/** The list row beginOpenEmail put in the viewer, until its message arrives. */
let openingRow: Email | null = null;

// Pending delayed "mark thread read" timers, by thread key. Collapsing the
// thread, or opening a message outside it, cancels its timer.
const pendingThreadReads = new Map<string, () => void>();

function cancelPendingThreadRead(threadKey?: string): void {
  const keys = threadKey === undefined ? [...pendingThreadReads.keys()] : [threadKey];
  for (const key of keys) {
    pendingThreadReads.get(key)?.();
    pendingThreadReads.delete(key);
  }
}

/**
 * The per-thread message counts to store once a page arrived: the counts that
 * page brought along (Thread/get chained onto its query) under the keys the
 * list groups threads by, merged over `current`. Empty when it brought none,
 * so the caller knows to ask for them separately.
 */
function threadCountsPatch(
  emails: Email[],
  counts: Record<string, number> | undefined,
  current: Map<string, number>,
): { threadEmailCounts: Map<string, number> } | Record<string, never> {
  if (!counts) return {};
  const merged = new Map(current);
  for (const email of emails) {
    if (!email.threadId) continue;
    const count = counts[email.threadId];
    if (count !== undefined) merged.set(threadKeyFor(email), count);
  }
  return { threadEmailCounts: merged };
}

function captureEmailListView(): () => boolean {
  const view = useEmailStore.getState();
  const activeAccountId = useAuthStore.getState().activeAccountId;
  const epoch = currentStoreEpoch();
  return () => {
    const current = useEmailStore.getState();
    return currentStoreEpoch() === epoch
      && current.selectedMailbox === view.selectedMailbox
      && current.selectedKeyword === view.selectedKeyword
      && current.viewingAccountId === view.viewingAccountId
      && current.isUnifiedView === view.isUnifiedView
      && current.unifiedRole === view.unifiedRole
      && current.crossView === view.crossView
      && useAuthStore.getState().activeAccountId === activeAccountId;
  };
}

// fetchUnifiedEmails/fetchCrossView start a new view generation of their own,
// so they cannot tell that the user left while the caller was still awaiting
// something (e.g. the unified account list). Such callers capture this before
// the await and skip the fetch if it reports false; otherwise the unified view
// is switched back on over the folder the user picked meanwhile (#1102).
export function captureViewToken(): () => boolean {
  const token = useEmailStore.getState().viewToken;
  return () => useEmailStore.getState().viewToken === token;
}

/**
 * The owner JMAP accountId of the shared/group folder currently being viewed
 * directly (the "Shared" sidebar section, non-unified), or `undefined` for a
 * normal own-account view. Emails in this view are undecorated (no
 * `sourceAccountId`) and are reached through the ACTIVE client, but their
 * mutations must carry this accountId — otherwise JMAP `Email/set` is sent to
 * the user's own account, where it silently no-ops (Stalwart returns the ids as
 * `updated: null` with an unchanged state, not `notUpdated`) and the change is
 * lost on the next reload. Mirrors `fetchEmails` and the single-email path.
 */
function resolveViewAccountId(): string | undefined {
  const state = useEmailStore.getState();
  const mb = resolveActionMailboxes().find(m => m.id === state.selectedMailbox);
  return mb?.isShared ? mb.accountId : undefined;
}

/**
 * Resolve a store-side mailbox id to the JMAP mutation target.
 *
 * Shared/group mailboxes use namespaced ids in the store (`accountId:id`) so
 * ids from different accounts cannot collide. JMAP `Mailbox/set`, however,
 * needs the owner's bare mailbox id plus the owner's accountId. The shared
 * account is still reached through the active/viewing login client; it does
 * not have a separately connected client of its own.
 *
 * If the owner also has a directly connected login on the same server, use that
 * client's primary account. Otherwise (the usual delegated/group case), keep
 * the active/viewing client and pass the owner's accountId explicitly.
 */
function resolveMailboxMutationContext(
  passedClient: IJMAPClient,
  storeMailboxId: string,
): {
  client: IJMAPClient;
  mailboxId: string;
  accountId: string | undefined;
  ownerAccountId: string | undefined;
} {
  const state = useEmailStore.getState();
  const actionMailboxes = resolveActionMailboxes();
  const mailbox = actionMailboxes.find((mb) => mb.id === storeMailboxId)
    ?? state.mailboxes.find((mb) => mb.id === storeMailboxId)
    ?? Object.values(state.accountMailboxes).flat().find((mb) => mb.id === storeMailboxId);

  // No live mailbox object (a concurrent refresh dropped the shared account
  // while a rename/create prompt was open, or a caller passed a stale id):
  // recover the owner and the bare id from the namespaced store id itself.
  // Without this the raw `accountId:id` would be sent as a mailbox id AND the
  // owner would be lost, so the mutation - including the role-clearing sweep
  // in setMailboxRole - would be applied to the active personal account.
  const parsed = mailbox ? undefined : parseNamespacedMailboxId(storeMailboxId);

  const ownerAccountId = mailbox?.accountId ?? parsed?.accountId;
  const accountTarget = resolveMailboxAccountTarget(passedClient, ownerAccountId);

  return {
    ...accountTarget,
    mailboxId: mailbox?.originalId || parsed?.mailboxId || storeMailboxId,
    ownerAccountId,
  };
}

/**
 * Split a namespaced shared-mailbox store id (`${accountId}:${mailboxId}`)
 * back into its parts. Bare (personal) ids carry no separator and yield
 * `undefined`, which keeps them on the personal path.
 */
function parseNamespacedMailboxId(
  storeMailboxId: string,
): { accountId: string; mailboxId: string } | undefined {
  const separator = storeMailboxId.indexOf(':');
  if (separator <= 0 || separator === storeMailboxId.length - 1) return undefined;
  return {
    accountId: storeMailboxId.slice(0, separator),
    mailboxId: storeMailboxId.slice(separator + 1),
  };
}

function resolveMailboxAccountTarget(
  passedClient: IJMAPClient,
  ownerAccountId?: string,
): { client: IJMAPClient; accountId: string | undefined } {
  const client = resolveActionClient(passedClient);
  if (!ownerAccountId || client.getAccountId() === ownerAccountId) {
    return { client, accountId: undefined };
  }

  // A directly connected owner login can act on its own primary account. Match
  // it on server URL as well as account id: JMAP account ids are opaque
  // per-server values, so two logins on different servers can share one id and
  // matching on the id alone would route the mutation to a foreign server -
  // where that bare mailbox id may well exist and belong to someone else.
  const serverUrl = client.getServerUrl();
  for (const candidate of useAuthStore.getState().getAllConnectedClients().values()) {
    if (candidate.getAccountId() === ownerAccountId && candidate.getServerUrl() === serverUrl) {
      return { client: candidate, accountId: undefined };
    }
  }

  // The usual delegated/group case: reach the owner through the active client.
  return { client, accountId: ownerAccountId };
}

/**
 * Resolves the store-side mailbox ids that make up a personal account's
 * contribution to the unified cross views (All mail / Unread / Starred), honoring
 * that account's `allMailFolderIds` folder selection. Returns `undefined` when the
 * account has no explicit selection, so the cross views fall back to their
 * role-exclusion default (inbox + custom folders). An explicit `[]` selection
 * yields an empty list (no own folders). `ownMailboxes` must already exclude
 * shared folders - the picker only ever scopes the user's own folders.
 */
function resolveCrossIncludedMailboxIds(accountId: string, ownMailboxes: Mailbox[]): string[] | undefined {
  const configured = useSettingsStore.getState().allMailFolderIds[accountId];
  if (configured === undefined) return undefined;
  const selected = new Set(configured);
  return ownMailboxes.filter((mb) => selected.has(mb.id)).map((mb) => mb.id);
}

/**
 * Resolves the JMAP client, mailbox list, and JMAP accountId to use for a
 * single-email action.
 *
 * In aggregate views each email is decorated with its source reference:
 * `sourceClientAccountId` (the logged-in client it is reachable through) and
 * `sourceAccountId` (the owning JMAP account). The mutation must be routed to
 * that client/account, or it is sent to the active account whose server doesn't
 * know the id, so JMAP `Email/set` silently returns `notUpdated` and the change
 * is lost on the next reload (issue #281). We always pass `sourceAccountId` as
 * the JMAP accountId: for personal sources it equals the client's primary (a
 * no-op, no namespacing), for shared/group sources it targets the owner. The
 * owner's mailbox list (cached by `buildUnifiedAccountClients` under the login
 * and that JMAP id, see sourceMailboxes) resolves role-based destinations like
 * trash/archive.
 *
 * For the normal single-account / viewing-account flow this preserves the
 * existing behavior exactly: the active/viewing client, its mailbox list, and
 * the shared-mailbox accountId derived from the currently selected mailbox.
 */
export function resolveEmailActionContext(
  email: { sourceClientAccountId?: string; sourceAccountId?: string },
  passedClient: IJMAPClient,
): { client: IJMAPClient; mailboxes: Mailbox[]; accountId: string | undefined } {
  const state = useEmailStore.getState();
  // In aggregate views every email is decorated with its source reference:
  // `sourceClientAccountId` (the login client it is reachable through) and
  // `sourceAccountId` (the owning JMAP account). These are unambiguous across
  // personal and shared/group sources, so resolution is the same three lines for
  // both - no id-space guessing, no capability scan. For personal sources
  // `sourceAccountId` equals the client's primary, so passing it to JMAP is a
  // no-op (matches the previous `accountId: undefined` behavior exactly).
  // The stamps are honored whenever present, not only while `isUnifiedView`
  // is set: a stamped email (e.g. the open selection) can outlive the flag, and
  // bare ids collide across accounts, so the active client is never a safe
  // substitute for the stamped one, also not once that login is gone. (#847)
  if (email.sourceClientAccountId && email.sourceAccountId) {
    return {
      client: stampedClient(email.sourceClientAccountId),
      mailboxes: sourceMailboxes(state, email.sourceClientAccountId, email.sourceAccountId),
      accountId: email.sourceAccountId,
    };
  }
  const mailboxes = resolveActionMailboxes();
  const currentMailbox = mailboxes.find((mb) => mb.id === state.selectedMailbox);
  return {
    client: resolveActionClient(passedClient),
    mailboxes,
    accountId: currentMailbox?.isShared ? currentMailbox.accountId : undefined,
  };
}

/**
 * Resolution for a keyword write, by email id.
 *
 * Same routing as `resolveEmailActionContext`, but only when the email is
 * actually known to the store. A keyword write can be triggered for a message
 * that is NOT the current selection - a Pro tab fetches its own email and does
 * not go through `selectedEmail` - and for those the selected mailbox says
 * nothing about the message's owner. Guessing from it would send an own-account
 * write to a shared account whenever a shared folder happened to be open, so an
 * unknown email keeps the previous behaviour instead: no explicit accountId,
 * i.e. the reaching client's own account.
 */
export function resolveKeywordActionContext(
  emailId: string,
  passedClient: IJMAPClient,
  emailKey?: string,
): { client: IJMAPClient; accountId: string | undefined } {
  const state = useEmailStore.getState();
  // By the row's key when given: in a merged view the bare id also matches
  // another account's namesake, whose account would receive the write.
  const isTarget = singleEmailMatcher(emailId, emailKey);
  const email = state.emails.find(isTarget)
    ?? (state.selectedEmail && isTarget(state.selectedEmail) ? state.selectedEmail : undefined);
  if (!email) return { client: passedClient, accountId: undefined };
  const { client, accountId } = resolveEmailActionContext(email, passedClient);
  return { client, accountId };
}

/**
 * Local account id ("user@host") whose connected client owns `mailbox`.
 * `mailbox.accountId` is the JMAP server's opaque id; map it back to a local
 * client id, falling back to the viewing/active account — a delegated/shared
 * folder has no separately-connected client, it's reached through the viewer's.
 * Mirrors resolveDestAccountId in use-mailbox-drop.ts.
 */
function resolveDestLocalAccountId(mailbox: Mailbox): string | null {
  const jmapId = mailbox.accountId;
  if (jmapId) {
    for (const [localId, client] of useAuthStore.getState().getAllConnectedClients()) {
      if (client.getAccountId() === jmapId) return localId;
    }
  }
  return useEmailStore.getState().viewingAccountId ?? useAuthStore.getState().activeAccountId;
}

/**
 * Builds the `UnifiedAccountClient[]` list used by every unified fan-out
 * action (browse, load-more, search). Each entry has a JMAP client plus a
 * fresh mailbox list so the helpers can resolve the role mailbox per account.
 * Accounts whose mailbox fetch fails are skipped - the unified result will
 * surface that in its per-account error map.
 *
 * When `includeGroup` is true, also emits one synthetic entry per shared
 * owner account reachable through each logged-in client. The shared entries
 * are flagged with `isShared: true` so `lib/unified-mailbox.ts` routes JMAP
 * requests via `originalId` + owner accountId.
 *
 * When `scopeToClientAccountId` is set, only the matching logged-in account
 * (and the shared owners reachable through its client) is built - this keeps
 * the unified mailbox within a single account boundary. Omitting it spans every
 * logged-in account (the cross-account sub-option).
 *
 * Personal entries carry `crossIncludedMailboxIds` derived from the account's
 * `allMailFolderIds` folder selection, restricting the All mail / Unread /
 * Starred cross views to the chosen own folders (shared entries are left
 * unrestricted so all their folders are included).
 *
 * A folder reachable through several logins (owner + grantee, or two grantees)
 * is kept only once - see `dedupeUnifiedAccounts`.
 */
/**
 * Folder lists of the logins in the unified scope, shared between builds.
 *
 * The scope is rebuilt on every connection while a browser restores its
 * logins, on every background push and on every unified browse, load-more and
 * search - and each build used to ask every login for its folders again, one
 * login after the other. With ten logins that was ten full `Mailbox/get`s per
 * build and over a hundred in the first seconds. A list is now fetched once,
 * shared by every build that wants it while in flight, and reused until that
 * login reports a change (see {@link invalidateUnifiedMailboxes}, called from
 * the push handlers). The time limit is a backstop for a change whose push was
 * lost, not the freshness mechanism.
 */
const UNIFIED_MAILBOX_TTL_MS = 60_000;
let unifiedMailboxGeneration = 0;
const unifiedMailboxCache = new WeakMap<object, Map<boolean, { at: number; generation: number; promise: Promise<Mailbox[]> }>>();

/**
 * `fresh` is true only for the build that started the fetch. Only that build
 * publishes the list into `accountMailboxes`: a reused one may be older than
 * what the store holds now - optimistic updates land there directly - and
 * writing it back would snap a just-changed counter back to its old value.
 */
async function unifiedMailboxesFor(
  client: IJMAPClient,
  includeGroup: boolean,
): Promise<{ mailboxes: Mailbox[]; fresh: boolean }> {
  let perClient = unifiedMailboxCache.get(client);
  if (!perClient) {
    perClient = new Map();
    unifiedMailboxCache.set(client, perClient);
  }
  const hit = perClient.get(includeGroup);
  if (hit && hit.generation === unifiedMailboxGeneration && Date.now() - hit.at < UNIFIED_MAILBOX_TTL_MS) {
    return { mailboxes: await hit.promise, fresh: false };
  }
  const entry = {
    at: Date.now(),
    generation: unifiedMailboxGeneration,
    promise: includeGroup ? client.getAllMailboxes() : client.getMailboxes(),
  };
  perClient.set(includeGroup, entry);
  const slot = perClient;
  entry.promise.catch(() => {
    if (slot.get(includeGroup) === entry) slot.delete(includeGroup);
  });
  return { mailboxes: await entry.promise, fresh: true };
}

/**
 * Puts one login's folder list into `accountMailboxes` through the same cache
 * the unified scope uses, so the two never fetch the same list twice and a
 * list already there is not fetched again until that login reports a change.
 */
export async function loadAccountMailboxes(client: IJMAPClient, accountId: string): Promise<boolean> {
  try {
    const { mailboxes, fresh } = await unifiedMailboxesFor(client, false);
    if (!fresh && useEmailStore.getState().accountMailboxes[accountId]) return true;
    useEmailStore.setState((state) => ({
      accountMailboxes: { ...state.accountMailboxes, [accountId]: mailboxes.slice() },
    }));
    return true;
  } catch (error) {
    console.error(`Failed to fetch mailboxes for account ${accountId}:`, error);
    return false;
  }
}

/**
 * Forgets the folder lists cached for the unified scope: one login's, when it
 * reports a change, or every login's when called without an argument.
 */
export function invalidateUnifiedMailboxes(client?: object): void {
  if (client) unifiedMailboxCache.delete(client);
  else unifiedMailboxGeneration++;
}

export async function buildUnifiedAccountClients(
  opts: { includeGroup?: boolean; scopeToClientAccountId?: string } = {},
): Promise<UnifiedAccountClient[]> {
  const { includeGroup = false, scopeToClientAccountId } = opts;
  const authAccounts = useAccountStore.getState().accounts.filter(
    (a) => a.isConnected && (!scopeToClientAccountId || a.id === scopeToClientAccountId),
  );
  const allClients = useAuthStore.getState().getAllConnectedClients();
  const built: UnifiedAccountClient[] = [];
  // Per-account mailbox lists gathered here are cached into `accountMailboxes`
  // after the fan-out so single-email actions can resolve role-based
  // destinations (trash/archive) in the email's own account (issue #281).
  const fetchedMailboxes: Record<string, Mailbox[]> = {};
  const ownLoginJmapIds = new Set<string>();
  for (const a of authAccounts) {
    const c = allClients.get(a.id);
    if (c) ownLoginJmapIds.add(`${unifiedServerKey(c)} ${c.getAccountId()}`);
  }
  // Every login at once rather than one after the other: the slowest login,
  // not the sum of all of them, bounds how long the scope takes.
  const fetched = await Promise.allSettled(authAccounts.map(async (a) => {
    const c = allClients.get(a.id);
    if (!c) return null;
    return { a, c, ...(await unifiedMailboxesFor(c, includeGroup)) };
  }));
  for (const result of fetched) {
    // Skip the account on mailbox fetch failure.
    if (result.status !== 'fulfilled' || !result.value) continue;
    const { a, c, mailboxes, fresh } = result.value;
    // A reused list never overwrites a live one, but fills a key nothing has published yet.
    const publish = (key: string, list: Mailbox[]) => {
      if (fresh || !useEmailStore.getState().accountMailboxes[key]) fetchedMailboxes[key] = list;
    };
    try {
      const ownMailboxes = includeGroup
        ? mailboxes.filter((m) => !m.isShared)
        : mailboxes.slice();
      // Primary JMAP account id of this login. Stamped onto personal emails as
      // `sourceAccountId`; equals the client's primary so passing it to JMAP is a
      // no-op (no namespacing) — keeps personal behavior identical while making
      // resolution branch-free against shared sources.
      const primaryJmapId = c.getAccountId();
      built.push({ accountId: a.id, accountLabel: a.label || a.email, client: c, mailboxes: ownMailboxes, clientAccountId: a.id, jmapAccountId: primaryJmapId, isShared: false, crossIncludedMailboxIds: resolveCrossIncludedMailboxIds(a.id, ownMailboxes) });
      publish(a.id, ownMailboxes);
      // Also cache under the JMAP id so `accountMailboxes[email.sourceAccountId]`
      // resolves uniformly for personal and shared sources alike, and under
      // login plus JMAP id, which stays apart when another login's server uses
      // the same account id (sourceMailboxes).
      publish(primaryJmapId, ownMailboxes);
      publish(sourceMailboxesKey(a.id, primaryJmapId), ownMailboxes);

      if (includeGroup) {
        const sharedByOwner = new Map<string, Mailbox[]>();
        for (const m of mailboxes) {
          if (!m.isShared || !m.accountId || m.accountId === a.id) continue;
          const list = sharedByOwner.get(m.accountId) ?? [];
          list.push(m);
          sharedByOwner.set(m.accountId, list);
        }
        for (const [ownerId, ownerMailboxes] of sharedByOwner) {
          const label = ownerMailboxes.find((m) => m.accountName)?.accountName || ownerId;
          built.push({
            accountId: ownerId,
            accountLabel: label,
            client: c,
            mailboxes: ownerMailboxes,
            clientAccountId: a.id,
            jmapAccountId: ownerId,
            isShared: true,
          });
          // Cache the owner's mailbox list keyed by its JMAP id so single-email
          // and batch actions can resolve role-based destinations (trash/archive)
          // in the owner account instead of falling back to the active account.
          // When the owner is logged in too, its own (un-namespaced) list wins:
          // dedupeUnifiedAccounts routes that folder through the owner's login.
          if (!ownLoginJmapIds.has(`${unifiedServerKey(c)} ${ownerId}`)) publish(ownerId, ownerMailboxes);
          publish(sourceMailboxesKey(a.id, ownerId), ownerMailboxes);
        }
      }
    } catch {
      /* skip account on mailbox fetch failure */
    }
  }
  if (Object.keys(fetchedMailboxes).length > 0) {
    useEmailStore.setState((state) => ({
      accountMailboxes: { ...state.accountMailboxes, ...fetchedMailboxes },
    }));
  }
  return dedupeUnifiedAccounts(built);
}

/**
 * The accounts a tag view spans: the active/viewing login's own account plus
 * every group/shared owner whose folders that login can see (#1038).
 *
 * A tag keyword is set on messages in all of them, so the sidebar tag entry
 * fans out over the whole set instead of only the account of the folder that
 * happened to be selected. Built synchronously from the mailbox list the
 * sidebar already holds (own + delegated folders), so no extra round trip.
 * Every entry reaches the server through the same login client; shared
 * entries are flagged so JMAP requests target the owner's accountId.
 */
export function buildTagViewAccountClients(passedClient: IJMAPClient): UnifiedAccountClient[] {
  const client = resolveActionClient(passedClient);
  const mailboxes = resolveActionMailboxes();
  const state = useEmailStore.getState();
  const auth = useAuthStore.getState();
  // AccountEntry.id of the login this client belongs to (`getClientForAccount`
  // key), stamped as `sourceClientAccountId` so actions resolve the client.
  let clientAccountId: string | undefined;
  for (const [id, c] of auth.getAllConnectedClients()) {
    if (c === client) { clientAccountId = id; break; }
  }
  clientAccountId ??= state.viewingAccountId ?? auth.activeAccountId ?? client.getAccountId();
  const primaryJmapId = client.getAccountId();
  const account = useAccountStore.getState().getAccountById(clientAccountId);

  const own = mailboxes.filter((m) => !m.isShared);
  const built: UnifiedAccountClient[] = [{
    accountId: clientAccountId,
    accountLabel: account?.label || account?.email || primaryJmapId,
    client,
    mailboxes: own,
    clientAccountId,
    jmapAccountId: primaryJmapId,
    isShared: false,
  }];

  const sharedByOwner = new Map<string, Mailbox[]>();
  for (const m of mailboxes) {
    if (!m.isShared || !m.accountId || m.accountId === primaryJmapId) continue;
    const list = sharedByOwner.get(m.accountId) ?? [];
    list.push(m);
    sharedByOwner.set(m.accountId, list);
  }
  for (const [ownerId, ownerMailboxes] of sharedByOwner) {
    built.push({
      accountId: ownerId,
      accountLabel: ownerMailboxes.find((m) => m.accountName)?.accountName || ownerId,
      client,
      mailboxes: ownerMailboxes,
      clientAccountId,
      jmapAccountId: ownerId,
      isShared: true,
    });
  }
  return built;
}

/**
 * Whether a search is running under a folder-less scope (the default "All
 * folders except Spam and Trash" or "All folders", see
 * isAllFoldersSearchScope) of the standard (non-unified) list. Those scopes
 * span the folders of the own account AND of the group/shared accounts this
 * login reaches, so the search fans out like a tag view and stamps its hits
 * with their source account (#1082). A search scoped to one folder stays
 * single-account.
 */
export function isUnscopedSearchActive(
  s: Pick<EmailStore, 'isUnifiedView' | 'searchMailboxId' | 'searchQuery' | 'searchFilters'>,
): boolean {
  return !s.isUnifiedView && isAllFoldersSearchScope(s.searchMailboxId) && (!!s.searchQuery || !isFilterEmpty(s.searchFilters));
}

/**
 * The fan-out options of a folder-less search scope: only "All folders"
 * searches Trash and Junk, the default scope ("") leaves them out.
 */
/** A single-account search result with its deferred snippets in fan-out shape. */
function withSnippetBatches(
  result: SearchEmailsResult,
): Omit<SearchEmailsResult, 'snippets'> & { snippets?: Promise<DeferredSnippetBatch[]> } {
  const { snippets, ...rest } = result;
  return snippets ? { ...rest, snippets: snippets.then((list) => (list ? [{ list }] : [])) } : rest;
}

/**
 * Highlights the results of an interactive search once its deferred
 * SearchSnippet/get lands (see SearchRequestOptions.deferSnippets). The list
 * is on screen by then, so this applies only while that same search still is:
 * matching ids would not do, since a folder opened in the meantime can hold
 * the same messages and must not show search excerpts.
 */
function highlightWhenSnippetsArrive(snippets: Promise<DeferredSnippetBatch[]> | undefined): void {
  if (!snippets) return;
  const { searchQuery, searchFilters, searchMailboxId } = useEmailStore.getState();
  const isSameView = captureEmailListView();
  void snippets.then((batches) => {
    const state = useEmailStore.getState();
    if (!isSameView() || state.isLoading) return;
    if (state.searchQuery !== searchQuery || state.searchFilters !== searchFilters || state.searchMailboxId !== searchMailboxId) return;
    const emails = withSearchSnippets(state.emails, batches);
    if (emails !== state.emails) useEmailStore.setState({ emails });
  });
}

function acrossAccountsSearchOptions(searchMailboxId: string): AcrossAccountsSearchOptions {
  return { excludeTrashAndJunk: searchMailboxId !== SEARCH_SCOPE_ALL_FOLDERS };
}

/**
 * Whether the current list mixes messages from several accounts, so actions
 * must route by each email's source stamps rather than by the selected
 * folder: the unified / cross-account views, a tag view (#1038) and an
 * "All folders" search (#1082).
 */
export function isAggregateListView(): boolean {
  const s = useEmailStore.getState();
  return s.isUnifiedView || !!s.selectedKeyword || isUnscopedSearchActive(s);
}

/** A batch write's share for one source of an aggregate list (see groupBySource). */
interface SourceBatch<T extends SourceStamped = SourceStamped> {
  /** Login that reaches the messages (`sourceClientAccountId`). */
  clientAccountId?: string;
  /** JMAP account that owns them; undefined for undecorated messages. */
  accountId?: string;
  ids: string[];
  messages: T[];
}

type SourceStamped = { id: string; sourceClientAccountId?: string; sourceAccountId?: string };

/** The login and account a message was stamped with; '' for an undecorated one. */
function sourceKey(message: { sourceClientAccountId?: string; sourceAccountId?: string }): string {
  return message.sourceAccountId ? `${message.sourceClientAccountId ?? ''}|${message.sourceAccountId}` : '';
}

/**
 * One row of an aggregate list: its source and its id. The id alone can name
 * rows of several accounts, since ids repeat across accounts and servers.
 */
function sourceRowKey(message: SourceStamped): string {
  return `${sourceKey(message)}#${message.id}`;
}

/**
 * Whether the open message is one of the rows `rowKeys` names (sourceRowKey).
 * A copy without the list's source stamps goes by its id.
 */
function isOneOfRows(email: SourceStamped | null | undefined, rowKeys: Set<string>): boolean {
  if (!email) return false;
  if (email.sourceAccountId) return rowKeys.has(sourceRowKey(email));
  return [...rowKeys].some(key => key.endsWith(`#${email.id}`));
}

/**
 * Groups the messages of a batch write by the login that reaches each one and
 * the JMAP account that owns it. Account ids are only unique per server: two
 * logins on different servers often share them (Stalwart numbers accounts b,
 * c, d, ... on every install), and a group keyed on the account alone sent one
 * login's messages through the other's client - to a server where the same
 * message ids name other messages. Messages without source stamps (a plain
 * folder view) form one group without an account, for the caller's client.
 */
function groupBySource<T extends SourceStamped>(messages: T[]): SourceBatch<T>[] {
  const groups = new Map<string, SourceBatch<T>>();
  for (const message of messages) {
    const accountId = message.sourceAccountId || undefined;
    const clientAccountId = accountId ? message.sourceClientAccountId : undefined;
    const key = sourceKey(message);
    const group = groups.get(key) ?? { clientAccountId, accountId, ids: [], messages: [] };
    group.ids.push(message.id);
    group.messages.push(message);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Messages of a batch write that were left as they were, and why. */
type BatchFailure = { ids: string[]; error: unknown };

/**
 * What a batch write reports when some of its groups failed: the reason when
 * one group failed, else how many messages were left as they were and the
 * first reason.
 */
function batchFailureMessage(failures: BatchFailure[], action: string): string {
  const reason = (error: unknown) => (error instanceof Error && error.message ? error.message : `Failed to ${action}`);
  if (failures.length === 1) return reason(failures[0].error);
  const count = failures.reduce((sum, failure) => sum + failure.ids.length, 0);
  return `Failed to ${action} ${count} emails; first error: ${reason(failures[0].error)}`;
}

/** Why a selected row that resolveSelectionRows found nowhere was left alone. */
const NOT_IN_LIST = 'Message not found in the list';

/** The failure for selected rows resolveSelectionRows found nowhere; none without any. */
function notFoundFailures(ids: string[]): BatchFailure[] {
  return ids.length > 0 ? [{ ids, error: new Error(NOT_IN_LIST) }] : [];
}

/**
 * The client for a SourceBatch: the stamped login's, or the caller's for
 * undecorated messages. Undefined when the login is gone - never another
 * login's client, which would write to the wrong server.
 */
function sourceBatchClient(batch: SourceBatch, passedClient: IJMAPClient): IJMAPClient | undefined {
  if (!batch.accountId) return resolveActionClient(passedClient);
  return batch.clientAccountId ? useAuthStore.getState().getClientForAccount(batch.clientAccountId) : undefined;
}

/**
 * Key of the folder list of one source of an aggregate list in
 * `accountMailboxes`: the login plus the JMAP account. The list is cached
 * under the bare JMAP id as well, but with two logins that share account ids
 * that entry holds whichever login's list was fetched last.
 */
function sourceMailboxesKey(clientAccountId: string, jmapAccountId: string): string {
  return `${clientAccountId}|${jmapAccountId}`;
}

/**
 * The folders a source's role-based destinations (Archive, Junk, Inbox,
 * Deleted Items) come from: the list cached for its login and account, else
 * that login's folder list narrowed to the account: a tag view and an "All
 * folders" search stamp their rows too, but only the unified views fill that
 * cache. Never the list cached under the bare account id, which holds
 * whichever login's list was fetched last when two logins share account ids.
 */
function sourceMailboxes(
  state: Pick<EmailStore, 'accountMailboxes' | 'mailboxes'>,
  clientAccountId: string,
  jmapAccountId: string,
): Mailbox[] {
  const cached = state.accountMailboxes[sourceMailboxesKey(clientAccountId, jmapAccountId)];
  if (cached) return cached;
  const loginMailboxes = clientAccountId === useAuthStore.getState().activeAccountId
    ? state.mailboxes
    : state.accountMailboxes[clientAccountId];
  return (loginMailboxes ?? []).filter((mailbox) => mailbox.accountId === jmapAccountId);
}

/** sourceMailboxes of a SourceBatch, or the viewed account's for undecorated messages. */
function sourceBatchMailboxes(batch: SourceBatch): Mailbox[] {
  if (!batch.accountId) return resolveActionMailboxes();
  if (!batch.clientAccountId) return [];
  return sourceMailboxes(useEmailStore.getState(), batch.clientAccountId, batch.accountId);
}

/** A folder that messages of an aggregate list are moved to (resolveMoveDestination). */
interface MoveDestination {
  /** The login whose folder list the folder was picked from. */
  localAccountId: string | null;
  /** The store id the folder was picked by. */
  storeId: string;
  /** The account that owns the folder, and the folder's id there. */
  accountId: string | undefined;
  mailboxId: string;
  isShared: boolean;
}

/**
 * The folder `storeId` names in the folder list of `localAccountId` - the
 * login a drop target is listed under - or, by default, of the active login:
 * the "Move to" menus offer its folders (`mailboxes`), whichever login was
 * browsed before the list that mixes accounts was opened.
 */
function resolveMoveDestination(passedClient: IJMAPClient, storeId: string, localAccountId?: string | null): MoveDestination {
  const state = useEmailStore.getState();
  const auth = useAuthStore.getState();
  const login = localAccountId ?? auth.activeAccountId;
  const isActive = login === auth.activeAccountId;
  const mailboxes = (isActive ? state.mailboxes : (login ? state.accountMailboxes[login] : undefined)) ?? [];
  const mailbox = mailboxes.find((mb) => mb.id === storeId);
  const client = (login ? auth.getClientForAccount(login) : undefined) ?? (isActive ? passedClient : undefined);
  return {
    localAccountId: login,
    storeId,
    accountId: mailbox?.accountId ?? client?.getAccountId(),
    mailboxId: mailbox?.originalId || storeId,
    isShared: !!mailbox?.isShared,
  };
}

/**
 * Moves the messages of an aggregate list into one folder. Only the messages
 * of the login and account that own the folder change folders in place: a
 * mailbox id means nothing in another account, where the same id - Stalwart
 * numbers the folders of every account alike - names that account's own
 * folder, or another one. The others go through the cross-account move
 * (crossAccountMoveEmails): Email/copy within one login, a download and an
 * import across logins. Messages whose login is gone stay where they are.
 *
 * Returns the rows moved in place (the cross-account move takes the rows it
 * moved off the list itself) and what failed.
 */
async function moveSourceBatches<T extends SourceStamped>(
  batches: SourceBatch<T>[],
  destination: MoveDestination,
  passedClient: IJMAPClient,
): Promise<{ moved: T[]; failures: BatchFailure[] }> {
  const callerLogin = useEmailStore.getState().viewingAccountId ?? useAuthStore.getState().activeAccountId;
  const moved: T[] = [];
  const failures: BatchFailure[] = [];
  const inPlace: Array<{ batch: SourceBatch<T>; client: IJMAPClient }> = [];
  const across: Array<{ batch: SourceBatch<T>; login: string }> = [];
  for (const batch of batches) {
    const client = sourceBatchClient(batch, passedClient);
    const login = batch.accountId ? batch.clientAccountId : callerLogin;
    if (!client || !login) {
      failures.push({ ids: batch.ids, error: new Error('Not connected') });
    } else if (login === destination.localAccountId && (batch.accountId ?? client.getAccountId()) === destination.accountId) {
      inPlace.push({ batch, client });
    } else {
      across.push({ batch, login });
    }
  }

  const outcomes = await Promise.allSettled(
    inPlace.map(({ batch, client }) => client.batchMoveEmails(batch.ids, destination.mailboxId, batch.accountId)),
  );
  outcomes.forEach((outcome, i) => {
    const { batch } = inPlace[i];
    if (outcome.status === 'fulfilled') {
      moved.push(...batch.messages);
      return;
    }
    // A refusal names the messages the server left alone; the rest moved.
    const refused = new Set(jmapErrorFailedIds(outcome.reason) ?? batch.ids);
    moved.push(...batch.messages.filter((message) => !refused.has(message.id)));
    failures.push({ ids: batch.ids.filter((id) => refused.has(id)), error: outcome.reason });
  });

  // One at a time: each run reports through the store's loading state.
  for (const { batch, login } of across) {
    try {
      if (!destination.localAccountId) throw new Error('Destination account is not connected');
      await useEmailStore.getState().crossAccountMoveEmails(
        new Map([[login, batch.ids]]),
        destination.localAccountId,
        destination.mailboxId,
        destination.isShared ? destination.accountId : undefined,
        batch.accountId,
      );
    } catch (error) {
      const listed = new Set(useEmailStore.getState().emails.map((email) => email.id));
      failures.push({ ids: batch.ids.filter((id) => listed.has(id)), error });
    }
  }
  return { moved, failures };
}

/**
 * Moves rows of an aggregate list into one folder (moveSourceBatches). The
 * rows that moved leave the list and the selection, with their folders'
 * counters; the others stay. Returns what failed.
 */
async function moveRowsToMailbox(rows: Email[], destination: MoveDestination, passedClient: IJMAPClient): Promise<BatchFailure[]> {
  const { moved, failures } = await moveSourceBatches(groupBySource(rows), destination, passedClient);
  if (moved.length === 0) return failures;
  const movedKeys = new Set(moved.map(sourceRowKey));
  const unread = moved.filter((email) => !email.keywords?.$seen).length;
  const arrive = (mailbox: Mailbox) => (mailbox.id === destination.storeId
    ? { ...mailbox, totalEmails: mailbox.totalEmails + moved.length, unreadEmails: mailbox.unreadEmails + unread }
    : mailbox);
  useEmailStore.setState((state) => {
    // Out of each message's own account list, into the folder's login's list.
    const patch = applyBatchMailboxCounterUpdate(state, moved, applyMoveOutCounters);
    const activeId = useAuthStore.getState().activeAccountId;
    if (!destination.localAccountId || destination.localAccountId === activeId) {
      patch.mailboxes = patch.mailboxes.map(arrive);
    } else if (patch.accountMailboxes[destination.localAccountId]) {
      patch.accountMailboxes[destination.localAccountId] = patch.accountMailboxes[destination.localAccountId].map(arrive);
    }
    const selectedEmailKeys = new Set(state.selectedEmailKeys);
    for (const email of moved) selectedEmailKeys.delete(emailKeyFor(email));
    return {
      emails: state.emails.filter((email) => !movedKeys.has(sourceRowKey(email))),
      selectedEmail: isOneOfRows(state.selectedEmail, movedKeys) ? null : state.selectedEmail,
      selectedEmailKeys,
      ...patch,
    };
  });
  return failures;
}

/**
 * Batch archive in a list that mixes accounts: each login and account
 * archives into its own Archive. One Archive for the whole selection moved
 * every message by its id in that Archive's account, where the ids of the
 * other accounts' messages name unrelated messages - or none. The rows that
 * were archived leave the list, the selection, the viewer and expanded
 * threads; the others stay and the failure is reported through `error`,
 * `notFound` selection keys (resolveSelectionRows) included. Throws when
 * nothing was archived; resolves false when a plugin stopped a group.
 *
 * Each group reads its folders through its own login and creates its Archive
 * when the account has none, as the folder view does (Stalwart makes no
 * Archive). Plugins are asked per group, each about its own Archive.
 */
async function archiveAggregateSelection(passedClient: IJMAPClient, selected: Email[], notFound: string[] = []): Promise<boolean> {
  if (selected.length === 0 && notFound.length === 0) return true;
  const mode = useSettingsStore.getState().archiveMode;
  const { selectedMailbox } = useEmailStore.getState();
  useEmailStore.setState({ isLoading: true, error: null });

  const archived: Email[] = [];
  const failures: BatchFailure[] = [];
  let stoppedByPlugin = false;
  await Promise.all(groupBySource(selected).map(async (batch) => {
    const client = sourceBatchClient(batch, passedClient);
    let move: Parameters<typeof allowEmailMove>[0] | null = null;
    let hookMailboxes: Mailbox[] = [];
    try {
      if (!client) throw new Error('Not connected');
      // The source's folders as its login reads them now, by the server's own
      // ids: batchArchiveEmails finds year/month folders by their parent's id
      // there, not by the store's namespaced one.
      const folders = async (refresh: boolean): Promise<Mailbox[]> => {
        if (!batch.accountId) {
          if (refresh) await refreshMailboxesForViewingAccount(passedClient);
          return resolveActionMailboxes();
        }
        return (await client.getMailboxes(batch.accountId)).map((m) => (m.originalId && m.accountId ? {
          ...m, id: m.originalId,
          parentId: m.parentId?.startsWith(`${m.accountId}:`) ? m.parentId.slice(m.accountId.length + 1) : m.parentId,
        } : m));
      };
      let mailboxes = await folders(false);
      const archive = await ensureArchiveMailbox({
        client, mailboxes, selectedMailboxId: selectedMailbox, accountId: batch.accountId,
        refresh: async () => (mailboxes = await folders(true)),
      });
      if (!archive) {
        stoppedByPlugin = true;
        return;
      }
      if (archive.myRights?.mayAddItems === false) throw new ArchiveMailboxNotFoundError();
      hookMailboxes = [...mailboxes, archive];
      move = {
        emailIds: [...new Set(batch.ids)],
        fromMailboxId: moveSourceMailboxId(batch.messages, hookMailboxes),
        toMailboxId: archive.id,
      };
      if (!(await allowEmailMove(move, hookMailboxes))) {
        stoppedByPlugin = true;
        return;
      }
      await client.batchArchiveEmails(
        batch.messages.map(e => ({ id: e.id, receivedAt: e.receivedAt })),
        archive.originalId || archive.id,
        mode,
        mailboxes,
        archive.accountId,
      );
      archived.push(...batch.messages);
      emitEmailMove(move, hookMailboxes);
    } catch (error) {
      // An archive that failed part way names the messages it did move.
      const moved = new Set(error instanceof ArchiveEmailsError ? error.updatedIds : []);
      archived.push(...batch.messages.filter(e => moved.has(e.id)));
      failures.push({ ids: batch.ids.filter(id => !moved.has(id)), error });
      if (move && moved.size > 0) emitEmailMove({ ...move, emailIds: move.emailIds.filter(id => moved.has(id)) }, hookMailboxes);
    }
  }));
  failures.push(...notFoundFailures(notFound));

  const error = failures.length > 0 ? batchFailureMessage(failures, 'archive') : null;
  if (archived.length === 0) {
    useEmailStore.setState({ error, isLoading: false });
    if (failures.length > 0) throw failures[0].error;
    return false;
  }
  const archivedKeys = new Set(archived.map(sourceRowKey));
  useEmailStore.setState((state) => {
    const selectedEmailKeys = new Set(state.selectedEmailKeys);
    for (const email of archived) selectedEmailKeys.delete(emailKeyFor(email));
    const threadEmailsCache = new Map(state.threadEmailsCache);
    const expandedThreadIds = new Set(state.expandedThreadIds);
    for (const [key, members] of threadEmailsCache) {
      const kept = members.filter(e => !archivedKeys.has(sourceRowKey(e)));
      if (kept.length === members.length) continue;
      if (kept.length > 0) threadEmailsCache.set(key, kept);
      else {
        threadEmailsCache.delete(key);
        expandedThreadIds.delete(key);
      }
    }
    return {
      emails: state.emails.filter(e => !archivedKeys.has(sourceRowKey(e))),
      selectedEmail: isOneOfRows(state.selectedEmail, archivedKeys) ? null : state.selectedEmail,
      selectedEmailKeys,
      threadEmailsCache,
      expandedThreadIds,
      isLoading: false,
      error,
    };
  });

  // A year/month archive can create new sub-folders.
  await refreshMailboxesForViewingAccount(passedClient);
  await useEmailStore.getState().refreshCurrentMailbox(passedClient);
  return !stoppedByPlugin;
}

/**
 * The emails the key-based selection names (resolveSelectedEmails): listed
 * rows and loaded members of expanded threads, each keyed by its own login
 * and account. A selected key found in neither - a row that left the list
 * after it was ticked - is returned as `unknown` for the caller to report
 * and keep selected, never written in the account the list happens to be
 * reached through.
 */
function resolveSelectionRows(): { rows: Email[]; unknown: string[] } {
  const state = useEmailStore.getState();
  const rows = resolveSelectedEmails(state);
  const found = new Set(rows.map(emailKeyFor));
  return { rows, unknown: [...state.selectedEmailKeys].filter((key) => !found.has(key)) };
}

/**
 * After a mailbox-list mutation (create/rename/delete/etc.), refresh the
 * cache for whichever account we're operating on. Writes the result to the
 * standard `mailboxes` slot for the active account, or the per-account
 * cache for non-active accounts so the Pro sidebar stays in sync.
 */
async function refreshMailboxesForViewingAccount(fallbackClient: IJMAPClient): Promise<void> {
  const viewingId = useEmailStore.getState().viewingAccountId;
  const client = resolveActionClient(fallbackClient);
  try {
    const mailboxes = await client.getMailboxes();
    if (viewingId) {
      useEmailStore.setState((state) => ({
        accountMailboxes: { ...state.accountMailboxes, [viewingId]: mailboxes },
      }));
    } else {
      useEmailStore.setState({ mailboxes });
    }
  } catch (error) {
    console.error('Failed to refresh mailboxes after mutation:', error);
  }
}

// Whether an email belongs to a given mailbox, for local counter math.
// Own-account emails carry bare ids (equal to both `id` and `originalId`).
// As of #281 V3, EVERY client fetch path (getEmails/getEmail/getThreadEmails/
// searchEmails/advancedSearchEmails) namespaces shared/delegated emails'
// `mailboxIds` to the store id (`${ownerId}:${origId}`), so the `ids[mailbox.id]`
// fast path below matches own and shared mailboxes alike - one id space.
// The `originalId` branches remain as a defensive fallback for any email that
// still carries a bare owner id (scoped to the owning account via
// `sourceAccountId === mailbox.accountId` so a bare owner id can't collide with
// another account's folder). (#281)
/**
 * The folder messages are moved out of, for the move hooks: the open folder,
 * or in an aggregate view (unified, tag, search across folders) the one
 * folder they all share, else null.
 */
function moveSourceMailboxId(emails: Array<Pick<Email, 'mailboxIds' | 'sourceAccountId'>>, mailboxes: Mailbox[]): string | null {
  const { selectedMailbox, selectedKeyword, isUnifiedView } = useEmailStore.getState();
  if (!selectedKeyword && !isUnifiedView && selectedMailbox && mailboxes.some(mb => mb.id === selectedMailbox)) {
    return selectedMailbox;
  }
  const sources = new Set<string>();
  for (const email of emails) {
    const mailbox = mailboxes.find(mb => emailInMailbox(email, mb));
    if (!mailbox) return null;
    sources.add(mailbox.id);
  }
  return sources.size === 1 ? [...sources][0] : null;
}

function emailInMailbox(
  email: { mailboxIds?: Record<string, boolean>; sourceAccountId?: string },
  mailbox: Mailbox,
): boolean {
  const ids = email.mailboxIds;
  if (!ids) return false;
  if (ids[mailbox.id]) return true;
  if (!mailbox.isShared && mailbox.originalId) return !!ids[mailbox.originalId];
  if (
    mailbox.isShared &&
    mailbox.originalId &&
    email.sourceAccountId &&
    email.sourceAccountId === mailbox.accountId
  ) {
    return !!ids[mailbox.originalId];
  }
  return false;
}

/**
 * The folder "Remove from this folder" takes messages out of (#615): the
 * folder the list shows, when it shows exactly one. A search scoped to one
 * folder counts as that folder. Null in the unified, cross-account, tag and
 * scheduled views and in a search across folders, where no single folder is
 * open.
 */
export function removalFolder(
  state: Pick<EmailStore,
    | 'isUnifiedView' | 'crossView' | 'selectedKeyword' | 'isScheduledView'
    | 'selectedMailbox' | 'searchMailboxId' | 'searchQuery' | 'searchFilters'
    | 'viewingAccountId' | 'accountMailboxes' | 'mailboxes'>,
): Mailbox | null {
  if (state.isUnifiedView || state.crossView || state.selectedKeyword || state.isScheduledView) return null;
  const searching = !!state.searchQuery || !isFilterEmpty(state.searchFilters);
  if (searching && isAllFoldersSearchScope(state.searchMailboxId)) return null;
  const folderId = searching ? state.searchMailboxId : state.selectedMailbox;
  if (!folderId) return null;
  return mailboxesInView(state).find(mb => mb.id === folderId) ?? null;
}

/**
 * Whether a message can leave `folder` and still be somewhere: it is in that
 * folder and in at least one other. JMAP lets a message sit in several
 * mailboxes at once, but never in none.
 */
export function canRemoveFromFolder(
  email: Pick<Email, 'mailboxIds' | 'sourceAccountId'>,
  folder: Mailbox | null,
): boolean {
  if (!folder || !emailInMailbox(email, folder)) return false;
  return Object.values(email.mailboxIds ?? {}).filter(Boolean).length > 1;
}

// Apply a per-mailbox counter adjustment to the mailbox list that actually holds
// the email's folders, and return the matching `set()` partial.
//
// In aggregate views an email may belong to another logged-in account. The
// sidebar shows the active account's folders from `mailboxes` (its
// getAllMailboxes, incl. its delegated shared folders) and every *other*
// account's folders from `accountMailboxes[<AccountEntry.id>]`. Updating the
// wrong list silently corrupts counters - and because JMAP mailbox ids can
// collide across accounts, blindly matching `mailboxes` would even decrement the
// *active* account's folder for a different account's email. So route by the
// email's source login: a different account → its `accountMailboxes` entry,
// otherwise (active account, its shared folders, or a non-aggregate view) →
// `mailboxes`. (#281)
function applyMailboxCounterUpdate(
  state: { mailboxes: Mailbox[]; accountMailboxes: Record<string, Mailbox[]> },
  email: { sourceClientAccountId?: string },
  adjust: (mb: Mailbox) => Mailbox,
): { mailboxes?: Mailbox[]; accountMailboxes?: Record<string, Mailbox[]> } {
  const srcClient = email.sourceClientAccountId;
  const activeId = useAuthStore.getState().activeAccountId;
  if (srcClient && srcClient !== activeId) {
    const list = state.accountMailboxes[srcClient];
    if (!list) return {};
    return { accountMailboxes: { ...state.accountMailboxes, [srcClient]: list.map(adjust) } };
  }
  return { mailboxes: state.mailboxes.map(adjust) };
}

// Batch variant of applyMailboxCounterUpdate: a set of emails may span accounts,
// so group them by the list that holds them and run `mapMailbox` per list using
// only that group's emails. Each account's counters are adjusted in its own list
// (active account → `mailboxes`, others → `accountMailboxes[sourceClientAccountId]`),
// avoiding cross-account id collisions. (#281)
function applyBatchMailboxCounterUpdate(
  state: { mailboxes: Mailbox[]; accountMailboxes: Record<string, Mailbox[]> },
  emails: Array<{ sourceClientAccountId?: string }>,
  mapMailbox: (mb: Mailbox, emailsForList: Array<{ sourceClientAccountId?: string }>) => Mailbox,
): { mailboxes: Mailbox[]; accountMailboxes: Record<string, Mailbox[]> } {
  const activeId = useAuthStore.getState().activeAccountId;
  const ACTIVE = '__active__';
  const groups = new Map<string, Array<{ sourceClientAccountId?: string }>>();
  for (const e of emails) {
    const k = e.sourceClientAccountId && e.sourceClientAccountId !== activeId ? e.sourceClientAccountId : ACTIVE;
    const g = groups.get(k);
    if (g) g.push(e); else groups.set(k, [e]);
  }
  let mailboxes = state.mailboxes;
  const accountMailboxes = { ...state.accountMailboxes };
  for (const [k, es] of groups) {
    if (k === ACTIVE) {
      mailboxes = mailboxes.map((mb) => mapMailbox(mb, es));
    } else if (accountMailboxes[k]) {
      accountMailboxes[k] = accountMailboxes[k].map((mb) => mapMailbox(mb, es));
    }
  }
  return { mailboxes, accountMailboxes };
}

/**
 * The folder with `role` in one account's mailbox list. `accountId` scopes it
 * to a shared/group owner; without it, own folders only. Own folders may or
 * may not carry their account id, so a missing one counts as own - but not
 * for an account the list holds shared folders of: the merged own+shared
 * list of a shared-folder view lists the own Inbox first, without an id.
 */
function findRoleMailbox(mailboxes: Mailbox[], role: string, accountId: string | undefined): Mailbox | undefined {
  const own = (m: Mailbox) => m.role === role && !m.isShared && !m.accountId;
  if (!accountId) return mailboxes.find(m => m.role === role && !m.isShared);
  const scoped = mailboxes.find(m => m.role === role && m.accountId === accountId);
  if (scoped || mailboxes.some(m => m.isShared && m.accountId === accountId)) return scoped;
  return mailboxes.find(own);
}

/**
 * Batch spam / not-spam. Each message is routed like the single-message
 * action: through its own account's client, to that account's junk or inbox.
 * The batch used to send everything through the active client to the selected
 * folder's account, so in unified, tag and search views it either failed for
 * other accounts or returned early while the caller showed a success toast.
 *
 * Throws when any message could not be moved; the ones that were moved still
 * leave the list.
 */
/**
 * Mark every unread message matching `filter` read. The server-side bulk
 * call doesn't say which messages it touched, so when a plugin listens the
 * ids are listed first, plugins are asked once, and told afterwards.
 * Resolves null when a plugin said no.
 */
async function markReadAskingPlugins(
  client: IJMAPClient,
  filter: Record<string, unknown>,
  accountId: string | undefined,
  bulk: (client: IJMAPClient) => Promise<number>,
): Promise<number | null> {
  const asks = emailHooks.onBeforeEmailReadStateChange.size > 0;
  const tells = emailHooks.onEmailReadStateChange.size > 0;
  if (!asks && !tells) return bulk(client);
  const unread = await client.queryEmailFields({ ...filter, notKeyword: '$seen' }, [], accountId, Number.MAX_SAFE_INTEGER);
  const emailIds = unread.map(e => String(e.id));
  if (emailIds.length === 0) return 0;
  if (asks && !(await emailHooks.onBeforeEmailReadStateChange.intercept({ emailIds, read: true }))) return null;
  await client.batchMarkAsRead(emailIds, true, accountId);
  void emailHooks.onEmailReadStateChange.emit({ emailIds, read: true });
  return emailIds.length;
}

async function runBatchSpamAction(
  get: StoreGet,
  set: StoreSet,
  client: IJMAPClient,
  emailIds: string[],
  role: 'junk' | 'inbox',
  run: (actionClient: IJMAPClient, email: Email, accountId: string | undefined, destination: Mailbox | undefined) => Promise<void>,
  arrivesUnread: (email: Email) => boolean,
): Promise<boolean> {
  // Act on the selected emails themselves: bare ids collide across accounts,
  // so looking them up in the list could pick another account's namesake.
  const wanted = new Set(emailIds);
  const state = get();
  const selected = resolveSelectedEmails(state).filter(e => wanted.has(e.id));
  const targets = selected.length > 0 ? selected : state.emails.filter(e => wanted.has(e.id));
  if (targets.length === 0) {
    throw new Error('Emails not found');
  }
  // Outside a list that mixes accounts the viewed folder names the account of
  // its unstamped rows. Throw rather than guess when it is gone: the caller
  // reports the mail as moved. (#695)
  if (role === 'junk' && !isAggregateListView() && targets.some(e => !e.sourceAccountId)
    && !resolveActionMailboxes().some(m => m.id === state.selectedMailbox)) {
    throw new Error('Mailbox not found - cannot mark as spam');
  }
  const spam = role === 'junk';
  if (emailHooks.onBeforeEmailSpamToggle.size > 0
    && !(await emailHooks.onBeforeEmailSpamToggle.intercept({ emailIds: [...new Set(targets.map(e => e.id))], spam }))) {
    return false;
  }

  const destinationByKey = new Map<string, string | undefined>();
  const failures: unknown[] = [];
  for (const email of targets) {
    // A message of a login that is gone stays where it is: another login's
    // client would write to a server where its id names another message.
    if (email.sourceAccountId && email.sourceClientAccountId
      && !useAuthStore.getState().getClientForAccount(email.sourceClientAccountId)) {
      failures.push(new Error('Not connected'));
      continue;
    }
    const { client: actionClient, mailboxes, accountId } = resolveEmailActionContext(email, client);
    const destination = findRoleMailbox(mailboxes, role, accountId);
    if (!destination && role === 'inbox') {
      failures.push(new Error('Inbox not found'));
      continue;
    }
    try {
      await run(actionClient, email, accountId, destination);
      destinationByKey.set(emailKeyFor(email), destination?.id);
    } catch (error) {
      failures.push(error);
    }
  }

  if (destinationByKey.size > 0) {
    const moved = targets.filter(e => destinationByKey.has(emailKeyFor(e)));
    set(s => {
      // Counters change in the email's own account list (#281).
      const patch = applyBatchMailboxCounterUpdate(s, moved, (mb, group) => {
        let dTotal = 0;
        let dUnread = 0;
        for (const e of group as Email[]) {
          if (emailInMailbox(e, mb)) {
            dTotal--;
            if (!e.keywords?.$seen) dUnread--;
          }
          if (destinationByKey.get(emailKeyFor(e)) === mb.id) {
            dTotal++;
            if (arrivesUnread(e)) dUnread++;
          }
        }
        return dTotal === 0 && dUnread === 0 ? mb : {
          ...mb,
          totalEmails: Math.max(0, mb.totalEmails + dTotal),
          unreadEmails: Math.max(0, mb.unreadEmails + dUnread),
        };
      });
      const isMoved = (e: Email) => destinationByKey.has(emailKeyFor(e));
      return {
        emails: s.emails.filter(e => !isMoved(e)),
        selectedEmail: s.selectedEmail && isMoved(s.selectedEmail) ? null : s.selectedEmail,
        selectedEmailKeys: new Set(),
        ...patch,
      };
    });
    void emailHooks.onEmailSpamToggle.emit({ emailIds: [...new Set(moved.map(e => e.id))], spam });
  }

  if (failures.length > 0) {
    console.error(`Batch ${role === 'junk' ? 'mark as spam' : 'not spam'} failed for ${failures.length} of ${targets.length} emails:`, failures);
    throw failures[0] instanceof Error ? failures[0] : new Error('Batch spam action failed');
  }
  return true;
}

// Sidebar tag badges render from `tagCounts`, which is *fetched from the server*
// (`fetchTagCounts` -> `getTagCounts`) rather than derived from `state.emails`.
// So a read/unread mutation has to keep it in step locally, exactly as it does
// for `mailboxes[].unreadEmails` - otherwise the tag unread count (and the bold
// tag name) stays stale until a full page reload.
//
// `changes` carries one entry per email whose read state *actually changed*
// (callers already compute that), with delta -1 when it became read and +1 when
// it became unread. Only `unread` moves: read state never changes tag
// membership, so `total` is left alone.
function applyTagCountReadDelta(
  tagCounts: Record<string, { total: number; unread: number }>,
  changes: Array<{ keywords?: Record<string, boolean>; delta: number }>,
): Record<string, { total: number; unread: number }> {
  const keywordIds = useSettingsStore.getState().emailKeywords.map(k => k.id);
  if (keywordIds.length === 0) return tagCounts;

  let next: Record<string, { total: number; unread: number }> | null = null;
  for (const { keywords, delta } of changes) {
    if (!keywords || delta === 0) continue;
    for (const id of keywordIds) {
      if (!keywords[`$label:${id}`]) continue;
      const current = (next ?? tagCounts)[id];
      if (!current) continue; // Tag not in the fetched counts yet; nothing to adjust.
      next = next ?? { ...tagCounts };
      next[id] = { total: current.total, unread: Math.max(0, current.unread + delta) };
    }
  }
  return next ?? tagCounts;
}

// Per-mailbox counter map (for applyBatchMailboxCounterUpdate) for removing a
// group of emails from a folder: decrement total (and unread for unseen) for
// each group email that lives in the mailbox.
function applyDeleteCounters(
  mailbox: Mailbox,
  group: Array<{ sourceClientAccountId?: string }>,
): Mailbox {
  let dTotal = 0;
  let dUnread = 0;
  for (const email of group as Email[]) {
    if (emailInMailbox(email, mailbox)) {
      dTotal--;
      if (!email.keywords?.$seen) dUnread--;
    }
  }
  return dTotal === 0 && dUnread === 0 ? mailbox : {
    ...mailbox,
    totalEmails: Math.max(0, mailbox.totalEmails + dTotal),
    unreadEmails: Math.max(0, mailbox.unreadEmails + dUnread),
    totalThreads: Math.max(0, mailbox.totalThreads + dTotal),
    unreadThreads: Math.max(0, mailbox.unreadThreads + dUnread),
  };
}

// Per-mailbox counter map (for applyBatchMailboxCounterUpdate) for moving a
// group of emails out of their folders: message counts only, like the
// destination's gain.
function applyMoveOutCounters(
  mailbox: Mailbox,
  group: Array<{ sourceClientAccountId?: string }>,
): Mailbox {
  let dTotal = 0;
  let dUnread = 0;
  for (const email of group as Email[]) {
    if (emailInMailbox(email, mailbox)) {
      dTotal--;
      if (!email.keywords?.$seen) dUnread--;
    }
  }
  return dTotal === 0 && dUnread === 0 ? mailbox : {
    ...mailbox,
    totalEmails: Math.max(0, mailbox.totalEmails + dTotal),
    unreadEmails: Math.max(0, mailbox.unreadEmails + dUnread),
  };
}

// ─── Unified-badge live projection ────────────────────────────────────────────
//
// The unified-section badges (unifiedCounts / crossUnreadCount) are a pure
// projection of the live per-account mailbox lists - the SAME lists the
// optimistic delete/move/markRead paths patch and that push refreshes. Rather
// than trusting the counter snapshot baked into the UnifiedAccountClient[] (which
// came from a server fetch and goes stale the moment a local mutation runs), we
// look each scope mailbox up by id in the live store list and use its current
// counters. This keeps the badges in lockstep with the per-folder counters - one
// source of truth, no server round trip, no eventual-consistency snap-back.

// The live store list that holds a unified-scope account's folders. Mirrors
// applyMailboxCounterUpdate's routing exactly: the active client's folders (incl.
// its delegated shared folders) live in `mailboxes`; every other logged-in
// account's folders live in `accountMailboxes[clientAccountId]`. Falls back to
// the account's own (snapshot) list so an unknown account still contributes its
// last-known counters instead of vanishing.
function liveListForAccount(
  account: UnifiedAccountClient,
  state: { mailboxes: Mailbox[]; accountMailboxes: Record<string, Mailbox[]> },
): Mailbox[] {
  const activeId = useAuthStore.getState().activeAccountId;
  if (account.clientAccountId === activeId) return state.mailboxes;
  return state.accountMailboxes[account.clientAccountId] ?? account.mailboxes;
}

// Returns a shallow copy of the scope account whose mailboxes carry LIVE counter
// values (matched by id against the live store list). Structure - which
// mailboxes, their roles, originalId, crossIncludedMailboxIds - is preserved from
// the scope snapshot; only the counter numbers are refreshed. This lets the
// existing lib aggregators (fetchUnifiedMailboxCounts / getCrossUnreadTotal) run
// unchanged over live data.
function accountWithLiveCounters(
  account: UnifiedAccountClient,
  state: { mailboxes: Mailbox[]; accountMailboxes: Record<string, Mailbox[]> },
): UnifiedAccountClient {
  const live = liveListForAccount(account, state);
  const byId = new Map(live.map((m) => [m.id, m]));
  return { ...account, mailboxes: account.mailboxes.map((m) => byId.get(m.id) ?? m) };
}

// Project the live mailbox state over the current unified scope into the two
// badge values. Pure function of (unifiedScope, mailboxes, accountMailboxes).
function projectUnifiedCounts(
  state: { unifiedScope: UnifiedAccountClient[]; mailboxes: Mailbox[]; accountMailboxes: Record<string, Mailbox[]> },
): { unifiedCounts: UnifiedMailboxCounts[]; crossUnreadCount: number } {
  if (state.unifiedScope.length === 0) {
    return { unifiedCounts: [], crossUnreadCount: 0 };
  }
  const live = state.unifiedScope.map((a) => accountWithLiveCounters(a, state));
  return {
    unifiedCounts: fetchUnifiedMailboxCounts(live),
    crossUnreadCount: getCrossUnreadTotal(live),
  };
}

// Find the trash mailbox for a given account scope. Prefers JMAP role, but
// falls back to name matching ("trash" / "deleted") so users with custom or
// pre-existing folders (e.g. "Deleted Items") aren't silently destroyed.
function findTrashMailbox(
  mailboxes: Mailbox[],
  scope: { accountId?: string; isShared?: boolean }
): Mailbox | undefined {
  const matchesScope = (mb: Mailbox): boolean => {
    if (scope.accountId) return mb.accountId === scope.accountId;
    return !mb.isShared;
  };

  const byRole = mailboxes.find(mb => mb.role === 'trash' && matchesScope(mb));
  if (byRole) return byRole;

  return mailboxes.find(mb => {
    if (!matchesScope(mb)) return false;
    const lower = mb.name.toLowerCase();
    return lower.includes('trash') || lower.includes('deleted');
  });
}

// Deleting a selection in this folder destroys it rather than moving it to
// the trash: in Trash, and in Junk when the user chose that. batchDelete
// decides the same way.
export function bulkDeleteIsPermanent(mailbox: { role?: string | null } | undefined): boolean {
  if (mailbox?.role === 'trash') return true;
  return mailbox?.role === 'junk' && useSettingsStore.getState().permanentlyDeleteJunk;
}

// Whether deleting several selected emails asks first. A permanent delete
// always does; moving them to the trash only while the user keeps the
// prompt on. (#1225)
export function shouldConfirmBulkDelete(mailbox: { role?: string | null } | undefined): boolean {
  return bulkDeleteIsPermanent(mailbox) || useSettingsStore.getState().confirmBulkDelete;
}

// Emptying Trash or Junk destroys their mail, as does every delete for users
// who chose permanent deletion; any other folder is emptied into the trash.
export function emptyFolderMovesToTrash(mailbox: Pick<Mailbox, 'role'>): boolean {
  if (mailbox.role === 'trash' || mailbox.role === 'junk') return false;
  return useSettingsStore.getState().deleteAction !== 'permanent';
}

// Plugin re-render for already fetched emails.
// Plugins can trigger: window.dispatchEvent(new Event('plugin:rerender-fetched-emails'))
if (typeof window !== 'undefined') {
  window.addEventListener('plugin:rerender-fetched-emails', async () => {
    const state = useEmailStore.getState();
    const transformed = await emailHooks.onEmailsFetched.transform(state.emails);
    useEmailStore.setState({
      emails: annotateScheduledEmails(transformed, state.scheduledSubmissionByEmailId),
    });
  });
}

/**
 * The two cross views whose filter is the very keyword the read/star actions
 * flip: 'unread' (notKeyword $seen) and 'starred' (hasKeyword $flagged). In
 * those views a just-read / just-unstarred mail no longer matches the query, so
 * a naive push refresh drops it. We keep such rows (see retainedInViewIds).
 * The 'all' view has no keyword filter and needs no retention.
 */
function retainingCrossView(state: { isUnifiedView: boolean; crossView: CrossView | null }): 'unread' | 'starred' | null {
  if (!state.isUnifiedView) return null;
  return state.crossView === 'unread' || state.crossView === 'starred' ? state.crossView : null;
}

/**
 * Immutably add/remove an id from the retain set. Returns the same set instance
 * when nothing changes (op 'none', or a no-op add/remove) to avoid needless
 * re-renders.
 */
function updateRetainedForView(current: Set<string>, op: 'add' | 'remove' | 'none', id: string): Set<string> {
  if (op === 'none') return current;
  if (op === 'add') {
    if (current.has(id)) return current;
    return new Set(current).add(id);
  }
  if (!current.has(id)) return current;
  const next = new Set(current);
  next.delete(id);
  return next;
}

/**
 * Re-insert rows the user just read/unstarred in an unread/starred cross view
 * that fell out of the fresh keyword-filtered page, keeping them at their prior
 * position so the row updates its status + counter instead of vanishing from
 * under the cursor. Rows genuinely gone (deleted/moved, hence absent from
 * `previous`) are NOT resurrected - only ids still present locally are kept.
 * Returns the original `merged` untouched when nothing needs retaining.
 */
function mergeRetainedRows(previous: Email[], merged: Email[], retainedIds: Set<string>): Email[] {
  if (retainedIds.size === 0) return merged;
  const mergedById = new Map(merged.map(e => [e.id, e] as const));
  const toRetain = previous.filter(e => retainedIds.has(e.id) && !mergedById.has(e.id));
  if (toRetain.length === 0) return merged;

  const previousIds = new Set(previous.map(e => e.id));
  const out: Email[] = [];
  const emitted = new Set<string>();
  // Genuinely new arrivals (not previously loaded) keep their fresh top slot.
  for (const e of merged) {
    if (!previousIds.has(e.id)) { out.push(e); emitted.add(e.id); }
  }
  // Then previous order: fresh copy if the row still matches, retained local
  // copy otherwise. Rows absent from both `merged` and the retain set are the
  // truly-removed ones and get dropped here.
  for (const e of previous) {
    if (emitted.has(e.id)) continue;
    const fresh = mergedById.get(e.id);
    if (fresh) { out.push(fresh); emitted.add(e.id); }
    else if (retainedIds.has(e.id)) { out.push(e); emitted.add(e.id); }
  }
  // Any deeper-page rows merged in but not covered above, in merged order.
  for (const e of merged) {
    if (!emitted.has(e.id)) { out.push(e); emitted.add(e.id); }
  }
  return out;
}

/** Most message ids a plugin may add to one search through onSearchResults. */
const MAX_PLUGIN_SEARCH_IDS = 100;

async function pluginSearchResultIds(query: string, filters: unknown, emails: Email[]): Promise<string[]> {
  if (emailHooks.onSearchResults.size === 0) return [];
  const shown = new Set(emails.map((e) => e.id));
  const ids = await emailHooks.onSearchResults.transform([] as string[], { query, filters, emailIds: [...shown] });
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length < 256 && !shown.has(id)))]
    .slice(0, MAX_PLUGIN_SEARCH_IDS);
}

/**
 * Plugins' results for the search that is running (onProvideSearchResults).
 * Asked beside the search, not before its list is shown: a slow plugin never
 * delays the messages, and the answer to a search that was replaced is dropped.
 */
let providedSearchRun: object | null = null;

function startProvidedSearchResults(
  query: string,
  filters: unknown,
  store: { get: () => EmailStore; set: (partial: Partial<EmailStore>) => void },
): void {
  const run = {};
  providedSearchRun = run;
  // Written only when it changes: a search without plugin results renders as before.
  const show = (results: ProvidedSearchResult[]) => {
    if (results.length > 0 || store.get().externalSearchResults.length > 0) store.set({ externalSearchResults: results });
  };
  show([]);
  if (emailHooks.onProvideSearchResults.size === 0) return;
  void provideSearchResults(query, filters).then((results) => {
    if (providedSearchRun === run) show(results);
  });
}

export const useEmailStore = create<EmailStore>((set, get) => ({
  emails: [],
  mailboxes: [],
  accountMailboxes: {},
  viewingAccountId: null,
  selectedEmail: null,
  selectedMailbox: "",
  isLoading: false,
  isLoadingEmail: false,
  isLoadingMore: false,
  error: null,
  searchQuery: "",
  quota: null,
  processingReadStatus: new Set(),
  selectedEmailKeys: new Set(),
  retainedInViewIds: new Set(),
  lastSelectedEmailKey: null,
  selectionFocus: null,
  listRows: null,
  hasMoreEmails: false,
  totalEmails: 0,
  listOrder: [],
  listKeepsServerTextOrder: false,
  listHold: null,
  isPushConnected: false,
  lastPushUpdate: null,
  emailListSync: null,
  unreadSection: null,
  mailboxSyncStates: {},
  newEmailNotification: null,

  // Thread expansion state
  expandedThreadIds: new Set(),
  threadEmailsCache: new Map(),
  isLoadingThread: null,
  threadEmailCounts: new Map(),

  // Keyword/tag filter
  selectedKeyword: null,
  tagCounts: {},

  // Advanced search state
  searchFilters: { ...DEFAULT_SEARCH_FILTERS },
  searchMailboxId: "",
  searchScopeFollowsFolder: false,
  isAdvancedSearchOpen: false,
  searchAbortController: null,
  externalSearchResults: [],

  // Unified mailbox state
  viewToken: 0,
  isUnifiedView: false,
  unifiedRole: null,
  crossView: null,
  unifiedErrors: new Map(),
  unifiedCounts: [],
  crossUnreadCount: 0,
  unifiedScope: [],

  // Scheduled send state
  scheduledEmails: [],
  scheduledEmailIds: new Set(),
  scheduledSubmissionByEmailId: new Map(),
  scheduledTotal: 0,
  scheduledHasMore: false,
  scheduledNextPosition: 0,
  scheduledTotalByAccount: {},
  isLoadingScheduled: false,
  isScheduledView: false,
  scheduledAccountScope: null,
  pendingUndoSend: null,

  // Spam undo cache
  spamUndoCache: new Map(),

  setEmails: (emails) => set({ emails }),
  setMailboxes: (mailboxes) => set({ mailboxes }),
  setAccountMailboxes: (accountId, mailboxes) => set((state) => ({
    accountMailboxes: { ...state.accountMailboxes, [accountId]: mailboxes },
  })),
  clearAccountMailboxes: () => set({ accountMailboxes: {} }),
  setViewingAccount: (accountId) => set({ viewingAccountId: accountId }),
  selectAccountMailbox: (accountId, mailboxId) => set(state => ({
    viewingAccountId: accountId,
    selectedMailbox: mailboxId,
    // The search panel's folder scope names a folder of the account we are
    // leaving. It resolves against `resolveActionMailboxes()`, which now
    // returns the NEW account's list, so the id no longer matches: the search
    // would query that foreign folder id against the wrong account and come
    // back empty, while the dropdown (which renders no matching option) reads
    // "All folders". Reset it so the scope matches what is shown. (#1082)
    // Only the new account's own list names its Spam/Trash: another
    // account's mailbox ids can collide with them. A scope that follows
    // the open folder moves to the new one.
    searchMailboxId: state.searchScopeFollowsFolder
      ? mailboxId
      : defaultSearchScopeFor(
        accountId ? state.accountMailboxes[accountId] ?? [] : state.mailboxes,
        mailboxId,
      ),
    isLoadingMore: false,
    selectedEmail: null,
    selectedEmailKeys: new Set(),
    selectedKeyword: null,
    expandedThreadIds: new Set(),
    threadEmailsCache: new Map(),
    threadEmailCounts: new Map(),
    isLoadingThread: null,
    // Account folders are always real folders; like selectMailbox, leave any
    // unified view so a pending unified fetch or refresh can't take it over (#1102).
    viewToken: state.viewToken + 1,
    isUnifiedView: false,
    unifiedRole: null,
    crossView: null,
  })),
  fetchAccountMailboxes: async (client, accountId, clientAccountId) => {
    try {
      // `accountId` is overloaded across callers:
      //  - a real login (AccountEntry.id, e.g. per-account sidebar / cross-account
      //    move) → `client` is that account's own login; getMailboxes() returns the
      //    right list.
      //  - a JMAP account id with no own login (a shared/group owner, used by the
      //    unified archive refresh) → must fetch by that JMAP id through the
      //    delegating client, else we'd cache the delegating account's own folders
      //    under the owner key.
      // Distinguish by whether a directly-logged-in client exists for the id.
      const hasOwnLogin = !!useAuthStore.getState().getClientForAccount(accountId);
      const mailboxes = hasOwnLogin
        ? await client.getMailboxes()
        : await client.getMailboxes(accountId);
      // Re-check the cache after the await to avoid stomping a more recent
      // fetch that finished while this one was in flight.
      set((state) => ({
        accountMailboxes: {
          ...state.accountMailboxes,
          [accountId]: mailboxes,
          ...(clientAccountId ? { [sourceMailboxesKey(clientAccountId, accountId)]: mailboxes } : {}),
        },
      }));
    } catch (error) {
      console.error(`Failed to fetch mailboxes for account ${accountId}:`, error);
    }
  },
  selectEmail: (email) => {
    const prev = get().selectedEmail;
    set({ selectedEmail: email, lastSelectedEmailKey: email ? emailKeyFor(email) : get().lastSelectedEmailKey });
    // Plain data only: handlers in a sandbox get a copy, and the raw store
    // object carries fields no plugin permission covers.
    if (prev && (!email || email.id !== prev.id) && emailHooks.onEmailClose.size > 0) {
      emailHooks.onEmailClose.emitSync({ emailId: prev.id });
    }
    if (email && (!prev || email.id !== prev.id) && emailHooks.onEmailOpen.size > 0) {
      emailHooks.onEmailOpen.emitSync(emailToReadView(email));
    }
  },
  beginOpenEmail: (row) => {
    const prev = get().selectedEmail;
    openingRow = row;
    set({ selectedEmail: row, lastSelectedEmailKey: emailKeyFor(row), isLoadingEmail: true });
    if (prev && row.id !== prev.id && emailHooks.onEmailClose.size > 0) {
      emailHooks.onEmailClose.emitSync({ emailId: prev.id });
    }
  },
  finishOpenEmail: (email) => {
    const prev = get().selectedEmail;
    const announced = prev !== null && prev !== openingRow;
    openingRow = null;
    set({ selectedEmail: email, lastSelectedEmailKey: emailKeyFor(email), isLoadingEmail: false });
    if (announced && prev.id !== email.id && emailHooks.onEmailClose.size > 0) {
      emailHooks.onEmailClose.emitSync({ emailId: prev.id });
    }
    if ((!announced || prev.id !== email.id) && emailHooks.onEmailOpen.size > 0) {
      emailHooks.onEmailOpen.emitSync(emailToReadView(email));
    }
  },
  abandonOpenEmail: (previous) => {
    const showing = get().selectedEmail;
    const wasRow = showing !== null && showing === openingRow;
    openingRow = null;
    set({ selectedEmail: previous, isLoadingEmail: false });
    // beginOpenEmail announced the close of `previous`; it is open again.
    if (wasRow && previous && showing.id !== previous.id && emailHooks.onEmailOpen.size > 0) {
      emailHooks.onEmailOpen.emitSync(emailToReadView(previous));
    }
  },
  holdListRow: (rowKey) => {
    const { listHold, emails, isScheduledView } = get();
    if (listHold?.rowKey === rowKey) return;
    const keywords = new Map<string, Email['keywords']>();
    for (const email of emails) {
      if (listRowKey(email, isScheduledView) === rowKey) keywords.set(email.id, email.keywords);
    }
    set({ listHold: { rowKey, keywords } });
  },
  selectKeyword: (keyword) => set(state => ({
    selectedKeyword: keyword,
    isLoadingMore: false,
    selectedEmail: null,
    selectedEmailKeys: new Set(),
    expandedThreadIds: new Set(),
    threadEmailsCache: new Map(),
    threadEmailCounts: new Map(),
    viewToken: state.viewToken + 1,
    isUnifiedView: false,
    unifiedRole: null,
    crossView: null,
  })),
  fetchTagCounts: (client) => coalesceRefresh(client, 'tagCounts', async () => {
    try {
      const keywords = useSettingsStore.getState().emailKeywords;
      if (keywords.length === 0) {
        set({ tagCounts: {} });
        return;
      }
      const tagIds = keywords.map(k => k.id);
      // The badge counts what the tag view lists: messages in the own account
      // AND in the group/shared accounts this login reaches (#1038). Sum the
      // per-account counts; an account that fails just contributes nothing.
      // Trash and Junk are left out of both, see fetchTagEmails (#1156).
      const built = buildTagViewAccountClients(client);
      const perAccount = await Promise.allSettled(
        built.map((a) => a.client.getTagCounts(tagIds, a.isShared ? a.accountId : undefined, trashAndJunkIds(a))),
      );
      const counts: Record<string, { total: number; unread: number }> = {};
      for (const outcome of perAccount) {
        if (outcome.status !== 'fulfilled') continue;
        for (const [id, c] of Object.entries(outcome.value)) {
          const cur = counts[id] ?? { total: 0, unread: 0 };
          counts[id] = { total: cur.total + c.total, unread: cur.unread + c.unread };
        }
      }
      set({ tagCounts: counts });
    } catch (error) {
      console.error('Failed to fetch tag counts:', error);
    }
  }),
  selectMailbox: (mailboxId) => set(state => {
    const mailboxes = mailboxesInView(state);
    // The folder's default search scope follows it (Spam and Trash search
    // themselves); a scope the user picked in the dropdown stays. The
    // unread badge's scope follows any real folder.
    const scopeIsDefault = state.searchMailboxId === defaultSearchScopeFor(mailboxes, state.selectedMailbox);
    const scopeFollows = state.searchScopeFollowsFolder && mailboxes.some(m => m.id === mailboxId);
    return {
      selectedMailbox: mailboxId,
      ...(scopeFollows
        ? { searchMailboxId: mailboxId }
        : scopeIsDefault ? { searchMailboxId: defaultSearchScopeFor(mailboxes, mailboxId) } : {}),
      isLoadingMore: false,
      selectedEmail: null,
      selectedEmailKeys: new Set(),
      selectedKeyword: null,
      expandedThreadIds: new Set(),
      threadEmailsCache: new Map(),
      threadEmailCounts: new Map(),
      isLoadingThread: null,
      viewToken: state.viewToken + 1,
      isUnifiedView: false,
      unifiedRole: null,
      crossView: null,
    };
  }),
  setLoading: (loading) => set({ isLoading: loading }),
  setLoadingEmail: (loading) => set({ isLoadingEmail: loading }),
  setError: (error) => set({ error }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setQuota: (quota) => set({ quota }),

  toggleEmailSelection: (email) => {
    const key = emailKeyFor(email);
    const { selectedEmailKeys } = get();
    const newSelection = new Set(selectedEmailKeys);
    if (newSelection.has(key)) {
      newSelection.delete(key);
    } else {
      newSelection.add(key);
    }
    set({ selectedEmailKeys: newSelection, lastSelectedEmailKey: key });
  },

  setListRows: (rows) => set({ listRows: rows }),

  selectRangeEmails: (target) => {
    const { emails, lastSelectedEmailKey, selectedEmailKeys, listRows } = get();
    const anchorKey = lastSelectedEmailKey || (emails[0] && emailKeyFor(emails[0]));
    if (!anchorKey) return;
    const targetKeyForRows = emailKeyFor(target);
    if (listRows && listRows.length > 0) {
      const anchorRow = findListRow(listRows, anchorKey);
      const targetRow = findListRow(listRows, targetKeyForRows);
      if (anchorRow !== -1 && targetRow !== -1) {
        const newSelection = new Set(selectedEmailKeys);
        for (let i = Math.min(anchorRow, targetRow); i <= Math.max(anchorRow, targetRow); i++) {
          for (const key of listRows[i].members) newSelection.add(key);
        }
        set({ selectedEmailKeys: newSelection, selectionFocus: { anchor: anchorKey, focus: targetKeyForRows } });
        return;
      }
    }
    const anchorIndex = emails.findIndex(e => emailKeyFor(e) === anchorKey);
    const targetKey = emailKeyFor(target);
    const targetIndex = emails.findIndex(e => emailKeyFor(e) === targetKey);
    if (anchorIndex === -1 || targetIndex === -1) return;
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const newSelection = new Set(selectedEmailKeys);
    for (let i = start; i <= end; i++) {
      newSelection.add(emailKeyFor(emails[i]));
    }
    set({ selectedEmailKeys: newSelection, selectionFocus: { anchor: anchorKey, focus: targetKey } });
  },

  extendSelection: (direction) => {
    const { emails, listRows, lastSelectedEmailKey, selectedEmail, selectedEmailKeys, selectionFocus } = get();
    // Walk the rows on screen, as shift-click does; without them, the emails.
    const rows: ListRow[] = listRows && listRows.length > 0
      ? listRows
      : emails.map((e) => ({ key: emailKeyFor(e), members: [emailKeyFor(e)] }));
    if (rows.length === 0) return;
    const membersOf = (from: number, to: number) => {
      const keys: string[] = [];
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) keys.push(...rows[i].members);
      return keys;
    };

    const anchorKey = lastSelectedEmailKey ?? (selectedEmail ? emailKeyFor(selectedEmail) : null);
    const anchor = anchorKey ? findListRow(rows, anchorKey) : -1;
    if (!anchorKey || anchor === -1) {
      // Nothing to extend from: start with the row at the end the key points from.
      const start = rows[direction > 0 ? 0 : rows.length - 1];
      set({
        selectedEmailKeys: new Set([...selectedEmailKeys, ...start.members]),
        lastSelectedEmailKey: start.key,
        selectionFocus: { anchor: start.key, focus: start.key },
      });
      return;
    }

    // Continue the range this anchor already has, or begin one at the anchor.
    const previous = selectionFocus && selectionFocus.anchor === anchorKey && selectedEmailKeys.size > 0
      ? findListRow(rows, selectionFocus.focus)
      : -1;
    const focus = previous === -1 ? anchor : previous;
    const nextFocus = Math.max(0, Math.min(rows.length - 1, focus + direction));

    const newSelection = new Set(selectedEmailKeys);
    if (previous !== -1) {
      for (const key of membersOf(anchor, previous)) newSelection.delete(key);
    }
    for (const key of membersOf(anchor, nextFocus)) newSelection.add(key);
    set({ selectedEmailKeys: newSelection, selectionFocus: { anchor: anchorKey, focus: rows[nextFocus].key } });
  },

  selectAllEmails: () => {
    const { emails } = get();
    set({ selectedEmailKeys: new Set(emails.map(emailKeyFor)) });
  },

  clearSelection: () => {
    set({ selectedEmailKeys: new Set(), lastSelectedEmailKey: null });
  },

  // JMAP operations
  fetchMailboxes: (client) => coalesceRefresh(client, 'mailboxes', async () => {
    // An account switch while this is in flight empties the stores for the
    // next account; this account's folders must not land in them.
    const epoch = currentStoreEpoch();
    const stale = () => currentStoreEpoch() !== epoch;
    // Only toggle the email list's isLoading on the initial load. Background
    // refreshes (after a move/archive that may have created new folders) must
    // not flash the list's loading state, which hides the results-count bar
    // and dims the list while folders re-fetch.
    const isInitialLoad = get().mailboxes.length === 0;
    if (isInitialLoad) set({ isLoading: true, error: null });
    try {
      // Prefer the state-reporting variant so a later Mailbox push can be
      // resolved as a delta (applyMailboxDelta) instead of this full refetch.
      const fetched = client.getAllMailboxesWithState
        ? await client.getAllMailboxesWithState()
        : { mailboxes: await client.getAllMailboxes(), states: {} };
      if (stale()) return;
      const mailboxes = fetched.mailboxes;

      // Guard against a transient fetch returning an empty list (e.g. a server
      // concurrent-request limit hit during a burst of deletes). Replacing a
      // populated folder list with [] leaves the sidebar stuck on "Loading
      // mailboxes..." until the next successful refetch. Keep what we have.
      if (mailboxes.length === 0 && !isInitialLoad) {
        return;
      }

      // Publish the existing mailbox-refresh extension hook after a successful
      // fetch. This is also emitted for Mailbox-only state changes (for example
      // an empty provider label), where no Email fetch follows.
      if (emailHooks.onMailboxesRefresh.size > 0) await emailHooks.onMailboxesRefresh.emit(mailboxes.map(mailboxToView));
      if (stale()) return;

      // Auto-select inbox if no mailbox is selected or the current selection
      // doesn't exist in the fetched list (e.g. after an account switch)
      const currentSelectedMailbox = get().selectedMailbox;
      const selectionValid = currentSelectedMailbox === VIRTUAL_SCHEDULED_MAILBOX_ID
        // Unified per-role views (All Inbox/Drafts/Junk/…) and cross-account views
        // (All unread/starred/all) use a virtual id not present in the fetched
        // list. A background refresh after a delete must not clobber it and jump
        // the user back to the inbox.
        || isUnifiedMailboxId(currentSelectedMailbox)
        || isCrossViewId(currentSelectedMailbox)
        || (currentSelectedMailbox && mailboxes.some(m => m.id === currentSelectedMailbox));
      // A first load with folders leaves isLoading on: the first page is
      // fetched next and turns it off. Dropping it here showed "No emails"
      // between the two, and a new skeleton after it.
      const loadingPatch = isInitialLoad && mailboxes.length === 0
        ? { isLoading: false, mailboxSyncStates: fetched.states }
        : { mailboxSyncStates: fetched.states };
      if (!selectionValid) {
        // A search scope naming a folder that is gone (e.g. the Spam/Trash
        // the default scope followed) falls back to the default.
        const scope = get().searchMailboxId;
        const scopePatch = !isAllFoldersSearchScope(scope) && !mailboxes.some(m => m.id === scope)
          ? { searchMailboxId: '' }
          : {};
        // Find inbox from PRIMARY account (not shared accounts)
        const inboxMailbox = mailboxes.find(m => m.role === 'inbox' && !m.isShared);
        if (inboxMailbox) {
          set({ mailboxes, selectedMailbox: inboxMailbox.id, ...scopePatch, ...loadingPatch });
        } else {
          set({ mailboxes, selectedMailbox: '', ...scopePatch, ...loadingPatch });
        }
      } else {
        set({ mailboxes, ...loadingPatch });
      }
    } catch (error) {
      if (stale()) return;
      // The existing folder list is deliberately left untouched: a failed
      // background refresh must never blank the sidebar (#780).
      set({
        error: error instanceof Error ? error.message : "Failed to fetch mailboxes",
        ...(isInitialLoad ? { isLoading: false } : {})
      });
    }
  }),

  prefetchInitialData: async (client) => {
    // Coalesce overlapping callers (e.g. login() and a slow home-page useEffect
    // racing for the same fetch). The promise is stashed on the client so we
    // don't need a separate keyed map and stale entries can't outlive the client.
    const target = client as IJMAPClient & { __prefetchPromise?: Promise<void>; __initialDataLoaded?: boolean };
    if (target.__prefetchPromise) return target.__prefetchPromise;
    target.__prefetchPromise = (async () => {
      try {
        await Promise.all([
          get().fetchMailboxes(client),
          get().fetchQuota(client),
        ]);
        const { selectedMailbox } = get();
        if (selectedMailbox) {
          await get().fetchEmails(client, selectedMailbox);
        } else {
          await get().fetchEmails(client);
        }
        target.__initialDataLoaded = get().mailboxes.length > 0;
        // Tag counts can finish whenever; don't block the prefetch on them.
        void get().fetchTagCounts(client);
      } finally {
        delete target.__prefetchPromise;
      }
    })();
    return target.__prefetchPromise;
  },

  fetchEmails: async (client, mailboxId, opts) => {
    const isCurrentView = captureEmailListView();
    // A background refresh (e.g. after an account switch restored a cached list)
    // repopulates the list without showing the loading overlay, so switching to
    // an already-visited account doesn't flash a spinner over the visible mail.
    let background = opts?.background ?? false;
    // Loading a real mailbox is a fresh navigation (leaving any cross view), so
    // drop the unread/starred retain set and the held row.
    set(background ? { error: null, retainedInViewIds: new Set(), listHold: null } : { isLoading: true, error: null, retainedInViewIds: new Set(), listHold: null }); // Keep previous emails visible during transition
    try {
      const targetMailboxId = mailboxId || get().selectedMailbox;
      if (targetMailboxId === VIRTUAL_SCHEDULED_MAILBOX_ID) {
        set({ isLoading: false, emails: [], hasMoreEmails: false, totalEmails: 0 });
        await get().fetchScheduledEmails(client);
        return;
      }

      // Unified / cross-account views use client-only virtual mailbox ids
      // (`__cross_*`, `__unified_*`) that no JMAP server accepts as `inMailbox`.
      // Route them through the fan-out loaders (mirrors loadMoreEmails /
      // refreshCurrentMailbox) instead of sending the virtual id to getEmails,
      // which the server rejects and the catch below then empties the list (#791).
      if (isCrossViewId(targetMailboxId) || isUnifiedMailboxId(targetMailboxId)) {
        const { crossView, unifiedRole, searchQuery, searchFilters } = get();
        // View state not resolved yet: don't send a virtual id and don't wipe
        // the current list - just stop the loading state.
        if (!crossView && !unifiedRole) {
          set({ isLoading: false });
          return;
        }
        const emailsPerPage = useSettingsStore.getState().emailsPerPage;
        const includeGroup = useSettingsStore.getState().includeGroupInUnified;
        const built = await buildUnifiedAccountClients({ includeGroup });
        const hasFilters = !isFilterEmpty(searchFilters);
        const result = crossView
          ? (hasFilters
              ? await advancedSearchCrossViewEmails(built, crossView, buildJMAPFilter(searchQuery, searchFilters, undefined), emailsPerPage, 0)
              : searchQuery
                ? await searchCrossViewEmails(built, crossView, searchQuery, emailsPerPage, 0)
                : await fetchCrossViewEmails(built, crossView, emailsPerPage, 0))
          : (hasFilters
              ? await advancedSearchUnifiedEmails(built, unifiedRole!, (mb) => buildJMAPFilter(searchQuery, searchFilters, mb), emailsPerPage, 0)
              : searchQuery
                ? await searchUnifiedEmails(built, unifiedRole!, searchQuery, emailsPerPage, 0)
                : await fetchUnifiedEmails(built, unifiedRole!, emailsPerPage, 0, getMessageListOrderFor(unifiedRole)));
        const enrichedEmails = await emailHooks.onEmailsFetched.transform(result.emails);
        if (!isCurrentView()) return;
        set({
          emails: annotateScheduledEmails(enrichedEmails, get().scheduledSubmissionByEmailId),
          hasMoreEmails: result.hasMore,
          totalEmails: result.total,
          listOrder: crossView || hasFilters || searchQuery ? [] : getMessageListOrderFor(unifiedRole),
          // Merged from several accounts with the client comparator.
          listKeepsServerTextOrder: false,
          emailListSync: null,
          threadEmailsCache: new Map(),
          expandedThreadIds: new Set(),
          isLoadingThread: null,
          isLoading: false,
          unifiedErrors: result.errors,
        });
        return;
      }

      // Get emails per page from settings
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;

      // A tag view takes precedence over the selected folder. Tags span
      // folders AND accounts: the same keyword sits on messages in the user's
      // own account and in the group/shared accounts they can reach, so fan
      // out over all of them instead of querying only the account of the
      // folder that happened to be selected (#1038). A tag view has no role,
      // so it only follows the list order under the "all folders" scope (#718).
      const { selectedKeyword } = get();
      if (selectedKeyword) {
        const order = getMessageListOrderFor(null);
        const built = buildTagViewAccountClients(client);
        // Selecting a tag keeps an active search (`handleTagSelect` does not
        // clear it), and the search paths narrow the tag rather than replace
        // it — so honour the query here too, or the list would flip between
        // narrowed and whole depending on which path last ran.
        const { searchQuery: tagQuery, searchFilters: tagFilters } = get();
        const tagFilter = !isFilterEmpty(tagFilters)
          ? buildJMAPFilter(tagQuery, tagFilters, undefined)
          : tagQuery
            ? textFilter(tagQuery)
            : undefined;
        const result = await fetchTagEmails(built, `$label:${selectedKeyword}`, emailsPerPage, 0, order, tagFilter);
        const enrichedEmails = await emailHooks.onEmailsFetched.transform(result.emails);
        if (!isCurrentView()) return;
        set({
          emails: annotateScheduledEmails(enrichedEmails, get().scheduledSubmissionByEmailId),
          hasMoreEmails: result.hasMore,
          totalEmails: result.total,
          listOrder: order,
          // Merged from several accounts with the client comparator.
          listKeepsServerTextOrder: false,
          // A server-side keyword filter cannot be delta-synced.
          emailListSync: null,
          threadEmailsCache: new Map(),
          expandedThreadIds: new Set(),
          isLoadingThread: null,
          isLoading: false,
          unifiedErrors: result.errors,
        });
        void get().fetchThreadEmailCounts(client);
        return;
      }

      const effectiveClient = resolveActionClient(client);

      // Find the mailbox to get its accountId (for shared folder support)
      const mailboxes = resolveActionMailboxes();
      const mailbox = mailboxes.find(mb => mb.id === targetMailboxId);
      // Only pass accountId for shared mailboxes, not for primary account
      const accountId = mailbox?.isShared ? mailbox.accountId : undefined;
      // Use originalId for JMAP queries (shared mailboxes use namespaced IDs in the store)
      const jmapMailboxId = mailbox?.originalId || targetMailboxId;

      // Plugin-registered category tabs (Gmail-style) AND their resolved JMAP
      // filter fragment into the mailbox view, and the "Unread first" inbox
      // leaves its unread mail to the section above the list.
      const categoryFilter = folderListFilter(mailbox, get());
      const unreadFirst = unreadFirstFor(mailbox, get());
      const sectionLoad = unreadFirst && mailbox
        ? loadUnreadSection(client, mailbox, get).catch((error) => {
            console.error('Failed to fetch the unread section:', error);
            return null;
          })
        : null;
      const showSection = async () => {
        if (!sectionLoad) return;
        const loaded = await sectionLoad;
        if (loaded && isCurrentView()) applyUnreadSection(get, set, targetMailboxId, loaded);
      };

      // The configured list order (#718).
      const order = getMessageListOrderFor(mailbox?.role);

      // Paint what this folder showed last time and load behind it: the rows
      // are there at once, the fresh page replaces them when it lands, and a
      // failed load leaves them in place instead of emptying the folder.
      const listKey = folderListKey({
        login: useAuthStore.getState().activeAccountId,
        viewingAccountId: get().viewingAccountId,
        // The login tells own accounts apart; a shared folder adds its owner.
        accountId: accountId ?? '',
        mailboxId: targetMailboxId,
        filter: categoryFilter,
        order,
      });
      const remembered = background ? undefined : rememberedFolderList(listKey);
      if (remembered) {
        background = true;
        set({
          emails: annotateScheduledEmails(remembered.emails, get().scheduledSubmissionByEmailId),
          hasMoreEmails: remembered.hasMoreEmails,
          totalEmails: remembered.totalEmails,
          listOrder: order,
          // The state the page was current at, if it was a plain folder list:
          // a push delta, and the catch-up below, start from it.
          emailListSync: remembered.sync?.mailboxId === targetMailboxId ? remembered.sync : null,
          threadEmailCounts: remembered.threadEmailCounts ?? new Map(),
          threadEmailsCache: new Map(),
          expandedThreadIds: new Set(),
          isLoadingThread: null,
          isLoading: false,
          // The remembered page holds the section's rows too; they are its unread ones.
          unreadSection: unreadFirst ? sectionFromUnreadRows(remembered.emails, targetMailboxId) : null,
        });
      } else if (!unreadFirst) {
        set({ unreadSection: null });
      }
      // Until this folder's rows are on screen, edits to the list belong to
      // whatever was showing before and must not be remembered under this key.
      shownFolderList = remembered ? { key: listKey, mailboxId: targetMailboxId, pageSize: emailsPerPage } : null;

      // A background refresh of rows already on screen for this folder, in
      // this order (an account switch or boot restoring its snapshot), can
      // start from their baseline too instead of replacing every row.
      const shownSync = get().emailListSync;
      const refreshesShownRows = background && !remembered && !!shownSync
        && shownSync.mailboxId === targetMailboxId
        && JSON.stringify(get().listOrder) === JSON.stringify(order);
      if (refreshesShownRows) shownFolderList = { key: listKey, mailboxId: targetMailboxId, pageSize: emailsPerPage };

      // A remembered page with a baseline only needs what changed since
      // (Email/changes): usually nothing, and then the rows stay as they are
      // instead of being re-read and rendered again. Anything the delta
      // cannot settle falls through to the full page below.
      if ((remembered || refreshesShownRows) && get().emailListSync && !categoryFilter) {
        const upToDate = await applyEmailDeltaNow(client, null, get, set);
        if (!isCurrentView()) return;
        if (upToDate) {
          await showSection();
          rememberFolderList(listKey, folderListState(get()), emailsPerPage);
          // The boot snapshot carries no conversation sizes.
          if (get().threadEmailCounts.size === 0) void get().fetchThreadEmailCounts(client);
          return;
        }
      }

      const result = await effectiveClient.getEmails(
        jmapMailboxId,
        accountId,
        emailsPerPage,
        0,
        undefined,
        true,
        categoryFilter ?? undefined,
        order,
      );
      const enrichedEmails = await emailHooks.onEmailsFetched.transform(result.emails);
      if (!isCurrentView()) return;
      // Only a plain folder list can be delta-synced; category views filter
      // server-side, and a delta cannot tell which changed rows would match
      // that filter.
      const emailListSync: EmailListSync | null =
        result.state && !categoryFilter
          ? {
              state: result.state,
              accountId: accountId ?? effectiveClient.getAccountId(),
              mailboxId: targetMailboxId,
            }
          : null;
      const threadCounts = threadCountsPatch(enrichedEmails, result.threadCounts, get().threadEmailCounts);
      set({
        emails: annotateScheduledEmails(enrichedEmails, get().scheduledSubmissionByEmailId),
        hasMoreEmails: result.hasMore,
        totalEmails: result.total,
        listOrder: order,
        listKeepsServerTextOrder: effectiveClient.keepsServerTextOrder?.(accountId) ?? false,
        emailListSync,
        // Clear thread caches since the email list was fully replaced
        threadEmailsCache: new Map(),
        expandedThreadIds: new Set(),
        isLoadingThread: null,
        ...threadCounts,
        isLoading: false
      });
      shownFolderList = { key: listKey, mailboxId: targetMailboxId, pageSize: emailsPerPage };
      await showSection();
      rememberFolderList(listKey, folderListState(get()), emailsPerPage);
      // Only a server that did not answer the chained Thread/get needs a
      // request of its own for the conversation sizes.
      if (!('threadEmailCounts' in threadCounts)) void get().fetchThreadEmailCounts(client);
    } catch (error) {
      if (!isCurrentView()) return;
      console.error('Failed to fetch emails:', error);
      // A failed background refresh must not wipe the list it was refreshing -
      // keep the restored/prefetched emails visible and just surface the error.
      if (background) {
        set({ error: error instanceof Error ? error.message : "Failed to fetch emails" });
      } else {
        set({
          error: error instanceof Error ? error.message : "Failed to fetch emails",
          isLoading: false,
          emails: [],
          hasMoreEmails: false,
          totalEmails: 0
        });
      }
    }
  },

  loadMoreEmails: async (client) => {
    const { isLoadingMore, hasMoreEmails, emails, selectedMailbox, searchQuery, selectedKeyword, isUnifiedView, unifiedRole, crossView } = get();
    const isCurrentView = captureEmailListView();

    // Don't load if already loading or no more emails
    if (isLoadingMore || !hasMoreEmails) return;

    // Cross-account views fan out across all accounts' included folders. Paginate
    // via the cross-view loader (search-aware), mirroring the unified branch.
    if (isUnifiedView && crossView) {
      set({ isLoadingMore: true, error: null });
      try {
        const emailsPerPage = useSettingsStore.getState().emailsPerPage;
        const includeGroup = useSettingsStore.getState().includeGroupInUnified;
        const position = positionsByAccount(emails);
        const built = await buildUnifiedAccountClients({ includeGroup });
        const hasFilters = !isFilterEmpty(get().searchFilters);
        const result = hasFilters
          ? await advancedSearchCrossViewEmails(built, crossView, buildJMAPFilter(searchQuery, get().searchFilters, undefined), emailsPerPage, position)
          : searchQuery
            ? await searchCrossViewEmails(built, crossView, searchQuery, emailsPerPage, position)
            : await fetchCrossViewEmails(built, crossView, emailsPerPage, position);
        const currentEmails = get().emails;
        const existingIds = new Set(currentEmails.map(e => e.id));
        const newEmails = result.emails.filter(e => !existingIds.has(e.id));
        const enrichedNewEmails = await emailHooks.onEmailsFetched.transform(newEmails);
        if (!isCurrentView()) return;
        set({
          emails: [...currentEmails, ...enrichedNewEmails],
          hasMoreEmails: result.hasMore,
          totalEmails: result.total,
          isLoadingMore: false,
          unifiedErrors: result.errors,
        });
      } catch (error) {
        if (!isCurrentView()) return;
        console.error('Failed to load more cross-account emails:', error);
        set({
          error: error instanceof Error ? error.message : "Failed to load more emails",
          isLoadingMore: false,
        });
      }
      return;
    }

    // Unified view uses a different fan-out loader. When a search query or
    // advanced filter is active we paginate the unified search instead of the
    // unified browse, so "load more" matches what's on screen.
    if (isUnifiedView && unifiedRole) {
      set({ isLoadingMore: true, error: null });
      try {
        const emailsPerPage = useSettingsStore.getState().emailsPerPage;
        const includeGroup = useSettingsStore.getState().includeGroupInUnified;
        const position = positionsByAccount(emails);
        const built = await buildUnifiedAccountClients({ includeGroup });
        const { searchFilters } = get();
        const hasFilters = !isFilterEmpty(searchFilters);
        const result = hasFilters
          ? await advancedSearchUnifiedEmails(
              built,
              unifiedRole,
              (mailboxId) => buildJMAPFilter(searchQuery, searchFilters, mailboxId),
              emailsPerPage,
              position,
            )
          : searchQuery
            ? await searchUnifiedEmails(built, unifiedRole, searchQuery, emailsPerPage, position)
            : await fetchUnifiedEmails(built, unifiedRole, emailsPerPage, position, getMessageListOrderFor(unifiedRole));
        const currentEmails = get().emails;
        const existingIds = new Set(currentEmails.map(e => e.id));
        const newEmails = result.emails.filter(e => !existingIds.has(e.id));
        const enrichedNewEmails = await emailHooks.onEmailsFetched.transform(newEmails);
        if (!isCurrentView()) return;
        set({
          emails: [...currentEmails, ...enrichedNewEmails],
          hasMoreEmails: result.hasMore,
          totalEmails: result.total,
          isLoadingMore: false,
          unifiedErrors: result.errors,
        });
      } catch (error) {
        if (!isCurrentView()) return;
        console.error('Failed to load more unified emails:', error);
        set({
          error: error instanceof Error ? error.message : "Failed to load more emails",
          isLoadingMore: false,
        });
      }
      return;
    }

    set({ isLoadingMore: true, error: null });
    try {
      if (selectedMailbox === VIRTUAL_SCHEDULED_MAILBOX_ID) {
        set({ isLoadingMore: false });
        await get().loadMoreScheduledEmails(client);
        return;
      }

      const effectiveClient = resolveActionClient(client);
      // Get emails per page from settings
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;

      // Capture position from current email count before the async call
      const position = emails.length;

      let result;

      const { searchFilters } = get();
      const hasFilters = !isFilterEmpty(searchFilters);

      if ((searchQuery || hasFilters) && selectedKeyword) {
        // Searching inside a tag view narrows the tag (see searchEmails), so
        // page 2 must carry the same keyword AND the same query — otherwise it
        // appends unrelated all-folders hits to a tag list.
        const built = buildTagViewAccountClients(client);
        result = await fetchTagEmails(
          built, `$label:${selectedKeyword}`, emailsPerPage, positionsByAccount(emails), getMessageListOrderFor(null),
          hasFilters
            ? buildJMAPFilter(searchQuery, searchFilters, undefined)
            : textFilter(searchQuery),
        );
        set({ unifiedErrors: result.errors });
      } else if (searchQuery || hasFilters) {
        // Paginate with the same scope the search itself ran under, not the
        // folder that happens to be open in the list.
        const { searchMailboxId } = get();
        if (isAllFoldersSearchScope(searchMailboxId)) {
          // Folder-less scope: the next page of the same own + group account
          // fan-out the search ran (#1082).
          const built = buildTagViewAccountClients(client);
          const scope = acrossAccountsSearchOptions(searchMailboxId);
          result = hasFilters
            ? await advancedSearchAcrossAccounts(built, buildJMAPFilter(searchQuery, searchFilters, undefined), emailsPerPage, positionsByAccount(emails), scope)
            : await searchAcrossAccounts(built, searchQuery, emailsPerPage, positionsByAccount(emails), scope);
          set({ unifiedErrors: result.errors });
        } else {
          const mailboxes = resolveActionMailboxes();
          const mailbox = mailboxes.find(mb => mb.id === searchMailboxId);
          const jmapMailboxId = mailbox?.originalId || searchMailboxId;
          const accountId = mailbox?.isShared ? mailbox.accountId : undefined;

          if (hasFilters) {
            const filter = buildJMAPFilter(searchQuery, searchFilters, jmapMailboxId);
            result = await effectiveClient.advancedSearchEmails(filter, accountId, emailsPerPage, position);
          } else {
            result = await effectiveClient.searchEmails(searchQuery, jmapMailboxId, accountId, emailsPerPage, position);
          }
        }
      } else if (selectedKeyword) {
        // Tag view: the next page of the same cross-account fan-out the
        // initial fetch ran (same keyword, no folder constraint, same order),
        // so pagination spans the own and group accounts alike (#1038).
        const built = buildTagViewAccountClients(client);
        result = await fetchTagEmails(
          built, `$label:${selectedKeyword}`, emailsPerPage, positionsByAccount(emails), getMessageListOrderFor(null),
        );
        set({ unifiedErrors: result.errors });
      } else {
        // Load more from mailbox
        // Find the mailbox to get its accountId (for shared folder support)
        const mailboxes = resolveActionMailboxes();
        const mailbox = mailboxes.find(mb => mb.id === selectedMailbox);
        // Only pass accountId for shared mailboxes, not for primary account
        const accountId = mailbox?.isShared ? mailbox.accountId : undefined;
        // Use originalId for JMAP queries (shared mailboxes use namespaced IDs in the store)
        const jmapMailboxId = mailbox?.originalId || selectedMailbox;

        // Category tabs (plugin-registered) must filter pagination the same
        // way as the initial fetch or pages would mix categories.
        const categoryFilter = folderListFilter(mailbox, get());
        // Rows kept out of a keyword order (the open conversation, see
        // refreshCurrentMailbox) are not part of the loaded head of the
        // server order; counting them would skip as many rows. Neither are
        // the rows of the Unread section.
        const retained = get().retainedInViewIds;
        const outOfOrder = emails.filter(e => retained.has(e.id)).length
          + unreadSectionRowCount(emails, get().unreadSection);
        result = await effectiveClient.getEmails(
          jmapMailboxId,
          accountId,
          emailsPerPage,
          position - outOfOrder,
          undefined,
          true,
          categoryFilter ?? undefined,
          getMessageListOrderFor(mailbox?.role),
        );
        // A kept row this page reached is back in order, and so is a row
        // of the Unread section that was read since.
        const reached = new Set(result.emails.map(e => e.id));
        if (outOfOrder > 0 && [...retained].some(id => reached.has(id))) {
          set({ retainedInViewIds: new Set([...get().retainedInViewIds].filter(id => !reached.has(id))) });
        }
        const unreadSection = withoutReached(get().unreadSection, reached);
        if (unreadSection !== get().unreadSection) set({ unreadSection });
      }

      // Use fresh state when merging to avoid overwriting concurrent updates
      // (e.g. refreshCurrentMailbox running during the load)
      const currentEmails = get().emails;

      // Deduplicate: the server may return overlapping results if new emails
      // arrived between paginated requests and shifted positions.
      const existingIds = new Set(currentEmails.map(e => e.id));
      const newEmails = annotateScheduledEmails(result.emails, get().scheduledSubmissionByEmailId).filter((e: Email) => !existingIds.has(e.id));

      const enrichedNewEmails = await emailHooks.onEmailsFetched.transform(newEmails);
      if (!isCurrentView()) return;
      const threadCounts = threadCountsPatch(
        enrichedNewEmails, 'threadCounts' in result ? result.threadCounts : undefined, get().threadEmailCounts,
      );
      set({
        emails: [...currentEmails, ...enrichedNewEmails],
        hasMoreEmails: result.hasMore,
        totalEmails: result.total,
        ...threadCounts,
        isLoadingMore: false
      });
      // Thread counts for the new rows, unless the page brought them along.
      if (enrichedNewEmails.length > 0 && !('threadEmailCounts' in threadCounts)) {
        void get().fetchThreadEmailCounts(client);
      }
    } catch (error) {
      if (!isCurrentView()) return;
      console.error('Failed to load more emails:', error);
      set({
        error: error instanceof Error ? error.message : "Failed to load more emails",
        isLoadingMore: false
      });
    }
  },

  fetchEmailContent: async (client, emailId, ownerAccountId) => {
    try {
      // Route to the owning account. In aggregate views (All Mail, unified,
      // cross-account) the selected mailbox is virtual, so derive the client +
      // accountId from the email itself (handles shared/group accounts); fall
      // back to the selected-mailbox shared-folder logic for normal views.
      const selected = get().selectedEmail;
      let listEmail = selected?.id === emailId ? selected : get().emails.find(e => e.id === emailId);
      let { client: actionClient, accountId } = resolveEmailBlobContext(listEmail ?? null, client);
      // A link names the account of a message outside the login's own; a
      // listed row with its id from another account is not that message.
      if (ownerAccountId && accountId !== ownerAccountId) {
        listEmail = undefined;
        actionClient = client;
        accountId = ownerAccountId;
      }
      if (!actionClient) throw new Error('No connected client for email source');

      const email = await actionClient.getEmail(emailId, accountId);

      if (email) {
        // Email/get does not return client-only source metadata. Keep the source
        // captured before the await, including automatic selection after actions.
        // Only carry stamps the list row has. A direct-folder row stays
        // unstamped, since threadKeyFor scopes keys by these stamps.
        const annotatedEmail = annotateScheduledEmail({
          ...email,
          sourceClientAccountId: listEmail?.sourceClientAccountId,
          sourceAccountId: listEmail?.sourceAccountId,
        }, get().scheduledSubmissionByEmailId);
        annotatedEmail.accountId = listEmail?.accountId;
        annotatedEmail.accountLabel = listEmail?.accountLabel;
        annotatedEmail.sourceFolder = listEmail?.sourceFolder;
        set({ selectedEmail: annotatedEmail });
        return annotatedEmail;
      }
      return email;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to fetch email content"
      });
      return null;
    }
  },

  fetchQuota: async (client) => {
    try {
      const quota = await resolveActionClient(client).getQuota();
      set({ quota });
    } catch {
      // Don't set error state as quota is optional
    }
  },

  sendEmail: async (client, to, subject, body, cc, bcc, identityId, fromEmail, draftId, fromName, htmlBody, attachments, inReplyTo, references, delayedUntil, envelopeMailFrom, options) => {
    set({ isLoading: true, error: null });
    try {
      const result = await client.sendEmail(to, subject, body, cc, bcc, identityId, fromEmail, draftId, fromName, htmlBody, attachments, inReplyTo, references, delayedUntil, envelopeMailFrom, options);
      // Each send leaves a submission record; sweep the ones that can go
      // (throttled per account by the client).
      void client.pruneEmailSubmissions();
      // Refresh handled by UI layer for immediate feedback
      set({
        isLoading: false,
        pendingUndoSend: result.scheduled && result.emailSubmissionId && result.sendAt
          ? {
              submissionId: result.emailSubmissionId,
              emailId: result.emailId,
              identityId,
              sendAt: result.sendAt,
              isSmime: false,
              submissionAccountId: result.submissionAccountId,
              // Cross-account send: undo/send-now must talk to the account that
              // holds the submission, not the active one (#461).
              localAccountId: options?.localAccountId,
            }
          : get().pendingUndoSend,
      });
      return result;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to send email",
        isLoading: false
      });
      throw error;
    }
  },

  sendRawEmail: async (client, rawMimeBlob, identityId, delayedUntil, envelopeRecipients) => {
    set({ isLoading: true, error: null });
    try {
      const mailboxes = await client.getMailboxes();
      const sentMailbox = mailboxes.find(mb => mb.role === 'sent');
      if (!sentMailbox) throw new Error('No sent mailbox found');
      const draftsMailbox = mailboxes.find(mb => mb.role === 'drafts');
      const result = await client.sendRawEmail(rawMimeBlob, identityId, sentMailbox.id, draftsMailbox?.id, delayedUntil, envelopeRecipients);
      void client.pruneEmailSubmissions();
      set({
        isLoading: false,
        pendingUndoSend: result.scheduled && result.emailSubmissionId && result.sendAt
          ? { submissionId: result.emailSubmissionId, emailId: result.emailId, identityId, sendAt: result.sendAt, isSmime: true, submissionAccountId: result.submissionAccountId }
          : get().pendingUndoSend,
      });
      return result;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to send email",
        isLoading: false,
      });
      throw error;
    }
  },

  deleteEmail: async (client, emailId, forceDelete, emailKey): Promise<boolean> => {
    try {
      // Get the email to check if it's unread and which mailboxes it belongs to
      const isTarget = singleEmailMatcher(emailId, emailKey);
      const email = get().emails.find(isTarget);
      if (!email) return false;

      const isUnread = !email.keywords?.$seen;
      // In unified view route to the email's own account (client + that
      // account's mailbox list); otherwise the active/viewing context. (#281)
      const { client: effectiveClient, mailboxes, accountId } = resolveEmailActionContext(email, client);

      // Get delete action preference from settings
      const deleteAction = useSettingsStore.getState().deleteAction;
      const permanentlyDeleteJunk = useSettingsStore.getState().permanentlyDeleteJunk;

      // The email's current mailbox drives the junk auto-permanent-delete rule.
      // In unified view it comes from the email's own folders (matching the
      // unified role), not the active account's selected mailbox.
      const currentMailbox = isAggregateListView()
        ? (mailboxes.find(mb => emailInMailbox(email, mb) && mb.role === get().unifiedRole)
            ?? mailboxes.find(mb => emailInMailbox(email, mb)))
        : mailboxes.find(mb => mb.id === get().selectedMailbox);

      // If in junk folder and setting is enabled, permanently delete
      const isInJunk = currentMailbox?.role === 'junk';
      if (isInJunk && permanentlyDeleteJunk) {
        forceDelete = true;
      }

      const permanent = !((deleteAction === 'trash' || deleteAction === 'trash-and-read') && !forceDelete);
      if (emailHooks.onBeforeEmailDelete.size > 0
        && !(await emailHooks.onBeforeEmailDelete.intercept({ emailIds: [emailId], permanent }))) {
        return false;
      }

      // If deleteAction is 'trash' or 'trash-and-read' and not forced permanent delete, try to move to trash mailbox
      if ((deleteAction === 'trash' || deleteAction === 'trash-and-read') && !forceDelete) {
        const trashMailbox = findTrashMailbox(mailboxes, { accountId });
        const alsoMarkRead = deleteAction === 'trash-and-read' && isUnread;

        if (trashMailbox) {
          // Use originalId for shared mailboxes if available
          const trashId = trashMailbox.originalId || trashMailbox.id;
          await effectiveClient.moveToTrash(emailId, trashId, accountId, alsoMarkRead);

          // After marking read in the same request, the email arrives in trash as read.
          const arrivesUnread = isUnread && !alsoMarkRead;

          // Remove from local state (email moved to trash, not in current view).
          // Counter changes go to the email's own account list (#281). Source and
          // trash live in the same account.
          set((state) => {
            const mailboxPatch = email.mailboxIds
              ? applyMailboxCounterUpdate(state, email, (mailbox) => {
                  if (emailInMailbox(email, mailbox)) {
                    return {
                      ...mailbox,
                      totalEmails: Math.max(0, mailbox.totalEmails - 1),
                      unreadEmails: isUnread ? Math.max(0, mailbox.unreadEmails - 1) : mailbox.unreadEmails,
                      totalThreads: Math.max(0, mailbox.totalThreads - 1),
                      unreadThreads: isUnread ? Math.max(0, mailbox.unreadThreads - 1) : mailbox.unreadThreads,
                    };
                  }
                  if (mailbox.id === trashMailbox.id) {
                    return {
                      ...mailbox,
                      totalEmails: mailbox.totalEmails + 1,
                      unreadEmails: arrivesUnread ? mailbox.unreadEmails + 1 : mailbox.unreadEmails,
                      totalThreads: mailbox.totalThreads + 1,
                      unreadThreads: arrivesUnread ? mailbox.unreadThreads + 1 : mailbox.unreadThreads,
                    };
                  }
                  return mailbox;
                })
              : {};

            return {
              emails: state.emails.filter(e => !isTarget(e)),
              selectedEmail: getNextSelectedEmailAfterRemovingRow(state, isTarget),
              ...mailboxPatch,
            };
          });
          void emailHooks.onAfterEmailDelete.emit({ emailIds: [emailId], permanent: false });
          return true;
        }
        // No trash folder found in this account. Surface the failure rather
        // than silently destroying the email - the user asked to move it to
        // trash, not to permanently delete it.
        throw new Error('Trash mailbox not found - cannot move email to trash');
      }

      // Permanent delete - in the email's own account, like the batch path.
      await effectiveClient.deleteEmail(emailId, accountId);

      // Remove from local state and update mailbox counters (in the email's own
      // account list). Unread emails also decrement the unread counters. (#281)
      set((state) => {
        const mailboxPatch = email.mailboxIds
          ? applyMailboxCounterUpdate(state, email, (mailbox) =>
              emailInMailbox(email, mailbox)
                ? {
                    ...mailbox,
                    totalEmails: Math.max(0, mailbox.totalEmails - 1),
                    unreadEmails: isUnread ? Math.max(0, mailbox.unreadEmails - 1) : mailbox.unreadEmails,
                    totalThreads: Math.max(0, mailbox.totalThreads - 1),
                    unreadThreads: isUnread ? Math.max(0, mailbox.unreadThreads - 1) : mailbox.unreadThreads,
                  }
                : mailbox)
          : {};

        return {
          emails: state.emails.filter(e => !isTarget(e)),
          selectedEmail: getNextSelectedEmailAfterRemovingRow(state, isTarget),
          ...mailboxPatch,
        };
      });
      void emailHooks.onAfterEmailDelete.emit({ emailIds: [emailId], permanent: true });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to delete email"
      });
      throw error;
    }
    return true;
  },

  markAsRead: async (client, emailId, read, emailKey): Promise<boolean> => {
    const isTarget = singleEmailMatcher(emailId, emailKey);
    try {
      // Check if this email is already being processed
      const processingKey = `${emailKey ?? emailId}-${read}`;
      const currentProcessing = get().processingReadStatus;
      if (currentProcessing.has(processingKey)) {
        return true; // Already being processed
      }

      // Get the email to check its current state and mailboxes
      const email = get().emails.find(isTarget);
      if (!email) return false;

      // Check if already in the desired state
      const isCurrentlyRead = email.keywords?.$seen;
      if (isCurrentlyRead === read) {
        return true; // Already in desired state
      }

      // Add to processing set
      set((state) => ({
        processingReadStatus: new Set([...state.processingReadStatus, processingKey])
      }));

      if (emailHooks.onBeforeEmailReadStateChange.size > 0
        && !(await emailHooks.onBeforeEmailReadStateChange.intercept({ emailIds: [emailId], read }))) {
        set((state) => {
          const next = new Set(state.processingReadStatus);
          next.delete(processingKey);
          return { processingReadStatus: next };
        });
        return false;
      }

      // In unified view route to the email's own account client; otherwise use
      // the active/viewing client and the shared-folder accountId. (#281)
      const { client: actionClient, accountId } = resolveEmailActionContext(email, client);

      await actionClient.markAsRead(emailId, read, accountId);

      // Update local state including mailbox counters
      set((state) => {
        // Remove from processing set
        const newProcessingSet = new Set(state.processingReadStatus);
        newProcessingSet.delete(processingKey);

        // Only update counters if the state is actually changing
        const emailInState = state.emails.find(isTarget);
        if (!emailInState) return { processingReadStatus: newProcessingSet };

        const wasRead = emailInState.keywords?.$seen;
        if (wasRead === read) {
          return { processingReadStatus: newProcessingSet }; // State unchanged, skip counter update
        }

        // Adjust the unread counter on the folder(s) holding this email, in the
        // email's *own* account's mailbox list (#281). -1 marking read, +1 unread.
        const delta = read ? -1 : 1;
        const mailboxPatch = applyMailboxCounterUpdate(state, emailInState, (mailbox) =>
          emailInMailbox(emailInState, mailbox)
            ? {
                ...mailbox,
                unreadEmails: Math.max(0, mailbox.unreadEmails + delta),
                unreadThreads: Math.max(0, mailbox.unreadThreads + delta),
              }
            : mailbox,
        );

        // In the unread cross view, a mail just marked read no longer matches the
        // filter. Retain it so the row stays put (status + counter update only)
        // rather than vanishing on the next push refresh; marking it unread again
        // makes it match, so drop the retention.
        const retainedInViewIds = updateRetainedForView(
          state.retainedInViewIds,
          retainingCrossView(state) === 'unread' ? (read ? 'add' : 'remove') : 'none',
          emailId,
        );

        return {
          emails: state.emails.map(e =>
            isTarget(e) ? { ...e, keywords: { ...e.keywords, $seen: read } } : e
          ),
          selectedEmail: (!!state.selectedEmail && isTarget(state.selectedEmail))
            ? { ...state.selectedEmail, keywords: { ...state.selectedEmail.keywords, $seen: read } }
            : state.selectedEmail,
          retainedInViewIds,
          ...mailboxPatch,
          // Same delta, applied to every tag this email carries, so the sidebar
          // tag badges track the folder counters instead of going stale.
          tagCounts: applyTagCountReadDelta(state.tagCounts, [
            { keywords: emailInState.keywords, delta },
          ]),
          processingReadStatus: newProcessingSet,
          // Also update threadEmailsCache so expanded dropdowns reflect the change
          threadEmailsCache: (() => {
            let updated = false;
            const newCache = new Map(state.threadEmailsCache);
            for (const [tid, cachedEmails] of newCache) {
              const idx = cachedEmails.findIndex(isTarget);
              if (idx !== -1) {
                newCache.set(tid, cachedEmails.map((e, i) =>
                  i === idx ? { ...e, keywords: { ...e.keywords, $seen: read } } : e
                ));
                updated = true;
                break;
              }
            }
            return updated ? newCache : state.threadEmailsCache;
          })(),
        };
      });
      void emailHooks.onEmailReadStateChange.emit({ emailIds: [emailId], read });
      refillAfterKeywordChange(get, client, ['$seen']);
    } catch (error) {
      // Remove from processing set on error
      set((state) => {
        const newProcessingSet = new Set(state.processingReadStatus);
        newProcessingSet.delete(`${emailId}-${read}`);
        return {
          processingReadStatus: newProcessingSet,
          error: error instanceof Error ? error.message : "Failed to update email"
        };
      });
      throw error;
    }
    return true;
  },

  moveToMailboxCrossAware: async (client, emailId, destinationMailboxId, emailKey): Promise<boolean> => {
    const isTarget = singleEmailMatcher(emailId, emailKey);
    const state = get();
    const email = state.emails.find(isTarget);
    if (!email) return false;

    // A list that mixes accounts offers the viewed account's folders, and
    // the message may be in any account (moveSourceBatches). Its own folder
    // list would take the id for one of that account's folders.
    if (isAggregateListView() && email.sourceAccountId) {
      const hookMailboxes = resolveActionMailboxes();
      const move = { emailIds: [email.id], fromMailboxId: moveSourceMailboxId([email], hookMailboxes), toMailboxId: destinationMailboxId };
      if (!(await allowEmailMove(move, hookMailboxes))) return false;
      const failures = await moveRowsToMailbox([email], resolveMoveDestination(client, destinationMailboxId), client);
      if (failures.length > 0) throw failures[0].error;
      emitEmailMove(move, hookMailboxes);
      return true;
    }

    const { mailboxes } = resolveEmailActionContext(email, client);
    const find = (id: string) =>
      mailboxes.find((mb) => mb.id === id) ?? state.mailboxes.find((mb) => mb.id === id);
    const destMailbox = find(destinationMailboxId);
    // A context-menu move acts on the visible list, so the source folder is the
    // one currently open.
    const sourceMailbox = find(state.selectedMailbox ?? '');

    // Cross-account when the two folders live in different JMAP accounts (both
    // own and shared mailboxes carry accountId, so this catches own↔shared too).
    const isCrossAccount =
      !!destMailbox &&
      !!sourceMailbox?.accountId &&
      !!destMailbox.accountId &&
      sourceMailbox.accountId !== destMailbox.accountId;

    if (!isCrossAccount) {
      return await get().moveToMailbox(client, emailId, destinationMailboxId, emailKey);
    }

    const destAccountId = resolveDestLocalAccountId(destMailbox!);
    const sourceAccountId =
      email.accountId ?? state.viewingAccountId ?? useAuthStore.getState().activeAccountId;
    if (!destAccountId || !sourceAccountId) {
      // Can't resolve the local endpoints — fall back rather than drop the mail.
      return await get().moveToMailbox(client, emailId, destinationMailboxId, emailKey);
    }

    // JMAP has no cross-account move: copy the raw message into the destination
    // account's mailbox, then delete the original (crossAccountMoveEmails). The
    // *Jmap* overrides target the owner account when a shared folder is reached
    // through another user's client.
    return await get().crossAccountMoveEmails(
      new Map([[sourceAccountId, [emailId]]]),
      destAccountId,
      destMailbox!.originalId ?? destMailbox!.id,
      destMailbox!.isShared ? destMailbox!.accountId : undefined,
      sourceMailbox?.isShared ? sourceMailbox.accountId : undefined,
    );
  },

  moveToMailbox: async (client, emailId, destinationMailboxId, emailKey): Promise<boolean> => {
    try {
      const isTarget = singleEmailMatcher(emailId, emailKey);
      const email = get().emails.find(isTarget);
      if (!email) return false;

      const isUnread = !email.keywords?.$seen;

      // In unified view route to the email's own account (client + that
      // account's mailbox list, where the destination id lives); otherwise the
      // active/viewing context. (#281)
      const { client: actionClient, mailboxes, accountId } = resolveEmailActionContext(email, client);

      const destMailbox = mailboxes.find(mb => mb.id === destinationMailboxId);
      const jmapDestId = destMailbox?.originalId || destinationMailboxId;

      const move = { emailIds: [emailId], fromMailboxId: moveSourceMailboxId([email], mailboxes), toMailboxId: destinationMailboxId };
      if (!(await allowEmailMove(move, mailboxes))) return false;

      await actionClient.moveEmail(emailId, jmapDestId, accountId);

      set((state) => {
        // Counter changes go to the email's own account list; source and
        // destination live in the same account. (#281)
        const mailboxPatch = applyMailboxCounterUpdate(state, email, (mailbox) => {
          if (emailInMailbox(email, mailbox)) {
            return {
              ...mailbox,
              totalEmails: Math.max(0, mailbox.totalEmails - 1),
              unreadEmails: isUnread ? Math.max(0, mailbox.unreadEmails - 1) : mailbox.unreadEmails,
              totalThreads: Math.max(0, mailbox.totalThreads - 1),
              unreadThreads: isUnread ? Math.max(0, mailbox.unreadThreads - 1) : mailbox.unreadThreads,
            };
          }
          if (mailbox.id === destinationMailboxId) {
            return {
              ...mailbox,
              totalEmails: mailbox.totalEmails + 1,
              unreadEmails: isUnread ? mailbox.unreadEmails + 1 : mailbox.unreadEmails,
              totalThreads: mailbox.totalThreads + 1,
              unreadThreads: isUnread ? mailbox.unreadThreads + 1 : mailbox.unreadThreads,
            };
          }
          return mailbox;
        });

        return {
          emails: state.emails.filter(e => !isTarget(e)),
          selectedEmail: getNextSelectedEmailAfterRemovingRow(state, isTarget),
          ...mailboxPatch,
        };
      });
      emitEmailMove(move, mailboxes);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to move email"
      });
      throw error;
    }
    return true;
  },

  moveEmailsToMailbox: async (client, emailIds, destinationMailboxId, destLocalAccountId, rows): Promise<boolean> => {
    if (emailIds.length === 0) return true;
    const idSet = new Set(emailIds);

    if (isAggregateListView()) {
      // Emails may span logins and accounts: each group changes folders in
      // place only in the folder's own account (moveSourceBatches). Rows
      // that could not be moved stay. The rows a drag names, not every listed
      // row with one of their ids: another account's message can share it.
      const moving = rows?.length ? rows.filter(e => idSet.has(e.id)) : get().emails.filter(e => idSet.has(e.id));
      const hookMailboxes = resolveActionMailboxes();
      const move = { emailIds: [...idSet], fromMailboxId: moveSourceMailboxId(moving, hookMailboxes), toMailboxId: destinationMailboxId };
      if (!(await allowEmailMove(move, hookMailboxes))) return false;
      const failures = await moveRowsToMailbox(
        moving,
        resolveMoveDestination(client, destinationMailboxId, destLocalAccountId),
        client,
      );
      const failed = new Set(failures.flatMap(f => f.ids));
      const movedIds = move.emailIds.filter(id => !failed.has(id));
      if (movedIds.length > 0) emitEmailMove({ ...move, emailIds: movedIds }, hookMailboxes);
      if (failures.length > 0) {
        const error = new Error(batchFailureMessage(failures, 'move'));
        set({ error: error.message });
        throw error;
      }
      return true;
    }
    // moveToMailbox acts on a listed row only; an id from elsewhere (a
    // plugin moving new mail) takes the batch path, or it was dropped.
    if (emailIds.length === 1 && get().emails.some(e => e.id === emailIds[0])) {
      return await get().moveToMailbox(client, emailIds[0], destinationMailboxId);
    }

    try {
      const { emails, selectedMailbox } = get();
      const mailboxes = resolveActionMailboxes();
      const destMailbox = mailboxes.find(mb => mb.id === destinationMailboxId);
      const jmapDestId = destMailbox?.originalId || destinationMailboxId;
      const affected = emails.filter(e => idSet.has(e.id));
      const move = { emailIds: [...idSet], fromMailboxId: moveSourceMailboxId(affected, mailboxes), toMailboxId: destinationMailboxId };
      if (!(await allowEmailMove(move, mailboxes))) return false;

      const currentMailbox = mailboxes.find(mb => mb.id === selectedMailbox);
      const accountId = currentMailbox?.isShared ? currentMailbox.accountId : undefined;
      await resolveActionClient(client).batchMoveEmails(emailIds, jmapDestId, accountId);

      // Adjust counters and drop moved emails from the current view.
      let unreadDelta = 0;
      for (const e of affected) {
        if (!e.keywords?.$seen) unreadDelta += 1;
      }
      const movedCount = affected.length;

      set((state) => {
        // Decrement source folders per the email's own account list (#281).
        const patch = applyBatchMailboxCounterUpdate(state, affected, applyMoveOutCounters);
        // The destination folder (picked from the active/viewing list) gains them.
        patch.mailboxes = patch.mailboxes.map(mb => mb.id === destinationMailboxId
          ? { ...mb, totalEmails: mb.totalEmails + movedCount, unreadEmails: mb.unreadEmails + unreadDelta }
          : mb);
        return {
          emails: state.emails.filter(e => !idSet.has(e.id)),
          selectedEmail: state.selectedEmail && idSet.has(state.selectedEmail.id) ? null : state.selectedEmail,
          selectedEmailKeys: (() => {
            const next = new Set(state.selectedEmailKeys);
            // Keys, not ids: drop exactly the emails leaving the list.
            for (const e of state.emails) if (idSet.has(e.id)) next.delete(emailKeyFor(e));
            return next;
          })(),
          ...patch,
        };
      });
      emitEmailMove(move, mailboxes);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to move emails' });
      throw error;
    }
    return true;
  },

  removeFromMailbox: async (client, targets): Promise<boolean> => {
    const folder = removalFolder(get());
    if (!folder) return false;
    // Rows are matched by key, not id: ids of different accounts can collide.
    const removable = new Map<string, Email>();
    for (const email of targets) {
      if (canRemoveFromFolder(email, folder)) removable.set(emailKeyFor(email), email);
    }
    if (removable.size === 0) return false;

    const mailboxes = resolveActionMailboxes();
    const leaving = [...removable.values()];
    // Plugins see it as a move out of the folder that lands nowhere new.
    const move = { emailIds: [...new Set(leaving.map(e => e.id))], fromMailboxId: folder.id, toMailboxId: null };
    if (!(await allowEmailMove(move, mailboxes))) return false;

    try {
      await resolveActionClient(client).removeEmailsFromMailbox(
        move.emailIds,
        folder.originalId || folder.id,
        folder.isShared ? folder.accountId : undefined,
      );
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to remove from folder' });
      throw error;
    }

    const isLeaving = (e: Email) => removable.has(emailKeyFor(e));
    const unread = leaving.filter(e => !e.keywords?.$seen).length;
    const withoutFolder = (e: Email): Email => {
      const mailboxIds = { ...e.mailboxIds };
      delete mailboxIds[folder.id];
      if (folder.originalId) delete mailboxIds[folder.originalId];
      return { ...e, mailboxIds };
    };

    set((state) => {
      // Only the open folder loses them; their other folders keep them.
      const adjust = (mb: Mailbox): Mailbox => mb.id !== folder.id ? mb : {
        ...mb,
        totalEmails: Math.max(0, mb.totalEmails - leaving.length),
        unreadEmails: Math.max(0, mb.unreadEmails - unread),
      };
      const inViewingList = !!state.viewingAccountId && !!state.accountMailboxes[state.viewingAccountId];
      const counters = inViewingList
        ? { accountMailboxes: { ...state.accountMailboxes, [state.viewingAccountId!]: state.accountMailboxes[state.viewingAccountId!].map(adjust) } }
        : { mailboxes: state.mailboxes.map(adjust) };

      // The open message moves on to its neighbour, as after a move.
      let selectedEmail = state.selectedEmail;
      if (selectedEmail && isLeaving(selectedEmail)) {
        const index = state.emails.findIndex(e => emailKeyFor(e) === emailKeyFor(selectedEmail!));
        const after = state.emails.slice(index + 1).find(e => !isLeaving(e));
        const before = state.emails.slice(0, Math.max(0, index)).reverse().find(e => !isLeaving(e));
        selectedEmail = index === -1 ? null : (removable.size === 1 ? after ?? before ?? null : null);
      }

      // Loaded thread members keep their other folders.
      let threadEmailsCache = state.threadEmailsCache;
      for (const [key, members] of state.threadEmailsCache) {
        if (!members.some(isLeaving)) continue;
        if (threadEmailsCache === state.threadEmailsCache) threadEmailsCache = new Map(state.threadEmailsCache);
        threadEmailsCache.set(key, members.map(e => (isLeaving(e) ? withoutFolder(e) : e)));
      }

      return {
        emails: state.emails.filter(e => !isLeaving(e)),
        selectedEmail,
        selectedEmailKeys: dropFromSelection(state, isLeaving),
        threadEmailsCache,
        ...counters,
      };
    });
    emitEmailMove(move, mailboxes);
    return true;
  },

  crossAccountMoveEmails: async (emailIdsBySource, destAccountId, destMailboxId, destJmapAccountId, sourceJmapAccountId, options): Promise<boolean> => {
    if (emailIdsBySource.size === 0) return true;
    const keepOriginal = options?.keepOriginal === true;
    // A copy leaves the messages where they are, so only a move asks plugins.
    const hookMailboxes = [...resolveActionMailboxes(), ...(get().accountMailboxes[destAccountId] ?? [])];
    const requestedIds = [...new Set([...emailIdsBySource.values()].flat())];
    const move = keepOriginal ? null : {
      emailIds: requestedIds,
      fromMailboxId: moveSourceMailboxId(get().emails.filter(e => requestedIds.includes(e.id)), hookMailboxes),
      toMailboxId: destMailboxId,
    };
    if (move && !(await allowEmailMove(move, hookMailboxes))) return false;
    set({ isLoading: true, error: null });
    try {
      const destClient = useAuthStore.getState().getClientForAccount(destAccountId);
      if (!destClient) {
        throw new Error('Destination account is not connected');
      }

      const movedIds: string[] = [];
      const failures: Array<{ emailId: string; error: string }> = [];

      for (const [sourceAccountId, emailIds] of emailIdsBySource.entries()) {
        const sourceClient = useAuthStore.getState().getClientForAccount(sourceAccountId);
        if (!sourceClient) {
          for (const emailId of emailIds) {
            failures.push({ emailId, error: 'Source account not connected' });
          }
          continue;
        }

        // Fan the per-email copy/import/delete pipeline out in parallel.
        // JMAP has no atomic cross-account move, so we accept that a crash
        // mid-flight could leave a duplicate; the delete on success keeps
        // the source clean in the happy path.
        const results = await Promise.allSettled(
          emailIds.map(async (emailId) => {
            // Delegated/shared folders: one client reaches both accounts, so a
            // server-side Email/copy moves the message. A client can't stage a
            // blob in a *delegated* account (blobNotFound), so the blob
            // copy+import path below is only valid across separate login
            // clients/servers.
            if (sourceClient === destClient) {
              await sourceClient.copyEmailAcrossAccounts(
                emailId,
                sourceJmapAccountId ?? sourceClient.getAccountId(),
                destJmapAccountId ?? destClient.getAccountId(),
                destMailboxId,
                keepOriginal ? { keepOriginal } : undefined,
              );
              return emailId;
            }
            // Separate clients (cross-server multi-account): the email, its
            // blob, and the destroy all live in the owner's JMAP account, not
            // the source client's primary one.
            const full = await sourceClient.getEmail(emailId, sourceJmapAccountId);
            if (!full?.blobId) {
              throw new Error('Source email has no raw blob to copy');
            }
            const blob = await sourceClient.fetchBlob(full.blobId, undefined, undefined, sourceJmapAccountId);
            // Every keyword, the server's attachment ones included (see
            // lib/jmap/server-keywords.ts).
            const keywords: Record<string, boolean> = { ...(full.keywords ?? {}) };
            // The original date, or the copy sorts as today's mail.
            await destClient.importRawEmail(blob, { [destMailboxId]: true }, keywords, destJmapAccountId, full.receivedAt);
            if (!keepOriginal) await sourceClient.deleteEmail(emailId, sourceJmapAccountId);
            return emailId;
          }),
        );

        results.forEach((outcome, i) => {
          const emailId = emailIds[i];
          if (outcome.status === 'fulfilled') {
            movedIds.push(emailId);
          } else {
            const err = outcome.reason;
            failures.push({
              emailId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
      }

      // Drop the moved emails from the current view and clear stale selection
      // entries. Counter accuracy comes from the mailbox refresh below. A copy
      // leaves the view and the selection as they are.
      const movedSet = new Set(movedIds);
      if (keepOriginal) set({ isLoading: false });
      else set((state) => ({
        emails: state.emails.filter((e) => !movedSet.has(e.id)),
        selectedEmail:
          state.selectedEmail && movedSet.has(state.selectedEmail.id)
            ? null
            : state.selectedEmail,
        selectedEmailKeys: (() => {
          const next = new Set(state.selectedEmailKeys);
          for (const e of state.emails) if (movedSet.has(e.id)) next.delete(emailKeyFor(e));
          return next;
        })(),
        isLoading: false,
      }));

      // Refresh mailbox folder lists/counters for every account we touched.
      // Background-only so the move feels instant - counters will catch up.
      const activeAccountId = useAuthStore.getState().activeAccountId;
      const touched = new Set<string>(keepOriginal ? [destAccountId] : [destAccountId, ...emailIdsBySource.keys()]);
      for (const acctId of touched) {
        const c = useAuthStore.getState().getClientForAccount(acctId);
        if (!c) continue;
        if (acctId === activeAccountId) {
          void get().fetchMailboxes(c);
        } else {
          void get().fetchAccountMailboxes(c, acctId);
        }
      }

      if (move && movedIds.length > 0) emitEmailMove({ ...move, emailIds: movedIds }, hookMailboxes);

      if (failures.length > 0) {
        const first = failures[0];
        const verb = keepOriginal ? 'copy' : 'move';
        throw new Error(
          failures.length === 1
            ? `Failed to ${verb} email: ${first.error}`
            : `Failed to ${verb} ${failures.length} email(s); first error: ${first.error}`,
        );
      }
    } catch (error) {
      set({
        isLoading: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to move emails between accounts',
      });
      throw error;
    }
    return true;
  },

  copyEmailsToAccount: async (emailIds, destAccountId, destMailboxId) => {
    const state = get();
    const auth = useAuthStore.getState();
    const viewLogin = state.viewingAccountId ?? auth.activeAccountId;
    const currentMailbox = resolveActionMailboxes().find((mb) => mb.id === state.selectedMailbox);
    // One group per (login, JMAP account): crossAccountMoveEmails takes a
    // single source JMAP account per call.
    const groups = new Map<string, { login: string; jmapAccountId?: string; ids: string[] }>();
    for (const entry of emailIds) {
      const id = typeof entry === 'string' ? entry : entry.id;
      const email = typeof entry !== 'string' ? entry : state.emails.find((e) => e.id === id)
        ?? (state.selectedEmail?.id === id ? state.selectedEmail : undefined);
      // Aggregate views stamp each email with the login that reaches it and
      // its owning JMAP account; otherwise it lives in the open folder.
      const stamped = !!(email?.sourceClientAccountId && email.sourceAccountId);
      const login = stamped ? email!.sourceClientAccountId! : viewLogin;
      const jmapAccountId = stamped
        ? email!.sourceAccountId
        : (currentMailbox?.isShared ? currentMailbox.accountId : undefined);
      if (!login) continue;
      const key = `${login}|${jmapAccountId ?? ''}`;
      if (!groups.has(key)) groups.set(key, { login, jmapAccountId, ids: [] });
      groups.get(key)!.ids.push(id);
    }

    // Copying a message into its own account is not a cross-account copy.
    const destPrimary = auth.getClientForAccount(destAccountId)?.getAccountId();
    for (const { login, jmapAccountId } of groups.values()) {
      if (login === destAccountId && (!jmapAccountId || jmapAccountId === destPrimary)) {
        const error = new Error('The messages are already in that account');
        set({ error: error.message });
        throw error;
      }
    }

    for (const { login, jmapAccountId, ids } of groups.values()) {
      await get().crossAccountMoveEmails(
        new Map([[login, ids]]),
        destAccountId,
        destMailboxId,
        undefined,
        jmapAccountId,
        { keepOriginal: true },
      );
    }
  },

  moveThreadToMailbox: async (client, emailId, destinationMailboxId, emailKey): Promise<boolean> => {
    const isTarget = singleEmailMatcher(emailId, emailKey);
    try {
      const state = get();
      const email = state.emails.find(isTarget)
        ?? ((!!state.selectedEmail && isTarget(state.selectedEmail)) ? state.selectedEmail : null);

      if (!email?.threadId) {
        return await get().moveToMailbox(client, emailId, destinationMailboxId, emailKey);
      }

      // In unified view route to the email's own account (client + that
      // account's mailbox list); otherwise the active/viewing context. (#281)
      const { client: effectiveClient, mailboxes, accountId } = resolveEmailActionContext(email, client);
      const destMailbox = mailboxes.find(mb => mb.id === destinationMailboxId);
      const jmapDestId = destMailbox?.originalId || destinationMailboxId;

      const thread = await effectiveClient.getThread(email.threadId, accountId);
      const threadEmailIds = thread?.emailIds?.length ? thread.emailIds : [emailId];

      if (threadEmailIds.length <= 1) {
        return await get().moveToMailbox(client, emailId, destinationMailboxId, emailKey);
      }

      const move = { emailIds: threadEmailIds, fromMailboxId: moveSourceMailboxId([email], mailboxes), toMailboxId: destinationMailboxId };
      if (!(await allowEmailMove(move, mailboxes))) return false;

      await effectiveClient.batchMoveEmails(threadEmailIds, jmapDestId, accountId);

      const removedEmailIds = new Set(threadEmailIds);
      set((currentState) => {
        const nextSelectedEmail = getNextSelectedEmailAfterRemoval(currentState, removedEmailIds);
        const removedKeys = new Set(
          currentState.emails.filter(e => removedEmailIds.has(e.id)).map(emailKeyFor)
        );
        const nextSelectedEmailIds = new Set(
          Array.from(currentState.selectedEmailKeys).filter(key => !removedKeys.has(key))
        );
        const nextExpandedThreadIds = new Set(currentState.expandedThreadIds);
        nextExpandedThreadIds.delete(threadKeyFor(email));
        const nextThreadEmailsCache = new Map(currentState.threadEmailsCache);
        nextThreadEmailsCache.delete(threadKeyFor(email));

        return {
          emails: currentState.emails.filter(currentEmail => !removedEmailIds.has(currentEmail.id)),
          selectedEmail: nextSelectedEmail,
          selectedEmailKeys: nextSelectedEmailIds,
          expandedThreadIds: nextExpandedThreadIds,
          threadEmailsCache: nextThreadEmailsCache,
        };
      });
      emitEmailMove(move, mailboxes);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to move email thread"
      });
      throw error;
    }
    return true;
  },

  searchEmails: async (client, typedQuery) => {
    const { searchAbortController } = get();

    if (searchAbortController) {
      searchAbortController.abort();
    }

    const controller = new AbortController();
    // The rows on screen stay, dimmed, until the results land, as on a folder
    // switch, instead of being torn down for a skeleton and rebuilt a round
    // trip later. What the mail view renders from is written only once the
    // request is on its way (see afterRequestDispatch); the controller is
    // recorded at once so a superseding search can still cancel this one.
    set({ searchAbortController: controller });
    afterRequestDispatch(() => {
      if (get().searchAbortController === controller) set({ isLoading: true, error: null, searchQuery: typedQuery });
    });
    try {
      // The store keeps what the user typed; plugins' changes apply to this run.
      // Without listeners the request goes out in this same tick, as before.
      const search = emailHooks.onSearch.size > 0
        ? await transformSearch(typedQuery, get().searchFilters)
        : { query: typedQuery, filters: get().searchFilters };
      if (controller.signal.aborted) return;
      if (!isFilterEmpty(search.filters)) {
        // A plugin added filters: only the advanced search applies them.
        await get().advancedSearch(client, search);
        return;
      }
      const query = search.query;
      const { isUnifiedView, unifiedRole, crossView, searchMailboxId, searchFilters, selectedKeyword } = get();
      startProvidedSearchResults(query, searchFilters, { get, set });
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;

      let result;
      let accountId;
      let unifiedErrors;

      if (isUnifiedView && crossView) {
        const includeGroup = useSettingsStore.getState().includeGroupInUnified;
        const built = await buildUnifiedAccountClients({ includeGroup });
        result = await searchCrossViewEmails(built, crossView, query, emailsPerPage, 0);
        unifiedErrors = result.errors;
        
      } else if (isUnifiedView && unifiedRole) {
        const includeGroup = useSettingsStore.getState().includeGroupInUnified;
        const built = await buildUnifiedAccountClients({ includeGroup });
        result = await searchUnifiedEmails(built, unifiedRole, query, emailsPerPage, 0);
        unifiedErrors = result.errors;

      } else if (selectedKeyword) {
        // A tag view takes precedence over the folder, as it does in
        // fetchEmails and refreshCurrentMailbox — so searching inside one
        // NARROWS the tag rather than silently replacing the list with an
        // unrelated all-folders result that the next push refresh would throw
        // away again.
        const built = buildTagViewAccountClients(client);
        result = await fetchTagEmails(
          built, `$label:${selectedKeyword}`, emailsPerPage, 0, getMessageListOrderFor(null),
          textFilter(query),
        );
        unifiedErrors = result.errors;

      } else if (isAllFoldersSearchScope(searchMailboxId)) {
        // Folder-less scope: the folders of the own account AND of every
        // group/shared account this login reaches - the same fan-out the tag
        // views use (#1038). A single own-account query silently skipped the
        // shared accounts' mail (#1082). The default scope leaves every
        // account's Trash and Junk out; "All folders" searches them too.
        const built = buildTagViewAccountClients(client);
        result = await searchAcrossAccounts(built, query, emailsPerPage, 0, { ...acrossAccountsSearchOptions(searchMailboxId), deferSnippets: true });
        unifiedErrors = result.errors;

      } else {
        // Scope the search to the folder picked in the search panel.
        const mailboxes = resolveActionMailboxes();
        const mailbox = mailboxes.find(mb => mb.id === searchMailboxId);
        // Use originalId for shared mailboxes
        const jmapMailboxId = mailbox?.originalId || searchMailboxId;
        // Only pass accountId for shared mailboxes, not for primary account
        accountId = mailbox?.isShared ? mailbox.accountId : undefined;

        result = withSnippetBatches(await resolveActionClient(client).searchEmails(query, jmapMailboxId, accountId, emailsPerPage, 0, { deferSnippets: true }));
      }

      // Plugins may add messages to the results by id; the messages are
      // fetched from the server, so a plugin can't put made-up rows in the list.
      const extraIds = await pluginSearchResultIds(query, searchFilters, result.emails);
      if (extraIds.length > 0) {
        const newEmails = await resolveActionClient(client).getSomeEmails(extraIds, accountId);
        result.emails.push(...newEmails);
        result.total += newEmails.length;
      }

      if (controller.signal.aborted) return;
      result.emails = await emailHooks.onEmailsFetched.transform(result.emails);
      set({
        emails: annotateScheduledEmails(result.emails, get().scheduledSubmissionByEmailId),
        hasMoreEmails: result.hasMore,
        totalEmails: result.total,
        // Also here: a fast answer can land before the deferred loading write.
        searchQuery: typedQuery,
        isLoading: false,
        searchAbortController: null,
        ...(unifiedErrors ? { unifiedErrors } : {})
      });
      highlightWhenSnippetsArrive('snippets' in result ? result.snippets : undefined);
    } catch (error) {
      if (controller.signal.aborted) return;
      set({
        error: error instanceof Error ? error.message : "Failed to search emails",
        searchQuery: typedQuery,
        isLoading: false,
        emails: [],
        externalSearchResults: [],
        hasMoreEmails: false,
        totalEmails: 0,
        searchAbortController: null,
      });
    }
  },

  advancedSearch: async (client, transformed) => {
    const { searchQuery: typedQuery, searchFilters: typedFilters, searchMailboxId, searchAbortController, isUnifiedView, unifiedRole, crossView, selectedKeyword } = get();
    const mailboxes = resolveActionMailboxes();

    if (searchAbortController) {
      searchAbortController.abort();
    }

    const controller = new AbortController();
    // See searchEmails: the rows stay, the loading state follows the request.
    set({ searchAbortController: controller });
    afterRequestDispatch(() => {
      if (get().searchAbortController === controller) set({ isLoading: true, error: null });
    });

    try {
      const { query: searchQuery, filters: searchFilters } = transformed
        ?? (emailHooks.onSearch.size > 0 ? await transformSearch(typedQuery, typedFilters) : { query: typedQuery, filters: typedFilters });
      if (controller.signal.aborted) return;
      startProvidedSearchResults(searchQuery, searchFilters, { get, set });
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;
      let result;
      let accountId;
      let unifiedErrors;

      if (isUnifiedView && crossView) {
        const includeGroup = useSettingsStore.getState().includeGroupInUnified;
        const built = await buildUnifiedAccountClients({ includeGroup });
        // Cross views apply the advanced filter (text + fields) on top of the
        // view membership; an empty filter degrades to a plain membership query.
        result = await advancedSearchCrossViewEmails(
          built, crossView, buildJMAPFilter(searchQuery, searchFilters, undefined), emailsPerPage, 0,
        );
        unifiedErrors = result.errors;

      } else if (isUnifiedView && unifiedRole) {
        const includeGroup = useSettingsStore.getState().includeGroupInUnified;
        const built = await buildUnifiedAccountClients({ includeGroup });
        result = await advancedSearchUnifiedEmails(
          built,
          unifiedRole,
          (mailboxId) => buildJMAPFilter(searchQuery, searchFilters, mailboxId),
          emailsPerPage,
          0,
        );
        unifiedErrors = result.errors;

      } else if (selectedKeyword) {
        // Narrow the tag rather than replace it — see searchEmails.
        const built = buildTagViewAccountClients(client);
        result = await fetchTagEmails(
          built, `$label:${selectedKeyword}`, emailsPerPage, 0, getMessageListOrderFor(null),
          buildJMAPFilter(searchQuery, searchFilters, undefined),
        );
        unifiedErrors = result.errors;

      } else if (isAllFoldersSearchScope(searchMailboxId)) {
        // Folder-less scope: fan out over the own + group/shared accounts with
        // a filter that carries no inMailbox clause (#1082).
        const built = buildTagViewAccountClients(client);
        result = await advancedSearchAcrossAccounts(
          built, buildJMAPFilter(searchQuery, searchFilters, undefined), emailsPerPage, 0,
          { ...acrossAccountsSearchOptions(searchMailboxId), deferSnippets: true },
        );
        unifiedErrors = result.errors;

      } else {
        const mailbox = mailboxes.find(mb => mb.id === searchMailboxId);
        const jmapMailboxId = mailbox?.originalId || searchMailboxId;
        accountId = mailbox?.isShared ? mailbox.accountId : undefined;

        const filter = buildJMAPFilter(searchQuery, searchFilters, jmapMailboxId);
        result = withSnippetBatches(await resolveActionClient(client).advancedSearchEmails(filter, accountId, emailsPerPage, 0, { deferSnippets: true }));
      }

      if (controller.signal.aborted) return;

      // Plugins may add messages to the results by id; the messages are
      // fetched from the server, so a plugin can't put made-up rows in the list.
      const extraIds = await pluginSearchResultIds(searchQuery, searchFilters, result.emails);
      if (extraIds.length > 0) {
        const newEmails = await resolveActionClient(client).getSomeEmails(extraIds, accountId);
        result.emails.push(...newEmails);
        result.total += newEmails.length;
      }

      if (controller.signal.aborted) return;
      result.emails = await emailHooks.onEmailsFetched.transform(result.emails);
      set({
        emails: annotateScheduledEmails(result.emails, get().scheduledSubmissionByEmailId),
        hasMoreEmails: result.hasMore,
        totalEmails: result.total,
        isLoading: false,
        searchAbortController: null,
        ...(unifiedErrors ? { unifiedErrors } : {})
      });
      highlightWhenSnippetsArrive('snippets' in result ? result.snippets : undefined);
    } catch (error) {
      if (controller.signal.aborted) return;
      set({
        error: error instanceof Error ? error.message : "Failed to search emails",
        isLoading: false,
        emails: [],
        externalSearchResults: [],
        hasMoreEmails: false,
        totalEmails: 0,
        searchAbortController: null,
      });
    }
  },

  setSearchFilters: (filters) => {
    set((state) => ({
      searchFilters: { ...state.searchFilters, ...filters },
    }));
  },

  setSearchMailboxId: (mailboxId) => {
    set({ searchMailboxId: mailboxId, searchScopeFollowsFolder: false });
  },

  // The unread badge filters its own folder. The default scope searches
  // every folder of every account (#788, #1082), so it has to name the
  // folder, and keep naming whichever folder is open.
  scopeSearchToOpenFolder: () => {
    set((state) => ({ searchMailboxId: state.selectedMailbox, searchScopeFollowsFolder: true }));
  },

  clearSearchFilters: () => {
    set((state) => ({
      searchFilters: { ...DEFAULT_SEARCH_FILTERS },
      searchMailboxId: defaultSearchScopeFor(mailboxesInView(state), state.selectedMailbox),
      searchScopeFollowsFolder: false,
    }));
  },

  toggleAdvancedSearch: () => {
    set((state) => ({ isAdvancedSearchOpen: !state.isAdvancedSearchOpen }));
  },

  toggleStar: async (client, emailId, emailKey): Promise<boolean> => {
    const isTarget = singleEmailMatcher(emailId, emailKey);
    try {
      const email = get().emails.find(isTarget);
      if (!email) return false;

      const isFlagged = email.keywords.$flagged || false;
      if (emailHooks.onBeforeEmailStarToggle.size > 0
        && !(await emailHooks.onBeforeEmailStarToggle.intercept({ emailIds: [emailId], starred: !isFlagged }))) {
        return false;
      }
      // In unified view route to the email's own account client + owner accountId
      // (the reaching client's primary is not the owner for shared sources). (#281)
      const { client: actionClient, accountId } = resolveEmailActionContext(email, client);
      await actionClient.toggleStar(emailId, !isFlagged, accountId);

      // Update local state
      set((state) => ({
        emails: state.emails.map(e =>
          isTarget(e) ? { ...e, keywords: { ...e.keywords, $flagged: !isFlagged } } : e
        ),
        selectedEmail: (!!state.selectedEmail && isTarget(state.selectedEmail))
          ? { ...state.selectedEmail, keywords: { ...state.selectedEmail.keywords, $flagged: !isFlagged } }
          : state.selectedEmail,
        // In the starred cross view, un-starring drops the mail out of the
        // hasKeyword:$flagged filter. Retain the row so it stays visible until the
        // view is re-opened; re-starring makes it match again, so drop retention.
        retainedInViewIds: updateRetainedForView(
          state.retainedInViewIds,
          retainingCrossView(state) === 'starred' ? (isFlagged ? 'add' : 'remove') : 'none',
          emailId,
        ),
      }));
      void emailHooks.onEmailStarToggle.emit({ emailIds: [emailId], starred: !isFlagged });
      refillAfterKeywordChange(get, client, ['$flagged']);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to update star"
      });
      throw error;
    }
    return true;
  },

  markEmailKeyword: async (client, emailId, keyword, source) => {
    // Single-flag counterpart of setEmailKeywords ($answered / $forwarded /
    // $mdnsent). Same routing, same reason: an unrouted write against the
    // reaching client's primary account is a silent no-op on a shared/group
    // message. Best-effort by contract - callers treat a failure as non-fatal.
    if (emailHooks.onBeforeEmailKeywordChange.size > 0
      && !(await emailHooks.onBeforeEmailKeywordChange.intercept({ emailIds: [emailId], added: [keyword], removed: [] }))) {
      return;
    }
    const { client: actionClient, accountId } = source?.clientAccountId
      ? { client: stampedClient(source.clientAccountId), accountId: source.accountId }
      : resolveKeywordActionContext(emailId, client);
    await actionClient.setKeyword(emailId, keyword, accountId);
    void emailHooks.onEmailKeywordChange.emit({ emailIds: [emailId], added: [keyword], removed: [] });
  },

  setEmailKeywords: async (client, emailId, keywords, emailKey): Promise<boolean> => {
    const isTarget = singleEmailMatcher(emailId, emailKey);
    // Route the write to the email's OWN account, exactly like toggleStar and
    // every other single-email action. `resolveEmailActionContext` covers both
    // shapes: in an aggregate view the owner comes from the email's
    // `sourceAccountId`, and when a shared/group folder is selected directly in
    // the "Shared" sidebar section - where emails are undecorated - it falls back
    // to the owner of the selected mailbox.
    //
    // Resolving only the aggregate shape (`isUnifiedView ? ... : undefined`) sent
    // the write to the reaching client's primary account, which the server
    // answers with `notUpdated`/`updated: null` and no error, so the keyword was
    // silently lost on the next reload - the same class of bug as the batch
    // actions in `email-store-shared-folder-actions.test.ts`. (#281)
    //
    // Only the keywords that differ from the row are written (see
    // patchEmailKeywords): replacing the whole set from the row undid what
    // another client had set since, such as `$seen` or `$answered`.
    const previous = (get().emails.find(isTarget) ?? get().selectedEmail)?.keywords ?? {};
    const changes: Record<string, boolean> = {};
    for (const key of new Set([...Object.keys(previous), ...Object.keys(keywords)])) {
      if (!!previous[key] !== !!keywords[key]) changes[key] = !!keywords[key];
    }
    return await get().patchEmailKeywords(client, emailId, changes, emailKey);
  },

  patchEmailKeywords: async (client, emailId, changes, emailKey): Promise<boolean> => {
    const isTarget = singleEmailMatcher(emailId, emailKey);
    const keys = Object.keys(changes);
    if (keys.length === 0) return true;
    if (emailHooks.onBeforeEmailKeywordChange.size > 0
      && !(await emailHooks.onBeforeEmailKeywordChange.intercept({ emailIds: [emailId], ...keywordChangeLists(changes) }))) {
      return false;
    }
    const { client: actionClient, accountId } = resolveKeywordActionContext(emailId, client, emailKey);
    // `keywords/<name>` pointers touch only these keywords on the server;
    // a cleared keyword is removed (null), since a keyword map holds `true`
    // values only.
    const patch = Object.fromEntries(keys.map(key => [keywordPointer(key), changes[key] ? true : null]));
    await actionClient.batchUpdateKeywords([emailId], patch, accountId);

    const previous = (get().emails.find(isTarget) ?? get().selectedEmail)?.keywords ?? {};
    const next: Record<string, boolean> = { ...previous };
    for (const key of keys) {
      if (changes[key]) next[key] = true;
      else delete next[key];
    }
    get().setEmailKeywordsLocal(emailId, next, emailKey);
    void emailHooks.onEmailKeywordChange.emit({ emailIds: [emailId], ...keywordChangeLists(changes) });
    refillAfterKeywordChange(get, client, keys.filter(k => !!previous[k] !== !!changes[k]));
    return true;
  },

  setEmailKeywordsLocal: (emailId, keywords, emailKey) => {
    const isTarget = singleEmailMatcher(emailId, emailKey);
    set((state) => {
      // This patch replaces the whole keyword map, so it can flip $seen as well
      // as labels. Only a genuine read-state change moves the tag unread counts.
      const previous = state.emails.find(isTarget) ?? state.selectedEmail;
      const wasRead = previous?.keywords?.$seen ?? false;
      const isRead = keywords.$seen ?? false;
      const delta = wasRead === isRead ? 0 : (isRead ? -1 : 1);

      return {
        emails: state.emails.map(e =>
          isTarget(e) ? { ...e, keywords: { ...keywords } } : e
        ),
        selectedEmail: (!!state.selectedEmail && isTarget(state.selectedEmail))
          ? { ...state.selectedEmail, keywords: { ...keywords } }
          : state.selectedEmail,
        tagCounts: applyTagCountReadDelta(state.tagCounts, [{ keywords, delta }]),
      };
    });
  },

  // Batch operations
  batchMarkAsRead: async (client, read, target): Promise<boolean> => {
    const { emails } = get();
    // The selection is keyed by owning account; JMAP takes the bare ids of
    // exactly those emails, never the keys and never a lookup by id (which
    // is what let a namesake in another account ride along). A targeted call
    // names its messages, and the account they belong to, itself. In a list
    // that mixes accounts a selected row found nowhere is left alone and
    // reported (resolveSelectionRows).
    const selection = target ? null : resolveSelectionRows();
    const selectedEmails = selection?.rows ?? [];
    const notFound = selection && isAggregateListView() ? selection.unknown : [];
    const targetIds = target ? new Set(target.emailIds) : null;
    const emailIdsArray = targetIds ? Array.from(targetIds) : selectedEmails.map(e => e.id);
    if (emailIdsArray.length === 0 && notFound.length === 0) return true;
    if (emailIdsArray.length > 0 && emailHooks.onBeforeEmailReadStateChange.size > 0
      && !(await emailHooks.onBeforeEmailReadStateChange.intercept({ emailIds: [...new Set(emailIdsArray)], read }))) {
      return false;
    }

    set({ isLoading: true, error: null });
    try {
      // Each write names the rows it covers: by key for the selection, so a
      // refusal in one account leaves a namesake in another marked; by id for
      // a targeted call, whose messages need not be loaded.
      const writes: { ids: string[]; rows: Email[]; write: () => Promise<void> }[] = [];
      if (target) {
        // Messages named by the caller need not be loaded, so the list's
        // source stamps cannot route them; the caller names the account.
        writes.push({
          ids: emailIdsArray,
          rows: [],
          write: () => target.client.batchMarkAsRead(emailIdsArray, read, target.accountId),
        });
      } else if (isAggregateListView()) {
        // Group by login and owning JMAP account; dispatch through the reaching
        // login client (groupBySource).
        for (const batch of groupBySource(selectedEmails)) {
          const acctClient = sourceBatchClient(batch, client);
          writes.push({
            ids: batch.ids,
            rows: batch.messages,
            write: acctClient
              ? () => acctClient.batchMarkAsRead(batch.ids, read, batch.accountId)
              : () => Promise.reject(new Error('Not connected')),
          });
        }
        if (notFound.length > 0) {
          writes.push({ ids: [], rows: [], write: () => Promise.reject(new Error(NOT_IN_LIST)) });
        }
      } else {
        // Non-unified: route to the viewed shared/group account (if any), reached
        // through the active client; undefined for a normal own-account view.
        writes.push({
          ids: emailIdsArray,
          rows: selectedEmails,
          write: () => resolveActionClient(client).batchMarkAsRead(emailIdsArray, read, resolveViewAccountId()),
        });
      }

      // A message the server refused (a read-only shared folder) keeps its
      // state; the rest of the selection is written and shown as such, and
      // the refusal is reported through `error`.
      const outcomes = await Promise.allSettled(writes.map(({ write }) => write()));
      const changedIds = new Set<string>();
      const changedKeys = new Set<string>();
      let failure: unknown = null;
      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i];
        let refused: Set<string> | null = null;
        if (outcome.status === 'rejected') {
          failure ??= outcome.reason;
          refused = new Set(jmapErrorFailedIds(outcome.reason) ?? writes[i].ids);
        }
        for (const id of writes[i].ids) if (!refused?.has(id)) changedIds.add(id);
        for (const row of writes[i].rows) if (!refused?.has(row.id)) changedKeys.add(emailKeyFor(row));
      }
      const changed = (email: Email) => (targetIds ? changedIds.has(email.id) : changedKeys.has(emailKeyFor(email)));
      if (failure && (targetIds ? changedIds.size : changedKeys.size) === 0) throw failure;

      // Update local state
      const updatedEmails = emails.map(email =>
        changed(email)
          ? { ...email, keywords: { ...email.keywords, $seen: read } }
          : email
      );

      // Update mailbox counters per the email's own account list (#281). The
      // selection's rows include the members of expanded threads.
      const affectedEmails = (targetIds ? emails : selectedEmails).filter(changed);
      const mailboxPatch = applyBatchMailboxCounterUpdate(get(), affectedEmails, (mailbox, group) => {
        let deltaUnread = 0;
        for (const email of group as Email[]) {
          if (emailInMailbox(email, mailbox) && (email.keywords?.$seen ?? false) !== read) {
            deltaUnread += read ? -1 : 1;
          }
        }
        return deltaUnread === 0 ? mailbox : {
          ...mailbox,
          unreadEmails: Math.max(0, mailbox.unreadEmails + deltaUnread),
          unreadThreads: Math.max(0, mailbox.unreadThreads + deltaUnread),
        };
      });

      // Tag badges follow the same delta as the folder counters, counting only
      // the emails whose read state actually changed.
      const tagCounts = applyTagCountReadDelta(
        get().tagCounts,
        affectedEmails
          .filter(email => (email.keywords?.$seen ?? false) !== read)
          .map(email => ({ keywords: email.keywords, delta: read ? -1 : 1 })),
      );

      // In the unread cross view, retain every mail we just marked read so the
      // rows stay put (status + counter update only); marking unread drops them.
      let retainedInViewIds = get().retainedInViewIds;
      if (retainingCrossView(get()) === 'unread') {
        const op = read ? 'add' : 'remove';
        for (const e of affectedEmails) {
          retainedInViewIds = updateRetainedForView(retainedInViewIds, op, e.id);
        }
      }

      // The members of expanded threads show their new state too.
      const affectedKeys = new Set(affectedEmails.map(sourceRowKey));
      const threadEmailsCache = new Map(get().threadEmailsCache);
      for (const [threadKey, members] of threadEmailsCache) {
        if (!members.some(member => affectedKeys.has(sourceRowKey(member)))) continue;
        threadEmailsCache.set(threadKey, members.map(member => affectedKeys.has(sourceRowKey(member))
          ? { ...member, keywords: { ...member.keywords, $seen: read } }
          : member));
      }

      set({
        emails: updatedEmails,
        ...mailboxPatch,
        tagCounts,
        retainedInViewIds,
        threadEmailsCache,
        // The user's own selection is not what a targeted call acted on.
        selectedEmailKeys: target ? get().selectedEmailKeys : new Set(notFound),
        isLoading: false,
        error: failure ? (failure instanceof Error ? failure.message : "Failed to update emails") : null,
      });
      if (changedIds.size > 0) void emailHooks.onEmailReadStateChange.emit({ emailIds: [...changedIds], read });
      refillAfterKeywordChange(get, client, ['$seen']);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to update emails",
        isLoading: false
      });
      return false;
    }
    return true;
  },

  batchSetTag: async (client, tagId, add): Promise<boolean> => {
    const { selectedEmailKeys } = get();
    if (selectedEmailKeys.size === 0) return true;

    // Both prefixes name the same tag when read, so taking one off clears
    // either spelling; putting one on writes the current spelling only.
    const tagKeys = [KEYWORD_PREFIX + tagId, KEYWORD_PREFIX_LEGACY + tagId];
    const changedKeys = add ? [tagKeys[0]] : tagKeys;
    const patch = Object.fromEntries(changedKeys.map(key => [keywordPointer(key), add ? true : null]));

    // Group by the account each message lives in, exactly as a single-message
    // tag change is routed: its source in an aggregate view, the selected
    // folder's owner in a shared folder. (#281) The selection is keyed by
    // owning account, so a namesake in another account is never written.
    const groups = new Map<IJMAPClient, Map<string | undefined, Email[]>>();
    for (const email of resolveSelectedEmails(get())) {
      // A message already in the wanted state needs no write.
      if (tagKeys.some(key => email.keywords?.[key] === true) === add) continue;
      const { client: actionClient, accountId } = resolveEmailActionContext(email, client);
      const byAccount = groups.get(actionClient) ?? new Map<string | undefined, Email[]>();
      groups.set(actionClient, byAccount);
      byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), email]);
    }

    if (groups.size === 0) return true;
    const tagChange = add ? { added: changedKeys, removed: [] } : { added: [], removed: changedKeys };
    if (emailHooks.onBeforeEmailKeywordChange.size > 0) {
      const emailIds = [...new Set([...groups.values()].flatMap(byAccount => [...byAccount.values()].flat().map(e => e.id)))];
      if (!(await emailHooks.onBeforeEmailKeywordChange.intercept({ emailIds, ...tagChange }))) return false;
    }

    const writes = [...groups].flatMap(([actionClient, byAccount]) =>
      [...byAccount].map(async ([accountId, group]) => {
        await actionClient.batchUpdateKeywords(group.map(e => e.id), patch, accountId);
        return group;
      }),
    );
    const settled = await Promise.allSettled(writes);
    const writtenEmails = settled.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    const results = settled.map(result => result.status === 'fulfilled'
      ? { status: 'fulfilled' as const, value: result.value.map(emailKeyFor) }
      : result);

    // Only the accounts whose write went through are patched locally.
    const written = new Set(results.flatMap(result => result.status === 'fulfilled' ? result.value : []));
    const retag = (keywords: Record<string, boolean> | undefined) => {
      const next = { ...keywords };
      if (add) next[tagKeys[0]] = true;
      else for (const key of tagKeys) delete next[key];
      return next;
    };
    set((state) => ({
      emails: state.emails.map(e => written.has(emailKeyFor(e)) ? { ...e, keywords: retag(e.keywords) } : e),
      selectedEmail: state.selectedEmail && written.has(emailKeyFor(state.selectedEmail))
        ? { ...state.selectedEmail, keywords: retag(state.selectedEmail.keywords) }
        : state.selectedEmail,
    }));
    if (written.size > 0) {
      void emailHooks.onEmailKeywordChange.emit({ emailIds: [...new Set(writtenEmails.map(e => e.id))], ...tagChange });
      void get().fetchTagCounts(client);
      refillAfterKeywordChange(get, client, changedKeys);
    }

    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    return true;
  },

  batchDelete: async (client, permanent = false): Promise<boolean> => {
    const { selectedEmailKeys, emails, selectedMailbox } = get();
    const mailboxes = resolveActionMailboxes();
    if (selectedEmailKeys.size === 0) return true;

    if (emailHooks.onBeforeEmailDelete.size > 0) {
      const toDelete = resolveSelectedEmails(get());
      if (toDelete.length > 0) {
        const currentMailbox = mailboxes.find(m => m.id === selectedMailbox);
        const destroys = permanent || bulkDeleteIsPermanent(currentMailbox);
        if (!(await emailHooks.onBeforeEmailDelete.intercept({ emailIds: [...new Set(toDelete.map(e => e.id))], permanent: destroys }))) return false;
      }
    }

    set({ isLoading: true, error: null });
    try {
      // The selection is keyed by owning account; JMAP takes the bare ids of
      // exactly those emails, never the keys and never a lookup by id (which
      // is what let a namesake in another account ride along). In a list that
      // mixes accounts a selected row found nowhere is left alone and
      // reported (resolveSelectionRows).
      const { rows: selectedEmails, unknown } = resolveSelectionRows();
      const notFound = isAggregateListView() ? unknown : [];
      if (selectedEmails.length === 0) {
        if (notFound.length > 0) {
          set({ error: NOT_IN_LIST, isLoading: false });
          return false;
        }
        set({ selectedEmailKeys: new Set(), isLoading: false });
        return true;
      }

      // Determine if the current folder forces permanent deletion.
      const currentMailbox = mailboxes.find(m => m.id === selectedMailbox);
      const isInTrash = currentMailbox?.role === 'trash';
      const permanentlyDeleteJunk = useSettingsStore.getState().permanentlyDeleteJunk;
      const isInJunk = currentMailbox?.role === 'junk';
      const forceDestroy = permanent || isInTrash || (isInJunk && permanentlyDeleteJunk);
      const alsoMarkRead = useSettingsStore.getState().deleteAction === 'trash-and-read';

      // Group emails by login and owning JMAP account (handles unified view and
      // search results spanning accounts). Each group resolves the reaching login
      // client via `sourceClientAccountId` and routes JMAP via `sourceAccountId`.
      // Undecorated emails (normal single-mailbox view) form one group for the
      // active client (groupBySource).
      const batches = groupBySource(selectedEmails);

      // Undecorated emails viewed in a shared/group folder directly (non-unified)
      // are reached through the active client but must carry the owner accountId,
      // or the move/destroy silently no-ops on the user's own account (see
      // resolveViewAccountId). undefined for a normal own-account view.
      const viewAccountId = currentMailbox?.isShared ? currentMailbox.accountId : undefined;
      // Each group's trash comes from its own login's folder list: another
      // login may use the same account id for an account with other folders,
      // which is what the list cached under the bare account id can hold.
      const mailboxesFor = (batch: SourceBatch) => (!batch.accountId ? mailboxes : sourceBatchMailboxes(batch));
      const jmapIdFor = (batch: SourceBatch) => batch.accountId ?? viewAccountId;

      // Ids the server confirmed, for onAfterEmailDelete.
      const deletedIds = new Set<string>();
      if (forceDestroy) {
        const promises = batches.map(async (batch) => {
          const acctClient = sourceBatchClient(batch, client);
          if (!acctClient) return;
          await acctClient.batchDeleteEmails(batch.ids, jmapIdFor(batch));
          batch.ids.forEach(id => deletedIds.add(id));
        });
        await Promise.allSettled(promises);
      } else {
        // Move to trash per account.
        let failedAccounts = 0;
        // Keys, not ids: a namesake in an account that failed must stay.
        const movedKeys = new Set<string>();
        const promises = batches.map(async (batch) => {
          const acctClient = sourceBatchClient(batch, client);
          if (!acctClient) {
            failedAccounts++;
            return;
          }
          const trashMailbox = findTrashMailbox(mailboxesFor(batch), {
            accountId: jmapIdFor(batch),
          });
          if (!trashMailbox) {
            // No trash for this account: skip rather than silently destroying.
            // The user asked to move to trash, not permanently delete.
            failedAccounts++;
            return;
          }
          const trashId = trashMailbox.originalId || trashMailbox.id;
          await acctClient.batchMoveEmails(batch.ids, trashId, jmapIdFor(batch), alsoMarkRead);
          batch.messages.forEach(email => movedKeys.add(emailKeyFor(email)));
          batch.ids.forEach(id => deletedIds.add(id));
        });
        await Promise.allSettled(promises);

        if (failedAccounts > 0 && movedKeys.size === 0) {
          // Nothing moved - bail out so the UI doesn't drop the emails from view.
          throw new Error('Trash mailbox not found - cannot move emails to trash');
        }

        // Only remove successfully moved emails from local state.
        if (movedKeys.size < selectedEmails.length) {
          const deletedEmails = selectedEmails.filter(e => movedKeys.has(emailKeyFor(e)));
          const remainingEmails = emails.filter(e => !movedKeys.has(emailKeyFor(e)));
          const mailboxPatch = applyBatchMailboxCounterUpdate(get(), deletedEmails, applyDeleteCounters);
          set({
            emails: remainingEmails,
            ...mailboxPatch,
            selectedEmailKeys: new Set(notFound),
            selectedEmail: null,
            isLoading: false,
            error: 'Some emails could not be moved: trash folder missing for one or more accounts',
          });
          void emailHooks.onAfterEmailDelete.emit({ emailIds: [...deletedIds], permanent: false });
          return false;
        }
      }

      // Remove deleted emails from local state
      const remainingEmails = emails.filter(e => !selectedEmailKeys.has(emailKeyFor(e)));

      // Update mailbox counters per the email's own account list (#281). The
      // selection's rows include the members of expanded threads.
      const mailboxPatch = applyBatchMailboxCounterUpdate(get(), selectedEmails, applyDeleteCounters);

      set({
        emails: remainingEmails,
        ...mailboxPatch,
        selectedEmailKeys: new Set(notFound),
        selectedEmail: null,
        isLoading: false,
        ...(notFound.length > 0 ? { error: NOT_IN_LIST } : {}),
      });
      if (deletedIds.size > 0) void emailHooks.onAfterEmailDelete.emit({ emailIds: [...deletedIds], permanent: forceDestroy });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to delete emails",
        isLoading: false
      });
      return false;
    }
    return true;
  },

  batchMoveToMailbox: async (client, toMailboxId, target): Promise<boolean> => {
    const { selectedEmailKeys, emails } = get();
    // Keyed selection as in batchMarkAsRead; a targeted call names its own.
    const selection = target ? null : resolveSelectionRows();
    const selectedEmails = selection?.rows ?? [];
    const targetIds = target ? new Set(target.emailIds) : null;
    const emailIdsArray = targetIds ? Array.from(targetIds) : selectedEmails.map(e => e.id);
    if (emailIdsArray.length === 0 && !(selection && isAggregateListView() && selection.unknown.length > 0)) return true;
    const hookMailboxes = resolveActionMailboxes();
    const move = {
      emailIds: [...new Set(emailIdsArray)],
      fromMailboxId: moveSourceMailboxId(targetIds ? emails.filter(e => targetIds.has(e.id)) : selectedEmails, hookMailboxes),
      toMailboxId,
    };
    if (move.emailIds.length > 0 && !(await allowEmailMove(move, hookMailboxes))) return false;

    set({ isLoading: true, error: null });
    try {
      // Ids of an account group whose move failed.
      const notMoved = new Set<string>();

      if (!target && isAggregateListView()) {
        // Only messages in the folder's own login and account change folders
        // in place; the others are moved across accounts (moveSourceBatches).
        // What could not be moved stays listed and selected, and so does a
        // selected row found neither listed nor in an expanded thread
        // (resolveSelectionRows).
        const failures = await moveRowsToMailbox(selectedEmails, resolveMoveDestination(client, toMailboxId), client);
        for (const failure of failures) failure.ids.forEach(id => notMoved.add(id));
        failures.push(...notFoundFailures(selection?.unknown ?? []));
        set({ isLoading: false, error: failures.length > 0 ? batchFailureMessage(failures, 'move') : null });
      } else {
        if (target) {
          // Messages named by the caller need not be loaded, so the list's
          // source stamps cannot route them; the caller names the account and
          // the destination's JMAP id.
          await target.client.batchMoveEmails(emailIdsArray, toMailboxId, target.accountId);
        } else {
          // Non-unified: route to the viewed shared/group account (if any), reached
          // through the active client. Resolve the destination to its bare owner id
          // (`originalId`) since shared folders use namespaced store ids.
          const viewAccountId = resolveViewAccountId();
          const destMailbox = resolveActionMailboxes().find(mb => mb.id === toMailboxId);
          const jmapDestId = destMailbox?.originalId || toMailboxId;
          await resolveActionClient(client).batchMoveEmails(emailIdsArray, jmapDestId, viewAccountId);
        }

        // Update local state - remove from current view since they moved
        const moved = (e: Email) => (targetIds ? targetIds.has(e.id) : selectedEmailKeys.has(emailKeyFor(e)));
        const remainingEmails = emails.filter(e => !moved(e));

        set({
          emails: remainingEmails,
          // A targeted call only drops the moved messages from the selection.
          selectedEmailKeys: target ? dropFromSelection(get(), moved) : new Set(),
          isLoading: false
        });
      }

      const movedIds = move.emailIds.filter(id => !notMoved.has(id));
      if (movedIds.length > 0) emitEmailMove({ ...move, emailIds: movedIds }, hookMailboxes);
      // Refresh emails to get updated list (honors active search/filters)
      if (!get().isUnifiedView) {
        await get().refreshCurrentMailbox(client);
      }
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to move emails",
        isLoading: false
      });
      return false;
    }
    return true;
  },

  batchArchive: async (client): Promise<boolean> => {
    if (!isArchiveActionEnabled()) return false;
    if (get().selectedEmailKeys.size === 0) return true;
    if (isAggregateListView()) {
      // The listed rows and the members of expanded threads the selection
      // names; a selected row found in neither is reported (resolveSelectionRows).
      const { rows, unknown } = resolveSelectionRows();
      return archiveAggregateSelection(client, rows, unknown);
    }
    const { selectedMailbox } = get();
    const selected = resolveSelectedEmails(get());
    if (selected.length === 0) return true;
    const listKeys = new Set(get().emails.map(emailKeyFor));

    // A JMAP id is only unique within its owning account. Keep the reaching client in
    // the grouping key as well as the owner account, including delegated owners.
    type Group = ReturnType<typeof resolveEmailActionContext> & {
      emails: Email[];
      loginId: string | null;
      stamped: boolean;
      updatedIds: Set<string>;
      createdArchive: boolean;
      move?: Parameters<typeof allowEmailMove>[0];
      hookMailboxes?: Mailbox[];
    };
    const groups: Group[] = [];
    const failures: Error[] = [];
    let stoppedByPlugin = false;
    const sourceClients = new Map<string, IJMAPClient | undefined>();
    const clientForSource = (loginId: string) => {
      if (!sourceClients.has(loginId)) {
        sourceClients.set(loginId, useAuthStore.getState().getClientForAccount(loginId));
      }
      return sourceClients.get(loginId);
    };
    const viewerLoginId = get().selectedEmail?.sourceClientAccountId;
    if (viewerLoginId) clientForSource(viewerLoginId);
    for (const email of selected) {
      const stamped = !!(email.sourceClientAccountId && email.sourceAccountId);
      if (stamped && !clientForSource(email.sourceClientAccountId!)) {
        failures.push(new Error('Email account is not connected - cannot archive email'));
        continue;
      }
      const context = resolveEmailActionContext(email, client);
      // Merge stamped and unstamped rows of the same primary account too.
      context.accountId ??= context.client.getAccountId?.()
        || context.mailboxes.find(m => !m.isShared)?.accountId;
      const group = groups.find(g => g.client === context.client && g.accountId === context.accountId);
      if (group) {
        group.emails.push(email);
        group.stamped ||= stamped;
      } else groups.push({
        ...context, emails: [email], stamped, updatedIds: new Set(), createdArchive: false,
        loginId: email.sourceClientAccountId ?? get().viewingAccountId ?? useAuthStore.getState().activeAccountId,
      });
    }

    const isCurrentView = captureEmailListView();
    const epoch = currentStoreEpoch();
    const unstampedContext = resolveEmailActionContext({}, client);
    const unstampedOwner = unstampedContext.accountId ?? unstampedContext.client.getAccountId?.()
      ?? unstampedContext.mailboxes.find(m => !m.isShared)?.accountId;
    const groupForEmail = (email: Email) => {
      const stamped = !!(email.sourceClientAccountId && email.sourceAccountId);
      const actionClient = stamped
        ? clientForSource(email.sourceClientAccountId!)
        : unstampedContext.client;
      const owner = stamped ? email.sourceAccountId : unstampedOwner;
      return groups.find(g => g.client === actionClient && g.accountId === owner);
    };
    const mode = useSettingsStore.getState().archiveMode;
    set({ isLoading: true, error: null });
    await Promise.all(groups.map(async group => {
      try {
        // The owner-only cache is ambiguous across servers/logins. Stamped
        // selections resolve folders through their authenticated client instead.
        let mailboxes = group.stamped
          ? await group.client.getMailboxes(group.accountId)
          : group.mailboxes;
        // A primary-account action can start with the merged sidebar list.
        // Keep only this owner's folders; older own-folder objects may lack
        // accountId, whereas delegated folders must always name their owner.
        const primaryOwner = !group.accountId || group.accountId === group.client.getAccountId?.();
        const ownerMailboxes = (folders: Mailbox[]) => folders
          .filter(m => group.accountId
            ? m.accountId === group.accountId || (primaryOwner && !m.accountId && !m.isShared)
            : !m.isShared)
          .map(m => m.isShared ? {
            ...m, id: `${m.accountId}:${m.originalId || m.id}`,
            originalId: m.originalId || m.id,
            parentId: m.parentId && !m.parentId.startsWith(`${m.accountId}:`)
              ? `${m.accountId}:${m.parentId}` : m.parentId,
          } : m.accountId ? m : { ...m, accountId: group.accountId });
        mailboxes = ownerMailboxes(mailboxes);
        const archive = await ensureArchiveMailbox({
          client: group.client, mailboxes, selectedMailboxId: selectedMailbox,
          accountId: group.accountId,
          refresh: async () => {
            mailboxes = ownerMailboxes(await group.client.getMailboxes(group.accountId));
            group.createdArchive = !!findArchiveMailbox(mailboxes, selectedMailbox, group.accountId);
            return mailboxes;
          },
        });
        if (!archive) {
          stoppedByPlugin = true;
          return;
        }
        if (archive.myRights?.mayReadItems === false || archive.myRights?.mayAddItems === false) {
          throw new ArchiveMailboxNotFoundError();
        }
        group.hookMailboxes = [...mailboxes, archive];
        group.move = {
          emailIds: [...new Set(group.emails.map(e => e.id))],
          fromMailboxId: moveSourceMailboxId(group.emails, group.hookMailboxes),
          toMailboxId: archive.id,
        };
        if (!(await allowEmailMove(group.move, group.hookMailboxes))) {
          stoppedByPlugin = true;
          return;
        }
        // Store-side shared folders may be namespaced; year/month lookup needs
        // the server's bare parent ids so existing subfolders can be reused.
        const jmapMailboxes = mailboxes.map(m => m.originalId ? {
          ...m, id: m.originalId,
          parentId: m.parentId?.startsWith(`${m.accountId}:`)
            ? m.parentId.slice(`${m.accountId}:`.length) : m.parentId,
        } : m);
        await group.client.batchArchiveEmails(
          group.emails.map(e => ({ id: e.id, receivedAt: e.receivedAt })),
          archive.originalId || archive.id, mode, jmapMailboxes, group.accountId ?? archive.accountId,
        );
        group.emails.forEach(e => group.updatedIds.add(e.id));
      } catch (error) {
        if (error instanceof ArchiveEmailsError) {
          // Only accept confirmations belonging to this request's owner.
          group.emails.forEach(e => {
            if (error.updatedIds.includes(e.id)) group.updatedIds.add(e.id);
          });
        }
        failures.push(error instanceof Error ? error : new Error('Failed to archive emails'));
      }
      if (group.move && group.hookMailboxes && group.updatedIds.size > 0) {
        emitEmailMove({ ...group.move, emailIds: [...group.updatedIds] }, group.hookMailboxes);
      }
    }));

    // Match the actual authenticated client and owner, including an unstamped
    // list row whose open viewer carries source stamps for that same account.
    const confirmedEmails = groups.flatMap(g => g.emails.filter(e => g.updatedIds.has(e.id)));
    const wasArchived = (email: Email) => groupForEmail(email)?.updatedIds.has(email.id) ?? false;
    const failedEmails = selected.filter(e => !wasArchived(e));
    if (isCurrentView() && confirmedEmails.length > 0) {
      set(state => {
        const remaining = state.emails.filter(e => !wasArchived(e));
        const remainingIds = new Set(remaining.map(e => e.id));
        const selectedEmailKeys = new Set(state.selectedEmailKeys);
        for (const email of confirmedEmails) selectedEmailKeys.delete(emailKeyFor(email));
        const changedThreads = new Set(confirmedEmails.map(threadKeyFor));
        state.emails.filter(wasArchived).forEach(e => {
          changedThreads.add(threadKeyFor(e));
          selectedEmailKeys.delete(emailKeyFor(e));
        });
        const remainingThreads = new Set(remaining.map(threadKeyFor));
        const threadEmailsCache = new Map(state.threadEmailsCache);
        for (const [key, members] of threadEmailsCache) {
          const cached = members.filter(e => !wasArchived(e));
          if (cached.length === members.length) continue;
          changedThreads.add(key);
          members.filter(wasArchived).forEach(e => selectedEmailKeys.delete(emailKeyFor(e)));
          if (cached.length) threadEmailsCache.set(key, cached);
          else threadEmailsCache.delete(key);
        }
        return {
          emails: remaining,
          totalEmails: Math.max(remaining.length, state.totalEmails - (state.emails.length - remaining.length)),
          selectedEmailKeys,
          selectedEmail: state.selectedEmail && wasArchived(state.selectedEmail) ? null : state.selectedEmail,
          threadEmailsCache,
          expandedThreadIds: new Set([...state.expandedThreadIds].filter(key =>
            !changedThreads.has(key) || remainingThreads.has(key) || threadEmailsCache.has(key))),
          retainedInViewIds: new Set([...state.retainedInViewIds].filter(id =>
            !confirmedEmails.some(e => e.id === id) || remainingIds.has(id))),
        };
      });
    }

    // Refresh every successful owner even if another owner (or another message
    // in this owner's Email/set) failed. Also publish a newly created Archive
    // when its email moves fail, as upstream's create-and-refresh path did.
    await Promise.all(groups.filter(g => g.updatedIds.size > 0 || g.createdArchive).map(async group => {
      try {
        const fresh = await group.client.getMailboxes(group.accountId);
        if (currentStoreEpoch() !== epoch || fresh.length === 0) return;
        const owner = group.accountId ?? fresh[0]?.accountId;
        const primary = group.client.getAccountId?.()
          ? group.client.getAccountId() === owner
          : !fresh[0]?.isShared;
        const normalized = fresh.filter(m => !owner || !m.accountId || m.accountId === owner).map(m => m.isShared ? {
          ...m, id: `${m.accountId}:${m.originalId || m.id}`,
          originalId: m.originalId || m.id,
          parentId: m.parentId && !m.parentId.startsWith(`${m.accountId}:`) ? `${m.accountId}:${m.parentId}` : m.parentId,
        } : m);
        set(state => {
          const accountMailboxes = { ...state.accountMailboxes };
          if (owner) accountMailboxes[owner] = normalized;
          // Login caches may contain both personal and delegated folders.
          // Replace this owner only, preserving the rest of that folder tree.
          const mergeOwner = (folders: Mailbox[]) => [
            ...folders.filter(m => primary ? m.isShared : m.accountId !== owner), ...normalized,
          ];
          if (group.loginId) {
            accountMailboxes[group.loginId] = mergeOwner(state.accountMailboxes[group.loginId] ?? []);
          }
          const activeClient = useAuthStore.getState().getClientForAccount(useAuthStore.getState().activeAccountId ?? '');
          return {
            accountMailboxes,
            mailboxes: activeClient === group.client
              ? mergeOwner(state.mailboxes)
              : state.mailboxes,
          };
        });
      } catch (error) {
        console.error('Failed to refresh mailboxes after archive:', error);
        failures.push(error instanceof Error ? error : new Error('Failed to refresh mailboxes after archive'));
      }
    }));
    if (confirmedEmails.length > 0 && isCurrentView()) {
      const failedKeys = new Set(failedEmails.map(emailKeyFor));
      const failedRows = failedEmails.filter(e => listKeys.has(emailKeyFor(e)));
      const failedThreads = [...get().threadEmailsCache].filter(([, members]) =>
        members.some(e => failedKeys.has(emailKeyFor(e))));
      try {
        await get().refreshCurrentMailbox(client);
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error('Failed to refresh emails after archive'));
      }
      if (isCurrentView() && failedEmails.length > 0) {
        // A refreshed first page can omit a failed selected row (or return an
        // equal raw id from another owner). Preserve failed objects and their
        // account-aware selection, including selected expanded-thread members.
        set(state => {
          const sameEmail = (a: Email, b: Email) => emailKeyFor(a) === emailKeyFor(b);
          const emails = state.emails.map(e => failedEmails.find(f => sameEmail(e, f)) ?? e);
          for (const failed of failedRows) {
            if (!emails.some(e => sameEmail(e, failed))) emails.push(failed);
          }
          const threadEmailsCache = new Map(state.threadEmailsCache);
          for (const [key, members] of failedThreads) {
            const merged = new Map(members.map(e => [emailKeyFor(e), e]));
            for (const e of threadEmailsCache.get(key) ?? []) merged.set(emailKeyFor(e), e);
            for (const e of failedEmails) {
              if (threadKeyFor(e) === key) merged.set(emailKeyFor(e), e);
            }
            threadEmailsCache.set(key, [...merged.values()]);
          }
          return {
            emails,
            totalEmails: Math.max(state.totalEmails, emails.length),
            selectedEmailKeys: new Set([...state.selectedEmailKeys, ...failedEmails.map(emailKeyFor)]),
            threadEmailsCache,
          };
        });
      }
    }

    // Publish after refresh so a successful refresh cannot erase the archive
    // failure, and reject so the existing bulk-action toast reports it.
    const error = failures.length === 1 ? failures[0]
      : failures.length > 1 ? new Error(failures.map(e => e.message).join('; ')) : null;
    if (isCurrentView()) set({ isLoading: false, error: error?.message ?? null });
    if (error) throw error;
    return !stoppedByPlugin;
  },

  // Spam operations
  markAsSpam: async (client, emailId, emailKey): Promise<boolean> => {
    const isTarget = singleEmailMatcher(emailId, emailKey);
    // The viewer may show an email the list no longer holds (e.g. the unread
    // quick-filter dropped it once it was read), so fall back to the selected
    // email like moveThreadToMailbox does. Throw rather than no-op so the
    // caller's success toast cannot fire for a message that was not moved. (#695)
    const state = get();
    const email = state.emails.find(isTarget)
      ?? ((!!state.selectedEmail && isTarget(state.selectedEmail)) ? state.selectedEmail : null);
    if (!email) {
      throw new Error('Email not found - cannot mark as spam');
    }
    if (emailHooks.onBeforeEmailSpamToggle.size > 0
      && !(await emailHooks.onBeforeEmailSpamToggle.intercept({ emailIds: [emailId], spam: true }))) {
      return false;
    }

    // In unified view route to the email's own account (client + that account's
    // mailbox list); otherwise the active/viewing context. (#281)
    const { client: actionClient, mailboxes, accountId } = resolveEmailActionContext(email, client);

    // The email's current mailbox is what undo restores it to. In unified view
    // derive it from the email's own folders (preferring the unified role),
    // otherwise the active account's selected mailbox.
    const currentMailbox = isAggregateListView()
      ? (mailboxes.find(mb => emailInMailbox(email, mb) && mb.role === get().unifiedRole)
          ?? mailboxes.find(mb => emailInMailbox(email, mb)))
      : mailboxes.find(m => m.id === get().selectedMailbox);

    // Without a known source folder there is nothing for undo to restore to;
    // still move the message, and undo falls back to the inbox. Returning
    // here let the caller show a success toast for a message never moved.
    if (currentMailbox) {
      get().spamUndoCache.set(emailKey ?? emailId, {
        emailId,
        originalMailboxId: currentMailbox.originalId || currentMailbox.id,
        accountId,
        sourceClientAccountId: email.sourceClientAccountId,
      });
    }

    try {
      const isUnread = !email.keywords?.$seen;
      const alsoMarkRead = useSettingsStore.getState().deleteAction === 'trash-and-read' && isUnread;
      await actionClient.markAsSpam(emailId, accountId, alsoMarkRead);

      // Same junk resolution the client used for the move itself.
      const junkMailbox = mailboxes.find(m =>
        accountId ? (m.role === 'junk' && m.accountId === accountId) : (m.role === 'junk' && !m.isShared)
      );
      // After marking read in the same request, the email arrives in junk as read.
      const arrivesUnread = isUnread && !alsoMarkRead;

      set(state => {
        // Counter changes go to the email's own account list; source and junk
        // live in the same account. (#281)
        const mailboxPatch = applyMailboxCounterUpdate(state, email, (mailbox) => {
          if (emailInMailbox(email, mailbox)) {
            return {
              ...mailbox,
              totalEmails: Math.max(0, mailbox.totalEmails - 1),
              unreadEmails: isUnread ? Math.max(0, mailbox.unreadEmails - 1) : mailbox.unreadEmails,
              totalThreads: Math.max(0, mailbox.totalThreads - 1),
              unreadThreads: isUnread ? Math.max(0, mailbox.unreadThreads - 1) : mailbox.unreadThreads,
            };
          }
          if (junkMailbox && mailbox.id === junkMailbox.id) {
            return {
              ...mailbox,
              totalEmails: mailbox.totalEmails + 1,
              unreadEmails: arrivesUnread ? mailbox.unreadEmails + 1 : mailbox.unreadEmails,
              totalThreads: mailbox.totalThreads + 1,
              unreadThreads: arrivesUnread ? mailbox.unreadThreads + 1 : mailbox.unreadThreads,
            };
          }
          return mailbox;
        });

        return {
          emails: state.emails.filter(e => !isTarget(e)),
          selectedEmail: getNextSelectedEmailAfterRemovingRow(state, isTarget),
          ...mailboxPatch,
        };
      });
      void emailHooks.onEmailSpamToggle.emit({ emailIds: [emailId], spam: true });
    } catch (error) {
      console.error('Failed to mark as spam:', error);
      throw error;
    }
    return true;
  },

  undoSpam: async (client, emailId, emailKey): Promise<boolean> => {
    const isTarget = singleEmailMatcher(emailId, emailKey);
    if (emailHooks.onBeforeEmailSpamToggle.size > 0
      && !(await emailHooks.onBeforeEmailSpamToggle.intercept({ emailIds: [emailId], spam: false }))) {
      return false;
    }
    const { selectedMailbox } = get();
    const mailboxes = resolveActionMailboxes();

    // Try cache first (preserves exact original mailbox for toast undo)
    const cachedData = get().spamUndoCache.get(emailKey ?? emailId);

    let targetMailboxId: string;
    let accountId: string | undefined;
    // In unified view the cache records the email's owning account so the undo
    // is routed to that account's client, not the active one. (#281)
    let undoClient: IJMAPClient = resolveActionClient(client);

    if (cachedData) {
      // Use cached original mailbox (more accurate for immediate undo)
      targetMailboxId = cachedData.originalMailboxId;
      accountId = cachedData.accountId;
      if (cachedData.sourceClientAccountId) {
        undoClient = stampedClient(cachedData.sourceClientAccountId);
      }
      get().spamUndoCache.delete(emailKey ?? emailId);
    } else {
      // Generic "not spam" (button/menu, no undo cache). In aggregate views
      // (e.g. "All Junk") route to the email's own account so shared/group
      // messages move back to *their* inbox via *their* client, not the active
      // account's. (#281)
      const listEmail = get().emails.find(isTarget);
      let inboxMailboxes = mailboxes;
      if (listEmail?.sourceClientAccountId && listEmail?.sourceAccountId) {
        undoClient = stampedClient(listEmail.sourceClientAccountId);
        accountId = listEmail.sourceAccountId;
        inboxMailboxes = sourceMailboxes(get(), listEmail.sourceClientAccountId, listEmail.sourceAccountId);
      } else {
        const currentMailbox = mailboxes.find(m => m.id === selectedMailbox);
        accountId = currentMailbox?.accountId;
      }

      // Find inbox in same account
      const inboxMailbox = inboxMailboxes.find(m =>
        m.role === 'inbox' &&
        (accountId ? m.accountId === accountId : !m.accountId)
      );

      if (!inboxMailbox) {
        throw new Error('Inbox not found');
      }

      targetMailboxId = inboxMailbox.originalId || inboxMailbox.id;
    }

    try {
      await undoClient.undoSpam(emailId, targetMailboxId, accountId);

      // Drop the restored mail from the current junk view and advance the open
      // message to the next one, mirroring markAsSpam. Without this the viewer
      // stays stuck on the mail that just left the folder.
      set(state => ({
        emails: state.emails.filter(e => !isTarget(e)),
        selectedEmail: getNextSelectedEmailAfterRemovingRow(state, isTarget),
      }));
      void emailHooks.onEmailSpamToggle.emit({ emailIds: [emailId], spam: false });

      // Refresh the view the user is actually looking at. If they leave it
      // while the account list loads, skip the fetch rather than re-enter it.
      if (get().isUnifiedView && get().crossView) {
        const isSameView = captureViewToken();
        const view = get().crossView!;
        const includeGroup = useSettingsStore.getState().includeGroupInUnified;
        const accounts = await buildUnifiedAccountClients({ includeGroup });
        if (isSameView()) await get().fetchCrossView(accounts, view);
      } else if (get().isUnifiedView && get().unifiedRole) {
        const isSameView = captureViewToken();
        const role = get().unifiedRole!;
        const includeGroup = useSettingsStore.getState().includeGroupInUnified;
        const accounts = await buildUnifiedAccountClients({ includeGroup });
        if (isSameView()) await get().fetchUnifiedEmails(accounts, role);
      } else {
        await get().fetchEmails(client, selectedMailbox);
      }

      // Folder counts don't move on their own without a reliable JMAP push
      // (often absent on subpath/cross-origin deploys), so refresh them here so
      // the junk folder's badge drops right away.
      void get().fetchMailboxes(client);
    } catch (error) {
      console.error('Failed to restore email:', error);
      throw error;
    }
    return true;
  },

  batchMarkAsSpam: async (client, emailIds): Promise<boolean> => {
    const alsoMarkRead = useSettingsStore.getState().deleteAction === 'trash-and-read';
    return await runBatchSpamAction(get, set, client, emailIds, 'junk', (actionClient, email, accountId) =>
      actionClient.markAsSpam(email.id, accountId, alsoMarkRead && !email.keywords?.$seen),
      // After marking read in the same request, the email arrives in junk as read.
      (email) => !email.keywords?.$seen && !alsoMarkRead,
    );
  },

  // Batch "not spam" goes to the Inbox: unlike the toast undo there is no
  // record of where each message came from.
  batchUndoSpam: async (client: IJMAPClient, emailIds: string[]): Promise<boolean> => {
    return await runBatchSpamAction(get, set, client, emailIds, 'inbox', (actionClient, email, accountId, destination) =>
      actionClient.undoSpam(email.id, destination!.originalId || destination!.id, accountId),
      (email) => !email.keywords?.$seen,
    );
  },

  // Push notification handlers
  setPushConnected: (connected) => {
    set({ isPushConnected: connected });
  },

  applyEmailDelta: (client, newState) => {
    // Serialise deltas: two pushes in quick succession must apply in order,
    // each against the sync state the previous one advanced to.
    const run = emailDeltaQueue.then(() => applyEmailDeltaNow(client, newState, get, set), () => applyEmailDeltaNow(client, newState, get, set));
    emailDeltaQueue = run.then(() => undefined, () => undefined);
    return run;
  },

  applyMailboxDelta: async (client, changed) => {
    if (!client.getMailboxChanges || !client.getMailboxesByIds) return false;
    const states = { ...get().mailboxSyncStates };
    let mailboxes = get().mailboxes;
    if (mailboxes.length === 0) return false;
    let patched = false;

    for (const [acct, types] of Object.entries(changed)) {
      const pushedState = types?.Mailbox;
      if (!pushedState) continue;
      const since = states[acct];
      // Unknown baseline for this account (e.g. it appeared after the last
      // full fetch) - the delta cannot be trusted, refetch everything.
      if (!since) return false;
      if (since === pushedState) continue;

      const delta = await client.getMailboxChanges(since, acct);
      // Folders created or destroyed change the tree shape (parents,
      // selection validity, auto-created role folders) - let fetchMailboxes
      // handle that path as before.
      if (!delta || delta.hasMoreChanges || delta.created.length > 0 || delta.destroyed.length > 0) {
        return false;
      }
      if (delta.updated.length > 0) {
        const fresh = await client.getMailboxesByIds(delta.updated, acct);
        const freshById = new Map(fresh.map((mb) => [mb.originalId ?? mb.id, mb]));
        // An updated folder we don't have (or that vanished between the two
        // calls) means the local list is out of step - fall back.
        for (const id of delta.updated) {
          const known = mailboxes.some((mb) => mb.accountId === acct && (mb.originalId ?? mb.id) === id);
          if (!known || !freshById.has(id)) return false;
        }
        mailboxes = mailboxes.map((mb) =>
          mb.accountId === acct ? (freshById.get(mb.originalId ?? mb.id) ?? mb) : mb,
        );
        patched = true;
      }
      states[acct] = delta.newState;
    }

    set({ mailboxes, mailboxSyncStates: states });
    if (patched) {
      // Same extension hook a full refresh publishes, so plugins that mirror
      // folder counters see delta updates too.
      if (emailHooks.onMailboxesRefresh.size > 0) await emailHooks.onMailboxesRefresh.emit(mailboxes.map(mailboxToView));
    }
    return true;
  },

  handleStateChange: async (change, client) => {
    syncRuns += 1;
    if (syncRuns === 1) void emailHooks.onSyncStateChange.emit({ state: 'syncing' });
    let syncError: string | null = null;
    try {
      // Update last push update timestamp
      set({ lastPushUpdate: Date.now() });

      // Get the current account ID from the client (assuming primary account)
      const accountId = client.getAccountId();

      // New mail for plugins. Read the list's baseline before the delta
      // below moves it past the new messages.
      const pushedEmailState = change.changed[accountId]?.Email;
      if (pushedEmailState) {
        const listSync = get().emailListSync;
        void reportNewInboxMail(
          client, accountId, pushedEmailState,
          listSync?.accountId === accountId ? listSync.state : undefined,
          get,
        );
      }

      // Changes may arrive for the client's primary account OR a delegated
      // shared/group owner it has access to. Active-account *view* concerns
      // (current email list, scheduled, calendar, filters) key off the primary
      // account only, but the mailbox-COUNT refresh must react to any changed
      // account: the active client's getAllMailboxes returns own + delegated
      // folders, and the unified-section counts project from that list. (#281)
      const accountChanges = change.changed[accountId];
      const anyMailboxChanged = Object.values(change.changed).some((c) => c?.Mailbox);

      // Handle Email state changes. A plain folder list is first resolved as
      // an Email/changes delta (RFC 8620 §5.2) against the state it was
      // loaded at - which also covers a shared folder whose owner account
      // changed - and only re-queried when the delta cannot be applied.
      const sync = get().emailListSync;
      const syncedAccountEmailState = sync ? change.changed[sync.accountId]?.Email : undefined;
      // A tag view and the sidebar tag badges span the own AND the group/shared
      // accounts (#1038), so an Email change in any of them concerns them.
      const anyEmailChanged = Object.values(change.changed).some((c) => c?.Email);
      const tagViewChanged = !!get().selectedKeyword && anyEmailChanged;
      // So does an "All folders" search (#1082).
      const unscopedSearchChanged = isUnscopedSearchActive(get()) && anyEmailChanged;
      // And the unified and cross-account views, which include group and
      // shared accounts (#1350).
      const unifiedViewChanged = get().isUnifiedView && anyEmailChanged;
      if (accountChanges?.Email || syncedAccountEmailState || tagViewChanged || unscopedSearchChanged || unifiedViewChanged) {
        // A delta that could not be read falls back to the full refresh.
        const applied = syncedAccountEmailState
          ? await get().applyEmailDelta(client, syncedAccountEmailState).catch(() => false)
          : false;
        if (!applied) {
          await get().refreshCurrentMailbox(client);
        }
        if (anyEmailChanged) {
          get().fetchTagCounts(client);
        }
      }

      if (accountChanges?.EmailSubmission) {
        await get().refreshScheduledMetadata(client);
        if (get().isScheduledView) {
          await get().fetchScheduledEmails(client);
        }
      }

      // Handle Mailbox state changes - refresh mailbox list (own + delegated
      // shared folders), so both the active account's and its shared folders'
      // counters follow background activity.
      if (anyMailboxChanged) {
        const applied = await get().applyMailboxDelta(client, change.changed);
        if (!applied) {
          await get().fetchMailboxes(client);
        }
      }

      // Handle Calendar/CalendarEvent state changes - refresh calendar data
      if (accountChanges?.Calendar || accountChanges?.CalendarEvent) {
        const calendarStore = useCalendarStore.getState();
        if (calendarStore.supportsCalendar) {
          calendarStore.fetchCalendars(client);
          const { dateRange, selectedCalendarIds } = calendarStore;
          if (dateRange && selectedCalendarIds.length > 0) {
            calendarStore.fetchEvents(client, dateRange.start, dateRange.end);
          }
          // Refresh tasks when calendar events change (e.g. task created via CalDAV)
          const { useTaskStore } = await import('./task-store');
          const taskStore = useTaskStore.getState();
          if (taskStore.tasks.length > 0 || calendarStore.viewMode === 'tasks') {
            taskStore.fetchTasks(client);
          }
        }
      }

      // Someone changed this user's access to one of their collections
      // (RFC 9670 ShareNotification): pull the notifications, the toaster
      // shows them and refreshes the affected list.
      if (Object.values(change.changed).some((c) => c?.ShareNotification)) {
        const { useShareNotificationStore } = await import('./share-notification-store');
        void useShareNotificationStore.getState().fetch(client);
      }

      // Another participant invited this user to, changed or cancelled an
      // event (CalendarEventNotification): same pull-and-toast flow.
      if (Object.values(change.changed).some((c) => c?.CalendarEventNotification)) {
        const { useCalendarEventNotificationStore } = await import('./calendar-event-notification-store');
        void useCalendarEventNotificationStore.getState().fetch(client);
      }

      // Handle SieveScript state changes - refresh filter rules
      if (accountChanges?.SieveScript) {
        const { useFilterStore } = await import('./filter-store');
        const filterStore = useFilterStore.getState();
        if (filterStore.isSupported) {
          filterStore.fetchFilters(client).catch((err) => {
            console.error('Failed to refresh filters:', err);
          });
        }
      }
    } catch (error) {
      console.error('Failed to handle state change:', error);
      syncError = error instanceof Error ? error.message : "Failed to handle push notification";
      set({ error: syncError });
    } finally {
      syncRuns -= 1;
      if (syncError !== null) {
        void emailHooks.onSyncStateChange.emit({ state: 'error', error: syncError });
      } else if (syncRuns === 0) {
        void emailHooks.onSyncStateChange.emit({ state: 'idle' });
      }
    }
  },

  refreshCurrentMailbox: (client) => coalesceRefresh(client, 'currentMailbox', async () => {
    const { selectedMailbox, selectedKeyword } = get();
    const isCurrentView = captureEmailListView();

    // Labels span folders and can be selected without a mailbox.
    if (!selectedMailbox && !selectedKeyword) return;

    if (!selectedKeyword && selectedMailbox === VIRTUAL_SCHEDULED_MAILBOX_ID) {
      await get().fetchScheduledEmails(client);
      return;
    }

    // The rows shown before the query goes out; see removedWhileQuerying.
    const listedBeforeQuery = get().emails.map(e => e.id);

    try {
      // Get emails per page from settings
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;

      // Respect active search filters / query so that a push-triggered refresh
      // does not silently replace a filtered list with an unfiltered one.
      const { searchQuery, searchFilters, isUnifiedView, unifiedRole, crossView } = get();
      const hasFilters = !isFilterEmpty(searchFilters);

      // The unified ("All Mail") and cross-account views hold a VIRTUAL
      // selectedMailbox id (e.g. __cross_all__ / __unified_inbox__) that no real
      // folder matches. Feeding it to getEmails as an inMailbox filter returns an
      // empty page, and the merge below would then wipe the whole aggregated list
      // on every push - and any delete/star/read raises an Email state change.
      // Fan out via the same loaders the initial load and loadMore use so the
      // aggregated list survives a refresh. `mailbox` stays undefined for these
      // views; it only gates the inbox new-mail notification, which the unified
      // views don't raise.
      let result;
      let mailbox;
      let unifiedErrors: Map<string, string> | undefined;
      let syncAfterRefresh: EmailListSync | null = null;
      // How many rows the refresh re-queries from the top of the view.
      let windowSize = emailsPerPage;
      // Set when the whole loaded list was re-queried in a keyword order.
      let keepOpenThread = false;
      if (!selectedKeyword && isUnifiedView && crossView) {
        const includeGroup = useSettingsStore.getState().includeGroupInUnified;
        const built = await buildUnifiedAccountClients({ includeGroup });
        result = hasFilters
          ? await advancedSearchCrossViewEmails(built, crossView, buildJMAPFilter(searchQuery, searchFilters, undefined), emailsPerPage, 0)
          : searchQuery
            ? await searchCrossViewEmails(built, crossView, searchQuery, emailsPerPage, 0)
            : await fetchCrossViewEmails(built, crossView, emailsPerPage, 0);
        unifiedErrors = result.errors;
      } else if (!selectedKeyword && isUnifiedView && unifiedRole) {
        const includeGroup = useSettingsStore.getState().includeGroupInUnified;
        const built = await buildUnifiedAccountClients({ includeGroup });
        result = hasFilters
          ? await advancedSearchUnifiedEmails(built, unifiedRole, (mailboxId) => buildJMAPFilter(searchQuery, searchFilters, mailboxId), emailsPerPage, 0)
          : searchQuery
            ? await searchUnifiedEmails(built, unifiedRole, searchQuery, emailsPerPage, 0)
            : await fetchUnifiedEmails(built, unifiedRole, emailsPerPage, 0, getMessageListOrderFor(unifiedRole));
        unifiedErrors = result.errors;
      } else {
        // Single real mailbox (own or shared): query by its JMAP id. Refresh the
        // list without clearing it first for a smoother update experience.
        const mailboxes = resolveActionMailboxes();
        const effectiveClient = resolveActionClient(client);
        mailbox = mailboxes.find(mb => mb.id === selectedMailbox);
        const accountId = mailbox?.isShared ? mailbox.accountId : undefined;
        const jmapMailboxId = mailbox?.originalId || selectedMailbox;
        if (selectedKeyword) {
          // Match fetchEmails: tag views take precedence and query the label
          // across all folders and across the own + group accounts (#1038).
          // They cannot establish a folder delta baseline.
          // An active search narrows the tag, so carry it or the refresh
          // would silently widen the list back to the whole tag.
          const built = buildTagViewAccountClients(client);
          result = await fetchTagEmails(
            built, `$label:${selectedKeyword}`, emailsPerPage, 0, getMessageListOrderFor(null),
            hasFilters
              ? buildJMAPFilter(searchQuery, searchFilters, undefined)
              : searchQuery
                ? textFilter(searchQuery)
                : undefined,
          );
          unifiedErrors = result.errors;
        } else if (hasFilters || searchQuery) {
          // A refresh while a search is active must re-run it under the
          // search's own folder scope, which is independent of selectedMailbox.
          const { searchMailboxId } = get();
          if (isAllFoldersSearchScope(searchMailboxId)) {
            // Folder-less scope: the same own + group account fan-out the
            // search ran, so a change in a group account reaches the list (#1082).
            const built = buildTagViewAccountClients(client);
            result = await advancedSearchAcrossAccounts(
              built, buildJMAPFilter(searchQuery, searchFilters, undefined), emailsPerPage, 0,
              acrossAccountsSearchOptions(searchMailboxId),
            );
            unifiedErrors = result.errors;
          } else {
            const scopeMailbox = mailboxes.find(mb => mb.id === searchMailboxId);
            const filter = buildJMAPFilter(searchQuery, searchFilters, scopeMailbox?.originalId || searchMailboxId);
            const scopeAccountId = scopeMailbox?.isShared ? scopeMailbox.accountId : undefined;
            result = await effectiveClient.advancedSearchEmails(filter, scopeAccountId, emailsPerPage, 0);
          }
        } else {
          const order = getMessageListOrderFor(mailbox?.role);
          // A keyword order (#718) moves rows whose read/star/tag state
          // changed - possibly past the end of what is loaded - and rows from
          // beyond it up. Re-query every loaded row, not only the first page,
          // so the list stays the head of the server order. The rows kept
          // out of that order below are not part of the head.
          if (orderKeywords(order).length > 0) {
            const { emails: loaded, retainedInViewIds, unreadSection } = get();
            const inOrder = loaded.filter(e => !retainedInViewIds.has(e.id) && !unreadSection?.ids.has(e.id)).length;
            windowSize = Math.min(Math.max(emailsPerPage, inOrder), effectiveClient.getMaxObjectsInGet());
            keepOpenThread = true;
          }
          // The open category tab filters the refresh like the first load and
          // pagination, or other tabs' mail would merge into the list (#1264).
          const categoryFilter = folderListFilter(mailbox, get());
          result = await effectiveClient.getEmails(jmapMailboxId, accountId, windowSize, 0, undefined, true, categoryFilter ?? undefined, order);
          // This page is the new delta-sync baseline for the folder; the
          // search / unified paths above cannot be delta-synced, and neither
          // can a category tab's page (see fetchEmails).
          syncAfterRefresh = result.state && !categoryFilter
            ? { state: result.state, accountId: accountId ?? effectiveClient.getAccountId(), mailboxId: selectedMailbox }
            : null;
        }
      }
      if (!isCurrentView()) return;
      set({ emailListSync: syncAfterRefresh });

      // Rows that left the list while the query was out were deleted, moved
      // or filed away meanwhile, and the server may have answered before that
      // change landed. Merging them back made a mail deleted in quick
      // succession reappear until the next push (#966).
      const removedWhileQuerying = new Set(listedBeforeQuery);
      for (const email of get().emails) removedWhileQuerying.delete(email.id);
      if (removedWhileQuerying.size > 0) {
        const page = result.emails.filter(e => !removedWhileQuerying.has(e.id));
        const dropped = result.emails.length - page.length;
        result = { ...result, emails: page, total: Math.max(0, (result.total || 0) - dropped) };
      }

      const currentEmails = get().emails;
      const previousTotal = get().totalEmails;
      const insertedCount = Math.max((result.total || 0) - previousTotal, 0);

      // Only notify for genuinely new incoming mail in the Inbox.
      // Without these guards the toast/sound also fires when sending,
      // saving drafts, or moving/deleting the top message in any mailbox,
      // because all of those change the first-email id of the current view.
      // Pinned mails sit above the date order, and a configured list order
      // (#718, e.g. starred first) can put older mail on top too, so the
      // candidate is the newest non-pinned mail on the page rather than its
      // first entry (a just-arrived mail cannot be pinned yet). Deleting the
      // top message shifts in an OLDER one, which never becomes the newest.
      // Re-querying a keyword order can also move up a newer mail that was not
      // loaded yet (e.g. unread first, the newest read mail); that is only
      // new mail when the folder grew.
      const newFirst = result.emails
        .filter(e => !e.keywords?.['$pinned'])
        .reduce<Email | undefined>(
          (newest, e) => (!newest || new Date(e.receivedAt).getTime() > new Date(newest.receivedAt).getTime() ? e : newest),
          undefined,
        ) ?? result.emails[0];
      if (
        newFirst &&
        !selectedKeyword &&
        mailbox?.role === 'inbox' &&
        !currentEmails.some(e => e.id === newFirst.id) &&
        (!keepOpenThread || insertedCount > 0)
      ) {
        notifyNewInboxMail(client, mailbox, newFirst, get);
      }

      // Merge the refreshed first page with the existing loaded emails.
      // This avoids discarding already-loaded pages which would cause the
      // virtual list to shrink and then rapidly re-load (scroll bounce).
      const refreshedEmails = annotateScheduledEmails(result.emails, get().scheduledSubmissionByEmailId);

      // Build the merged list: start with the fresh first page, then append
      // existing emails beyond that page (if any), skipping duplicates. Do not
      // append the whole previous list: drafts are saved as destroy+create, so
      // the old draft can disappear from the refreshed first page and must not
      // be reintroduced from stale local state.
      let merged: Email[] = [...refreshedEmails];
      const mergedIds = new Set(refreshedEmails.map((e: Email) => e.id));
      // Derive the cutoff from the page size, not from the refreshed list's
      // length: when the folder shrank (a deletion - e.g. the draft of a just
      // sent mail), the fresh page is shorter than the stale list and a
      // length-based cutoff re-appends the deleted rows from stale local
      // state. That ghost row is how "sent mail still shows as draft"
      // reports happen (#592) - and re-sending the ghost delivers the mail
      // again.
      const appendFromIndex = Math.max(windowSize - insertedCount, 0);
      // Rows kept out of a keyword order are not part of the re-queried head
      // and are decided on below.
      const previouslyRetained = get().retainedInViewIds;
      // Nor are the Unread section's; they go back in front below, until
      // the section is loaded again. A row of it the fresh page has (read
      // since) is the page's now.
      const unreadSection = withoutReached(get().unreadSection, mergedIds);
      const sectionRows = unreadSection ? currentEmails.filter(e => unreadSection.ids.has(e.id)) : [];
      const inOrderEmails = (keepOpenThread || sectionRows.length > 0)
        ? currentEmails.filter(e => !(keepOpenThread && previouslyRetained.has(e.id)) && !unreadSection?.ids.has(e.id))
        : currentEmails;

      for (const email of inOrderEmails.slice(appendFromIndex)) {
        if (!mergedIds.has(email.id)) {
          merged.push(email);
          mergedIds.add(email.id);
        }
      }

      // Rows that left the re-queried head of a keyword order are dropped;
      // load-more brings them back where they now belong. Not the open
      // conversation's, though: every action on an email looks it up in this
      // list, so "mark as unread" on the mail just read must still find it.
      // Nor the held row, which stays where it was clicked. They stay until
      // something else is opened, and load-more does not count them.
      const held = get().listHold?.keywords;
      let retainedInViewIds: Set<string> | undefined;
      if (keepOpenThread) {
        const open = get().selectedEmail;
        const openThread = open ? threadKeyFor(open) : null;
        retainedInViewIds = new Set();
        for (const email of currentEmails) {
          if (mergedIds.has(email.id)) continue;
          if (threadKeyFor(email) !== openThread && !held?.has(email.id)) continue;
          merged.push(email);
          mergedIds.add(email.id);
          retainedInViewIds.add(email.id);
        }
      }

      // Keep rows the user just read/unstarred in the unread/starred cross view:
      // the fresh keyword-filtered page dropped them, but they should stay put
      // (their status + the counters already updated in the action) until the
      // view is re-opened. Only applies to those two views; the retain set is
      // empty otherwise.
      let retainedAddedCount = 0;
      if (retainingCrossView({ isUnifiedView, crossView })) {
        const beforeLen = merged.length;
        merged = mergeRetainedRows(currentEmails, merged, get().retainedInViewIds);
        retainedAddedCount = merged.length - beforeLen;
      }

      // The fresh order has the held row where its new read/star/tag state
      // sorts; put it back where the list shows it (the order EmailList uses).
      merged = placeHeldRows(merged, searchQuery || crossView || hasFilters ? [] : get().listOrder, held);
      if (sectionRows.length > 0) merged = [...sectionRows, ...merged];

      // Check if anything actually changed to avoid unnecessary re-renders
      const hasChanged =
        currentEmails.length !== merged.length ||
        merged.some((email, i) => {
          const curr = currentEmails[i];
          if (!curr) return true;
          return (
            curr.id !== email.id ||
            curr.threadId !== email.threadId ||
            JSON.stringify(curr.keywords) !== JSON.stringify(email.keywords)
          );
        });

      if (hasChanged) {
        // Retained rows sit beyond the server's keyword-filtered count, so add
        // them to the total; otherwise the list would claim fewer items than it
        // shows and mis-compute hasMore.
        const effectiveTotal = (result.total || 0) + retainedAddedCount;
        // hasMore should reflect whether there are still more emails beyond
        // what we have loaded, using the fresh total from the server. The
        // Unread section's rows are not part of that total.
        // A total below the page it came with is one the server did not give:
        // then only a full page tells that more may follow (#1364).
        const hasMore = (result.total || 0) >= result.emails.length
          ? merged.length - sectionRows.length < effectiveTotal
          : result.hasMore;

        // Invalidate thread email caches for threads whose composition changed
        // so expanded threads pick up new/removed emails.
        const prevThreadIds = new Set(currentEmails.map(e => threadKeyFor(e)));
        const nextThreadIds = new Set(merged.map(e => threadKeyFor(e)));
        const changedThreadIds = new Set<string>();
        for (const tid of prevThreadIds) {
          if (!nextThreadIds.has(tid)) changedThreadIds.add(tid);
        }
        for (const tid of nextThreadIds) {
          if (!prevThreadIds.has(tid)) changedThreadIds.add(tid);
        }
        // Also check threads where the set of email IDs changed
        const prevEmailsByThread = new Map<string, Set<string>>();
        for (const e of currentEmails) {
          const key = threadKeyFor(e);
          if (!prevEmailsByThread.has(key)) prevEmailsByThread.set(key, new Set());
          prevEmailsByThread.get(key)!.add(e.id);
        }
        const nextEmailsByThread = new Map<string, Set<string>>();
        for (const e of merged) {
          const key = threadKeyFor(e);
          if (!nextEmailsByThread.has(key)) nextEmailsByThread.set(key, new Set());
          nextEmailsByThread.get(key)!.add(e.id);
        }
        for (const [tid, nextIds] of nextEmailsByThread) {
          const prevIds = prevEmailsByThread.get(tid);
          if (!prevIds || prevIds.size !== nextIds.size) {
            changedThreadIds.add(tid);
          } else {
            for (const id of nextIds) {
              if (!prevIds.has(id)) { changedThreadIds.add(tid); break; }
            }
          }
        }

        set((state) => {
          const newCache = new Map(state.threadEmailsCache);
          for (const tid of changedThreadIds) {
            newCache.delete(tid);
          }
          return {
            emails: merged,
            hasMoreEmails: hasMore,
            totalEmails: effectiveTotal,
            threadEmailsCache: newCache,
            ...(unifiedErrors !== undefined ? { unifiedErrors } : {}),
            ...(retainedInViewIds ? { retainedInViewIds } : {}),
            unreadSection,
          };
        });

        // Re-fetch cross-folder thread data for any currently expanded threads
        // so they show the complete conversation (not just current-folder emails).
        const expandedNow = get().expandedThreadIds;
        if (expandedNow.size > 0) {
          const effectiveClient2 = resolveActionClient(client);
          const accountId = effectiveClient2.getAccountId();
          for (const tid of expandedNow) {
            void effectiveClient2.getThreadEmails(tid, accountId).then((fullEmails) => {
              if (fullEmails.length > 0) {
                set((state) => {
                  const c = new Map(state.threadEmailsCache);
                  c.set(tid, fullEmails);
                  return { threadEmailsCache: c };
                });
              }
            });
          }
        }

        // Fetch full thread counts in the background (non-blocking)
        void get().fetchThreadEmailCounts(client);
      } else if (retainedInViewIds) {
        set({ retainedInViewIds });
      }

      // The Unread section is loaded again too; new mail lands there.
      if (mailbox && !selectedKeyword && unreadFirstFor(mailbox, get())) {
        const loaded = await loadUnreadSection(client, mailbox, get);
        if (!isCurrentView()) return;
        const listed = new Set(get().emails.map(e => e.id));
        const newest = loaded.emails.find(e => !e.keywords?.['$pinned']);
        if (newest && !listed.has(newest.id) && loaded.total > (get().unreadSection?.total ?? 0)) {
          notifyNewInboxMail(client, mailbox, newest, get);
        }
        applyUnreadSection(get, set, selectedMailbox, loaded);
      }
    } catch (error) {
      console.error('Failed to refresh current mailbox:', error);
      // Don't set error state for background refreshes to avoid disrupting the UI
    }
  }),

  handleNewEmailNotification: (email) => {
    // Set the new email notification state
    // This can be consumed by a toast component
    set({ newEmailNotification: email });
  },

  clearNewEmailNotification: () => {
    set({ newEmailNotification: null });
  },

  // Thread expansion actions
  toggleThreadExpansion: (threadKey) => {
    const { expandedThreadIds } = get();
    const newExpandedThreadIds = new Set(expandedThreadIds);

    if (newExpandedThreadIds.has(threadKey)) {
      newExpandedThreadIds.delete(threadKey);
      cancelPendingThreadRead(threadKey);
    } else {
      newExpandedThreadIds.add(threadKey);
      // Expanding may mark the thread read; hold it before that lands.
      get().holdListRow(threadKey);
    }

    set({ expandedThreadIds: newExpandedThreadIds });
  },

  fetchThreadEmails: async (client, threadKey) => {
    const { threadEmailsCache, selectedMailbox } = get();
    const mailboxes = resolveActionMailboxes();

    // Check if we already have this thread cached
    const cachedEmails = threadEmailsCache.get(threadKey);
    if (cachedEmails && cachedEmails.length > 0) {
      return cachedEmails;
    }

    // Set loading state
    set({ isLoadingThread: threadKey });

    try {
      // Route to the thread's own account. In aggregate views `selectedMailbox`
      // is virtual, so derive the client + accountId from a list email of this
      // thread (handles shared/group accounts); otherwise fall back to the
      // selected-mailbox shared-folder logic. (#281) The key is account-scoped,
      // so this can't pick up another account's thread with the same id.
      const threadEmail = get().emails.find(e => threadKeyFor(e) === threadKey);
      const threadId = threadEmail?.threadId ?? threadIdFromKey(threadKey);
      const route = resolveThreadRoute({
        isUnifiedView: isAggregateListView(),
        ref: threadEmail,
        mailboxes,
        selectedMailbox,
      });
      let actionClient = resolveActionClient(client);
      if (route.clientAccountId) {
        actionClient = useAuthStore.getState().getClientForAccount(route.clientAccountId) ?? actionClient;
      }

      // Fetch all emails in the thread
      const emails = await actionClient.getThreadEmails(threadId, route.accountId);

      // Re-stamp the source reference so actions on thread emails resolve to the
      // right account (the fetched objects don't carry it).
      if (isAggregateListView() && threadEmail) {
        for (const e of emails) {
          e.accountId = threadEmail.accountId;
          e.accountLabel = threadEmail.accountLabel;
          e.sourceClientAccountId = threadEmail.sourceClientAccountId;
          e.sourceAccountId = threadEmail.sourceAccountId;
        }
      }

      // Update cache
      const newCache = new Map(get().threadEmailsCache);
      newCache.set(threadKey, emails);

      set({
        threadEmailsCache: newCache,
        isLoadingThread: null
      });

      return emails;
    } catch (error) {
      console.error('Failed to fetch thread emails:', error);
      set({ isLoadingThread: null });
      return [];
    }
  },

  autoMarkExpandedThreadAsRead: (client, threadKey) => {
    cancelPendingThreadRead(threadKey);
    const { markAsReadDelay } = useSettingsStore.getState();
    const cancel = scheduleAutoMarkAsRead(markAsReadDelay, () => {
      pendingThreadReads.delete(threadKey);
      // Collapsed (or the list was reset) before the delay ran out.
      if (!get().expandedThreadIds.has(threadKey)) return;
      void get().markThreadAsRead(client, threadKey);
    });
    if (markAsReadDelay > 0) pendingThreadReads.set(threadKey, cancel);
  },

  cancelAutoMarkThreadAsRead: (threadKey) => {
    cancelPendingThreadRead(threadKey);
  },

  markThreadAsRead: async (client, threadKey) => {
    const state = get();
    const threadEmails = state.threadEmailsCache.get(threadKey) ?? [];
    const mainEmails = state.emails.filter(e => threadKeyFor(e) === threadKey);

    // Combine unique emails from both sources
    const allEmailMap = new Map<string, Email>();
    for (const e of mainEmails) allEmailMap.set(e.id, e);
    for (const e of threadEmails) allEmailMap.set(e.id, e);

    const unreadIds = Array.from(allEmailMap.values())
      .filter(e => !e.keywords?.$seen)
      .map(e => e.id);

    if (unreadIds.length === 0) return;
    if (emailHooks.onBeforeEmailReadStateChange.size > 0
      && !(await emailHooks.onBeforeEmailReadStateChange.intercept({ emailIds: [...unreadIds], read: true }))) {
      return;
    }

    // Group the unread ids by the client and the JMAP account that own them.
    // Ids repeat across accounts (#847): a write without the owner's account
    // id lands in the login's own account, where the server answers notFound
    // or marks an unrelated message that happens to share the id. So a thread
    // in a shared or group folder has to name its account.
    const groups = new Map<IJMAPClient, Map<string | undefined, string[]>>();
    try {
      for (const id of unreadIds) {
        const { client: actionClient, accountId } = resolveEmailActionContext(allEmailMap.get(id)!, client);
        const byAccount = groups.get(actionClient) ?? new Map<string | undefined, string[]>();
        byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), id]);
        groups.set(actionClient, byAccount);
      }
    } catch (error) {
      // A message of a login that is gone: the thread stays unread.
      console.error('Failed to mark thread as read:', error);
      return;
    }

    // Mark all as read on the server. A message the server refused (a
    // read-only shared folder) stays unread; the others are marked.
    const writes = Array.from(groups.entries()).flatMap(([actionClient, byAccount]) =>
      Array.from(byAccount.entries()).map(([accountId, emailIds]) => ({
        emailIds,
        done: actionClient.batchMarkAsRead(emailIds, true, accountId),
      }))
    );
    const outcomes = await Promise.allSettled(writes.map(({ done }) => done));
    const refused = new Set<string>();
    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i];
      if (outcome.status === 'fulfilled') continue;
      console.error('Failed to mark thread as read:', outcome.reason);
      for (const id of jmapErrorFailedIds(outcome.reason) ?? writes[i].emailIds) refused.add(id);
    }
    const markedIds = unreadIds.filter(id => !refused.has(id));
    if (markedIds.length === 0) return;

    // Update local state
    set((state) => {
      const unreadSet = new Set(markedIds);

      const updatedEmails = state.emails.map(e =>
        unreadSet.has(e.id) ? { ...e, keywords: { ...e.keywords, $seen: true } } : e
      );

      // Update threadEmailsCache
      const newCache = new Map(state.threadEmailsCache);
      const cached = newCache.get(threadKey);
      if (cached) {
        newCache.set(threadKey, cached.map(e =>
          unreadSet.has(e.id) ? { ...e, keywords: { ...e.keywords, $seen: true } } : e
        ));
      }

      // Update mailbox unread counters in the thread's own account list (#281).
      const affectedEmails = state.emails.filter(e => unreadSet.has(e.id));
      const mailboxPatch = applyBatchMailboxCounterUpdate(state, affectedEmails, (mailbox, group) => {
        let delta = 0;
        for (const email of group as Email[]) {
          if (emailInMailbox(email, mailbox)) delta -= 1;
        }
        return delta === 0 ? mailbox : {
          ...mailbox,
          unreadEmails: Math.max(0, mailbox.unreadEmails + delta),
          unreadThreads: Math.max(0, mailbox.unreadThreads + delta),
        };
      });

      return {
        emails: updatedEmails,
        threadEmailsCache: newCache,
        ...mailboxPatch,
        selectedEmail: state.selectedEmail && unreadSet.has(state.selectedEmail.id)
          ? { ...state.selectedEmail, keywords: { ...state.selectedEmail.keywords, $seen: true } }
          : state.selectedEmail,
      };
    });
    void emailHooks.onEmailReadStateChange.emit({ emailIds: [...unreadIds], read: true });
    refillAfterKeywordChange(get, client, ['$seen']);
  },

  collapseAllThreads: () => {
    cancelPendingThreadRead();
    set({
      expandedThreadIds: new Set(),
      isLoadingThread: null
    });
  },

  updateThreadCache: (threadId, emails) => {
    const newCache = new Map(get().threadEmailsCache);
    newCache.set(threadId, emails);
    set({ threadEmailsCache: newCache });
  },

  fetchThreadEmailCounts: (client) => coalesceRefresh(client, 'threadCounts', async () => {
    const { emails } = get();
    if (emails.length === 0) return;

    // Thread ids are per-account, so ask each source account for its own
    // threads and file the counts under the account-scoped key. One client
    // answering for every id would return the ACTIVE account's unrelated
    // thread "b" for every other account's thread "b" in an aggregate view.
    const bySource = new Map<string, { ref: Email; threadIds: Set<string> }>();
    for (const e of emails) {
      if (!e.threadId) continue;
      const source = `${e.sourceClientAccountId ?? ''}/${e.sourceAccountId ?? ''}`;
      const entry = bySource.get(source) ?? { ref: e, threadIds: new Set<string>() };
      entry.threadIds.add(e.threadId);
      bySource.set(source, entry);
    }
    if (bySource.size === 0) return;

    try {
      const newCounts = new Map(get().threadEmailCounts);
      for (const { ref, threadIds } of bySource.values()) {
        const { client: sourceClient, accountId } = resolveEmailActionContext(ref, client);
        const threads = await sourceClient.getThreads([...threadIds], accountId);
        for (const thread of threads) {
          const key = threadKeyFor({
            threadId: thread.id,
            sourceClientAccountId: ref.sourceClientAccountId,
            sourceAccountId: ref.sourceAccountId,
          });
          newCounts.set(key, thread.emailIds?.length ?? 0);
        }
      }
      set({ threadEmailCounts: newCounts });
    } catch {
      // Non-critical — fall back to inbox-only counts
    }
  }),

  // Mailbox management
  createMailbox: async (client, name, parentId, accountId): Promise<boolean> => {
    try {
      // Root creation is personal unless its UI caller explicitly supplies a
      // shared/group account (the account header's context menu). Never infer
      // a root target merely from whichever mailbox happens to be selected.
      const target = parentId
        ? resolveMailboxMutationContext(client, parentId)
        : { ...resolveMailboxAccountTarget(client, accountId), mailboxId: undefined };
      if (emailHooks.onBeforeMailboxCreate.size > 0
        && !(await emailHooks.onBeforeMailboxCreate.intercept({ name, parentId: parentId ?? null }))) {
        return false;
      }
      const created = await target.client.createMailbox(name, target.mailboxId, target.accountId);
      void emailHooks.onMailboxCreate.emit({ mailboxId: created?.id ?? null, name, parentId: parentId ?? null });
      if (get().viewingAccountId) {
        await refreshMailboxesForViewingAccount(client);
      } else {
        await get().fetchMailboxes(client);
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to create folder' });
      throw error;
    }
    return true;
  },

  renameMailbox: async (client, mailboxId, name): Promise<boolean> => {
    try {
      const target = resolveMailboxMutationContext(client, mailboxId);
      if (emailHooks.onBeforeMailboxRename.size > 0
        && !(await emailHooks.onBeforeMailboxRename.intercept({ mailboxId, name }))) {
        return false;
      }
      const previousName = resolveActionMailboxes().find(mb => mb.id === mailboxId)?.name ?? null;
      await target.client.updateMailbox(target.mailboxId, { name }, target.accountId);
      void emailHooks.onMailboxRename.emit({ mailboxId, name, previousName });
      const viewingId = get().viewingAccountId;
      if (viewingId) {
        set((state) => ({
          accountMailboxes: {
            ...state.accountMailboxes,
            [viewingId]: (state.accountMailboxes[viewingId] ?? []).map(mb =>
              mb.id === mailboxId ? { ...mb, name } : mb
            ),
          },
        }));
      } else {
        set({
          mailboxes: get().mailboxes.map(mb =>
            mb.id === mailboxId ? { ...mb, name } : mb
          ),
        });
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to rename folder' });
      throw error;
    }
    return true;
  },

  deleteMailbox: async (client, mailboxId, options): Promise<boolean> => {
    try {
      const target = resolveMailboxMutationContext(client, mailboxId);
      const deletedName = resolveActionMailboxes().find(mb => mb.id === mailboxId)?.name ?? null;
      if (emailHooks.onBeforeMailboxDelete.size > 0
        && !(await emailHooks.onBeforeMailboxDelete.intercept({ mailboxId, name: deletedName }))) {
        return false;
      }
      // Only pass the options when set: the plain call keeps the two-argument
      // shape other client implementations (demo, plugins) expect.
      if (options?.removeEmails) {
        await target.client.deleteMailbox(target.mailboxId, target.accountId, options);
      } else {
        await target.client.deleteMailbox(target.mailboxId, target.accountId);
      }
      void emailHooks.onMailboxDelete.emit({ mailboxId, name: deletedName });
      const { selectedMailbox, viewingAccountId: viewingId } = get();
      if (viewingId) {
        const updatedList = (get().accountMailboxes[viewingId] ?? []).filter(mb => mb.id !== mailboxId);
        const patch: Partial<EmailStore> = {
          accountMailboxes: { ...get().accountMailboxes, [viewingId]: updatedList },
        };
        if (selectedMailbox === mailboxId) {
          const inbox = updatedList.find(mb => mb.role === 'inbox' && !mb.isShared);
          if (inbox) patch.selectedMailbox = inbox.id;
        }
        set(patch);
      } else {
        const newMailboxes = get().mailboxes.filter(mb => mb.id !== mailboxId);
        const updates: Partial<EmailStore> = { mailboxes: newMailboxes };
        if (selectedMailbox === mailboxId) {
          const inbox = newMailboxes.find(mb => mb.role === 'inbox' && !mb.isShared);
          if (inbox) updates.selectedMailbox = inbox.id;
        }
        set(updates);
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to delete folder' });
      throw error;
    }
    return true;
  },

  setMailboxRole: async (client, mailboxId, role) => {
    try {
      const target = resolveMailboxMutationContext(client, mailboxId);
      // If assigning a role, first clear that role from every other mailbox in
      // the SAME owning account. Never clear the active user's role while
      // changing a shared/group mailbox (or vice versa).
      if (role) {
        const existingMailboxes = resolveActionMailboxes().filter((mb) =>
          mb.role === role
          && mb.id !== mailboxId
          && (target.ownerAccountId ? mb.accountId === target.ownerAccountId : !mb.isShared)
        );
        for (const existing of existingMailboxes) {
          const existingTarget = resolveMailboxMutationContext(client, existing.id);
          await existingTarget.client.updateMailbox(existingTarget.mailboxId, { role: null }, existingTarget.accountId);
        }
      }
      await target.client.updateMailbox(target.mailboxId, { role }, target.accountId);
      if (get().viewingAccountId) {
        await refreshMailboxesForViewingAccount(client);
      } else {
        await get().fetchMailboxes(client);
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to update folder role' });
      throw error;
    }
  },

  reorderMailboxes: async (client, orderedIds) => {
    // Assign a 1-based sortOrder to the given sibling group in its new order.
    // sortOrder is the primary sort key (see buildMailboxTree), so this pins
    // the folders' arrangement in the sidebar and settings.
    const updates = orderedIds.map((id, idx) => ({ id, sortOrder: idx + 1 }));
    const applyLocal = (list: Mailbox[]) =>
      list.map(mb => {
        const u = updates.find(x => x.id === mb.id);
        return u ? { ...mb, sortOrder: u.sortOrder } : mb;
      });
    // Optimistic local update so the reorder is reflected immediately.
    const viewingId = get().viewingAccountId;
    if (viewingId) {
      set((state) => ({
        accountMailboxes: {
          ...state.accountMailboxes,
          [viewingId]: applyLocal(state.accountMailboxes[viewingId] ?? []),
        },
      }));
    } else {
      set({ mailboxes: applyLocal(get().mailboxes) });
    }
    try {
      for (const u of updates) {
        const target = resolveMailboxMutationContext(client, u.id);
        await target.client.updateMailbox(target.mailboxId, { sortOrder: u.sortOrder }, target.accountId);
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to reorder folders' });
      // Re-sync from server so local state doesn't drift from persisted order.
      if (viewingId) {
        await refreshMailboxesForViewingAccount(client);
      } else {
        await get().fetchMailboxes(client);
      }
      throw error;
    }
  },

  moveMailbox: async (client, mailboxId, newParentId, orderedSiblingIds) => {
    const target = resolveMailboxMutationContext(client, mailboxId);
    // The new parent may itself be a namespaced shared id; the server needs
    // the owner's bare id. Cross-account moves are not supported by JMAP.
    const parentTarget = newParentId ? resolveMailboxMutationContext(client, newParentId) : null;
    const sortUpdates = (orderedSiblingIds ?? []).map((id, idx) => ({ id, sortOrder: idx + 1 }));
    const movedSort = sortUpdates.find(u => u.id === mailboxId);

    // Optimistic local update so the folder appears under its new parent
    // immediately; the fetch below re-syncs with the server's view.
    const applyLocal = (list: Mailbox[]) =>
      list.map(mb => {
        const patch: Partial<Mailbox> = {};
        if (mb.id === mailboxId) patch.parentId = newParentId ?? undefined;
        const u = sortUpdates.find(x => x.id === mb.id);
        if (u) patch.sortOrder = u.sortOrder;
        return Object.keys(patch).length > 0 ? { ...mb, ...patch } : mb;
      });
    const viewingId = get().viewingAccountId;
    if (viewingId) {
      set((state) => ({
        accountMailboxes: {
          ...state.accountMailboxes,
          [viewingId]: applyLocal(state.accountMailboxes[viewingId] ?? []),
        },
      }));
    } else {
      set({ mailboxes: applyLocal(get().mailboxes) });
    }

    try {
      await target.client.updateMailbox(
        target.mailboxId,
        { parentId: parentTarget ? parentTarget.mailboxId : null, ...(movedSort ? { sortOrder: movedSort.sortOrder } : {}) },
        target.accountId,
      );
      for (const u of sortUpdates) {
        if (u.id === mailboxId) continue;
        const siblingTarget = resolveMailboxMutationContext(client, u.id);
        await siblingTarget.client.updateMailbox(siblingTarget.mailboxId, { sortOrder: u.sortOrder }, siblingTarget.accountId);
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to move folder' });
      // Re-sync from server so local state doesn't drift from the real hierarchy.
      if (viewingId) {
        await refreshMailboxesForViewingAccount(client);
      } else {
        await get().fetchMailboxes(client);
      }
      throw error;
    }
    // Reparenting changes the hierarchy, so always confirm against the server
    // rather than trusting the optimistic patch (GitHub #855).
    if (viewingId) {
      await refreshMailboxesForViewingAccount(client);
    } else {
      await get().fetchMailboxes(client);
    }
  },

  moveMailboxes: async (client, mailboxIds, newParentId) => {
    // One Mailbox/set per owning account instead of one request per folder,
    // so moving a hundred folders under a new parent stays quick (#1173).
    const parentTarget = newParentId ? resolveMailboxMutationContext(client, newParentId) : null;
    const groups: Array<{
      client: IJMAPClient;
      accountId: string | undefined;
      updates: Record<string, { parentId: string | null }>;
      storeIds: Record<string, string>;
    }> = [];
    for (const id of mailboxIds) {
      const target = resolveMailboxMutationContext(client, id);
      let group = groups.find(g => g.client === target.client && g.accountId === target.accountId);
      if (!group) {
        group = { client: target.client, accountId: target.accountId, updates: {}, storeIds: {} };
        groups.push(group);
      }
      group.updates[target.mailboxId] = { parentId: parentTarget ? parentTarget.mailboxId : null };
      group.storeIds[target.mailboxId] = id;
    }

    const moving = new Set(mailboxIds);
    const applyLocal = (list: Mailbox[]) =>
      list.map(mb => (moving.has(mb.id) ? { ...mb, parentId: newParentId ?? undefined } : mb));
    const viewingId = get().viewingAccountId;
    if (viewingId) {
      set((state) => ({
        accountMailboxes: {
          ...state.accountMailboxes,
          [viewingId]: applyLocal(state.accountMailboxes[viewingId] ?? []),
        },
      }));
    } else {
      set({ mailboxes: applyLocal(get().mailboxes) });
    }

    const failed: string[] = [];
    try {
      for (const group of groups) {
        const refused = await group.client.updateMailboxes(group.updates, group.accountId);
        for (const bareId of Object.keys(refused)) {
          failed.push(group.storeIds[bareId] ?? bareId);
        }
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to move folders' });
      throw error;
    } finally {
      // Refused folders kept their old parent, so the optimistic patch is
      // wrong for them; re-sync in every case.
      if (viewingId) {
        await refreshMailboxesForViewingAccount(client);
      } else {
        await get().fetchMailboxes(client);
      }
    }
    return failed;
  },

  emptyMailbox: async (client, mailboxId): Promise<boolean> => {
    const emptied = resolveActionMailboxes().find(mb => mb.id === mailboxId);
    if (emailHooks.onBeforeMailboxEmpty.size > 0
      && !(await emailHooks.onBeforeMailboxEmpty.intercept({ mailboxId, role: emptied?.role ?? null }))) {
      return false;
    }
    try {
      set({ isLoading: true, error: null });
      const mailboxes = resolveActionMailboxes();
      const mailbox = mailboxes.find(mb => mb.id === mailboxId);
      const accountId = mailbox?.isShared ? mailbox.accountId : undefined;
      const jmapMailboxId = mailbox?.originalId || mailboxId;

      let trashMailbox: Mailbox | undefined;
      let markAsRead = false;
      if (mailbox && emptyFolderMovesToTrash(mailbox)) {
        trashMailbox = findTrashMailbox(mailboxes, { accountId });
        // The user asked to move to trash, not permanently delete.
        if (!trashMailbox) throw new Error('Trash mailbox not found - cannot move emails to trash');
        markAsRead = useSettingsStore.getState().deleteAction === 'trash-and-read';
        await resolveActionClient(client).moveMailboxContents(
          jmapMailboxId,
          trashMailbox.originalId || trashMailbox.id,
          accountId,
          markAsRead,
        );
      } else {
        await resolveActionClient(client).emptyMailbox(jmapMailboxId, accountId);
      }

      // Clear emails from local state if we're viewing this mailbox
      const currentMailbox = get().selectedMailbox;
      if (currentMailbox === mailboxId) {
        set({ emails: [], selectedEmail: null });
      }

      const updateCounters = (mb: Mailbox): Mailbox => {
        if (mb.id === mailboxId) {
          return { ...mb, totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0 };
        }
        if (mailbox && mb.id === trashMailbox?.id) {
          return {
            ...mb,
            totalEmails: mb.totalEmails + mailbox.totalEmails,
            unreadEmails: mb.unreadEmails + (markAsRead ? 0 : mailbox.unreadEmails),
            totalThreads: mb.totalThreads + mailbox.totalThreads,
            unreadThreads: mb.unreadThreads + (markAsRead ? 0 : mailbox.unreadThreads),
          };
        }
        return mb;
      };

      const viewingId = get().viewingAccountId;
      if (viewingId) {
        set((state) => ({
          accountMailboxes: {
            ...state.accountMailboxes,
            [viewingId]: (state.accountMailboxes[viewingId] ?? []).map(updateCounters),
          },
        }));
      } else {
        set({ mailboxes: get().mailboxes.map(updateCounters) });
      }
      set({ isLoading: false });
      void emailHooks.onMailboxEmpty.emit({ mailboxId, role: mailbox?.role ?? null, count: mailbox?.totalEmails ?? 0 });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to empty folder',
        isLoading: false,
      });
      throw error;
    }
    return true;
  },

  markAllMailboxesAsRead: async (client) => {
    return markReadAskingPlugins(client, {}, undefined, (actionClient) => actionClient.markAllAsRead());
  },

  markMailboxAsRead: async (client, mailboxId) => {
    try {
      const mailbox = resolveActionMailboxes().find(mb => mb.id === mailboxId);
      const accountId = mailbox?.isShared ? mailbox.accountId : undefined;
      const jmapMailboxId = mailbox?.originalId || mailboxId;

      const count = await markReadAskingPlugins(
        resolveActionClient(client), { inMailbox: jmapMailboxId }, accountId,
        (actionClient) => actionClient.markMailboxAsRead(jmapMailboxId, accountId),
      );
      if (count === null) return null;

      // Update local state: mark all emails currently visible in this mailbox as read,
      // and zero-out the mailbox unread counter.
      set((state) => ({
        emails: state.emails.map(e =>
          e.mailboxIds && e.mailboxIds[mailboxId]
            ? { ...e, keywords: { ...e.keywords, $seen: true } }
            : e
        ),
        selectedEmail: state.selectedEmail && state.selectedEmail.mailboxIds?.[mailboxId]
          ? { ...state.selectedEmail, keywords: { ...state.selectedEmail.keywords, $seen: true } }
          : state.selectedEmail,
        mailboxes: state.mailboxes.map(mb =>
          mb.id === mailboxId
            ? { ...mb, unreadEmails: 0, unreadThreads: 0 }
            : mb
        ),
      }));

      // Tag counts are refetched here rather than adjusted with a local delta
      // (as markAsRead/batchMarkAsRead do). This is a server-side bulk operation
      // over the *whole* mailbox, so it also marks emails that were never loaded
      // into `state.emails` - a local delta would only see the loaded page and
      // would leave the tag counts drifting high. Fire-and-forget: the folder
      // counters above already update instantly.
      void get().fetchTagCounts(client);

      return count;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to mark folder as read' });
      throw error;
    }
  },

  // Unified mailbox operations
  fetchUnifiedEmails: async (accounts, role) => {
    const token = get().viewToken + 1;
    set({
      isLoading: true,
      error: null,
      isUnifiedView: true,
      unifiedRole: role,
      crossView: null,
      selectedKeyword: null,
      retainedInViewIds: new Set(),
      listHold: null,
      viewToken: token,
    });
    try {
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;
      const order = getMessageListOrderFor(role);
      const result = await fetchUnifiedEmails(accounts, role, emailsPerPage, 0, order);
      // The user may have navigated to a different mailbox/keyword/unified view
      // while this was in flight — don't let a stale response overwrite it.
      if (get().viewToken !== token) return;
      set({
        emails: result.emails,
        hasMoreEmails: result.hasMore,
        totalEmails: result.total,
        listOrder: order,
        listKeepsServerTextOrder: false,
        isLoading: false,
        unifiedErrors: result.errors,
      });
    } catch (error) {
      if (get().viewToken !== token) return;
      console.error('Failed to fetch unified emails:', error);
      set({
        error: error instanceof Error ? error.message : "Failed to fetch unified emails",
        isLoading: false,
        emails: [],
        hasMoreEmails: false,
        totalEmails: 0,
      });
    }
  },

  loadMoreUnifiedEmails: async (accounts) => {
    const { isLoadingMore, hasMoreEmails, emails, unifiedRole } = get();
    if (isLoadingMore || !hasMoreEmails || !unifiedRole) return;

    set({ isLoadingMore: true, error: null });
    try {
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;
      const position = positionsByAccount(emails);
      const result = await fetchUnifiedEmails(accounts, unifiedRole, emailsPerPage, position, getMessageListOrderFor(unifiedRole));

      const currentEmails = get().emails;
      const existingIds = new Set(currentEmails.map(e => e.id));
      const newEmails = result.emails.filter(e => !existingIds.has(e.id));

      set({
        emails: [...currentEmails, ...newEmails],
        hasMoreEmails: result.hasMore,
        totalEmails: result.total,
        isLoadingMore: false,
        unifiedErrors: result.errors,
      });
    } catch (error) {
      console.error('Failed to load more unified emails:', error);
      set({
        error: error instanceof Error ? error.message : "Failed to load more unified emails",
        isLoadingMore: false,
      });
    }
  },

  refreshUnifiedCounts: async (accounts) => {
    try {
      // Store the scope and project live counters over it. The badges then track
      // the live mailbox lists via the store subscription (below), so subsequent
      // optimistic mutations update them without another build/fetch.
      set((state) => {
        const next = { ...state, unifiedScope: accounts };
        return { unifiedScope: accounts, ...projectUnifiedCounts(next) };
      });
    } catch (error) {
      console.error('Failed to refresh unified counts:', error);
    }
  },

  fetchCrossView: async (accounts, view) => {
    const token = get().viewToken + 1;
    set({
      isLoading: true,
      error: null,
      isUnifiedView: true,
      unifiedRole: null,
      crossView: view,
      selectedKeyword: null,
      retainedInViewIds: new Set(),
      listHold: null,
      viewToken: token,
    });
    try {
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;
      const result = await fetchCrossViewEmails(accounts, view, emailsPerPage, 0);
      // The user may have navigated to a different mailbox/keyword/unified view
      // while this was in flight — don't let a stale response overwrite it.
      if (get().viewToken !== token) return;
      set({
        emails: result.emails,
        hasMoreEmails: result.hasMore,
        totalEmails: result.total,
        isLoading: false,
        unifiedErrors: result.errors,
      });
    } catch (error) {
      if (get().viewToken !== token) return;
      console.error('Failed to fetch cross-account view:', error);
      set({
        error: error instanceof Error ? error.message : "Failed to fetch cross-account view",
        isLoading: false,
        emails: [],
        hasMoreEmails: false,
        totalEmails: 0,
      });
    }
  },

  refreshCrossCounts: (accounts) => {
    try {
      set((state) => {
        const next = { ...state, unifiedScope: accounts };
        return { unifiedScope: accounts, ...projectUnifiedCounts(next) };
      });
    } catch (error) {
      console.error('Failed to refresh cross-account counts:', error);
    }
  },

  exitUnifiedView: () => {
    set(state => ({
      isUnifiedView: false,
      unifiedRole: null,
      crossView: null,
      unifiedErrors: new Map(),
      retainedInViewIds: new Set(),
      listHold: null,
      viewToken: state.viewToken + 1,
    }));
  },

  setScheduledView: (isScheduledView, accountScope = null) => set(state => {
    const leavingScheduled = !isScheduledView && state.selectedMailbox === VIRTUAL_SCHEDULED_MAILBOX_ID;
    return {
      isScheduledView,
      scheduledAccountScope: isScheduledView ? accountScope : null,
      selectedMailbox: isScheduledView ? VIRTUAL_SCHEDULED_MAILBOX_ID : leavingScheduled ? "" : state.selectedMailbox,
      selectedEmail: leavingScheduled ? null : state.selectedEmail,
      selectedEmailKeys: leavingScheduled ? new Set<string>() : state.selectedEmailKeys,
      // Search is unavailable in the scheduled view (the input is disabled there).
      // Reset any active search when entering it so a stale query can't linger or
      // re-run when the user leaves again.
      searchQuery: isScheduledView ? "" : state.searchQuery,
      searchFilters: isScheduledView ? { ...DEFAULT_SEARCH_FILTERS } : state.searchFilters,
      searchMailboxId: isScheduledView ? "" : state.searchMailboxId,
      searchScopeFollowsFolder: isScheduledView ? false : state.searchScopeFollowsFolder,
    };
  }),
  clearPendingUndoSend: () => set({ pendingUndoSend: null }),

  fetchScheduledEmails: async (client) => {
    set({ isLoadingScheduled: true, error: null });
    try {
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;
      const result = await client.getScheduledEmails(emailsPerPage, 0);
      result.emails = await emailHooks.onEmailsFetched.transform(result.emails);
      const scheduledEmailIds = new Set(result.emails.map(email => email.id));
      const scheduledSubmissionByEmailId = scheduledSubmissionMap(client, result.emails);
      const pendingUndoSend = get().pendingUndoSend;
      set({
        scheduledEmails: result.emails,
        scheduledEmailIds,
        scheduledSubmissionByEmailId,
        scheduledTotal: result.total,
        scheduledTotalByAccount: result.totalByAccount ?? {},
        scheduledHasMore: result.hasMore,
        scheduledNextPosition: result.nextPosition,
        isLoadingScheduled: false,
        pendingUndoSend: shouldClearPendingUndoSend(pendingUndoSend, result.emails) ? null : pendingUndoSend,
      });
    } catch (error) {
      console.error('Failed to fetch scheduled emails:', error);
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch scheduled emails',
        scheduledEmails: [],
        scheduledEmailIds: new Set(),
        scheduledSubmissionByEmailId: new Map(),
        scheduledTotal: 0,
        scheduledHasMore: false,
        scheduledNextPosition: 0,
        isLoadingScheduled: false,
      });
    }
  },

  loadMoreScheduledEmails: async (client) => {
    const { isLoadingScheduled, scheduledHasMore, scheduledEmails, scheduledNextPosition } = get();
    if (isLoadingScheduled || !scheduledHasMore) return;
    set({ isLoadingScheduled: true, error: null });
    try {
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;
      const result = await client.getScheduledEmails(emailsPerPage, scheduledNextPosition);
      result.emails = await emailHooks.onEmailsFetched.transform(result.emails);
      const merged = [...scheduledEmails, ...result.emails.filter(email => !scheduledEmails.some(existing => isSameScheduledSend(existing, email)))];
      const pendingUndoSend = get().pendingUndoSend;
      set({
        scheduledEmails: merged,
        scheduledEmailIds: new Set(merged.map(email => email.id)),
        scheduledSubmissionByEmailId: scheduledSubmissionMap(client, merged),
        scheduledTotal: result.total,
        scheduledTotalByAccount: result.totalByAccount ?? {},
        scheduledHasMore: result.hasMore,
        scheduledNextPosition: result.nextPosition,
        isLoadingScheduled: false,
        pendingUndoSend: shouldClearPendingUndoSend(pendingUndoSend, merged) ? null : pendingUndoSend,
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to load scheduled emails', isLoadingScheduled: false });
    }
  },

  refreshScheduledMetadata: async (client) => {
    // This runs at startup, after scheduled sends and undo, and whenever
    // EmailSubmission state changes - the moments submission records pile up
    // or turn prunable. The client throttles the prune per account; the list
    // doesn't depend on it, so it isn't awaited.
    void client.pruneEmailSubmissions();
    try {
      const emailsPerPage = useSettingsStore.getState().emailsPerPage;
      const allEmails: ScheduledEmail[] = [];
      let position = 0;
      let hasMore = true;
      let total = 0;
      let totalByAccount: Record<string, number> = {};
      while (hasMore) {
        const page = await client.getScheduledEmails(emailsPerPage, position);
        allEmails.push(...page.emails.filter(email => !allEmails.some(existing => isSameScheduledSend(existing, email))));
        total = page.total;
        totalByAccount = page.totalByAccount ?? totalByAccount;
        hasMore = page.hasMore && page.nextPosition > position;
        position = page.nextPosition;
      }
      const pendingUndoSend = get().pendingUndoSend;
      const scheduledSubmissionByEmailId = scheduledSubmissionMap(client, allEmails);
      set({
        scheduledEmails: get().isScheduledView ? allEmails : get().scheduledEmails,
        scheduledEmailIds: new Set(allEmails.map(email => email.id)),
        scheduledSubmissionByEmailId,
        // Re-annotate the visible list: this refresh runs concurrently with
        // the initial fetchEmails, so rows fetched before the metadata landed
        // still get their scheduled badges.
        emails: annotateScheduledEmails(get().emails, scheduledSubmissionByEmailId),
        scheduledTotal: total,
        scheduledTotalByAccount: totalByAccount,
        scheduledHasMore: false,
        scheduledNextPosition: position,
        pendingUndoSend: shouldClearPendingUndoSend(pendingUndoSend, allEmails) ? null : pendingUndoSend,
      });
    } catch (error) {
      console.error('Failed to refresh scheduled metadata:', error);
    }
  },

  cancelScheduledEmail: async (client, submissionId, emailId) => {
    const owner = get().scheduledEmails.find(email => email.emailSubmissionId === submissionId);
    await client.cancelEmailSubmission(submissionId, owner?.scheduledAccountId);
    if (emailId) {
      // The message lives beside its submission, not always in the own account.
      await client.deleteEmail(emailId, owner?.scheduledAccountId);
      set(state => ({
        selectedEmail: state.selectedEmail?.id === emailId ? null : state.selectedEmail,
        selectedEmailKeys: dropFromSelection(state, e => e.id === emailId),
      }));
    }
    if (get().pendingUndoSend?.submissionId === submissionId) {
      set({ pendingUndoSend: null });
    }
    await get().fetchScheduledEmails(client);
  },

  cancelScheduledEmailForEdit: async (client, email) => {
    const submissionId = email.emailSubmissionId;
    if (!submissionId) return null;
    // The message lives beside its submission (see getScheduledEmails).
    const accountId = email.scheduledAccountId;
    await client.cancelEmailSubmission(submissionId, accountId);
    if (get().pendingUndoSend?.submissionId === submissionId) {
      set({ pendingUndoSend: null });
    }
    // Nothing goes out any more; a failure from here on is not a failed cancel.
    try {
      if (email.isSmimeScheduled) {
        await client.deleteEmail(email.id, accountId);
        set(state => ({
          selectedEmail: state.selectedEmail?.id === email.id ? null : state.selectedEmail,
          selectedEmailKeys: dropFromSelection(state, e => e.id === email.id),
        }));
      } else {
        await restoreSentToDraft(client, get().mailboxes, email.id, accountId);
      }
    } catch (error) {
      void get().fetchScheduledEmails(client);
      throw new SendCancelledCleanupError(email.isSmimeScheduled ? 'remove' : 'restore', error);
    }
    await get().fetchScheduledEmails(client);
    if (email.isSmimeScheduled) return null;
    // Back in Drafts either way; the caller opens it when it can.
    return client.getEmail(email.id, accountId).catch((error) => {
      console.error('Failed to load the restored draft:', error);
      return null;
    });
  },

  rescheduleScheduledEmail: async (client, submissionId, emailId, identityId, delayedUntil, accountId) => {
    let result: SendEmailResult | undefined;
    const inAccount = (candidate: string | undefined) => !accountId || !candidate || candidate === accountId;
    try {
      const owner = get().scheduledEmails.find(email => email.emailSubmissionId === submissionId && inAccount(email.scheduledAccountId));
      result = await client.rescheduleEmailSubmission(submissionId, emailId, identityId, delayedUntil, accountId ?? owner?.scheduledAccountId);
      const pendingUndoSend = get().pendingUndoSend;
      if (pendingUndoSend?.submissionId === submissionId && inAccount(pendingUndoSend.submissionAccountId)) {
        set({ pendingUndoSend: { ...pendingUndoSend, submissionId: result.emailSubmissionId || submissionId, sendAt: result.sendAt || delayedUntil } });
      }
      return result;
    } catch (error) {
      // The original was put back under a new id; Undo has to cancel that one.
      if (error instanceof RescheduleRestoredError) {
        const pendingUndoSend = get().pendingUndoSend;
        if (pendingUndoSend?.submissionId === submissionId && inAccount(pendingUndoSend.submissionAccountId)) {
          set({ pendingUndoSend: { ...pendingUndoSend, submissionId: error.restoredSubmissionId, sendAt: error.restoredSendAt || pendingUndoSend.sendAt } });
        }
      }
      throw error;
    } finally {
      await get().fetchScheduledEmails(client);
      if (result && get().selectedEmail?.id === emailId) {
        const refreshed = get().scheduledEmails.find(email => email.id === emailId && inAccount(email.scheduledAccountId));
        set(state => ({
          selectedEmail: refreshed || (state.selectedEmail ? {
            ...state.selectedEmail,
            emailSubmissionId: result?.emailSubmissionId || submissionId,
            scheduledSendAt: result?.sendAt || delayedUntil,
            scheduledIdentityId: identityId,
            scheduledUndoStatus: 'pending' as const,
            isScheduled: true,
          } : state.selectedEmail),
        }));
      }
    }
  },

  cancelUndoSend: async (client, pending) => {
    // A submission refers to an Email of its own account, so the message is
    // where the submission is: in the group or shared account when it was
    // sent from that account's identity.
    const accountId = pending.submissionAccountId;
    await client.cancelEmailSubmission(pending.submissionId, accountId);
    // Nothing goes out any more. A failure from here on must not read as a
    // failed undo, which would tell the user the mail may still leave.
    set({ pendingUndoSend: null });
    try {
      if (pending.emailId && pending.isSmime) {
        await client.deleteEmail(pending.emailId, accountId);
        set(state => ({
          selectedEmail: state.selectedEmail?.id === pending.emailId ? null : state.selectedEmail,
          selectedEmailKeys: dropFromSelection(state, e => e.id === pending.emailId),
        }));
      } else if (pending.emailId) {
        await restoreSentToDraft(client, get().mailboxes, pending.emailId, accountId);
      }
    } catch (error) {
      void get().refreshScheduledMetadata(client);
      throw new SendCancelledCleanupError(pending.isSmime ? 'remove' : 'restore', error);
    }
    await get().refreshScheduledMetadata(client);
    if (!pending.emailId || pending.isSmime) return null;
    // Back in Drafts either way; the caller opens it when it can.
    return client.getEmail(pending.emailId, accountId).catch((error) => {
      console.error('Failed to load the restored draft:', error);
      return null;
    });
  },

  loadMockData: () => {
    const mockEmails: Email[] = [
      {
        id: "1",
        threadId: "thread-1",
        mailboxIds: { inbox: true },
        keywords: { $seen: false },
        size: 1024,
        receivedAt: new Date().toISOString(),
        from: [{ name: "GitHub", email: "notifications@github.com" }],
        to: [{ email: "you@example.com" }],
        subject: "[bulwark-webmail] New pull request #42: Add OAuth2 module",
        preview: "dependabot[bot] opened a pull request in bulwarkmail/webmail. This PR adds a comprehensive authentication module with OAuth2 PKCE support...",
        hasAttachment: false,
      },
      {
        id: "2",
        threadId: "thread-2",
        mailboxIds: { inbox: true },
        keywords: { $seen: true, $flagged: true },
        size: 512,
        receivedAt: new Date(Date.now() - 3600000).toISOString(),
        from: [{ name: "Emily Chen", email: "emily.chen@gmail.com" }],
        to: [{ email: "you@example.com" }],
        subject: "Re: Dashboard Redesign v2 - feedback",
        preview: "Hey! I just pushed the updated mockups to Figma. I incorporated all the feedback from last week's meeting. Let me know what you think about the new nav...",
        hasAttachment: true,
      },
      {
        id: "3",
        threadId: "thread-3",
        mailboxIds: { inbox: true },
        keywords: { $seen: false },
        size: 2048,
        receivedAt: new Date(Date.now() - 7200000).toISOString(),
        from: [{ name: "Slack", email: "notifications@slack.com" }],
        to: [{ email: "you@example.com" }],
        subject: "3 new messages in #engineering",
        preview: "Marcus: Hey team, the CI pipeline is green again. Sarah: Great, merging the feature branch now. Alex: Let's do a quick sync at 3 PM...",
        hasAttachment: false,
      },
      {
        id: "4",
        threadId: "thread-4",
        mailboxIds: { inbox: true },
        keywords: { $seen: true },
        size: 768,
        receivedAt: new Date(Date.now() - 14400000).toISOString(),
        from: [{ name: "Marcus Rivera", email: "marcus.rivera@outlook.com" }],
        to: [{ email: "you@example.com" }],
        subject: "Quick question about the API rate limits",
        preview: "Hey, I was looking at the JMAP spec and I'm not sure how we should handle rate limiting on the server side. Do you have any thoughts on...",
        hasAttachment: false,
      },
      {
        id: "5",
        threadId: "thread-5",
        mailboxIds: { inbox: true },
        keywords: { $seen: true },
        size: 1536,
        receivedAt: new Date(Date.now() - 86400000).toISOString(),
        from: [{ name: "Stripe", email: "receipts@stripe.com" }],
        to: [{ email: "you@example.com" }],
        subject: "Your invoice from Acme Corp is ready",
        preview: "Invoice #INV-2026-0312 for $49.00 has been paid. Thank you for your payment. View your receipt and download your invoice...",
        hasAttachment: true,
      },
      {
        id: "6",
        threadId: "thread-6",
        mailboxIds: { inbox: true },
        keywords: { $seen: false },
        size: 3072,
        receivedAt: new Date(Date.now() - 108000000).toISOString(),
        from: [{ name: "Sarah Kim", email: "sarah.kim@proton.me" }],
        to: [{ email: "you@example.com" }],
        subject: "Conference talk proposal - need your review",
        preview: "I'm submitting a talk to ReactConf about our email client architecture. Could you take a look at my abstract before the deadline on Friday?...",
        hasAttachment: true,
      },
      {
        id: "7",
        threadId: "thread-7",
        mailboxIds: { inbox: true },
        keywords: { $seen: true, $flagged: true },
        size: 4096,
        receivedAt: new Date(Date.now() - 172800000).toISOString(),
        from: [{ name: "Vercel", email: "notifications@vercel.com" }],
        to: [{ email: "you@example.com" }],
        subject: "Deployment successful: bulwark-webmail \u2192 Production",
        preview: "Your project bulwark-webmail has been deployed to production. Build completed in 47s. All checks passed. Preview: https://bulwark-webmail.vercel.app...",
        hasAttachment: false,
      },
      {
        id: "8",
        threadId: "thread-8",
        mailboxIds: { inbox: true },
        keywords: { $seen: true },
        size: 2560,
        receivedAt: new Date(Date.now() - 259200000).toISOString(),
        from: [{ name: "Alex Petrov", email: "alex.petrov@fastmail.com" }],
        to: [{ email: "you@example.com" }],
        subject: "Meeting notes from yesterday's standup",
        preview: "Here are the action items from yesterday. 1) Finish the drag-and-drop implementation by Wednesday. 2) Review the accessibility audit results...",
        hasAttachment: false,
      },
      {
        id: "9",
        threadId: "thread-9",
        mailboxIds: { inbox: true },
        keywords: { $seen: false },
        size: 1280,
        receivedAt: new Date(Date.now() - 345600000).toISOString(),
        from: [{ name: "Linear", email: "notifications@linear.app" }],
        to: [{ email: "you@example.com" }],
        subject: "ENG-384: Implement email threading view \u2014 moved to In Progress",
        preview: "Alice Johnson moved ENG-384 to In Progress. This issue covers implementing the conversation thread view for the email client...",
        hasAttachment: false,
      },
      {
        id: "10",
        threadId: "thread-10",
        mailboxIds: { inbox: true },
        keywords: { $seen: true },
        size: 896,
        receivedAt: new Date(Date.now() - 432000000).toISOString(),
        from: [{ name: "Priya Sharma", email: "priya.sharma@icloud.com" }],
        to: [{ email: "you@example.com" }],
        subject: "Re: Onboarding docs for new contributors",
        preview: "Thanks for putting this together! I added a section on setting up the dev environment. Also linked the architecture diagram from our wiki...",
        hasAttachment: false,
      },
      {
        id: "11",
        threadId: "thread-11",
        mailboxIds: { inbox: true },
        keywords: { $seen: true },
        size: 5120,
        receivedAt: new Date(Date.now() - 518400000).toISOString(),
        from: [{ name: "LaunchWeekly", email: "newsletter@launchweekly.com" }],
        to: [{ email: "you@example.com" }],
        subject: "\uD83D\uDE80 This week in tech: AI agents, new frameworks, and more",
        preview: "Happy Monday! Here's your weekly roundup of the most interesting launches, open-source projects, and developer tools you might have missed...",
        hasAttachment: false,
      },
    ];

    const mockMailboxes: Mailbox[] = [
      {
        id: "inbox",
        name: "Inbox",
        role: "inbox",
        sortOrder: 1,
        totalEmails: 11,
        unreadEmails: 4,
        totalThreads: 11,
        unreadThreads: 4,
        myRights: {
          mayReadItems: true,
          mayAddItems: true,
          mayRemoveItems: true,
          maySetSeen: true,
          maySetKeywords: true,
          mayCreateChild: true,
          mayRename: true,
          mayDelete: true,
          maySubmit: true,
        },
        isSubscribed: true,
      },
    ];

    set({
      emails: mockEmails,
      mailboxes: mockMailboxes,
    });
  },
}));

// Plugin hooks that follow a piece of store state rather than one action, so
// every path that changes it (clicks, keyboard, a batch action clearing the
// selection, an account switch) fires them once.
useEmailStore.subscribe((state, prev) => {
  if (state.selectedEmailKeys !== prev.selectedEmailKeys && emailHooks.onEmailSelectionChange.size > 0) {
    const changed = state.selectedEmailKeys.size !== prev.selectedEmailKeys.size
      || [...state.selectedEmailKeys].some(key => !prev.selectedEmailKeys.has(key));
    if (changed) void emailHooks.onEmailSelectionChange.emit({ emailIds: idsFromSelectionKeys(state.selectedEmailKeys) });
  }
  if (state.selectedMailbox !== prev.selectedMailbox && state.selectedMailbox && emailHooks.onMailboxChange.size > 0) {
    const mailbox = mailboxesInView(state).find(mb => mb.id === state.selectedMailbox);
    void emailHooks.onMailboxChange.emit({
      mailboxId: state.selectedMailbox,
      role: mailbox?.role ?? (state.isUnifiedView ? state.unifiedRole : null) ?? null,
      previousMailboxId: prev.selectedMailbox || null,
    });
  }
  if (state.quota && state.quota !== prev.quota
    && (state.quota.used !== prev.quota?.used || state.quota.total !== prev.quota?.total)) {
    void emailHooks.onQuotaChange.emit(quotaToView(state.quota));
  }
  if (state.isPushConnected !== prev.isPushConnected) {
    void emailHooks.onPushConnectionChange.emit({ connected: state.isPushConnected });
  }
});

// Keep the unified-section badges in lockstep with the live per-account mailbox
// lists. Whenever `mailboxes`, `accountMailboxes`, or the unified scope change -
// i.e. after any optimistic delete/move/markRead patch or a push-driven mailbox
// refresh - re-project the badges from that single source of truth. The guard
// short-circuits on every unrelated state change (emails, loading flags, …) by
// reference equality, and our own counter writes don't re-enter the projection
// because they leave the three watched lists untouched (no loop). (#281)
useEmailStore.subscribe((state, prev) => {
  if (
    state.mailboxes === prev.mailboxes &&
    state.accountMailboxes === prev.accountMailboxes &&
    state.unifiedScope === prev.unifiedScope
  ) {
    return;
  }
  if (state.unifiedScope.length === 0) return;
  const projected = projectUnifiedCounts(state);
  const sameCross = projected.crossUnreadCount === state.crossUnreadCount;
  const sameUnified =
    projected.unifiedCounts.length === state.unifiedCounts.length &&
    projected.unifiedCounts.every((c, i) => {
      const cur = state.unifiedCounts[i];
      return cur && cur.role === c.role && cur.unreadEmails === c.unreadEmails && cur.totalEmails === c.totalEmails;
    });
  if (sameCross && sameUnified) return;
  useEmailStore.setState(projected);
});

// Opening a message holds its list row (see listHold), however it was opened:
// a click, next/previous, or the pick after a delete. This runs before the
// message is marked read, so the hold records it unread.
useEmailStore.subscribe((state, prev) => {
  const email = state.selectedEmail;
  if (!email || email.id === prev.selectedEmail?.id) return;
  state.holdListRow(listRowKey(email, state.isScheduledView));
});

// A folder's remembered list follows what happens to it on screen - a message
// read, archived or deleted here is shown that way when the folder is opened
// again, rather than as it was when the folder was loaded.
useEmailStore.subscribe((state, prev) => {
  if (state.mailboxes.length === 0 && state.emails.length === 0) {
    shownFolderList = null;
    forgetFolderLists();
    return;
  }
  if (state.emails === prev.emails || !shownFolderList) return;
  if (
    state.selectedMailbox !== shownFolderList.mailboxId ||
    state.searchQuery ||
    !isFilterEmpty(state.searchFilters) ||
    state.selectedKeyword ||
    state.isUnifiedView ||
    state.isScheduledView
  ) {
    shownFolderList = null;
    return;
  }
  rememberFolderList(shownFolderList.key, folderListState(state), shownFolderList.pageSize);
});

// ---------------------------------------------------------------------------
// Boot snapshot: persist the mailbox list and the first page of the current
// list so a returning visit paints rows the moment auth resolves, instead of
// waiting on the Mailbox/get + Email/query round trips. The live fetch still
// runs and replaces the snapshot in the background (mail-app passes
// { background: true } when the list is already populated).
// ---------------------------------------------------------------------------
const EMAIL_SNAPSHOT_KEY = 'email-snapshot';
// v2: unified / cross-account lists are no longer snapshotted (their rows carry
// per-account source stamps that a fresh boot ignores, so a colliding JMAP id
// opened the wrong account's mail - #847). Older snapshots are discarded.
// v3: the snapshot names its account and is only restored for that account.
const EMAIL_SNAPSHOT_VERSION = 3;
const EMAIL_SNAPSHOT_MAX_EMAILS = 50;

function isEmailListSync(value: unknown, mailboxId: string): value is EmailListSync {
  const sync = value as EmailListSync | null;
  return !!sync && typeof sync.state === 'string' && typeof sync.accountId === 'string' && sync.mailboxId === mailboxId;
}

/** The signed-in session persisted by auth-store, read without importing it. */
function persistedAuthState(): { isAuthenticated?: unknown; activeAccountId?: unknown } | null {
  try {
    const raw = window.localStorage.getItem('auth-storage');
    return raw ? JSON.parse(raw)?.state ?? null : null;
  } catch {
    return null;
  }
}

if (typeof window !== 'undefined') {
  // Restore at module load, before the first render reads the store - and only
  // when the last session ended authenticated, so a logged-out visitor never
  // sees cached mail, and for the account the snapshot was taken from.
  try {
    const auth = persistedAuthState();
    const authed = auth?.isAuthenticated === true;
    const raw = authed ? window.localStorage.getItem(EMAIL_SNAPSHOT_KEY) : null;
    if (raw) {
      const snap = JSON.parse(raw);
      if (
        snap?.v === EMAIL_SNAPSHOT_VERSION &&
        typeof snap.account === 'string' &&
        snap.account === auth?.activeAccountId &&
        Array.isArray(snap.mailboxes) &&
        snap.mailboxes.length > 0
      ) {
        const snapMailbox = typeof snap.selectedMailbox === 'string' ? snap.selectedMailbox : '';
        // The snapshot holds the last plain folder that was open, which may be
        // Trash from a session that ended in a unified view. Only a reload of
        // a folder link continues there; opening the app starts in the
        // account's own inbox, and rows cached for another folder are dropped.
        const ownInbox = (snap.mailboxes as Mailbox[]).find(m => m.role === 'inbox' && !m.isShared);
        const selectedMailbox = pathNamesMailFolder(window.location.pathname) || !ownInbox
          ? snapMailbox
          : ownInbox.id;
        useEmailStore.setState({
          mailboxes: snap.mailboxes,
          selectedMailbox,
          searchMailboxId: defaultSearchScopeFor(snap.mailboxes, selectedMailbox),
          ...(selectedMailbox === snapMailbox && Array.isArray(snap.emails) && snap.emails.length > 0
            ? {
                emails: snap.emails,
                totalEmails: typeof snap.totalEmails === 'number' ? snap.totalEmails : snap.emails.length,
                hasMoreEmails: !!snap.hasMoreEmails,
                // The order the rows were fetched in; the list is drawn sorted
                // by it, so without it an "unread first" page shows by date
                // until the live fetch lands and re-sorts it.
                ...(Array.isArray(snap.listOrder) ? { listOrder: sanitizeSortLevels(snap.listOrder) } : {}),
                // Without the baseline the live load re-reads the page and its
                // total: a saved total that doesn't cover the rows is wrong, and
                // a catch-up from the baseline would keep it, and "no more
                // mail" with it, across reloads (#1364).
                ...(isEmailListSync(snap.emailListSync, snapMailbox) && !(snap.totalEmails < snap.emails.length)
                  ? { emailListSync: snap.emailListSync }
                  : {}),
              }
            : {}),
        });
      }
    }
  } catch { /* corrupt snapshot - start empty */ }

  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  useEmailStore.subscribe((state, prev) => {
    if (
      state.emails === prev.emails &&
      state.mailboxes === prev.mailboxes &&
      state.selectedMailbox === prev.selectedMailbox
    ) {
      return;
    }
    // A reset (logout / store wipe) must drop the snapshot immediately - mail
    // data may not outlive the session in localStorage.
    if (state.mailboxes.length === 0 && state.emails.length === 0) {
      if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
      try { window.localStorage.removeItem(EMAIL_SNAPSHOT_KEY); } catch { /* ignore */ }
      return;
    }
    if (snapshotTimer) clearTimeout(snapshotTimer);
    // Debounced trailing write: the store updates far too often to serialize
    // the list on every set().
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      const s = useEmailStore.getState();
      if (s.mailboxes.length === 0) return;
      // Don't snapshot search results, keyword filters, the scheduled view, a
      // secondary account's view or a unified/cross-account list - the previous
      // plain listing stays in place for the next boot. A unified list mixes
      // accounts whose email ids collide; restored without its view flags it
      // would be read as the active account's mail. (#847)
      if (s.searchQuery || s.selectedKeyword || s.isScheduledView || s.viewingAccountId || s.isUnifiedView) return;
      const account = persistedAuthState()?.activeAccountId;
      if (typeof account !== 'string' || !account) return;
      try {
        window.localStorage.setItem(EMAIL_SNAPSHOT_KEY, JSON.stringify({
          v: EMAIL_SNAPSHOT_VERSION,
          account,
          mailboxes: s.mailboxes,
          selectedMailbox: s.selectedMailbox,
          emails: s.emails.slice(0, EMAIL_SNAPSHOT_MAX_EMAILS),
          totalEmails: s.totalEmails,
          hasMoreEmails: s.hasMoreEmails || s.emails.length > EMAIL_SNAPSHOT_MAX_EMAILS,
          listOrder: s.listOrder,
          emailListSync: s.emailListSync,
        }));
      } catch { /* storage quota - skip */ }
    }, 1000);
  });
}
