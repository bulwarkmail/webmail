// Host-side registry for plugin-provided message-list category tabs
// (Gmail-style Primary / Promotions / Social / Updates).
//
// Plugins register tab DEFINITIONS via `api.tabs.set(config)`; this store
// merges them, tracks the active tab, and resolves the JMAP filter fragment
// the email store ANDs into the mailbox Email/query. Tabs are search-first:
// a tab's `query` is evaluated server-side at view time (no mail mutation);
// `keyword` tabs filter via hasKeyword for durable Sieve-assigned categories.
// The tab strip itself renders natively (components/email/message-list-tabs.tsx)
// — no plugin iframe involved, per the core contract in lib/plugin-types.ts.

import { create } from 'zustand';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Email } from '@/lib/jmap/types';
import type { MessageListTab, MessageListTabsConfig } from '@/lib/plugin-types';
import { MAX_MESSAGE_LIST_TABS } from '@/lib/plugin-types';
import { messageListTabHooks } from '@/lib/plugin-hooks';
import { keywordPointer } from '@/lib/jmap/patch-pointer';
import { useEmailStore } from './email-store';

// ─── Validation ──────────────────────────────────────────────

// System keywords a tab may never claim: filtering the inbox by these would
// hijack read/star/pin semantics, and `$label:` keywords belong to user tags.
const RESERVED_KEYWORDS = new Set([
  '$seen', '$flagged', '$draft', '$answered', '$forwarded',
  '$recent', '$junk', '$notjunk', '$phishing', '$pinned',
]);

const TAB_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
// RFC 5788 keyword syntax, conservatively narrowed. Keywords are matched
// case-insensitively by IMAP servers, so we lowercase on normalization.
const KEYWORD_RE = /^\$[a-z0-9][a-z0-9_.-]{0,63}$/;

// Upper bound on a serialized tab query — a filter tree bigger than this is
// either a bug or an abuse vector for the JMAP request budget.
const MAX_QUERY_JSON_BYTES = 16 * 1024;

function validateTabQuery(tabId: string, query: unknown): Record<string, unknown> {
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    throw new Error(`tabs.set: tab "${tabId}" query must be a JMAP filter object`);
  }
  let json: string;
  try {
    json = JSON.stringify(query);
  } catch {
    throw new Error(`tabs.set: tab "${tabId}" query is not serializable`);
  }
  if (json.length > MAX_QUERY_JSON_BYTES) {
    throw new Error(`tabs.set: tab "${tabId}" query exceeds ${MAX_QUERY_JSON_BYTES} bytes`);
  }
  // Deep-clone via JSON so the stored filter is plain data (no prototypes,
  // functions or getters can cross into request bodies).
  return JSON.parse(json) as Record<string, unknown>;
}

/**
 * Validate and normalize a plugin-supplied tabs config. Throws with a
 * developer-readable message on any violation (surfaces as the api.tabs.set
 * promise rejection inside the plugin sandbox).
 */
export function validateTabsConfig(config: MessageListTabsConfig): MessageListTabsConfig {
  if (!config || !Array.isArray(config.tabs)) throw new Error('tabs.set: config.tabs must be an array');
  if (config.tabs.length < 2) throw new Error('tabs.set: at least 2 tabs required');
  if (config.tabs.length > MAX_MESSAGE_LIST_TABS) throw new Error(`tabs.set: at most ${MAX_MESSAGE_LIST_TABS} tabs allowed`);

  const ids = new Set<string>();
  let defaults = 0;
  const tabs: MessageListTab[] = config.tabs.map((t) => {
    if (!t || typeof t.id !== 'string' || !TAB_ID_RE.test(t.id)) {
      throw new Error(`tabs.set: invalid tab id "${String(t?.id)}"`);
    }
    if (ids.has(t.id)) throw new Error(`tabs.set: duplicate tab id "${t.id}"`);
    ids.add(t.id);
    if (typeof t.label !== 'string' || !t.label.trim() || t.label.length > 40) {
      throw new Error(`tabs.set: tab "${t.id}" needs a label (max 40 chars)`);
    }

    const query = t.query !== undefined ? validateTabQuery(t.id, t.query) : undefined;

    let keyword: string | null | undefined = undefined;
    if (t.keyword !== null && t.keyword !== undefined) {
      keyword = String(t.keyword).toLowerCase();
      if (!KEYWORD_RE.test(keyword)) {
        throw new Error(`tabs.set: tab "${t.id}" keyword "${t.keyword}" is not a valid JMAP keyword (must match ${KEYWORD_RE})`);
      }
      if (RESERVED_KEYWORDS.has(keyword) || keyword.startsWith('$label')) {
        throw new Error(`tabs.set: tab "${t.id}" may not use reserved keyword "${keyword}"`);
      }
    }
    if (!query && !keyword) defaults++;

    return {
      id: t.id,
      label: t.label.trim(),
      query,
      keyword: keyword ?? null,
      icon: typeof t.icon === 'string' ? t.icon.slice(0, 40) : undefined,
      color: typeof t.color === 'string' ? t.color.slice(0, 40) : undefined,
      order: typeof t.order === 'number' && Number.isFinite(t.order) ? t.order : 100,
      showUnreadBadge: t.showUnreadBadge !== false,
    };
  });
  if (defaults > 1) throw new Error('tabs.set: at most one default tab (no query, no keyword) allowed');

  const mailboxRoles = Array.isArray(config.mailboxRoles) && config.mailboxRoles.length > 0
    ? config.mailboxRoles.filter((r): r is string => typeof r === 'string').map((r) => r.toLowerCase())
    : ['inbox'];

  return { tabs, mailboxRoles };
}

// ─── Filter resolution ───────────────────────────────────────

function isDefaultTab(tab: MessageListTab): boolean {
  return !tab.query && !tab.keyword;
}

/** The JMAP filter fragment that positively selects a (non-default) tab. */
function positiveFragment(tab: MessageListTab): Record<string, unknown> | null {
  if (tab.query) return tab.query;
  if (tab.keyword) return { hasKeyword: tab.keyword };
  return null;
}

/**
 * Resolve the filter fragment for one tab in the context of all tabs.
 * Default tab = NOT(every other tab's positive fragment) — RFC 8620 §5.5:
 * a NOT FilterOperator is true iff none of its conditions match.
 */
export function resolveTabFilter(tab: MessageListTab, allTabs: MessageListTab[]): Record<string, unknown> | null {
  const positive = positiveFragment(tab);
  if (positive) return positive;
  const others = allTabs
    .filter((t) => t.id !== tab.id)
    .map(positiveFragment)
    .filter((f): f is Record<string, unknown> => !!f);
  return others.length > 0 ? { operator: 'NOT', conditions: others } : null;
}

// ─── Store ───────────────────────────────────────────────────

interface MessageListTabsStore {
  /** pluginId → validated config. */
  registrations: Record<string, MessageListTabsConfig>;
  /** Merged, order-sorted tabs across all registrations. */
  tabs: MessageListTab[];
  /** Union of mailbox roles the strip is enabled for (lowercase). */
  mailboxRoles: string[];
  activeTabId: string | null;
  /** tabId → unread count for the current mailbox. */
  tabCounts: Record<string, number>;
  isCountsLoading: boolean;

  registerTabs: (pluginId: string, config: MessageListTabsConfig) => void;
  clearTabs: (pluginId: string) => void;
  setActiveTab: (tabId: string, mailboxId: string | null) => void;
  /**
   * JMAP filter fragment for the active tab (to AND into the mailbox query),
   * or null when tabs don't apply to this mailbox role.
   */
  getCategoryFilter: (mailboxRole: string | null | undefined) => Record<string, unknown> | null;
  /** True when the strip should render for this mailbox role. */
  isEnabledForRole: (mailboxRole: string | null | undefined) => boolean;
  refreshCounts: (client: IJMAPClient, jmapMailboxId: string, accountId?: string) => Promise<void>;
  /**
   * Move messages to a keyword-based (or default) tab: patches category
   * keywords via Email/set, updates the visible list optimistically, and
   * fires the categorize hooks. Returns false when a plugin intercept
   * cancelled the move or the target tab is search-based.
   */
  categorizeEmails: (client: IJMAPClient, emailIds: string[], toTabId: string) => Promise<boolean>;
}

function mergeRegistrations(registrations: Record<string, MessageListTabsConfig>): {
  tabs: MessageListTab[];
  mailboxRoles: string[];
} {
  const tabs: MessageListTab[] = [];
  const roles = new Set<string>();
  let haveDefault = false;
  const sorted = Object.values(registrations)
    .flatMap((cfg) => {
      for (const r of cfg.mailboxRoles ?? ['inbox']) roles.add(r);
      return cfg.tabs;
    })
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  for (const tab of sorted) {
    // Across plugins, only the first default tab (by order) survives — two
    // "everything else" buckets can't both be right.
    if (isDefaultTab(tab)) {
      if (haveDefault) continue;
      haveDefault = true;
    }
    tabs.push(tab);
  }
  return { tabs, mailboxRoles: [...roles] };
}

function pickActiveTab(tabs: MessageListTab[], prevActive: string | null): string | null {
  if (tabs.some((t) => t.id === prevActive)) return prevActive;
  return (tabs.find(isDefaultTab) ?? tabs[0])?.id ?? null;
}

export const useMessageListTabsStore = create<MessageListTabsStore>()((set, get) => ({
  registrations: {},
  tabs: [],
  mailboxRoles: [],
  activeTabId: null,
  tabCounts: {},
  isCountsLoading: false,

  registerTabs: (pluginId, config) => {
    const validated = validateTabsConfig(config);
    const registrations = { ...get().registrations, [pluginId]: validated };
    const merged = mergeRegistrations(registrations);
    set({ registrations, ...merged, activeTabId: pickActiveTab(merged.tabs, get().activeTabId) });
    void messageListTabHooks.onTabsChange.emit(merged.tabs);
  },

  clearTabs: (pluginId) => {
    if (!(pluginId in get().registrations)) return;
    const registrations = { ...get().registrations };
    delete registrations[pluginId];
    const merged = mergeRegistrations(registrations);
    set({
      registrations,
      ...merged,
      activeTabId: pickActiveTab(merged.tabs, get().activeTabId),
      ...(merged.tabs.length === 0 ? { tabCounts: {} } : {}),
    });
    void messageListTabHooks.onTabsChange.emit(merged.tabs);
  },

  setActiveTab: (tabId, mailboxId) => {
    const { tabs, activeTabId } = get();
    if (!tabs.some((t) => t.id === tabId) || tabId === activeTabId) return;
    set({ activeTabId: tabId });
    void messageListTabHooks.onTabActivate.emit({ tabId, previousTabId: activeTabId, mailboxId });
  },

  isEnabledForRole: (mailboxRole) => {
    const { tabs, mailboxRoles } = get();
    return tabs.length > 0 && !!mailboxRole && mailboxRoles.includes(mailboxRole.toLowerCase());
  },

  getCategoryFilter: (mailboxRole) => {
    const { tabs, activeTabId } = get();
    if (!get().isEnabledForRole(mailboxRole)) return null;
    const active = tabs.find((t) => t.id === activeTabId) ?? tabs.find(isDefaultTab) ?? tabs[0];
    if (!active) return null;
    return resolveTabFilter(active, tabs);
  },

  refreshCounts: async (client, jmapMailboxId, accountId) => {
    const { tabs } = get();
    if (tabs.length === 0) return;
    set({ isCountsLoading: true });
    try {
      const counts = await client.getCategoryUnreadCounts(
        jmapMailboxId,
        tabs.map((t) => ({ id: t.id, filter: resolveTabFilter(t, tabs) })),
        accountId,
      );
      set({ tabCounts: counts, isCountsLoading: false });
      void messageListTabHooks.onTabCountsRefresh.emit(counts);
    } catch (err) {
      console.error('Failed to refresh category tab counts:', err);
      set({ isCountsLoading: false });
    }
  },

  categorizeEmails: async (client, emailIds, toTabId) => {
    const { tabs } = get();
    const target = tabs.find((t) => t.id === toTabId);
    if (!target || emailIds.length === 0) return false;
    // Search-based tabs derive membership from their query — there is no
    // keyword to write. The owning plugin implements moves there by updating
    // its query (per-sender override) and re-registering.
    if (target.query) return false;

    const allKeywords = tabs.map((t) => t.keyword).filter((k): k is string => !!k);
    const keywordAdded = target.keyword ?? null;
    const keywordsRemoved = allKeywords.filter((k) => k !== keywordAdded);
    if (!keywordAdded && keywordsRemoved.length === 0) return false;

    const emailState = useEmailStore.getState();
    const affected = emailState.emails.filter((e) => emailIds.includes(e.id));
    const senders = [...new Set(
      affected.flatMap((e) => (e.from ?? []).map((f) => f.email?.toLowerCase()).filter((x): x is string => !!x)),
    )];

    const ctx = { emailIds, toTabId, keywordAdded, keywordsRemoved, senders };
    const proceed = await messageListTabHooks.onBeforeEmailCategorize.intercept(ctx);
    if (!proceed) return false;

    // One PatchObject per message: drop every other category keyword, add the
    // target's (removals of absent keywords are no-ops per RFC 8620 §5.3).
    const patch: Record<string, boolean | null> = {};
    for (const k of keywordsRemoved) patch[keywordPointer(k)] = null;
    if (keywordAdded) patch[keywordPointer(keywordAdded)] = true;

    // Group by owning account so shared-mailbox messages patch correctly.
    const byAccount = new Map<string | undefined, string[]>();
    for (const id of emailIds) {
      const email = affected.find((e) => e.id === id) as (Email & { accountId?: string }) | undefined;
      const acct = email?.accountId;
      const list = byAccount.get(acct) ?? [];
      list.push(id);
      byAccount.set(acct, list);
    }
    for (const [acct, ids] of byAccount) {
      await client.batchUpdateKeywords(ids, patch, acct);
    }

    // Optimistic local update: fix keywords in place, and drop moved messages
    // from a keyword-filtered view they no longer belong to. (Query-based
    // active tabs are left as-is — membership there is server-derived.)
    const idSet = new Set(emailIds);
    const activeTab = tabs.find((t) => t.id === get().activeTabId);
    const shouldDrop = !!activeTab && !activeTab.query && activeTab.id !== toTabId
      && get().isEnabledForRole(
        emailState.mailboxes.find((mb) => mb.id === emailState.selectedMailbox)?.role ?? null,
      );
    useEmailStore.setState((state) => ({
      emails: state.emails
        .map((e) => {
          if (!idSet.has(e.id)) return e;
          const keywords = { ...e.keywords };
          for (const k of keywordsRemoved) delete keywords[k];
          if (keywordAdded) keywords[keywordAdded] = true;
          return { ...e, keywords };
        })
        .filter((e) => !shouldDrop || !idSet.has(e.id)),
    }));

    void messageListTabHooks.onEmailCategorize.emit(ctx);
    return true;
  },
}));
