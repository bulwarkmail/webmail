"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useUIStore } from "@/stores/ui-store";
import { useShallow } from "zustand/react/shallow";
import { usePaneSize } from "@/hooks/use-pane-size";

// Tailwind v4 breakpoints, in px at the default 16px text size.
const BREAKPOINTS = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
} as const;

/**
 * The widths that decide the layout (`desk:` in app/globals.css is the first).
 * Below PHONE_BELOW the phone layout: one pane at a time, a bottom tab bar and
 * the folders in a drawer. From there up the desktop layout, with the app rail
 * and the folder sidebar beside the list. Below FULL_DESKTOP that desktop is
 * compact: the folder sidebar folds to its icons, and calendar, contacts and
 * files open their sidebars over the page. A half-screen window and a laptop
 * at 150 % (911px) are desktops, not tablets (usability test 2026-11-04).
 */
export const PHONE_BELOW = 600;
export const FULL_DESKTOP = BREAKPOINTS.lg;
export interface DeviceClass {
  /** Phone layout. */
  isMobile: boolean;
  /** Desktop layout narrower than the full desktop: the sidebar folds to icons. */
  isCompact: boolean;
  /** Desktop layout, compact or full. */
  isDesktop: boolean;
}

/** The layout a window or pane `width` CSS pixels wide gets. */
export function classifyWidth(width: number): DeviceClass {
  return {
    isMobile: width < PHONE_BELOW,
    isCompact: width >= PHONE_BELOW && width < FULL_DESKTOP,
    isDesktop: width >= PHONE_BELOW,
  };
}

const getMediaQueryServerSnapshot = () => false;

/**
 * The media query for "narrower than `px`" in rem, as Tailwind writes its own
 * breakpoints (`max-md:` is `width < 48rem`). A rem in a media query is the
 * browser's default text size, so someone who sets a larger default (say
 * 32px) gets the layout the CSS draws at that size: a 1440px window then
 * counts as a phone in both, instead of the scripts choosing the desktop
 * panes while the CSS hides them.
 */
export function narrowerThan(px: number): string {
  return `(width < ${px / 16}rem)`;
}

/** The media query for "at least `px` wide", in rem (see narrowerThan). */
export function atLeast(px: number): string {
  return `(width >= ${px / 16}rem)`;
}

/**
 * SSR-safe media query hook. On SSR and the first hydration pass we report
 * `false`; on all subsequent client renders (including client-side navigation
 * remounts) we read `matchMedia` synchronously, so components don't flash
 * through a one-frame "mobile" layout on desktop.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (callback: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", callback);
      return () => mq.removeEventListener("change", callback);
    },
    [query],
  );

  const getSnapshot = useCallback(
    () => window.matchMedia(query).matches,
    [query],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getMediaQueryServerSnapshot);
}

/**
 * When the Pro shell renders a page inside a (possibly split) pane, that pane
 * publishes its measured width via `PaneSizeContext`. Inner pages should
 * branch their layout against the pane width - not the full viewport - so a
 * narrow pane gets the phone or compact layout instead of overflowing.
 *
 * Returns `null` when no pane size is published, signalling the caller to
 * fall back to `window.matchMedia`.
 */
function classifyPane(paneWidth: number | null): DeviceClass | null {
  return paneWidth === null ? null : classifyWidth(paneWidth);
}

/**
 * Hook to detect the layout class (classifyWidth) and sync it with the UI
 * store: phone below 600px, compact desktop to 1024px, full desktop above.
 *
 * When invoked inside a Pro pane, the returned values reflect the pane's
 * width instead of the window's. The global UI store is NOT updated in that
 * case - two split panes would otherwise fight to write conflicting values,
 * and the store is meant to mirror the actual viewport for callers that read
 * it directly (mobile navigation helpers etc.).
 */
export function useDeviceDetection(): DeviceClass {
  const { setDeviceType, isMobile, isCompact, isDesktop } = useUIStore(useShallow((state) => ({ setDeviceType: state.setDeviceType, isMobile: state.isMobile, isCompact: state.isCompact, isDesktop: state.isDesktop })));
  const paneWidth = usePaneSize();
  const paneClassification = classifyPane(paneWidth);

  // Each class asks its own query, so the first hydration pass (every query
  // false) reads as the full desktop and draws no folded sidebar for a frame.
  const isMobileQuery = useMediaQuery(narrowerThan(PHONE_BELOW));
  const isCompactQuery = useMediaQuery(`${atLeast(PHONE_BELOW)} and ${narrowerThan(FULL_DESKTOP)}`);
  const isDesktopQuery = useMediaQuery(atLeast(PHONE_BELOW));

  useEffect(() => {
    if (paneClassification) return;
    setDeviceType(isMobileQuery, isCompactQuery, isDesktopQuery);
  }, [isMobileQuery, isCompactQuery, isDesktopQuery, setDeviceType, paneClassification]);

  if (paneClassification) return paneClassification;
  return { isMobile, isCompact, isDesktop };
}

/** The phone layout (below PHONE_BELOW), for the window or the Pro pane. */
export function useIsMobile() {
  const paneWidth = usePaneSize();
  const viewport = useMediaQuery(narrowerThan(PHONE_BELOW));
  return paneWidth !== null ? paneWidth < PHONE_BELOW : viewport;
}

/** The desktop layout, compact or full (from PHONE_BELOW up). */
export function useIsDesktop() {
  const paneWidth = usePaneSize();
  const viewport = useMediaQuery(atLeast(PHONE_BELOW));
  return paneWidth !== null ? paneWidth >= PHONE_BELOW : viewport;
}

/**
 * The full desktop (from FULL_DESKTOP up), where sidebars sit beside the page
 * at their own width. Below it calendar, contacts and files open theirs over
 * the page.
 */
export function useIsFullDesktop() {
  const paneWidth = usePaneSize();
  const viewport = useMediaQuery(atLeast(FULL_DESKTOP));
  return paneWidth !== null ? paneWidth >= FULL_DESKTOP : viewport;
}

