"use client";

import { useEffect } from "react";
import { useSelectedLayoutSegment } from "next/navigation";
import { usePathname, useRouter } from "@/i18n/navigation";
import { useSettingsStore } from "@/stores/settings-store";
import { useIsDesktop } from "@/hooks/use-media-query";
import { useProTabStore, type ProAppTabKind } from "@/stores/pro-tab-store";
import { matchSurface, type AppSurface } from "@/lib/deep-links";
import { setPendingDeepLink } from "@/lib/deep-link-handoff";
import { ProSkeleton } from "@/components/boot-skeleton/pro-skeleton";
import { useSkeletonLabels } from "@/components/boot-skeleton/use-skeleton-labels";

const SURFACE_TO_TAB: Record<AppSurface, ProAppTabKind> = {
  mail: 'mail',
  calendar: 'calendar',
  contacts: 'contacts',
  files: 'files',
  settings: 'settings',
};

/**
 * Whether the Pro shell is currently taking over the standard routes. Surfaces
 * use this to keep off the address bar: under Pro the only route is /pro, so a
 * surface rewriting the URL to its own permalink would fight the redirect.
 */
export function useProInterfaceActive(): boolean {
  const proInterface = useSettingsStore((s) => s.proInterface);
  const isDesktop = useIsDesktop();
  return proInterface && isDesktop;
}

/**
 * When the Pro interface is enabled, the standard mail/calendar/contacts/
 * files/settings routes are taken over by the Pro shell - the user shouldn't
 * have to click "Open" in settings to land there. Mobile/tablet keeps the
 * standard layout because Pro is desktop-only (see pro/page.tsx).
 *
 * Surfaces are matched by prefix rather than by exact path, and any deep-link
 * segments are handed to the tab that opens (#733), so `/mail/message/<id>`
 * opens that message in a Pro mail tab instead of silently landing on the
 * inbox.
 *
 * Until /pro has rendered, the Pro skeleton covers the standard page, which
 * may finish loading first (a fast session restore, a slow /pro chunk): the
 * visitor sees the Pro frame from the first paint to the loaded Pro shell,
 * never the standard page in between. The server HTML and the hydration pass
 * draw nothing here (isDesktop is false there); the page's own skeleton is
 * already the Pro frame then (components/boot-skeleton/shell.tsx).
 */
export function ProInterfaceRedirect() {
  const router = useRouter();
  const pathname = usePathname();
  const proInterface = useSettingsStore((s) => s.proInterface);
  const isDesktop = useIsDesktop();
  const { label } = useSkeletonLabels();
  // Browser Back onto a URL the shell wrote by hand: the path says Calendar
  // but the route is still /pro, with the shell mounted. Nothing to cover.
  const shellIsUp = useSelectedLayoutSegment() === 'pro';
  const takingOver = proInterface && isDesktop && !shellIsUp && matchSurface(pathname) !== null;

  useEffect(() => {
    if (!proInterface || !isDesktop) return;
    const match = matchSurface(pathname);
    if (!match) return;
    // Focus the tab before handing over the link: when the surface is already
    // mounted the handoff delivers live, and its handler may itself open a
    // tab (a message permalink opens an email tab) that must keep focus.
    useProTabStore.getState().openTab(SURFACE_TO_TAB[match.surface]);
    // The query half goes with it (`?shared=` of a shared drive's folder,
    // `?preview=`, `?account=`): /pro has none left by the time the surface
    // reads the link, and a link that is only a query - a shared folder is
    // named by id - would be lost on reload.
    const search = window.location.search;
    if (match.segments.length > 0 || search) {
      setPendingDeepLink(match.surface, match.segments, search || undefined);
    }
    router.replace('/pro');
  }, [proInterface, isDesktop, pathname, router]);

  if (!takingOver) return null;
  return (
    <div className="fixed inset-0 z-50 pt-[var(--titlebar-inset)]" data-pro-takeover="">
      <ProSkeleton label={label} />
    </div>
  );
}
