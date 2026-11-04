"use client";

import { useEffect, useState } from "react";
import { applyControlsArea, watchTitlebarArea, watchWindowRows, type TitlebarArea } from "@/lib/window-controls-overlay";
import { claimBrowserSignIn } from "@/lib/desktop/browser-sign-in";
import { claimFilesControls } from "@/lib/files-sync/controls";

/**
 * The window's controls over the app, with no title bar row: see
 * lib/window-controls-overlay.ts. Renders nothing, and changes nothing on the
 * page, without an overlay. In the root layout, so that the pages outside [locale]
 * (admin, setup) get it too; there are no messages up there.
 */
export function WindowControlsHost() {
  // In the first render of every page, before any frame exists: a frame can reach the
  // bridge, and whoever comes after this gets nothing.
  if (typeof window !== "undefined") {
    claimBrowserSignIn();
    claimFilesControls();
  }
  const [area, setArea] = useState<TitlebarArea | null>(null);

  useEffect(() => watchTitlebarArea((next) => {
    applyControlsArea(next);
    setArea(next);
  }), []);

  const key = area ? `${area.x},${area.width},${area.height}` : "";
  useEffect(() => {
    if (!area) return;
    return watchWindowRows(area);
    // `key` stands for area, a new object at each change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return null;
}
