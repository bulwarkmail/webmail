"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import type { DesktopMenuBarEntry } from "@/lib/desktop/types";

/**
 * Alt floats the menu's names over the top left for a moment, since a window with no
 * frame has no native bar. Each name opens the app's menu as a native one
 * (src/main/menu.ts in the desktop repo). Dismissed, nothing is left of it.
 */
export function WindowMenuBar() {
  const t = useTranslations("desktopUi.menu");
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

  const dismiss = useCallback(() => {
    setEntries(null);
    previousFocus.current?.focus?.();
    previousFocus.current = null;
  }, []);

  useEffect(() => {
    const bar = getDesktopBridge()?.menu?.bar;
    if (!bar) return;
    return bar.onEvent((event) => {
      if (!event.visible) {
        dismiss();
        return;
      }
      void bar.entries().then((list) => {
        previousFocus.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
        afterShow.current = event.open ?? null;
        setEntries(list);
      });
    });
  }, [dismiss]);

  useEffect(() => {
    const next = afterShow.current;
    if (!entries || next === undefined) return;
    afterShow.current = undefined;
    if (next) openMenu(next);
    else stripRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [entries, openMenu]);

  if (!entries) return null;

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
      dismiss();
    }
  };

  return (
    <div
      ref={stripRef}
      role="menubar"
      aria-label={t("bar_label")}
      data-window-menu-bar=""
      onKeyDown={onStripKey}
      className="fixed start-2 top-2 z-[100002] flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-lg select-none"
    >
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          data-menu-id={entry.id}
          onClick={() => openMenu(entry.id)}
          className="rounded px-2.5 py-1 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}
