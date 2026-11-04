"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronUp } from "@/components/icons";
import { cn } from "@/lib/utils";

/**
 * Below this reading-pane height a docked reply can't share the pane with
 * the message: an 800×600 window or a 1366×768 laptop at 150 % left two
 * lines to type in and none of the message (compose-p2-4).
 */
export const DOCK_SHARE_MIN_PANE = 700;

/**
 * How the reply docked under its message takes the reading pane
 * (mail-p2-2, compose-p2-4).
 *
 * - A tall pane: the reply starts as high as its content (the compact
 *   composer: To, a few lines, the bottom bar) and grows with the text up to
 *   half the pane, so the message stays readable above it.
 * - A short pane: the reply takes the pane, with "Show the message" to fold it
 *   to a bar and read the message, and back.
 */
export function dockLayout(paneHeight: number): { mode: 'share' | 'takeover'; maxHeight?: number } {
  if (paneHeight > 0 && paneHeight < DOCK_SHARE_MIN_PANE) return { mode: 'takeover' };
  return { mode: 'share', maxHeight: paneHeight > 0 ? Math.round(paneHeight / 2) : undefined };
}

export function ReplyDock({ children }: { children: ReactNode }) {
  const t = useTranslations("mail_p2_conv");
  const ref = useRef<HTMLDivElement>(null);
  const [paneHeight, setPaneHeight] = useState(0);
  // The reader's toolbar and subject above its scrolling part: they stay.
  const [readerChrome, setReaderChrome] = useState(0);
  const [showMessage, setShowMessage] = useState(false);

  useLayoutEffect(() => {
    const pane = ref.current?.parentElement;
    if (!pane) return;
    const measure = () => {
      const paneBox = pane.getBoundingClientRect();
      setPaneHeight(Math.round(paneBox.height));
      const scroll = pane.querySelector<HTMLElement>("[data-reader-scroll]");
      setReaderChrome(scroll ? Math.max(0, Math.round(scroll.getBoundingClientRect().top - paneBox.top)) : 0);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(pane);
    return () => ro.disconnect();
  }, []);

  const layout = dockLayout(paneHeight);
  const takeover = layout.mode === "takeover";
  const folded = takeover && showMessage;

  return (
    <div
      ref={ref}
      data-reply-dock=""
      data-dock-mode={layout.mode}
      className="flex min-h-0 shrink-0 flex-col border-t border-border bg-background"
      style={takeover
        ? (folded ? undefined : { height: Math.max(paneHeight - readerChrome, 0) })
        : { maxHeight: layout.maxHeight ?? "50%" }}
    >
      {takeover && (
        <button
          type="button"
          onClick={() => setShowMessage((v) => !v)}
          aria-expanded={showMessage}
          data-dock-show-message=""
          className="flex shrink-0 items-center justify-center gap-1.5 border-b border-border px-4 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          {showMessage ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          {showMessage ? t("back_to_reply") : t("show_message")}
        </button>
      )}
      {/* Folded, the composer stays mounted, with its text and its undo history. */}
      <div className={cn("flex min-h-0 flex-1 flex-col", folded && "hidden")}>
        {children}
      </div>
    </div>
  );
}
