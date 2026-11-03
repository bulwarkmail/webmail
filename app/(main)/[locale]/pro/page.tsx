"use client";

import { useEffect, useMemo, useState, type ComponentType, type DragEvent } from "react";
import { useTranslations } from "next-intl";
import { NavigationRail } from "@/components/layout/navigation-rail";
import { KeyboardShortcutsModal } from "@/components/keyboard-shortcuts-modal";
import { SidebarAppsModal } from "@/components/layout/sidebar-apps-modal";
import { InlineAppView } from "@/components/layout/inline-app-view";
import { useSidebarApps } from "@/hooks/use-sidebar-apps";
import { useAuthStore, redirectToLogin } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useDeviceDetection } from "@/hooks/use-media-query";
import { EmbeddedContext } from "@/hooks/use-is-embedded";
import { OrgAnnouncement } from "@/components/org/org-announcement";
import { PaneSizeContext } from "@/hooks/use-pane-size";
import { PaneIdContext, ProTabFocusContext } from "@/hooks/use-pane-context";
import { useDeepLinkUrl } from "@/hooks/use-deep-link-url";
import { appPath, buildMailPath } from "@/lib/deep-links";
import { GlobalSearchPalette } from "@/components/global-search/global-search-palette";
import { SearchTabBody } from "@/components/global-search/search-tab-body";
import { useGlobalSearchStore } from "@/stores/global-search-store";
import { ProTabBar } from "@/components/pro/pro-tab-bar";
import {
  PRO_TAB_DRAG_MIME,
  EMAIL_IDS_DRAG_MIME,
  MAILBOX_DRAG_MIME,
  dragKindFromTypes,
  parseEmailIdsPayload,
  parseMailboxDragPayload,
  resolveBodyDropTarget,
  type BodyDropTarget,
  type MailboxDragPayload,
} from "@/components/pro/pro-shell-drop";
import { useProTabStore, type ProTab, type ProTabKind, type ProPaneId, type ProSplitSide } from "@/stores/pro-tab-store";
import { cn } from "@/lib/utils";
import { getPathPrefix } from "@/lib/browser-navigation";
import { onOpenEmail, proEmailTabOpener } from "@/lib/plugin-sandbox/open-email";
import { ProSkeleton } from "@/components/boot-skeleton/pro-skeleton";
import { useSkeletonLabels } from "@/components/boot-skeleton/use-skeleton-labels";

import { MailApp } from "@/components/mail/mail-app";
import { CalendarApp } from "@/components/calendar/calendar-app";
import { ContactsApp } from "@/components/contacts/contacts-app";
import { FilesApp } from "@/components/files/files-app";
import { SettingsApp } from "@/components/settings/settings-app";
import { ProComposeTabBody } from "@/components/pro/pro-compose-tab-body";
import { ProEmailTabBody } from "@/components/pro/pro-email-tab-body";
import { ProFolderTabBody } from "@/components/pro/pro-folder-tab-body";

// Each surface renders the same component the standard routes do. Deep links
// reach them through the handoff ProInterfaceRedirect parks (#733), not as
// props - Pro tabs have no route of their own.
const APP_TAB_COMPONENTS: Partial<Record<ProTabKind, ComponentType>> = {
  mail: MailApp,
  calendar: CalendarApp,
  contacts: ContactsApp,
  files: FilesApp,
  settings: SettingsApp,
};

function renderTabBody(tab: ProTab): React.ReactNode {
  if (tab.kind === 'compose' && tab.composeData) {
    return <ProComposeTabBody tabId={tab.id} data={tab.composeData} />;
  }
  if (tab.kind === 'email' && tab.emailData) {
    return <ProEmailTabBody tabId={tab.id} data={tab.emailData} />;
  }
  if (tab.kind === 'folder' && tab.folderData) {
    return <ProFolderTabBody tabId={tab.id} data={tab.folderData} />;
  }
  if (tab.kind === 'search' && tab.searchData) {
    return <SearchTabBody tabId={tab.id} data={tab.searchData} />;
  }
  const Component = APP_TAB_COMPONENTS[tab.kind];
  return Component ? <Component /> : null;
}

/**
 * Open dragged emails as Pro tabs in `pane`. A single email reuses the
 * shared reader tab (so repeated drags/double-clicks drive one tab); a
 * multi-selection opens one tab per message, capped so a stray
 * select-all drag can't explode the tab strip.
 */
function openDroppedEmails(
  emailIds: string[],
  pane: ProPaneId,
  side: ProSplitSide | undefined,
  fallbackTitle: string,
) {
  const { setSplitSide, openEmailTab } = useProTabStore.getState();
  const known = useEmailStore.getState().emails;
  const targets = emailIds
    .map((id) => known.find((e) => e.id === id))
    .filter((e): e is NonNullable<typeof e> => !!e)
    .slice(0, 10);
  if (targets.length === 0) return;
  if (side) setSplitSide(side);
  const reuseReader = targets.length === 1;
  for (const email of targets) {
    openEmailTab(
      {
        accountId: email.accountId ?? '',
        emailId: email.id,
        mailboxId: null,
        title: email.subject?.trim() || fallbackTitle,
      },
      { pane, reuseReader },
    );
  }
}

/** Open a dragged sidebar folder as a folder tab in `pane`. */
function openDroppedFolder(
  payload: MailboxDragPayload,
  pane: ProPaneId,
  side: ProSplitSide | undefined,
) {
  const { setSplitSide, openFolderTab } = useProTabStore.getState();
  if (side) setSplitSide(side);
  openFolderTab(
    { accountId: payload.accountId, mailboxId: payload.mailboxId, title: payload.name },
    { pane },
  );
}

interface PaneProps {
  paneId: ProPaneId;
  tabs: ProTab[];
  activeTabId: string | null;
  loadedTabIds: string[];
  onPaneFocus: (paneId: ProPaneId) => void;
  isFocused: boolean;
}

function Pane({ paneId, tabs, activeTabId, loadedTabIds, onPaneFocus, isFocused }: PaneProps) {
  // Held in state (not a ref) so the ResizeObserver effect re-runs once the
  // element exists.
  const [paneEl, setPaneEl] = useState<HTMLDivElement | null>(null);
  // Measured pane width, published to children via PaneSizeContext so that
  // useDeviceDetection / useIsMobile / etc. branch on pane width - not full
  // viewport - and inner pages collapse to their mobile/tablet layouts when
  // the pane is narrow.
  const [paneWidth, setPaneWidth] = useState<number | null>(null);

  useEffect(() => {
    if (!paneEl || typeof ResizeObserver === "undefined") return;
    const initialRect = paneEl.getBoundingClientRect();
    if (initialRect.width > 0) setPaneWidth(initialRect.width);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = entry.contentRect.width;
      setPaneWidth((prev) => (prev !== null && Math.abs(prev - w) < 0.5 ? prev : w));
    });
    ro.observe(paneEl);
    return () => ro.disconnect();
  }, [paneEl]);

  return (
    <div
      ref={setPaneEl}
      className="relative flex flex-1 flex-col overflow-hidden min-w-0 min-h-0"
      onMouseDownCapture={() => { if (!isFocused) onPaneFocus(paneId); }}
    >
      <PaneIdContext.Provider value={paneId}>
        <PaneSizeContext.Provider value={paneWidth}>
          {tabs
            .filter((tab) => loadedTabIds.includes(tab.id))
            .map((tab) => {
              const isActive = tab.id === activeTabId;
              return (
                <div
                  key={tab.id}
                  className={cn("absolute inset-0 overflow-hidden", !isActive && "hidden")}
                  aria-hidden={!isActive}
                >
                  {/* Exactly one tab across both panes is "focused" - it owns
                      shared single-instance concerns like the address bar. */}
                  <ProTabFocusContext.Provider value={isActive && isFocused}>
                    {renderTabBody(tab)}
                  </ProTabFocusContext.Provider>
                </div>
              );
            })}
        </PaneSizeContext.Provider>
      </PaneIdContext.Provider>
    </div>
  );
}

export default function ProHome() {
  const t = useTranslations();
  const { label: skeletonLabel } = useSkeletonLabels();
  const { isMobile, isTablet, isDesktop } = useDeviceDetection();

  const [initialCheckDone, setInitialCheckDone] = useState(
    () => useAuthStore.getState().isAuthenticated && !!useAuthStore.getState().client
  );
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const {
    showAppsModal,
    inlineApp,
    loadedApps,
    handleManageApps,
    handleInlineApp,
    closeInlineApp,
    closeAppsModal,
  } = useSidebarApps();

  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const client = useAuthStore((s) => s.client);
  const logout = useAuthStore((s) => s.logout);
  const checkAuth = useAuthStore((s) => s.checkAuth);
  const authLoading = useAuthStore((s) => s.isLoading);
  const quota = useEmailStore((s) => s.quota);
  const isPushConnected = useEmailStore((s) => s.isPushConnected);
  const proInterface = useSettingsStore((s) => s.proInterface);

  const tabs = useProTabStore((s) => s.tabs);
  const activeMainTabId = useProTabStore((s) => s.activeTabId);
  const activeSplitTabId = useProTabStore((s) => s.activeSplitTabId);
  const focusedPaneId = useProTabStore((s) => s.focusedPaneId);
  const splitSide = useProTabStore((s) => s.splitSide);
  const loadedTabIds = useProTabStore((s) => s.loadedTabIds);
  const openTab = useProTabStore((s) => s.openTab);
  const requestCloseTab = useProTabStore((s) => s.requestCloseTab);
  const setActiveTab = useProTabStore((s) => s.setActiveTab);
  const setFocusedPane = useProTabStore((s) => s.setFocusedPane);
  const moveTabToPane = useProTabStore((s) => s.moveTabToPane);

  /** Tab id currently being dragged from either strip, if any. */
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [bodyDropTarget, setBodyDropTarget] = useState<BodyDropTarget>(null);

  // Auth bootstrap (mirrors standard page)
  useEffect(() => {
    const state = useAuthStore.getState();
    if (state.isAuthenticated && state.client) {
      setInitialCheckDone(true);
      return;
    }
    checkAuth().finally(() => {
      setInitialCheckDone(true);
    });
  }, [checkAuth]);

  useEffect(() => {
    if (initialCheckDone && !isAuthenticated && !authLoading) {
      redirectToLogin();
    }
  }, [initialCheckDone, isAuthenticated, authLoading]);

  useEffect(() => {
    if (!initialCheckDone || typeof window === "undefined") return;
    // Pro is desktop-only, and only used when the user has explicitly
    // enabled it. If either precondition stops holding, hand the user back
    // to the standard shell - on the surface they were just using, so
    // switching Pro off from Settings lands back in Settings rather than
    // on the mail list. Read imperatively: the focused tab must not retrigger
    // this effect, it only matters at the moment a precondition flips.
    if (isMobile || isTablet || !proInterface) {
      const { tabs: allTabs, focusedPaneId: pane, activeTabId, activeSplitTabId } = useProTabStore.getState();
      const focusedId = pane === 'split' ? activeSplitTabId : activeTabId;
      const kind = allTabs.find((tab) => tab.id === focusedId)?.kind;
      const surface = kind === 'calendar' || kind === 'contacts' || kind === 'files' || kind === 'settings'
        ? `/${kind}`
        : '/';
      window.location.replace(`${getPathPrefix()}${surface}`);
    }
  }, [initialCheckDone, isMobile, isTablet, proInterface]);

  const mainTabs = useMemo(() => tabs.filter((t) => t.paneId === 'main'), [tabs]);
  const splitTabs = useMemo(() => tabs.filter((t) => t.paneId === 'split'), [tabs]);
  const isSplit = splitTabs.length > 0;

  const focusedActiveTab = useMemo(() => {
    const id = focusedPaneId === 'main' ? activeMainTabId : activeSplitTabId;
    return tabs.find((t) => t.id === id) ?? null;
  }, [tabs, focusedPaneId, activeMainTabId, activeSplitTabId]);

  // ---- Address bar: reflect the focused tab's permalink ----
  // Mail-family tabs are reflected here (MailApp's own URL machinery is
  // suppressed when embedded); calendar/contacts/files/settings write their
  // own, more precise paths via useDeepLinkUrl gated on ProTabFocusContext.
  // replaceState only, and ProInterfaceRedirect doesn't observe it - a reload
  // of the shown URL goes through the redirect's handoff and restores the view.
  const selectedMailbox = useEmailStore((s) => s.selectedMailbox);
  const selectedEmailId = useEmailStore((s) => s.selectedEmail?.id ?? null);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const accountMailboxes = useEmailStore((s) => s.accountMailboxes);
  const reflectedPath = useMemo(() => {
    if (!isAuthenticated || !client || !focusedActiveTab) return null;
    switch (focusedActiveTab.kind) {
      case 'mail':
        return appPath(buildMailPath(
          { mailboxId: selectedMailbox || null, emailId: selectedEmailId, threadId: null },
          mailboxes,
        ));
      case 'email':
        return focusedActiveTab.emailData
          ? appPath(buildMailPath({ mailboxId: null, emailId: focusedActiveTab.emailData.emailId, threadId: null }))
          : null;
      case 'folder': {
        const data = focusedActiveTab.folderData;
        if (!data) return null;
        const list = data.accountId ? accountMailboxes[data.accountId] ?? [] : mailboxes;
        const path = appPath(buildMailPath({ mailboxId: data.mailboxId, emailId: null, threadId: null }, list));
        return data.accountId ? `${path}?account=${encodeURIComponent(data.accountId)}` : path;
      }
      case 'compose':
      case 'search':
        // Neither a draft nor a search-results tab has a permalink - fall
        // back to the shell's own route so the bar never shows a message the
        // user is no longer looking at.
        return appPath('/pro');
      default:
        return null;
    }
  }, [isAuthenticated, client, focusedActiveTab, selectedMailbox, selectedEmailId, mailboxes, accountMailboxes]);
  useDeepLinkUrl(reflectedPath);

  // Global search shortcuts: Ctrl/⌘+K toggles the palette, Ctrl+Shift+F
  // opens it (features doc §"Focus global search"). Window-level and keyed on
  // event.code so they fire from inside inputs and on non-Latin layouts.
  useEffect(() => {
    const onSearchShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.code === 'KeyK' && !event.shiftKey) {
        event.preventDefault();
        useGlobalSearchStore.getState().togglePalette();
      } else if (event.code === 'KeyF' && event.shiftKey) {
        event.preventDefault();
        useGlobalSearchStore.getState().openPalette();
      }
    };
    window.addEventListener('keydown', onSearchShortcut);
    return () => window.removeEventListener('keydown', onSearchShortcut);
  }, []);

  // A plugin opening a message (api.ui.openEmail) gets an email tab, as a
  // message link does here: the mail tab stays mounted while hidden, so its
  // reader is not one the user would see.
  const loadingTitle = t('common.loading');
  useEffect(() => onOpenEmail(proEmailTabOpener(loadingTitle)), [loadingTitle]);

  const handleRailNavigate = (itemId: 'mail' | 'calendar' | 'contacts' | 'files' | 'settings') => {
    openTab(itemId);
    return true;
  };

  const railActiveItemId: 'mail' | 'calendar' | 'contacts' | 'files' | 'settings' | null =
    focusedActiveTab && (
      focusedActiveTab.kind === 'mail' || focusedActiveTab.kind === 'calendar'
      || focusedActiveTab.kind === 'contacts' || focusedActiveTab.kind === 'files'
      || focusedActiveTab.kind === 'settings'
    ) ? focusedActiveTab.kind : null;

  // ---- Body-level drop targets (tab drags and email drags) ----

  const emailFallbackTitle = t('email_composer.new_message');

  const resolveTargetForEvent = (e: DragEvent<HTMLDivElement>): BodyDropTarget => {
    const kind = dragKindFromTypes(e.dataTransfer.types);
    if (!kind) return null;
    const rect = e.currentTarget.getBoundingClientRect();
    const xFrac = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
    return resolveBodyDropTarget({
      xFrac,
      isSplit,
      splitSide,
      kind,
      // A tab can only create a split if another tab stays behind; emails
      // and folders always can (their source surface keeps existing).
      canCreateSplit: kind === 'tab' ? tabs.length > 1 : true,
      draggedTabPane: kind === 'tab'
        ? (tabs.find((t) => t.id === draggedTabId)?.paneId ?? null)
        : null,
    });
  };

  const sameTarget = (a: BodyDropTarget, b: BodyDropTarget) =>
    a === b || (!!a && !!b && a.type === b.type && a.side === b.side
      && (a.type !== 'pane' || b.type !== 'pane' || a.pane === b.pane));

  const handleBodyDragOver = (e: DragEvent<HTMLDivElement>) => {
    // Something inside the pane (a folder drop target, a tab strip) already
    // claimed this position - stand down so we never double-handle.
    if (e.defaultPrevented) {
      if (bodyDropTarget) setBodyDropTarget(null);
      return;
    }
    const kind = dragKindFromTypes(e.dataTransfer.types);
    if (!kind) return;
    const target = resolveTargetForEvent(e);
    if (!target) {
      // Not calling preventDefault leaves the browser's no-drop feedback in
      // place - an illegal drop is visibly illegal, never a silent no-op.
      if (bodyDropTarget) setBodyDropTarget(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = kind === 'tab' ? 'move' : 'copy';
    setBodyDropTarget((prev) => (sameTarget(prev, target) ? prev : target));
  };

  const handleBodyDragLeave = (e: DragEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setBodyDropTarget(null);
  };

  const handleBodyDrop = (e: DragEvent<HTMLDivElement>) => {
    setBodyDropTarget(null);
    if (e.defaultPrevented) return;
    const kind = dragKindFromTypes(e.dataTransfer.types);
    if (!kind) return;
    const target = resolveTargetForEvent(e);
    setDraggedTabId(null);
    if (!target) return;
    e.preventDefault();

    if (kind === 'tab') {
      const draggedId = e.dataTransfer.getData(PRO_TAB_DRAG_MIME);
      if (!draggedId) return;
      if (target.type === 'create-split') {
        moveTabToPane(draggedId, 'split', { side: target.side });
      } else {
        moveTabToPane(draggedId, target.pane);
      }
      return;
    }

    if (kind === 'folder') {
      const payload = parseMailboxDragPayload(e.dataTransfer.getData(MAILBOX_DRAG_MIME));
      if (!payload) return;
      if (target.type === 'create-split') {
        openDroppedFolder(payload, 'split', target.side);
      } else {
        openDroppedFolder(payload, target.pane, undefined);
      }
      return;
    }

    const ids = parseEmailIdsPayload(e.dataTransfer.getData(EMAIL_IDS_DRAG_MIME));
    if (ids.length === 0) return;
    if (target.type === 'create-split') {
      openDroppedEmails(ids, 'split', target.side, emailFallbackTitle);
    } else {
      openDroppedEmails(ids, target.pane, undefined, emailFallbackTitle);
    }
  };

  // A tab being dragged is the shell's business wherever it goes, except onto
  // a tab strip: no surface takes tabs, and many drop handlers (settings rows,
  // address books, calendar days) stop or claim whatever crosses them. So the
  // shell answers on the way down, before they see it. Messages and folders
  // stay on the way up: a folder row in a pane is a real target for those.
  const isTabDragOffStrip = (e: DragEvent<HTMLDivElement>) =>
    dragKindFromTypes(e.dataTransfer.types) === 'tab'
    && !(e.target instanceof Element && e.target.closest('[data-pane-strip]'));

  const handleBodyDragOverCapture = (e: DragEvent<HTMLDivElement>) => {
    if (!isTabDragOffStrip(e)) return;
    e.stopPropagation();
    handleBodyDragOver(e);
  };

  const handleBodyDropCapture = (e: DragEvent<HTMLDivElement>) => {
    if (!isTabDragOffStrip(e)) return;
    e.stopPropagation();
    handleBodyDrop(e);
  };

  // Until the session is up: the same skeleton the server drew, so hydration
  // matches and nothing moves. Below desktop width the effect above is about
  // to send the visitor to the standard page; keep the skeleton up meanwhile
  // rather than a blank page.
  if (!initialCheckDone || authLoading || !isAuthenticated || !client || !isDesktop) {
    return <ProSkeleton label={skeletonLabel} />;
  }

  // Each pane renders as a column: its own tab strip directly above its
  // body, so a tab visibly belongs to the pane beneath it and clicking a
  // tab only ever changes that pane.
  //
  // Stable keys are essential: when the split collapses, the row's child
  // list changes shape. Without keys, React would reuse the column at
  // index 0 - repurposing the *split* pane's instance into the main pane,
  // which strands the main pane's ResizeObserver/paneWidth on a now-
  // unmounted DOM node and reparents the mail tab body (causing remount
  // + stale "still-narrow" measurements after the split is closed).
  const renderColumn = (paneId: ProPaneId) => (
    <div key={`col-${paneId}`} className="flex flex-1 flex-col overflow-hidden min-w-0 min-h-0">
      <ProTabBar
        paneId={paneId}
        tabs={paneId === 'main' ? mainTabs : splitTabs}
        activeTabId={paneId === 'main' ? activeMainTabId : activeSplitTabId}
        isFocused={focusedPaneId === paneId}
        onActivate={setActiveTab}
        onClose={requestCloseTab}
        onDragStateChange={(dragging, tabId) => setDraggedTabId(dragging ? tabId : null)}
        onEmailDrop={(ids) => openDroppedEmails(ids, paneId, undefined, emailFallbackTitle)}
        onFolderDrop={(payload) => openDroppedFolder(payload, paneId, undefined)}
      />
      <Pane
        paneId={paneId}
        tabs={paneId === 'main' ? mainTabs : splitTabs}
        activeTabId={paneId === 'main' ? activeMainTabId : activeSplitTabId}
        loadedTabIds={loadedTabIds}
        onPaneFocus={setFocusedPane}
        isFocused={focusedPaneId === paneId}
      />
    </div>
  );

  const splitDivider = isSplit ? (
    <div
      key="pane-divider"
      aria-hidden="true"
      className="flex-shrink-0 w-px bg-transparent"
      style={{ borderLeft: '1px solid rgba(128, 128, 128, 0.3)' }}
    />
  ) : null;

  // Drop-zone overlay: a half-body preview of where the dragged tab/email
  // would land, driven by the same resolver that performs the drop.
  const dropZone = bodyDropTarget ? <DropZone side={bodyDropTarget.side} /> : null;

  return (
    <EmbeddedContext.Provider value={true}>
      {/* data-pro-shell: a page skeleton inside a pane draws its own frame, not the Pro one. */}
      <div data-pro-shell="" className="flex flex-col h-dvh bg-background overflow-hidden pt-[env(safe-area-inset-top)]">
        {/* Once for the whole shell: email and folder tabs have no app strip, and split panes would show it twice. */}
        <OrgAnnouncement />
        <div className="flex flex-1 overflow-hidden">
          {/* Leftmost Navigation Rail - identical to the standard layout */}
          <div
            className="w-14 bg-secondary flex flex-col flex-shrink-0"
            style={{ borderInlineEnd: '1px solid rgba(128, 128, 128, 0.3)' }}
          >
            <NavigationRail
              collapsed
              quota={quota}
              isPushConnected={isPushConnected}
              onLogout={logout}
              onShowShortcuts={() => setShowShortcutsModal(true)}
              onManageApps={handleManageApps}
              onInlineApp={handleInlineApp}
              onCloseInlineApp={closeInlineApp}
              activeAppId={inlineApp?.id ?? null}
              onNavigate={handleRailNavigate}
              activeItemId={railActiveItemId}
              onOpenSearch={() => useGlobalSearchStore.getState().openPalette()}
            />
          </div>

          {inlineApp && (
            <InlineAppView
              apps={loadedApps}
              activeAppId={inlineApp.id}
              onClose={closeInlineApp}
              className="flex-1"
            />
          )}

          {!inlineApp && (
            // The split's side and the drop zones are physical (left, right),
            // so the row must not flip in RTL: a drop on the right went left.
            <div
              className="relative flex flex-row rtl:flex-row-reverse flex-1 overflow-hidden min-w-0"
              onDragOverCapture={handleBodyDragOverCapture}
              onDropCapture={handleBodyDropCapture}
              onDragOver={handleBodyDragOver}
              onDragLeave={handleBodyDragLeave}
              onDrop={handleBodyDrop}
            >
              {isSplit
                ? (splitSide === 'left'
                    ? <>{renderColumn('split')}{splitDivider}{renderColumn('main')}</>
                    : <>{renderColumn('main')}{splitDivider}{renderColumn('split')}</>)
                : renderColumn('main')}

              {dropZone}
            </div>
          )}
        </div>

        <GlobalSearchPalette />

        <KeyboardShortcutsModal
          isOpen={showShortcutsModal}
          onClose={() => setShowShortcutsModal(false)}
        />
        {showAppsModal && (
          <SidebarAppsModal isOpen={showAppsModal} onClose={closeAppsModal} />
        )}
      </div>
    </EmbeddedContext.Provider>
  );
}

function DropZone({ side }: { side: 'left' | 'right' }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute top-0 bottom-0 w-1/2 z-10",
        "bg-primary/15 ring-2 ring-primary/40 ring-inset",
        side === 'left' ? "left-0" : "right-0",
      )}
    />
  );
}
