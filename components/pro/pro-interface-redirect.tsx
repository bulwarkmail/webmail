"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "@/i18n/navigation";
import { useSettingsStore } from "@/stores/settings-store";
import { useIsDesktop } from "@/hooks/use-media-query";
import { useProTabStore, type ProAppTabKind } from "@/stores/pro-tab-store";
import { matchSurface, type AppSurface } from "@/lib/deep-links";
import { setPendingDeepLink } from "@/lib/deep-link-handoff";

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
 */
export function ProInterfaceRedirect() {
  const router = useRouter();
  const pathname = usePathname();
  const proInterface = useSettingsStore((s) => s.proInterface);
  const isDesktop = useIsDesktop();

  useEffect(() => {
    if (!proInterface || !isDesktop) return;
    const match = matchSurface(pathname);
    if (!match) return;
    // Focus the tab before handing over the link: when the surface is already
    // mounted the handoff delivers live, and its handler may itself open a
    // tab (a message permalink opens an email tab) that must keep focus.
    useProTabStore.getState().openTab(SURFACE_TO_TAB[match.surface]);
    if (match.segments.length > 0) {
      setPendingDeepLink(match.surface, match.segments);
    }
    router.replace('/pro');
  }, [proInterface, isDesktop, pathname, router]);

  return null;
}
