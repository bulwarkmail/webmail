"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export type ScrollAxis = "vertical" | "horizontal";
export type ScrollWindowSide = "start" | "end";

/** Scroll offset from the logical start (handles RTL horizontal scrolling). */
export function getScrollStart(el: HTMLElement, axis: ScrollAxis): number {
  if (axis === "vertical") return el.scrollTop;
  return getComputedStyle(el).direction === "rtl" ? -el.scrollLeft : el.scrollLeft;
}

export function setScrollStart(el: HTMLElement, axis: ScrollAxis, value: number): void {
  if (axis === "vertical") {
    el.scrollTop = value;
    return;
  }
  el.scrollLeft = getComputedStyle(el).direction === "rtl" ? -value : value;
}

/** Smoothly scrolls to a logical start offset (RTL-aware). */
export function scrollToStart(el: HTMLElement, axis: ScrollAxis, value: number): void {
  if (axis === "vertical") {
    el.scrollTo({ top: value, behavior: "smooth" });
    return;
  }
  el.scrollTo({ left: getComputedStyle(el).direction === "rtl" ? -value : value, behavior: "smooth" });
}

function scrollSize(el: HTMLElement, axis: ScrollAxis): number {
  return axis === "vertical" ? el.scrollHeight : el.scrollWidth;
}

/** Distance of an element's leading edge from the container's leading edge. */
function startOffset(el: Element, container: HTMLElement, axis: ScrollAxis): number {
  const rect = el.getBoundingClientRect();
  const box = container.getBoundingClientRect();
  if (axis === "vertical") return rect.top - box.top;
  return getComputedStyle(container).direction === "rtl" ? box.right - rect.right : rect.left - box.left;
}

/** The first anchorable element that is still (partly) inside the viewport. */
function findAnchor(container: HTMLElement, selector: string, axis: ScrollAxis): { el: Element; offset: number } | null {
  const box = container.getBoundingClientRect();
  for (const el of container.querySelectorAll(selector)) {
    const rect = el.getBoundingClientRect();
    const inside = axis === "vertical"
      ? rect.bottom > box.top
      : (getComputedStyle(container).direction === "rtl" ? rect.left < box.right : rect.right > box.left);
    if (inside) return { el, offset: startOffset(el, container, axis) };
  }
  return null;
}

export interface UseScrollWindowOptions {
  scrollRef: RefObject<HTMLElement | null>;
  axis: ScrollAxis;
  /** True while the events for the current range are being fetched. */
  isLoading: boolean;
  /** Changes when a fresh window is started; its first fetch re-arms the edges. */
  windowKey: string;
  /** Changes when the user navigates; the view then scrolls to the focus. */
  focusNonce: number;
  /** Puts the focused day into view. Called on navigation and once the rows for a fresh window arrived. */
  scrollToFocus: () => void;
  /** Widen the window at the start; omit when the limit is reached. */
  onExtendStart?: () => void;
  /** Widen the window at the end; omit when the limit is reached. */
  onExtendEnd?: () => void;
  /** Sentinel observed for automatic start extension (optional: views may trigger it themselves). */
  startSentinelRef?: RefObject<HTMLElement | null>;
  endSentinelRef?: RefObject<HTMLElement | null>;
  /** Re-observe the sentinels when the rendered content changed. */
  contentKey?: unknown;
  /**
   * Selector for the rows/columns that can serve as the scroll anchor while
   * the start side grows. Without it the total scroll size is used, which
   * is only right when nothing but the prepended content changes height.
   */
  anchorSelector?: string;
  /** Distance in px before a sentinel enters the viewport at which it counts as visible. */
  margin?: number;
}

/**
 * The scroll mechanics shared by the calendar views (#759): one outstanding
 * extension at a time, the visible content kept in place when rows or
 * columns are prepended, the focused day scrolled into view on navigation,
 * and the edge sentinels armed only once the first fetch of a window landed
 * (before that the rows on screen belong to the previous window).
 */
export function useScrollWindow({
  scrollRef,
  axis,
  isLoading,
  windowKey,
  focusNonce,
  scrollToFocus,
  onExtendStart,
  onExtendEnd,
  startSentinelRef,
  endSentinelRef,
  contentKey,
  anchorSelector,
  margin = 300,
}: UseScrollWindowOptions) {
  const pendingRef = useRef<ScrollWindowSide | null>(null);
  const [pendingSide, setPendingSide] = useState<ScrollWindowSide | null>(null);
  const wasLoadingRef = useRef(isLoading);
  const loadedRef = useRef(false);
  const lastSizeRef = useRef<number | null>(null);
  const anchorRef = useRef<{ el: Element; offset: number } | null>(null);
  const scrollToFocusRef = useRef(scrollToFocus);

  useLayoutEffect(() => {
    scrollToFocusRef.current = scrollToFocus;
  });

  useLayoutEffect(() => {
    loadedRef.current = false;
  }, [windowKey]);

  useLayoutEffect(() => {
    pendingRef.current = null;
    setPendingSide(null);
    scrollToFocusRef.current();
  }, [focusNonce]);

  // While an extension at the start is outstanding, every content change
  // (the rows or columns added right away, then the events that fill them)
  // grows the scroll size ahead of what the user is looking at: shift the
  // scroll position by the same amount so it stays put. (Browser scroll
  // anchoring is disabled on the containers so this is not applied twice.)
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const size = scrollSize(el, axis);
    const previous = lastSizeRef.current;
    lastSizeRef.current = size;
    if (previous === null || pendingRef.current !== "start") return;
    const anchor = anchorRef.current;
    if (anchor && anchor.el.isConnected) {
      const drift = startOffset(anchor.el, el, axis) - anchor.offset;
      if (drift !== 0) setScrollStart(el, axis, getScrollStart(el, axis) + drift);
      return;
    }
    if (size !== previous) setScrollStart(el, axis, getScrollStart(el, axis) + size - previous);
  }, [contentKey, axis, scrollRef]);

  // The fetch an extension triggered has finished: data and the loading flag
  // land in the same render. The first load of a fresh window also puts the
  // focus into view, as the rows were not there when navigation happened.
  useLayoutEffect(() => {
    const finished = wasLoadingRef.current && !isLoading;
    wasLoadingRef.current = isLoading;
    if (!finished) return;
    pendingRef.current = null;
    setPendingSide(null);
    if (!loadedRef.current) {
      loadedRef.current = true;
      scrollToFocusRef.current();
    }
  }, [isLoading]);

  const requestStart = useCallback(() => {
    if (!onExtendStart || isLoading || pendingRef.current) return;
    const el = scrollRef.current;
    if (el) {
      lastSizeRef.current = scrollSize(el, axis);
      anchorRef.current = anchorSelector ? findAnchor(el, anchorSelector, axis) : null;
    }
    pendingRef.current = "start";
    setPendingSide("start");
    onExtendStart();
  }, [onExtendStart, isLoading, scrollRef, axis, anchorSelector]);

  const requestEnd = useCallback(() => {
    if (!onExtendEnd || isLoading || pendingRef.current) return;
    pendingRef.current = "end";
    setPendingSide("end");
    onExtendEnd();
  }, [onExtendEnd, isLoading]);

  // Sentinels load more as soon as they come into view. The observer is
  // recreated whenever the content or loading state changes so a sentinel
  // that stays visible (short content) keeps filling until the limit.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || isLoading || !loadedRef.current || typeof IntersectionObserver === "undefined") return;
    const targets: Array<[HTMLElement, () => void]> = [];
    if (onExtendStart && startSentinelRef?.current) targets.push([startSentinelRef.current, requestStart]);
    if (onExtendEnd && endSentinelRef?.current) targets.push([endSentinelRef.current, requestEnd]);
    if (targets.length === 0) return;
    const rootMargin = axis === "vertical" ? `${margin}px 0px` : `0px ${margin}px`;
    const observers = targets.map(([target, request]) => {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) request();
      }, { root, rootMargin });
      observer.observe(target);
      return observer;
    });
    return () => observers.forEach((observer) => observer.disconnect());
    // contentKey is a dependency on purpose: new content means new geometry.
  }, [contentKey, isLoading, onExtendStart, onExtendEnd, requestStart, requestEnd, axis, margin, scrollRef, startSentinelRef, endSentinelRef]);

  return { requestStart, requestEnd, pendingSide };
}
