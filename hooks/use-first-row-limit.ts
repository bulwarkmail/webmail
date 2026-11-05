"use client";

import { useLayoutEffect, useState } from "react";

/** Marks a row's items for {@link useFirstRowLimit}. */
export const ROW_ITEM_ATTR = "data-row-item";
/** Marks the "+N more" item that follows them. */
export const ROW_MORE_ATTR = "data-row-more";

interface FirstRowLimit<T extends HTMLElement> {
  /** For the container whose children wrap (a grid or a wrapping flex row). */
  ref: (el: T | null) => void;
  /**
   * How many items to draw before the "+N more" item, or null to draw them
   * all (they fit on one row, it isn't measured yet, or `enabled` is off).
   */
  limit: number | null;
}

/**
 * Keeps a wrapping row of items to its first line: when they don't fit,
 * `limit` says how many to show so a "+N more" item still fits after them.
 *
 * Every item is drawn once and measured before the browser paints; items
 * on a lower line than the first push the rest behind "+N more". The
 * container's width is watched, so a narrower pane shows fewer. A single
 * item that fills the line on its own stays, with "+N more" under it.
 */
export function useFirstRowLimit<T extends HTMLElement = HTMLDivElement>(count: number, enabled = true): FirstRowLimit<T> {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  const [fit, setFit] = useState<{ key: string; limit: number | null } | null>(null);
  const key = `${count}:${width}`;
  const measured = fit?.key === key;
  const limit = enabled && measured ? fit.limit : null;

  useLayoutEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((prev) => (prev === next ? prev : next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);

  useLayoutEffect(() => {
    if (!enabled || !el) return;
    const items = Array.from(el.children).filter((c) => c.hasAttribute(ROW_ITEM_ATTR));
    if (items.length === 0) return;
    const firstTop = items[0].getBoundingClientRect().top;
    const onFirstRow = (node: Element) => node.getBoundingClientRect().top <= firstTop + 1;
    if (!measured) {
      // Everything is drawn: count what the first line holds.
      const fits = items.filter(onFirstRow).length;
      setFit({ key, limit: fits >= count ? null : Math.max(1, fits - 1) });
      return;
    }
    // "+N more" went to the next line: give it one more item's room.
    const more = Array.from(el.children).find((c) => c.hasAttribute(ROW_MORE_ATTR));
    if (fit.limit !== null && fit.limit > 1 && more && !onFirstRow(more)) {
      setFit({ key, limit: fit.limit - 1 });
    }
  }, [el, enabled, measured, key, count, fit]);

  return { ref: setEl, limit };
}
