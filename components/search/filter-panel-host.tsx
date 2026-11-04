"use client";

import { useLayoutEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Where the advanced-filter panel is drawn.
 *
 * With no anchor it stays where it has always been: in the flow of the
 * message-list column, directly under the header that carries the filter
 * button. That is the default layout, and nothing about it changes.
 *
 * Mountain View moves the filter button up into the global top bar, next to
 * the search field. Given the anchor the top bar renders under that field, the
 * panel drops from it instead: same leading edge, same width, directly
 * below.
 *
 * It is portalled to <body> and positioned from the anchor's box rather than
 * rendered inside the anchor. Inside the top bar it shared the root stacking
 * context with the sidebar column, which carries the same z-index and comes
 * later in the document, so the sidebar painted over the panel's leading half.
 * At the end of <body> it wins that tie, and it still loses to any dialog
 * opened afterwards, which is the order one wants.
 */
export function FilterPanelHost({
  anchor,
  children,
}: {
  anchor: HTMLElement | null;
  children: ReactNode;
}) {
  const box = useAnchorBox(anchor);

  const panel = (
    <div className="px-3 pb-3 space-y-2.5 animate-in slide-in-from-top-1 fade-in duration-150">
      {children}
    </div>
  );

  if (!anchor) return panel;
  if (!box) return null;

  return createPortal(
    <div
      data-mv-filter-panel=""
      style={box}
      className="fixed z-50 max-h-[calc(100dvh-5rem)] overflow-y-auto rounded-lg border border-border bg-popover pt-3 shadow-xl"
    >
      {panel}
    </div>,
    document.body
  );
}

/** Below this the form's labelled rows leave its date and size fields a few characters wide. */
const MIN_PANEL_WIDTH = 480;
const VIEWPORT_MARGIN = 8;

/**
 * Where the panel goes for a given search field: under it, sharing its leading
 * edge and width. The field shrinks with the window, so a narrow one gets a
 * panel wider than itself, growing towards the trailing side and kept on screen.
 */
export function filterPanelBox(
  rect: { left: number; right: number; bottom: number; width: number },
  viewportWidth: number,
  rtl: boolean,
): CSSProperties {
  const width = Math.max(rect.width, Math.min(MIN_PANEL_WIDTH, viewportWidth - VIEWPORT_MARGIN * 2));
  const preferred = rtl ? rect.right - width : rect.left;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(preferred, viewportWidth - width - VIEWPORT_MARGIN));
  return { top: rect.bottom + 4, left, width };
}

/** The anchor's leading edge, width and bottom, kept current as the bar resizes. */
function useAnchorBox(anchor: HTMLElement | null): CSSProperties | null {
  const [box, setBox] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!anchor) {
      setBox(null);
      return;
    }
    const measure = () => {
      setBox(filterPanelBox(anchor.getBoundingClientRect(), window.innerWidth, getComputedStyle(anchor).direction === "rtl"));
    };
    measure();

    // The field is flex-sized, so it moves with the sidebar and the window;
    // either observer alone misses one of the two.
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(anchor);
    if (anchor.parentElement) observer?.observe(anchor.parentElement);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [anchor]);

  return box;
}
