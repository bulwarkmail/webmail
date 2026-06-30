"use client";

import { useEffect, useMemo, useRef, useState, type ComponentType, type DragEvent } from "react";
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
import { PaneSizeContext } from "@/hooks/use-pane-size";
import { ProTabBar, PRO_TAB_DRAG_MIME } from "@/components/pro/pro-tab-bar";
import { useProTabStore, type ProTab, type ProTabKind, type ProPaneId } from "@/stores/pro-tab-store";
import { cn } from "@/lib/utils";
import { getPathPrefix } from "@/lib/browser-navigation";

import MailPage from "@/app/(main)/[locale]/page";
import CalendarPage from "@/app/(main)/[locale]/calendar/page";
import ContactsPage from "@/app/(main)/[locale]/contacts/page";
import FilesPage from "@/app/(main)/[locale]/files/page";
import SettingsPage from "@/app/(main)/[locale]/settings/page";
import { ProComposeTabBody } from "@/components/pro/pro-compose-tab-body";
import { ProEmailTabBody } from "@/components/pro/pro-email-tab-body";

const APP_TAB_COMPONENTS: Partial<Record<ProTabKind, ComponentType>> = {
  mail: MailPage,
  calendar: CalendarPage,
  contacts: ContactsPage,
  files: FilesPage,
  settings: SettingsPage,
};

type DropTarget = 'left' | 'right' | null;

function renderTabBody(tab: ProTab): React.ReactNode {
  if (tab.kind === 'compose' && tab.composeData) {
    return <ProComposeTabBody tabId={tab.id} data={tab.composeData} />;
  }
  if (tab.kind === 'email' && tab.emailData) {
    return <ProEmailTabBody tabId={tab.id} data={tab.emailData} />;
  }
  const Component = APP_TAB_COMPONENTS[tab.kind];
  return Component ? <Component /> : null;
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
  const paneRef = useRef<HTMLDivElement | null>(null);
  // Measured pane width, published to children via PaneSizeContext so that
  // useDeviceDetection / useIsMobile / etc. branch on pane width - not full
  // viewport - and inner pages collapse to their mobile/tablet layouts when
  // the pane is narrow.
  const [paneWidth, setPaneWidth] = useState<number | null>(null);

  useEffect(() => {
    const el = paneRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const initialRect = el.getBoundingClientRect();
    if (initialRect.width > 0) setPaneWidth(initialRect.width);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = entry.contentRect.width;
      setPaneWidth((prev) => (prev !== null && Math.abs(prev - w) < 0.5 ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={paneRef}
      className="relative flex flex-1 flex-col overflow-hidden min-w-0 min-h-0"
      onMouseDownCapture={() => { if (!isFocused) onPaneFocus(paneId); }}
    >
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
                {renderTabBody(tab)}
              </div>
            );
          })}
      </PaneSizeContext.Provider>
    </div>
  );
}

export default function ProHome() {
  const t = useTranslations();
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
  const splitOrientation = useProTabStore((s) => s.splitOrientation);
  const focusedPaneId = useProTabStore((s) => s.focusedPaneId);
  const loadedTabIds = useProTabStore((s) => s.loadedTabIds);
  const openTab = useProTabStore((s) => s.openTab);
  const requestCloseTab = useProTabStore((s) => s.requestCloseTab);
  const setActiveTab = useProTabStore((s) => s.setActiveTab);
  const setFocusedPane = useProTabStore((s) => s.setFocusedPane);
  const moveTabToPane = useProTabStore((s) => s.moveTabToPane);

  const [isTabDragging, setIsTabDragging] = useState(false);
  const [splitDropTarget, setSplitDropTarget] = useState<DropTarget>(null);
  /** Whether the split pane visually renders before (true) or after (false) main. */
  const [splitLeading, setSplitLeading] = useState(false);

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
    // to the standard shell.
    if (isMobile || isTablet || !proInterface) {
      window.location.replace(`${getPathPrefix()}/`);
    }
  }, [initialCheckDone, isMobile, isTablet, proInterface]);

  const mainTabs = useMemo(() => tabs.filter((t) => t.paneId === 'main'), [tabs]);
  const splitTabs = useMemo(() => tabs.filter((t) => t.paneId === 'split'), [tabs]);

  const focusedActiveTab = useMemo(() => {
    const id = focusedPaneId === 'main' ? activeMainTabId : activeSplitTabId;
    return tabs.find((t) => t.id === id) ?? null;
  }, [tabs, focusedPaneId, activeMainTabId, activeSplitTabId]);

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

  const isSplit = splitOrientation !== null && splitTabs.length > 0;

  // ---- Body-level drop targets ----

  const isProTabDrag = (e: DragEvent) => e.dataTransfer.types.includes(PRO_TAB_DRAG_MIME);

  const computeDropTarget = (e: DragEvent<HTMLDivElement>): DropTarget => {
    const rect = e.currentTarget.getBoundingClientRect();
    const xFrac = (e.clientX - rect.left) / rect.width;
    return xFrac < 0.5 ? 'left' : 'right';
  };

  const targetPaneFromDrop = (target: DropTarget): ProPaneId | null => {
    if (!target || !isSplit) return null;
    const leftIsSplit = splitLeading;
    if (target === 'left') return leftIsSplit ? 'split' : 'main';
    return leftIsSplit ? 'main' : 'split';
  };

  const handleBodyDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!isProTabDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const next = computeDropTarget(e);
    if (next !== splitDropTarget) setSplitDropTarget(next);
  };

  const handleBodyDragLeave = (e: DragEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setSplitDropTarget(null);
  };

  const handleBodyDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!isProTabDrag(e)) return;
    const target = computeDropTarget(e);
    setSplitDropTarget(null);
    setIsTabDragging(false);
    if (!target) return;
    e.preventDefault();
    const draggedId = e.dataTransfer.getData(PRO_TAB_DRAG_MIME);
    if (!draggedId) return;

    if (isSplit) {
      // Move tab to whichever pane occupies the dropped side.
      const destPane = targetPaneFromDrop(target);
      if (destPane) moveTabToPane(draggedId, destPane);
      return;
    }
    // Create a new side-by-side split. `splitLeading` controls which side
    // visually hosts the split pane.
    moveTabToPane(draggedId, 'split', 'vertical');
    setSplitLeading(target === 'left');
  };

  // Loading state (matches standard page exactly)
  if (!initialCheckDone || authLoading || !isAuthenticated || !client) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-foreground mx-auto"></div>
          <p className="mt-4 text-sm text-muted-foreground">{t("common.loading")}</p>
        </div>
      </div>
    );
  }

  if (!isDesktop) return null;

  // Stable keys are essential: when the split collapses, the row's child
  // list goes from [splitPane, divider, mainPane] (or the leading variant)
  // to [mainPane]. Without keys, React would reuse the Pane instance at
  // index 0 - repurposing the *split* pane's instance into the main pane,
  // which strands the main pane's ResizeObserver/paneWidth on a now-
  // unmounted DOM node and reparents the mail tab body (causing remount
  // + stale "still-narrow" measurements after the split is closed).
  const mainPane = (
    <Pane
      key="pane-main"
      paneId="main"
      tabs={mainTabs}
      activeTabId={activeMainTabId}
      loadedTabIds={loadedTabIds}
      onPaneFocus={setFocusedPane}
      isFocused={focusedPaneId === 'main'}
    />
  );

  const splitPane = isSplit ? (
    <Pane
      key="pane-split"
      paneId="split"
      tabs={splitTabs}
      activeTabId={activeSplitTabId}
      loadedTabIds={loadedTabIds}
      onPaneFocus={setFocusedPane}
      isFocused={focusedPaneId === 'split'}
    />
  ) : null;

  const splitDivider = isSplit ? (
    <div
      key="pane-divider"
      aria-hidden="true"
      className="flex-shrink-0 w-px bg-transparent"
      style={{ borderLeft: '1px solid rgba(128, 128, 128, 0.3)' }}
    />
  ) : null;

  // Drop-zone overlay: a single half-body preview of where the dragged tab
  // would land. The whole body is always a drop target (the entire surface
  // maps to one of the four sides), so we only render the active side.
  const dropZone = isTabDragging && splitDropTarget ? (
    <DropZone side={splitDropTarget} />
  ) : null;

  return (
    <EmbeddedContext.Provider value={true}>
      <div className="flex flex-col h-dvh bg-background overflow-hidden pt-[env(safe-area-inset-top)]">
        <div className="flex flex-1 overflow-hidden">
          {/* Leftmost Navigation Rail - identical to the standard layout */}
          <div
            className="w-14 bg-secondary flex flex-col flex-shrink-0"
            style={{ borderRight: '1px solid rgba(128, 128, 128, 0.3)' }}
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
            <div className="flex flex-1 flex-col overflow-hidden min-w-0">
              {/* Single, unified tab bar above both panes. */}
              <ProTabBar
                tabs={tabs}
                activeMainTabId={activeMainTabId}
                activeSplitTabId={activeSplitTabId}
                onActivate={setActiveTab}
                onClose={requestCloseTab}
                onDragStateChange={setIsTabDragging}
              />

              {/* Panes container - accepts body drops for split/move. */}
              <div
                className="relative flex flex-row flex-1 overflow-hidden min-w-0"
                onDragOver={handleBodyDragOver}
                onDragLeave={handleBodyDragLeave}
                onDrop={handleBodyDrop}
              >
                {isSplit
                  ? (splitLeading
                      ? <>{splitPane}{splitDivider}{mainPane}</>
                      : <>{mainPane}{splitDivider}{splitPane}</>)
                  : mainPane}

                {dropZone}
              </div>
            </div>
          )}
        </div>

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
