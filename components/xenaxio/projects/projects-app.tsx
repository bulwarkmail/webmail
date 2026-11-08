"use client";

// xenaxio step 118: the "Projekte" section next to mail, calendar, chat and
// flows. One page: the list of projects, or one project (?id=…) with its
// board, overview and linked emails and files; ?task=… opens a task. The
// client is a static export, so the project and task travel in the query.
import { useCallback, useEffect, useState } from "react";
import { InlineAppView } from "@/components/layout/inline-app-view";
import { MvTopBar } from "@/components/layout/mv-top-bar";
import { NavigationRail } from "@/components/layout/navigation-rail";
import { SidebarAppsModal } from "@/components/layout/sidebar-apps-modal";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useIsEmbedded } from "@/hooks/use-is-embedded";
import { useIsMobile } from "@/hooks/use-media-query";
import { useMountainViewShell } from "@/hooks/use-mountain-view-shell";
import { useSidebarApps } from "@/hooks/use-sidebar-apps";
import { cn } from "@/lib/utils";
import { XenaxioApiError, xenaxio } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";
import { redirectToLogin, saveRedirectAfterLogin, useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { ProjectList } from "./project-list";
import { ProjectView } from "./project-view";

interface Place {
  id: string | null;
  task: string | null;
}

/** Step 119: the type on /objects?type=… (projects have their own page). */
function readType(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("type");
}

function readPlace(): Place {
  if (typeof window === "undefined") return { id: null, task: null };
  const q = new URLSearchParams(window.location.search);
  return { id: q.get("id"), task: q.get("task") };
}

/** Moves within the section without reloading: the address bar follows, Back works. */
function writePlace(place: Place, replace = false): void {
  const q = new URLSearchParams();
  const type = readType();
  if (type) q.set("type", type);
  if (place.id) q.set("id", place.id);
  if (place.id && place.task) q.set("task", place.task);
  const s = q.toString();
  const path = window.location.pathname.replace(/\/?$/, "/");
  const url = `${path}${s ? `?${s}` : ""}`;
  if (replace) window.history.replaceState(window.history.state, "", url);
  else window.history.pushState(window.history.state, "", url);
}

function ProjectsSection({ typeKey }: { typeKey: string }) {
  const [place, setPlace] = useState<Place>(readPlace);

  useEffect(() => {
    const onPop = () => setPlace(readPlace());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = useCallback((next: Place, replace = false) => {
    writePlace(next, replace);
    setPlace(next);
  }, []);

  if (place.id) {
    return (
      <ProjectView
        key={place.id}
        id={place.id}
        taskId={place.task}
        onOpenTask={(task) => go({ id: place.id, task }, true)}
        onOpenProject={(id) => go({ id, task: null })}
        onBack={() => go({ id: null, task: null })}
      />
    );
  }
  return <ProjectList typeKey={typeKey} onOpen={(id, task) => go({ id, task: task ?? null })} />;
}

export function ProjectsApp({ objects = false }: { objects?: boolean } = {}) {
  const t = useXT();
  const [typeKey] = useState(() => (objects ? (readType() ?? "") : "project"));
  useDocumentTitle(objects ? t("objects.title") : t("projects.title"));
  const { logout, checkAuth } = useAuthStore();
  const { quota, isPushConnected } = useEmailStore();
  const { showAppsModal, inlineApp, loadedApps, handleManageApps, handleInlineApp, closeInlineApp, closeAppsModal } = useSidebarApps();
  const [signedIn, setSignedIn] = useState(false);
  const isMobile = useIsMobile();
  const isEmbedded = useIsEmbedded();
  const mvShell = useMountainViewShell(isEmbedded);

  useEffect(() => {
    let cancelled = false;
    xenaxio
      .me()
      .then(() => !cancelled && setSignedIn(true))
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof XenaxioApiError && err.status === 401) {
          saveRedirectAfterLogin();
          redirectToLogin();
        } else setSignedIn(true);
      });
    if (!useAuthStore.getState().isAuthenticated) void checkAuth().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [checkAuth]);

  if (!signedIn) return null;

  return (
    <div data-app-shell="" className={cn("flex flex-col overflow-hidden pt-[env(safe-area-inset-top)]", mvShell ? "bg-[var(--mv-canvas)]" : "bg-background", isEmbedded ? "h-full" : "h-dvh")}>
      {mvShell && <MvTopBar showMenuButton={false} onManageApps={handleManageApps} onInlineApp={handleInlineApp} onCloseInlineApp={closeInlineApp} activeAppId={inlineApp?.id ?? null} />}
      <div data-mv-card={mvShell ? "" : undefined} className={cn("flex min-h-0 flex-1 overflow-hidden", mvShell && "mx-4 mb-4 bg-background")}>
        {!isMobile && !isEmbedded && !mvShell && (
          <div data-app-rail="" className="flex w-14 flex-shrink-0 flex-col bg-secondary" style={{ borderRight: "1px solid rgba(128, 128, 128, 0.3)" }}>
            <NavigationRail collapsed quota={quota} isPushConnected={isPushConnected} onLogout={logout} onManageApps={handleManageApps} onInlineApp={handleInlineApp} onCloseInlineApp={closeInlineApp} activeAppId={inlineApp?.id ?? null} />
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          {inlineApp && <InlineAppView apps={loadedApps} activeAppId={inlineApp.id} onClose={closeInlineApp} />}
          <div className={cn("flex min-h-0 flex-1", inlineApp && "hidden")}>
            {typeKey ? <ProjectsSection typeKey={typeKey} /> : <p className="p-4 text-sm text-muted-foreground">{t("objects.type_missing")}</p>}
          </div>
          {isMobile && !isEmbedded && <NavigationRail orientation="horizontal" onManageApps={handleManageApps} onInlineApp={handleInlineApp} onCloseInlineApp={closeInlineApp} activeAppId={inlineApp?.id ?? null} />}
        </div>
      </div>
      <SidebarAppsModal isOpen={showAppsModal} onClose={closeAppsModal} />
    </div>
  );
}
