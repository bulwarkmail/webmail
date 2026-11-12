"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Puzzle } from "@/components/icons";
import { useAuthStore, redirectToLogin, saveRedirectAfterLogin } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { usePluginStore } from "@/stores/plugin-store";
import { NavigationRail } from "@/components/layout/navigation-rail";
import { PhoneAppHeader } from "@/components/layout/phone-header-actions";
import { SidebarAppsModal } from "@/components/layout/sidebar-apps-modal";
import { InlineAppView } from "@/components/layout/inline-app-view";
import { MvTopBar } from "@/components/layout/mv-top-bar";
import { MvSidePanel } from "@/components/layout/mv-side-panel";
import { AppTopBannerSlot } from "@/components/plugins/app-top-banner-slot";
import { PluginIframeSlot } from "@/components/plugins/plugin-iframe-slot";
import { PluginSidePanel } from "@/components/plugins/plugin-side-panels";
import { useSidebarApps } from "@/hooks/use-sidebar-apps";
import { useIsEmbedded } from "@/hooks/use-is-embedded";
import { useIsMobile } from "@/hooks/use-media-query";
import { useMountainViewShell } from "@/hooks/use-mountain-view-shell";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { findPage, subscribePages } from "@/lib/plugin-sandbox/pages";
import { offersForSlot, subscribe as subscribeSlots } from "@/lib/plugin-sandbox/registry";
import { cn } from "@/lib/utils";
import { PluginPageSkeleton, PluginPageSkeletonBody } from "@/components/boot-skeleton/plugin-page-skeleton";
import { useSkeletonLabels } from "@/components/boot-skeleton/use-skeleton-labels";

export interface PluginPageAppProps {
  /** Path segments after `/apps`: `[pluginId, pageId, ...subPath]`. */
  linkSegments?: string[];
}

/**
 * A page a plugin added with api.ui.setPages, at /apps/<pluginId>/<pageId>.
 * The app's own frame (navigation rail, or Mountain View's top bar, and the
 * phone navigation) stays around it; the plugin's `app-page` slot fills the
 * content area and gets the rest of the path as `path`.
 */
export function PluginPageApp({ linkSegments = [] }: PluginPageAppProps) {
  const t = useTranslations("plugin_pages");
  const skeleton = useSkeletonLabels();
  const [pluginId = "", pageId = "", ...rest] = linkSegments;
  const subPath = rest.join("/");

  const { isAuthenticated, logout, checkAuth, isLoading: authLoading } = useAuthStore();
  const [initialCheckDone, setInitialCheckDone] = useState(
    () => useAuthStore.getState().isAuthenticated && !!useAuthStore.getState().client,
  );
  const { quota, isPushConnected } = useEmailStore();
  const { showAppsModal, inlineApp, loadedApps, handleManageApps, handleInlineApp, closeInlineApp, closeAppsModal } = useSidebarApps();
  const isMobile = useIsMobile();
  const isEmbedded = useIsEmbedded();
  const mvShell = useMountainViewShell(isEmbedded);
  const pluginsReady = usePluginStore((s) => s.initialized);

  const page = useSyncExternalStore(
    subscribePages,
    () => findPage(pluginId, pageId),
    () => null,
  );
  const offersPage = useSyncExternalStore(
    subscribeSlots,
    () => offersForSlot("app-page").some((o) => o.pluginId === pluginId),
    () => false,
  );
  const fillsPage = useSyncExternalStore(
    subscribeSlots,
    () => offersForSlot("app-page").some((o) => o.pluginId === pluginId && o.fill),
    () => false,
  );
  useDocumentTitle(page?.title ?? null);

  useEffect(() => {
    const state = useAuthStore.getState();
    if (state.isAuthenticated && state.client) {
      setInitialCheckDone(true);
      return;
    }
    checkAuth().finally(() => setInitialCheckDone(true));
  }, [checkAuth]);

  useEffect(() => {
    if (initialCheckDone && !isAuthenticated && !authLoading) {
      saveRedirectAfterLogin();
      redirectToLogin();
    }
  }, [initialCheckDone, isAuthenticated, authLoading]);

  // Opened straight from a link or a reload: the plugins have not been
  // started yet on this page load (mail and settings do the same).
  useEffect(() => {
    if (isAuthenticated) void usePluginStore.getState().initializePlugins();
  }, [isAuthenticated]);

  const extraProps = useMemo(() => ({ pageId, path: subPath }), [pageId, subPath]);

  // Until the session is restored: the page skeleton the server drew.
  if (!isAuthenticated) {
    return isEmbedded
      ? <PluginPageSkeletonBody embedded />
      : <PluginPageSkeleton label={skeleton.label} labels={skeleton.labels} />;
  }

  const available = !!page && offersPage;
  let content: React.ReactNode;
  if (available) {
    content = (
      <div className={cn("flex-1 min-h-0", fillsPage ? "flex flex-col overflow-hidden" : "overflow-y-auto")} data-plugin-page={`${pluginId}/${pageId}`}>
        <PluginIframeSlot key={`${pluginId}/${pageId}`} pluginId={pluginId} slot="app-page" extraProps={extraProps} fill={fillsPage} />
      </div>
    );
  } else if (!pluginsReady) {
    // The plugins are starting: the same empty area the page skeleton drew,
    // so nothing moves before the page (or the "not available" note) arrives.
    content = (
      <div className="flex flex-1 min-h-0" role="status" data-plugin-page-loading="">
        <span className="sr-only">{t("loading")}</span>
      </div>
    );
  } else {
    content = (
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="max-w-sm text-center space-y-3">
          <Puzzle className="w-10 h-10 text-muted-foreground mx-auto" />
          <p className="text-sm font-medium text-foreground">{t("not_available_title")}</p>
          <p className="text-xs text-muted-foreground">{t("not_available_description")}</p>
          <Link href="/" className="inline-block text-sm text-primary hover:underline underline-offset-2">
            {t("back_to_mail")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col overflow-hidden pt-[var(--app-top-inset)]", mvShell ? "bg-[var(--mv-canvas)]" : "bg-background", isEmbedded ? "h-full" : "h-dvh")}>
      <AppTopBannerSlot />
      {mvShell && (
        <MvTopBar
          showMenuButton={false}
          onManageApps={handleManageApps}
          onInlineApp={handleInlineApp}
          onCloseInlineApp={closeInlineApp}
          activeAppId={inlineApp?.id ?? null}
        />
      )}
      <div className="flex flex-1 min-h-0 overflow-hidden">
      <div data-mv-card={mvShell ? "" : undefined} className={cn("flex flex-1 min-w-0 min-h-0 overflow-hidden", mvShell && "mb-4 mx-4")}>
        {!isMobile && !isEmbedded && !mvShell && (
          <div className="w-14 bg-secondary flex flex-col flex-shrink-0" style={{ borderRight: "1px solid rgba(128, 128, 128, 0.3)" }}>
            <NavigationRail
              collapsed
              quota={quota}
              isPushConnected={isPushConnected}
              onLogout={logout}
              onManageApps={handleManageApps}
              onInlineApp={handleInlineApp}
              onCloseInlineApp={closeInlineApp}
              activeAppId={inlineApp?.id ?? null}
            />
          </div>
        )}
        <div className="flex flex-col flex-1 min-w-0">
          {!isEmbedded && <PhoneAppHeader title={page?.title ?? ""} below="md" />}
          {inlineApp && <InlineAppView apps={loadedApps} activeAppId={inlineApp.id} onClose={closeInlineApp} />}
          <div className={cn("flex flex-col flex-1 min-h-0", inlineApp && "hidden")}>
            {content}
          </div>
          {isMobile && !isEmbedded && (
            <NavigationRail
              orientation="horizontal"
              onManageApps={handleManageApps}
              onInlineApp={handleInlineApp}
              onCloseInlineApp={closeInlineApp}
              activeAppId={inlineApp?.id ?? null}
            />
          )}
        </div>
      </div>
      {/* The plugins' panels beside the page (the side-panel slot), as
          beside the mail: the page narrows by the panel's width. One open
          state with the mail's, and api.ui.openPanel('side-panel') answered
          here too. */}
      {mvShell && !inlineApp && <MvSidePanel />}
      {!mvShell && !isMobile && !isEmbedded && !inlineApp && <PluginSidePanel />}
      </div>
      <SidebarAppsModal isOpen={showAppsModal} onClose={closeAppsModal} />
    </div>
  );
}
