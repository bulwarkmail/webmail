import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ComposerDraftData } from '@/components/email/email-composer';

export type ProTabKind =
  | 'mail' | 'calendar' | 'contacts' | 'files' | 'settings'
  | 'compose' | 'email';

export type ProPaneId = 'main' | 'split';
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

export interface ProTab {
  id: string;
  kind: ProTabKind;
  /** i18n key under `sidebar.*` for built-in app tabs. Empty for compose/email. */
  labelKey: string;
  title?: string;
  closeable: boolean;
  composeData?: ProComposeTabData;
  emailData?: ProEmailTabData;
  /** Which pane this tab lives in. Defaults to 'main' for the single-pane case. */
  paneId: ProPaneId;
}

interface ProTabState {
  tabs: ProTab[];
  /** Active tab in each pane. `split` is null when there is no split. */
  activeTabId: string;
  activeSplitTabId: string | null;
  /** When the user last clicked into a tab/body, which pane was it? */
  focusedPaneId: ProPaneId;
  splitOrientation: ProSplitOrientation | null;
  loadedTabIds: string[];

  openTab: (kind: 'mail' | 'calendar' | 'contacts' | 'files' | 'settings') => string;
  openComposeTab: (data: ProComposeTabData) => string;
  openEmailTab: (data: ProEmailTabData) => string;
  closeTab: (id: string) => void;
  /**
   * Request closing a tab, honouring any registered close interceptor (e.g. a
   * compose tab with unsaved changes that wants to show the "Save or discard
   * draft?" dialog first). Falls back to `closeTab` when none is registered.
   */
  requestCloseTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  setFocusedPane: (paneId: ProPaneId) => void;

  /**
   * Move a tab next to another tab. `edge` controls whether it lands before
   * or after the target - used by the tab bar's drop indicator. Reordering
   * works both within a pane and across panes (cross-pane drops move the
   * tab to the target pane).
   */
  reorderTab: (draggedId: string, targetTabId: string, edge: 'before' | 'after') => void;

  /**
   * Move a tab to a specific pane. If moving into `split` and no split
   * exists, opens a new split using the supplied orientation.
   */
  moveTabToPane: (
    tabId: string,
    paneId: ProPaneId,
    orientation?: ProSplitOrientation,
  ) => void;

  /** Collapse the split: every split-pane tab returns to main. */
  collapseSplit: () => void;

  updateTabTitle: (id: string, title: string) => void;
  updateComposeDraft: (id: string, draft: ComposerDraftData) => void;
}

const TAB_BLUEPRINTS: Record<'mail' | 'calendar' | 'contacts' | 'files' | 'settings', { labelKey: string }> = {
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

export const useProTabStore = create<ProTabState>()(
  persist(
    (set, get) => ({
      tabs: [HOME_TAB],
      activeTabId: HOME_TAB.id,
      activeSplitTabId: null,
      focusedPaneId: 'main',
      splitOrientation: null,
      loadedTabIds: [HOME_TAB.id],

      openTab: (kind) => {
        const state = get();
        const targetPane = state.focusedPaneId;
        const existing = state.tabs.find((tab) => tab.kind === kind && tab.paneId === targetPane);
        if (existing) {
          if (targetPane === 'main') {
            set({
              activeTabId: existing.id,
              loadedTabIds: state.loadedTabIds.includes(existing.id)
                ? state.loadedTabIds
                : [...state.loadedTabIds, existing.id],
            });
          } else {
            set({
              activeSplitTabId: existing.id,
              loadedTabIds: state.loadedTabIds.includes(existing.id)
                ? state.loadedTabIds
                : [...state.loadedTabIds, existing.id],
            });
          }
          return existing.id;
        }
        const blueprint = TAB_BLUEPRINTS[kind];
        const newTab: ProTab = {
          id: makeId(),
          kind,
          labelKey: blueprint.labelKey,
          closeable: true,
          paneId: targetPane,
        };
        set({
          tabs: [...state.tabs, newTab],
          ...(targetPane === 'main'
            ? { activeTabId: newTab.id }
            : { activeSplitTabId: newTab.id }),
          loadedTabIds: [...state.loadedTabIds, newTab.id],
        });
        return newTab.id;
      },

      openComposeTab: (data) => {
        const state = get();
        const targetPane = state.focusedPaneId;
        const newTab: ProTab = {
          id: makeId(),
          kind: 'compose',
          labelKey: '',
          title: data.title,
          closeable: true,
          composeData: data,
          paneId: targetPane,
        };
        set({
          tabs: [...state.tabs, newTab],
          ...(targetPane === 'main'
            ? { activeTabId: newTab.id }
            : { activeSplitTabId: newTab.id }),
          loadedTabIds: [...state.loadedTabIds, newTab.id],
        });
        return newTab.id;
      },

      openEmailTab: (data) => {
        const state = get();
        const targetPane = state.focusedPaneId;
        const existing = state.tabs.find(
          (tab) => tab.kind === 'email'
            && tab.emailData?.emailId === data.emailId
            && tab.emailData?.accountId === data.accountId
        );
        if (existing) {
          // Focus the existing email tab in its current pane.
          if (existing.paneId === 'main') {
            set({
              activeTabId: existing.id,
              focusedPaneId: 'main',
              loadedTabIds: state.loadedTabIds.includes(existing.id)
                ? state.loadedTabIds
                : [...state.loadedTabIds, existing.id],
            });
          } else {
            set({
              activeSplitTabId: existing.id,
              focusedPaneId: 'split',
              loadedTabIds: state.loadedTabIds.includes(existing.id)
                ? state.loadedTabIds
                : [...state.loadedTabIds, existing.id],
            });
          }
          return existing.id;
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
        set({
          tabs: [...state.tabs, newTab],
          ...(targetPane === 'main'
            ? { activeTabId: newTab.id }
            : { activeSplitTabId: newTab.id }),
          loadedTabIds: [...state.loadedTabIds, newTab.id],
        });
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
        const state = get();
        const tab = state.tabs.find((t) => t.id === id);
        if (!tab || !tab.closeable) return;

        // Drop any registered close interceptor for this tab.
        closeInterceptors.delete(id);

        const removedPane = tab.paneId;
        const newTabs = state.tabs.filter((t) => t.id !== id);
        const newLoaded = state.loadedTabIds.filter((tid) => tid !== id);

        let activeTabId = state.activeTabId;
        let activeSplitTabId = state.activeSplitTabId;
        let splitOrientation = state.splitOrientation;
        let focusedPaneId = state.focusedPaneId;

        if (removedPane === 'main' && state.activeTabId === id) {
          activeTabId = neighborInPane(newTabs, id, 'main') ?? HOME_TAB.id;
        }
        if (removedPane === 'split' && state.activeSplitTabId === id) {
          activeSplitTabId = neighborInPane(newTabs, id, 'split');
        }

        // If the split pane is empty, collapse the split.
        const stillSplit = newTabs.some((t) => t.paneId === 'split');
        if (!stillSplit) {
          activeSplitTabId = null;
          splitOrientation = null;
          focusedPaneId = 'main';
        }

        // Guard: never let the tab list be fully empty.
        if (newTabs.length === 0) {
          set({
            tabs: [HOME_TAB],
            activeTabId: HOME_TAB.id,
            activeSplitTabId: null,
            splitOrientation: null,
            focusedPaneId: 'main',
            loadedTabIds: [HOME_TAB.id],
          });
          return;
        }

        // Make sure the chosen active tab is loaded.
        const ensureLoaded = (loaded: string[], id: string | null) =>
          id && !loaded.includes(id) ? [...loaded, id] : loaded;
        const loaded = ensureLoaded(ensureLoaded(newLoaded, activeTabId), activeSplitTabId);

        set({
          tabs: newTabs,
          activeTabId,
          activeSplitTabId,
          splitOrientation,
          focusedPaneId,
          loadedTabIds: loaded,
        });
      },

      setActiveTab: (id) => {
        const state = get();
        const tab = state.tabs.find((t) => t.id === id);
        if (!tab) return;
        const loaded = state.loadedTabIds.includes(id)
          ? state.loadedTabIds
          : [...state.loadedTabIds, id];
        if (tab.paneId === 'main') {
          if (state.activeTabId === id && state.focusedPaneId === 'main') return;
          set({ activeTabId: id, focusedPaneId: 'main', loadedTabIds: loaded });
        } else {
          if (state.activeSplitTabId === id && state.focusedPaneId === 'split') return;
          set({ activeSplitTabId: id, focusedPaneId: 'split', loadedTabIds: loaded });
        }
      },

      setFocusedPane: (paneId) => {
        const state = get();
        if (state.focusedPaneId === paneId) return;
        // Switching focus to the split pane is only meaningful when it exists.
        if (paneId === 'split' && state.splitOrientation === null) return;
        set({ focusedPaneId: paneId });
      },

      reorderTab: (draggedId, targetTabId, edge) => {
        const state = get();
        if (draggedId === targetTabId) return;
        const dragged = state.tabs.find((t) => t.id === draggedId);
        const target = state.tabs.find((t) => t.id === targetTabId);
        if (!dragged || !target) return;

        // Mirror the moveTabToPane guard: never let a cross-pane reorder
        // empty the main pane, which would otherwise leave the layout with
        // a blank main pane next to a populated split pane.
        if (dragged.paneId === 'main' && target.paneId !== 'main') {
          const otherMainTabs = state.tabs.filter((t) => t.paneId === 'main' && t.id !== draggedId);
          if (otherMainTabs.length === 0) return;
        }

        const next = state.tabs.filter((t) => t.id !== draggedId);
        const insertAt = next.findIndex((t) => t.id === targetTabId) + (edge === 'after' ? 1 : 0);
        const reassigned: ProTab = dragged.paneId === target.paneId
          ? dragged
          : { ...dragged, paneId: target.paneId };
        next.splice(insertAt, 0, reassigned);

        // If the dragged tab was active in its old pane and just moved to a
        // different pane, fix up the active ids so the empty side doesn't
        // hang on to a stale id.
        const patch: Partial<ProTabState> = { tabs: next };
        if (dragged.paneId !== target.paneId) {
          if (dragged.paneId === 'main' && state.activeTabId === draggedId) {
            patch.activeTabId = neighborInPane(next, draggedId, 'main') ?? HOME_TAB.id;
          }
          if (dragged.paneId === 'split' && state.activeSplitTabId === draggedId) {
            patch.activeSplitTabId = neighborInPane(next, draggedId, 'split');
          }
          // Make the dragged tab active in its new home.
          if (target.paneId === 'main') {
            patch.activeTabId = draggedId;
            patch.focusedPaneId = 'main';
          } else {
            patch.activeSplitTabId = draggedId;
            patch.focusedPaneId = 'split';
          }
          // Collapse the split if it just emptied.
          const stillSplit = next.some((t) => t.paneId === 'split');
          if (!stillSplit) {
            patch.activeSplitTabId = null;
            patch.splitOrientation = null;
            patch.focusedPaneId = 'main';
          }
        }
        set(patch);
      },

      moveTabToPane: (tabId, paneId, orientation) => {
        const state = get();
        const tab = state.tabs.find((t) => t.id === tabId);
        if (!tab) return;
        if (tab.paneId === paneId) return;

        // The home tab can move freely (and the unsplit guard below restores
        // sanity), but if moving it would leave main empty we prevent it.
        const movingFromMain = tab.paneId === 'main';
        if (movingFromMain) {
          const otherMainTabs = state.tabs.filter((t) => t.paneId === 'main' && t.id !== tabId);
          if (otherMainTabs.length === 0) return; // refuse to empty main
        }

        const newTabs = state.tabs.map((t) => t.id === tabId ? { ...t, paneId } : t);

        const patch: Partial<ProTabState> = { tabs: newTabs };

        if (paneId === 'split') {
          // Creating or extending a split.
          patch.splitOrientation = state.splitOrientation ?? orientation ?? 'vertical';
          patch.activeSplitTabId = tabId;
          patch.focusedPaneId = 'split';
          // If main lost its active tab, pick a neighbor.
          if (state.activeTabId === tabId) {
            patch.activeTabId = neighborInPane(newTabs, tabId, 'main') ?? HOME_TAB.id;
          }
        } else {
          patch.activeTabId = tabId;
          patch.focusedPaneId = 'main';
          if (state.activeSplitTabId === tabId) {
            patch.activeSplitTabId = neighborInPane(newTabs, tabId, 'split');
          }
          // Collapse if split just emptied.
          const stillSplit = newTabs.some((t) => t.paneId === 'split');
          if (!stillSplit) {
            patch.activeSplitTabId = null;
            patch.splitOrientation = null;
          }
        }

        const loaded = state.loadedTabIds.includes(tabId)
          ? state.loadedTabIds
          : [...state.loadedTabIds, tabId];
        patch.loadedTabIds = loaded;

        set(patch);
      },

      collapseSplit: () => {
        const state = get();
        if (state.splitOrientation === null) return;
        const newTabs = state.tabs.map((t) =>
          t.paneId === 'split' ? { ...t, paneId: 'main' as const } : t
        );
        set({
          tabs: newTabs,
          activeSplitTabId: null,
          splitOrientation: null,
          focusedPaneId: 'main',
        });
      },

      updateTabTitle: (id, title) => {
        const state = get();
        const tabs = state.tabs.map((tab) =>
          tab.id === id ? { ...tab, title } : tab
        );
        set({ tabs });
      },

      updateComposeDraft: (id, draft) => {
        const state = get();
        const tabs = state.tabs.map((tab) => {
          if (tab.id !== id || tab.kind !== 'compose' || !tab.composeData) return tab;
          return {
            ...tab,
            composeData: { ...tab.composeData, initialData: draft },
          };
        });
        set({ tabs });
      },
    }),
    {
      name: 'pro-tabs',
      version: 3,
      // Don't persist transient compose drafts in tab metadata - the composer's
      // own draft-store already handles that. Persisted email tabs are fine to
      // restore (the tab body refetches the email by id).
      partialize: (state) => ({
        tabs: state.tabs
          .filter((tab) => tab.kind !== 'compose')
          .map((tab) => tab.kind === 'compose'
            ? { ...tab, composeData: undefined }
            : tab),
        activeTabId: state.activeTabId,
        activeSplitTabId: state.activeSplitTabId,
        splitOrientation: state.splitOrientation,
        focusedPaneId: state.focusedPaneId,
        loadedTabIds: state.loadedTabIds,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Backfill paneId in case the user upgrades from version 2.
        state.tabs = state.tabs.map((tab) => tab.paneId ? tab : { ...tab, paneId: 'main' as const });
        if (state.tabs.length === 0) {
          state.tabs = [HOME_TAB];
          state.activeTabId = HOME_TAB.id;
          state.activeSplitTabId = null;
          state.splitOrientation = null;
          state.focusedPaneId = 'main';
          state.loadedTabIds = [HOME_TAB.id];
          return;
        }
        // Heal broken state where every tab ended up on the split pane:
        // collapse the split so the surviving tabs return to main, otherwise
        // the layout would render an empty main pane next to the split.
        if (!state.tabs.some((t) => t.paneId === 'main')) {
          state.tabs = state.tabs.map((t) => ({ ...t, paneId: 'main' as const }));
          state.activeSplitTabId = null;
          state.splitOrientation = null;
          state.focusedPaneId = 'main';
        }
        if (!state.tabs.some((t) => t.id === state.activeTabId && t.paneId === 'main')) {
          state.activeTabId = state.tabs.find((t) => t.paneId === 'main')?.id ?? HOME_TAB.id;
        }
        if (state.activeSplitTabId !== null && !state.tabs.some((t) => t.id === state.activeSplitTabId && t.paneId === 'split')) {
          state.activeSplitTabId = state.tabs.find((t) => t.paneId === 'split')?.id ?? null;
        }
        if (state.activeSplitTabId === null) {
          state.splitOrientation = null;
          state.focusedPaneId = 'main';
        }
        if (!state.loadedTabIds.includes(state.activeTabId)) {
          state.loadedTabIds = [...state.loadedTabIds, state.activeTabId];
        }
        if (state.activeSplitTabId && !state.loadedTabIds.includes(state.activeSplitTabId)) {
          state.loadedTabIds = [...state.loadedTabIds, state.activeSplitTabId];
        }
      },
    },
  ),
);
