"use client";

import { useEffect, useState } from "react";
import { CLOSE_MOVES_ATTRIBUTE, CONTROLS_ATTRIBUTE } from "@/lib/window-controls-overlay";

/**
 * Whether this row's own close would sit right beside the window's close, in an
 * installed app or the desktop app: then it goes to the row's other end, in the
 * page's order too, so Tab reaches it where it's seen. The row says so through
 * the mark lib/window-controls-overlay.ts keeps on it; without window controls
 * over the page this is always false.
 */
export function useCloseBesideControls(row: HTMLElement | null): boolean {
  const [beside, setBeside] = useState(false);
  useEffect(() => {
    if (!row) {
      setBeside(false);
      return;
    }
    const root = row.ownerDocument.documentElement;
    const read = () => setBeside(root.hasAttribute(CONTROLS_ATTRIBUTE) && row.hasAttribute(CLOSE_MOVES_ATTRIBUTE));
    read();
    if (typeof MutationObserver === "undefined") return;
    const marks = new MutationObserver(read);
    marks.observe(row, { attributes: true, attributeFilter: [CLOSE_MOVES_ATTRIBUTE] });
    marks.observe(root, { attributes: true, attributeFilter: [CONTROLS_ATTRIBUTE] });
    return () => marks.disconnect();
  }, [row]);
  return beside;
}
