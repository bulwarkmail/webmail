import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ComposerDraftData } from '@/components/email/email-composer';

export type ProTabKind =
  | 'mail' | 'calendar' | 'contacts' | 'files' | 'settings'
  | 'compose' | 'email' | 'folder';

export type ProAppTabKind = Exclude<ProTabKind, 'compose' | 'email' | 'folder'>;

export type ProPaneId = 'main' | 'split';

/** Which visual side of the shell the split pane renders on. Persisted, so a reload never flips the layout. */
export type ProSplitSide = 'left' | 'right';

/**
 * Pro split layout. Only side-by-side is supported - the pane that "splits
 * off" always lives next to the main pane on the horizontal axis. Kept as
 * a type alias to leave room for future layouts without churning callers.
 */
export type ProSplitOrientation = 'vertical';

export type ProComposerMode = 'compose' | 'reply' | 'replyAll' | 'forward';

/**
 * Mirror of `EmailComposer.replyTo` - kept as a structural type here so the
 * tab store doesn't take a runtime dependency on the composer module.
 */
export interface ProReplyContext {
  from?: { email?: string; name?: string }[];
  replyToAddresses?: { email?: string; name?: string }[];
  to?: { email?: string; name?: string }[];
  cc?: { email?: string; name?: string }[];
  bcc?: { email?: string; name?: string }[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  receivedAt?: string;
  accountId?: string;
  attachments?: Array<{
    blobId: string; name?: string; type: string; size: number;
    cid?: string; disposition?: string;
  }>;
  messageId?: string;
  inReplyTo?: string[];
  references?: string[];
  quoteHeaderHtml?: string;
  quoteHeaderText?: string;
  quoteWrapInBlockquote?: boolean;
}

export interface ProComposeTabData {
  sessionId: number;
  mode: ProComposerMode;
  replyTo?: ProReplyContext;
  initialDraftText?: string;
  initialData?: ComposerDraftData | null;
  sourceEmailId?: string | null;
  title: string;
}

export interface ProEmailTabData {
  accountId: string;
  emailId: string;
  mailboxId: string | null;
  title: string;
}

export interface ProFolderTabData {
  /**
   * Connected-account id the folder belongs to (multi-account sidebar
   * groups); null = the active account. Used to resolve the JMAP client the
   * folder tab fetches through.
   */
  accountId: string | null;
  mailboxId: string;
  title: string;
}

export interface ProTab {
  id: string;
  kind: ProTabKind;
  /** i18n key under `sidebar.*` for built-in app tabs. Empty for compose/email/folder. */
  labelKey: string;
  title?: string;
  closeable: boolean;
  composeData?: ProComposeTabData;
  emailData?: ProEmailTabData;
  folderData?: ProFolderTabData;
  /** Which pane this tab lives in. Defaults to 'main' for the single-pane case. */
  paneId: ProPaneId;
}

export interface OpenEmailTabOptions {
  /**
   * Force the tab into a specific pane. Passing 'split' when no split exists
   * creates one (used by the shell's drop zones and by double-click routing).
   */
  pane?: ProPaneId;
  /**
   * Reuse the shared "reader" email tab in the target pane instead of piling
   * up a new tab per opened message (VS Code preview-tab behaviour). The
   * reader tab is whatever email tab this flow created last; explicit flows
   * that want a durable tab simply don't pass this.
   */
  reuseReader?: boolean;
}

/**
 * The data half of the store - everything `normalizeProTabState` operates on.
 * Kept separate from the actions so the normalizer stays a pure function.
 */
export interface ProTabCoreState {
  tabs: ProTab[];
  /** Active tab in each pane. `split` is null when there is no split. */
  activeTabId: string;
  activeSplitTabId: string | null;
  /** When the user last clicked into a tab/body, which pane was it? */
  focusedPaneId: ProPaneId;
  /** Derived: non-null exactly when the split pane has tabs. */
  splitOrientation: ProSplitOrientation | null;
  splitSide: ProSplitSide;
  /** The reusable double-click/drop "reader" email tab, if it still exists. */
  readerTabId: string | null;
  loadedTabIds: string[];
}

interface ProTabState extends ProTabCoreState {
  openTab: (kind: ProAppTabKind) => string;
  openComposeTab: (data: ProComposeTabData) => string;
  openEmailTab: (data: ProEmailTabData, opts?: OpenEmailTabOptions) => string;
  /**
   * Open a mailbox in its own tab (sidebar folder dragged onto a tab strip
   * or a pane). One tab per folder: opening an already-open folder focuses
   * its tab instead of duplicating it.
   */
  openFolderTab: (data: ProFolderTabData, opts?: { pane?: ProPaneId }) => string;
  closeTab: (id: string) => void;
  /**
   * Request closing a tab, honouring any registered close interceptor (e.g. a
   * compose tab with unsaved changes that wants to show the "Save or discard
   * draft?" dialog first). Falls back to `closeTab` when none is registered.
   */
  requestCloseTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  setFocusedPane: (paneId: ProPaneId) => void;
  setSplitSide: (side: ProSplitSide) => void;

  /**
   * Move a tab next to another tab. `edge` controls whether it lands before
   * or after the target - used by the tab bar's drop indicator. Reordering
   * works both within a pane and across panes (cross-pane drops move the
   * tab to the target pane).
   */
  reorderTab: (draggedId: string, targetTabId: string, edge: 'before' | 'after') => void;

  /**
   * Move a tab to a specific pane. Moving into `split` when no split exists
   * opens one (on `opts.side` if given, else the persisted side). Moving the
   * last main-pane tab into the split merges the panes instead of refusing -
   * no drag is ever a silent no-op.
   */
  moveTabToPane: (tabId: string, paneId: ProPaneId, opts?: { side?: ProSplitSide }) => void;

  /** Collapse the split: every split-pane tab returns to main. */
  collapseSplit: () => void;

  updateTabTitle: (id: string, title: string) => void;
  updateComposeDraft: (id: string, draft: ComposerDraftData) => void;
}

const TAB_BLUEPRINTS: Record<ProAppTabKind, { labelKey: string }> = {
  mail:     { labelKey: 'mail' },
  calendar: { labelKey: 'calendar' },
  contacts: { labelKey: 'contacts' },
  files:    { labelKey: 'files' },
  settings: { labelKey: 'settings' },
};

const HOME_TAB: ProTab = {
  id: 'home-mail',
  kind: 'mail',
  labelKey: TAB_BLUEPRINTS.mail.labelKey,
  closeable: false,
  paneId: 'main',
};

/**
 * Module-level registry of tab close interceptors. Kept outside the persisted
 * Zustand state so functions are never serialised. A compose tab registers a
 * handler here so an external close request (tab-bar "X", middle-click) routes
 * through the composer's unsaved-changes guard instead of closing instantly.
 */
const closeInterceptors = new Map<string, () => void>();

export function registerProTabCloseInterceptor(id: string, fn: () => void): () => void {
  closeInterceptors.set(id, fn);
  return () => {
    if (closeInterceptors.get(id) === fn) closeInterceptors.delete(id);
  };
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `pro-tab-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function neighborInPane(tabs: ProTab[], removedId: string, paneId: ProPaneId): string | null {
  const inPane = tabs.filter((t) => t.paneId === paneId);
  const idx = inPane.findIndex((t) => t.id === removedId);
  if (idx === -1) return inPane[0]?.id ?? null;
  return (inPane[idx + 1] ?? inPane[idx - 1])?.id ?? null;
}

/**
 * The single invariant enforcer. Every mutation builds its intended next
 * state and runs it through here; rehydration runs through here too. The
 * guarantees (see the Pro shell plan):
 *
 *   I1  At least one tab always exists (the pinned home Mail tab is
 *       recreated if the list somehow empties).
 *   I2  Every tab belongs to a pane; the split pane exists iff it has tabs.
 *   I3  Each pane's active tab id points at a tab in that pane.
 *   I4  If main empties while split has tabs, the split pane *becomes* the
 *       main pane (pane merge) - callers never have to special-case it.
 *   I5  `focusedPaneId` points at an existing pane.
 *   I6  `loadedTabIds` contains both active tabs and only existing tabs.
 *
 * Pure function - exported for direct unit/property testing.
 */
export function normalizeProTabState(input: ProTabCoreState): ProTabCoreState {
  let tabs = input.tabs.map((t) => (t.paneId ? t : { ...t, paneId: 'main' as const }));

  // I1: never empty.
  if (tabs.length === 0) {
    return {
      tabs: [HOME_TAB],
      activeTabId: HOME_TAB.id,
      activeSplitTabId: null,
      focusedPaneId: 'main',
      splitOrientation: null,
      splitSide: input.splitSide === 'left' ? 'left' : 'right',
      readerTabId: null,
      loadedTabIds: [HOME_TAB.id],
    };
  }

  let activeTabId = input.activeTabId;
  let activeSplitTabId = input.activeSplitTabId;

  // I4: main never sits empty next to a populated split - the split pane
  // takes over as main. The user's split-side focus carries across.
  if (!tabs.some((t) => t.paneId === 'main')) {
    tabs = tabs.map((t) => (t.paneId === 'split' ? { ...t, paneId: 'main' as const } : t));
    if (activeSplitTabId) activeTabId = activeSplitTabId;
    activeSplitTabId = null;
  }

  const mainTabs = tabs.filter((t) => t.paneId === 'main');
  const splitTabs = tabs.filter((t) => t.paneId === 'split');
  const hasSplit = splitTabs.length > 0;

  // I3: per-pane active ids must exist in their pane.
  if (!mainTabs.some((t) => t.id === activeTabId)) {
    activeTabId = mainTabs[0].id;
  }
  if (!hasSplit) {
    activeSplitTabId = null;
  } else if (!splitTabs.some((t) => t.id === activeSplitTabId)) {
    activeSplitTabId = splitTabs[0].id;
  }

  // I2 (derived flag) + I5.
  const splitOrientation: ProSplitOrientation | null = hasSplit ? 'vertical' : null;
  const focusedPaneId: ProPaneId =
    input.focusedPaneId === 'split' && hasSplit ? 'split' : 'main';

  // Reader tab must still exist and still be an email tab.
  const readerTabId = tabs.some((t) => t.id === input.readerTabId && t.kind === 'email')
    ? input.readerTabId
    : null;

  // I6: prune ghosts, keep both actives renderable.
  const ids = new Set(tabs.map((t) => t.id));
  let loadedTabIds = input.loadedTabIds.filter((id) => ids.has(id));
  if (!loadedTabIds.includes(activeTabId)) loadedTabIds = [...loadedTabIds, activeTabId];
  if (activeSplitTabId && !loadedTabIds.includes(activeSplitTabId)) {
    loadedTabIds = [...loadedTabIds, activeSplitTabId];
  }

  return {
    tabs,
    activeTabId,
    activeSplitTabId,
    focusedPaneId,
    splitOrientation,
    splitSide: input.splitSide === 'left' ? 'left' : 'right',
    readerTabId,
    loadedTabIds,
  };
}

/** True when the (normalized) state currently renders two panes. */
export function hasSplitPane(state: Pick<ProTabCoreState, 'tabs'>): boolean {
  return state.tabs.some((t) => t.paneId === 'split');
}

function core(state: ProTabState): ProTabCoreState {
  return {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    activeSplitTabId: state.activeSplitTabId,
    focusedPaneId: state.focusedPaneId,
    splitOrientation: state.splitOrientation,
    splitSide: state.splitSide,
    readerTabId: state.readerTabId,
    loadedTabIds: state.loadedTabIds,
  };
}

/** Mark a tab active (and focused) in whichever pane it lives in. */
function withTabActivated(state: ProTabCoreState, tab: ProTab): ProTabCoreState {
  return {
    ...state,
    ...(tab.paneId === 'main'
      ? { activeTabId: tab.id, focusedPaneId: 'main' as const }
      : { activeSplitTabId: tab.id, focusedPaneId: 'split' as const }),
    loadedTabIds: state.loadedTabIds.includes(tab.id)
      ? state.loadedTabIds
      : [...state.loadedTabIds, tab.id],
  };
}

export const useProTabStore = create<ProTabState>()(
  persist(
    (set, get) => {
      /** Apply a mutation to the core state and commit the normalized result. */
      const commit = (mutate: (s: ProTabCoreState) => ProTabCoreState) => {
        set(normalizeProTabState(mutate(core(get()))));
      };

      return {
        tabs: [HOME_TAB],
        activeTabId: HOME_TAB.id,
        activeSplitTabId: null,
        focusedPaneId: 'main',
        splitOrientation: null,
        splitSide: 'right',
        readerTabId: null,
        loadedTabIds: [HOME_TAB.id],

        openTab: (kind) => {
          const state = core(get());
          // App tabs are singletons across the whole workspace: opening one
          // that already exists focuses it wherever it lives (fixes the
          // duplicate-Settings-tab bug), it never creates a second copy.
          const existing = state.tabs.find((tab) => tab.kind === kind);
          if (existing) {
            commit((s) => withTabActivated(s, existing));
            return existing.id;
          }
          const newTab: ProTab = {
            id: makeId(),
            kind,
            labelKey: TAB_BLUEPRINTS[kind].labelKey,
            closeable: true,
            paneId: state.focusedPaneId,
          };
          commit((s) => withTabActivated({ ...s, tabs: [...s.tabs, newTab] }, newTab));
          return newTab.id;
        },

        openComposeTab: (data) => {
          const newTab: ProTab = {
            id: makeId(),
            kind: 'compose',
            labelKey: '',
            title: data.title,
            closeable: true,
            composeData: data,
            paneId: get().focusedPaneId,
          };
          commit((s) => withTabActivated({ ...s, tabs: [...s.tabs, newTab] }, newTab));
          return newTab.id;
        },

        openEmailTab: (data, opts) => {
          const state = core(get());

          // Same email already open anywhere: focus it, never open twice.
          const existing = state.tabs.find(
            (tab) => tab.kind === 'email'
              && tab.emailData?.emailId === data.emailId
              && tab.emailData?.accountId === data.accountId
          );
          if (existing) {
            commit((s) => withTabActivated(s, existing));
            return existing.id;
          }

          const targetPane: ProPaneId = opts?.pane ?? state.focusedPaneId;

          // Reuse the reader tab in the target pane: replace its content
          // in place so double-click / drop flows drive a single tab
          // instead of accumulating one per message.
          if (opts?.reuseReader && state.readerTabId) {
            const reader = state.tabs.find(
              (t) => t.id === state.readerTabId && t.kind === 'email' && t.paneId === targetPane,
            );
            if (reader) {
              commit((s) => withTabActivated({
                ...s,
                tabs: s.tabs.map((t) => t.id === reader.id
                  ? { ...t, emailData: data, title: data.title }
                  : t),
              }, reader));
              return reader.id;
            }
          }

          const newTab: ProTab = {
            id: makeId(),
            kind: 'email',
            labelKey: '',
            title: data.title,
            closeable: true,
            emailData: data,
            paneId: targetPane,
          };
          commit((s) => withTabActivated({
            ...s,
            tabs: [...s.tabs, newTab],
            readerTabId: opts?.reuseReader ? newTab.id : s.readerTabId,
          }, newTab));
          return newTab.id;
        },

        openFolderTab: (data, opts) => {
          const state = core(get());

          // Same folder already open anywhere: focus it, never open twice.
          const existing = state.tabs.find(
            (tab) => tab.kind === 'folder'
              && tab.folderData?.mailboxId === data.mailboxId
              && (tab.folderData?.accountId ?? null) === (data.accountId ?? null)
          );
          if (existing) {
            commit((s) => withTabActivated(s, existing));
            return existing.id;
          }

          const newTab: ProTab = {
            id: makeId(),
            kind: 'folder',
            labelKey: '',
            title: data.title,
            closeable: true,
            folderData: data,
            paneId: opts?.pane ?? state.focusedPaneId,
          };
          commit((s) => withTabActivated({ ...s, tabs: [...s.tabs, newTab] }, newTab));
          return newTab.id;
        },

        requestCloseTab: (id) => {
          const interceptor = closeInterceptors.get(id);
          if (interceptor) {
            interceptor();
            return;
          }
          get().closeTab(id);
        },

        closeTab: (id) => {
          const state = core(get());
          const tab = state.tabs.find((t) => t.id === id);
          if (!tab || !tab.closeable) return;

          // Drop any registered close interceptor for this tab.
          closeInterceptors.delete(id);

          commit((s) => ({
            ...s,
            tabs: s.tabs.filter((t) => t.id !== id),
            // If the closed tab was active, hand its pane to a neighbour
            // (looked up in the pre-close list, so it's the tab next door,
            // not just the pane's first tab). normalize() covers the
            // emptied-pane cases.
            activeTabId: tab.paneId === 'main' && s.activeTabId === id
              ? (neighborInPane(s.tabs, id, 'main') ?? s.activeTabId)
              : s.activeTabId,
            activeSplitTabId: tab.paneId === 'split' && s.activeSplitTabId === id
              ? neighborInPane(s.tabs, id, 'split')
              : s.activeSplitTabId,
          }));
        },

        setActiveTab: (id) => {
          const state = core(get());
          const tab = state.tabs.find((t) => t.id === id);
          if (!tab) return;
          if (tab.paneId === 'main'
            && state.activeTabId === id && state.focusedPaneId === 'main') return;
          if (tab.paneId === 'split'
            && state.activeSplitTabId === id && state.focusedPaneId === 'split') return;
          commit((s) => withTabActivated(s, tab));
        },

        setFocusedPane: (paneId) => {
          const state = core(get());
          if (state.focusedPaneId === paneId) return;
          commit((s) => ({ ...s, focusedPaneId: paneId }));
        },

        setSplitSide: (side) => {
          if (get().splitSide === side) return;
          commit((s) => ({ ...s, splitSide: side }));
        },

        reorderTab: (draggedId, targetTabId, edge) => {
          const state = core(get());
          if (draggedId === targetTabId) return;
          const dragged = state.tabs.find((t) => t.id === draggedId);
          const target = state.tabs.find((t) => t.id === targetTabId);
          if (!dragged || !target) return;

          commit((s) => {
            const rest = s.tabs.filter((t) => t.id !== draggedId);
            const insertAt = rest.findIndex((t) => t.id === targetTabId) + (edge === 'after' ? 1 : 0);
            const moved: ProTab = dragged.paneId === target.paneId
              ? dragged
              : { ...dragged, paneId: target.paneId };
            const tabs = [...rest];
            tabs.splice(insertAt, 0, moved);

            let next: ProTabCoreState = { ...s, tabs };
            if (dragged.paneId !== target.paneId) {
              // The old pane needs a new active tab if the dragged one was
              // active there (its neighbour in the pre-move list); the new
              // pane activates the dragged tab.
              if (dragged.paneId === 'main' && s.activeTabId === draggedId) {
                next = { ...next, activeTabId: neighborInPane(s.tabs, draggedId, 'main') ?? s.activeTabId };
              }
              if (dragged.paneId === 'split' && s.activeSplitTabId === draggedId) {
                next = { ...next, activeSplitTabId: neighborInPane(s.tabs, draggedId, 'split') };
              }
              next = withTabActivated(next, moved);
            }
            return next;
          });
        },

        moveTabToPane: (tabId, paneId, opts) => {
          const state = core(get());
          const tab = state.tabs.find((t) => t.id === tabId);
          if (!tab) return;
          if (tab.paneId === paneId) return;

          const openingSplit = paneId === 'split' && !hasSplitPane(state);

          commit((s) => {
            const tabs = s.tabs.map((t) => (t.id === tabId ? { ...t, paneId } : t));
            const moved = { ...tab, paneId };
            let next: ProTabCoreState = {
              ...s,
              tabs,
              splitSide: openingSplit ? (opts?.side ?? s.splitSide) : s.splitSide,
            };
            // Hand the vacated pane to a neighbour (from the pre-move list)
            // before activating the moved tab in its new pane. If the
            // vacated pane emptied, normalize() collapses/merges as needed.
            if (tab.paneId === 'main' && s.activeTabId === tabId) {
              next = { ...next, activeTabId: neighborInPane(s.tabs, tabId, 'main') ?? s.activeTabId };
            }
            if (tab.paneId === 'split' && s.activeSplitTabId === tabId) {
              next = { ...next, activeSplitTabId: neighborInPane(s.tabs, tabId, 'split') };
            }
            return withTabActivated(next, moved);
          });
        },

        collapseSplit: () => {
          const state = core(get());
          if (!hasSplitPane(state)) return;
          commit((s) => ({
            ...s,
            tabs: s.tabs.map((t) => (t.paneId === 'split' ? { ...t, paneId: 'main' as const } : t)),
            activeSplitTabId: null,
            focusedPaneId: 'main',
          }));
        },

        updateTabTitle: (id, title) => {
          set({
            tabs: get().tabs.map((tab) => (tab.id === id ? { ...tab, title } : tab)),
          });
        },

        updateComposeDraft: (id, draft) => {
          set({
            tabs: get().tabs.map((tab) => {
              if (tab.id !== id || tab.kind !== 'compose' || !tab.composeData) return tab;
              return { ...tab, composeData: { ...tab.composeData, initialData: draft } };
            }),
          });
        },
      };
    },
    {
      name: 'pro-tabs',
      version: 4,
      // Don't persist transient compose drafts in tab metadata - the composer's
      // own draft-store already handles that. Persisted email tabs are fine to
      // restore (the tab body refetches the email by id).
      partialize: (state) => ({
        tabs: state.tabs.filter((tab) => tab.kind !== 'compose'),
        activeTabId: state.activeTabId,
        activeSplitTabId: state.activeSplitTabId,
        focusedPaneId: state.focusedPaneId,
        splitOrientation: state.splitOrientation,
        splitSide: state.splitSide,
        readerTabId: state.readerTabId,
        loadedTabIds: state.loadedTabIds,
      }),
      migrate: (persisted, version) => {
        // v3 -> v4: `splitSide` and `readerTabId` are new; earlier versions
        // carried an un-persisted "which side" that always reset to the
        // right. Everything else is repaired by normalize() on rehydrate.
        const state = persisted as Partial<ProTabCoreState>;
        if (version < 4) {
          return {
            ...state,
            splitSide: 'right' as const,
            readerTabId: null,
          };
        }
        return state;
      },
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const normalized = normalizeProTabState({
          tabs: Array.isArray(state.tabs) ? state.tabs : [],
          activeTabId: state.activeTabId,
          activeSplitTabId: state.activeSplitTabId ?? null,
          focusedPaneId: state.focusedPaneId ?? 'main',
          splitOrientation: state.splitOrientation ?? null,
          splitSide: state.splitSide ?? 'right',
          readerTabId: state.readerTabId ?? null,
          loadedTabIds: Array.isArray(state.loadedTabIds) ? state.loadedTabIds : [],
        });
        state.tabs = normalized.tabs;
        state.activeTabId = normalized.activeTabId;
        state.activeSplitTabId = normalized.activeSplitTabId;
        state.focusedPaneId = normalized.focusedPaneId;
        state.splitOrientation = normalized.splitOrientation;
        state.splitSide = normalized.splitSide;
        state.readerTabId = normalized.readerTabId;
        state.loadedTabIds = normalized.loadedTabIds;
      },
    },
  ),
);
