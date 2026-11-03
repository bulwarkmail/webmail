"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import type { DesktopMenuBarEntry } from "@/lib/desktop/types";
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
 *
 * In the desktop app on Windows, Alt swaps the title for the menu's names, since a
 * window without a native frame has no native bar. Each name opens the app's menu
 * as a native one (src/main/menu.ts in the desktop repo).
 */
export function WindowTitleBar() {
  const [area, setArea] = useState<TitlebarArea | null>(null);
  const [title, setTitle] = useState("");
  const [entries, setEntries] = useState<DesktopMenuBarEntry[] | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  // What to do once the names are on screen: open that menu, or null to focus the first name.
  const afterShow = useRef<string | null | undefined>(undefined);

  const openMenu = useCallback((id: string) => {
    const button = stripRef.current?.querySelector<HTMLElement>(`[data-menu-id="${CSS.escape(id)}"]`);
    if (!button) return;
    const rect = button.getBoundingClientRect();
    getDesktopBridge()?.menu?.bar?.open(id, { x: rect.left, y: rect.bottom });
  }, []);

  useEffect(() => {
    const bar = getDesktopBridge()?.menu?.bar;
    if (!bar) return;
    return bar.onEvent((event) => {
      if (!event.visible) {
        setEntries(null);
        previousFocus.current?.focus?.();
        previousFocus.current = null;
        return;
      }
      void bar.entries().then((list) => {
        previousFocus.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
        afterShow.current = event.open ?? null;
        setEntries(list);
      });
    });
  }, []);

  useEffect(() => {
    const next = afterShow.current;
    if (!entries || next === undefined) return;
    afterShow.current = undefined;
    if (next) openMenu(next);
    else stripRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [entries, openMenu]);

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

  const onStripKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(stripRef.current?.querySelectorAll<HTMLElement>("button") ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      buttons[(at + delta + buttons.length) % buttons.length]?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      buttons[at]?.click();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setEntries(null);
      previousFocus.current?.focus?.();
      previousFocus.current = null;
    }
  };

  if (entries) {
    return (
      <div
        ref={stripRef}
        role="menubar"
        data-window-title-bar=""
        data-window-menu-bar=""
        onKeyDown={onStripKey}
        className="window-title-bar fixed z-[100002] flex items-center gap-0.5 bg-background ps-1 pe-3 text-xs text-foreground select-none"
        style={{ top: area.y, left: area.x, width: area.width, height: area.height }}
      >
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            data-menu-id={entry.id}
            onClick={() => openMenu(entry.id)}
            className="window-title-bar-item rounded px-2 py-1 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
          >
            {entry.label}
          </button>
        ))}
      </div>
    );
  }

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
