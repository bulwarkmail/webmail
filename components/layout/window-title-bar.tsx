"use client";

import { useEffect, useState } from "react";
import { applyTitlebarInset, watchTitlebarArea, type TitlebarArea } from "@/lib/window-controls-overlay";

/**
 * The strip above the app in a window without a native title bar: the part
 * the user drags the window by, with the window's title in small text. The
 * native window controls sit next to it, outside the area it is given. The
 * page roots leave this row empty through --titlebar-inset.
 *
 * Renders nothing, and changes nothing on the page, without an overlay. It
 * repeats the title for sighted users only, so it stays out of the
 * accessibility tree and out of the tab order.
 */
export function WindowTitleBar() {
  const [area, setArea] = useState<TitlebarArea | null>(null);
  const [title, setTitle] = useState("");

  useEffect(() => watchTitlebarArea((next) => {
    applyTitlebarInset(next);
    setArea(next);
  }), []);

  const visible = area !== null;
  useEffect(() => {
    if (!visible) return;
    const read = () => setTitle(document.title);
    read();
    // Each surface sets its own title, and Next puts <title> back on navigation.
    const observer = new MutationObserver(read);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [visible]);

  if (!area) return null;

  return (
    <div
      aria-hidden="true"
      data-window-title-bar=""
      className="window-title-bar fixed z-[100002] flex items-center bg-background ps-3 pe-3 text-xs text-muted-foreground select-none"
      style={{ top: area.y, left: area.x, width: area.width, height: area.height }}
    >
      <span className="truncate">{title}</span>
    </div>
  );
}
