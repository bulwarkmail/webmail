"use client";

// The popup on an underlined issue. Opens under the word (above it when
// there is no room), follows it while the page scrolls, and closes on
// Escape, on a click elsewhere, and when the issue goes away.
//
// Opened with the mouse, it leaves the focus in the text, so typing goes on
// and Escape closes it. Opened from the keyboard (next/previous issue, the
// issue list, the context-menu key), it takes the focus: arrows move between
// its buttons, Enter picks, Escape goes back to the text.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import type { DismissAction, PlacedIssue } from "@/lib/proofreading/composer-proofreader";
import type { IssuePopupState } from "./use-proofreading";
import { IssueActions } from "./issue-actions";

const WIDTH = 320;
const GAP = 6;

interface Props {
  state: IssuePopupState;
  issue: PlacedIssue;
  /** Where the issue is now (it moves with typing and scrolling). */
  anchor: () => DOMRect | null;
  onApply: (issue: PlacedIssue, replacement: string) => boolean;
  onDismiss: (issue: PlacedIssue, action: DismissAction) => void;
  onClose: (refocus: boolean) => void;
}

function place(anchor: DOMRect | null, height: number): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!anchor) return { top: Math.max(8, vh / 2 - height / 2), left: Math.max(8, vw / 2 - WIDTH / 2) };
  const rtl = document.documentElement.dir === "rtl";
  let left = rtl ? anchor.right - WIDTH : anchor.left;
  left = Math.min(Math.max(8, left), vw - WIDTH - 8);
  let top = anchor.bottom + GAP;
  if (top + height > vh - 8 && anchor.top - GAP - height > 8) top = anchor.top - GAP - height;
  return { top: Math.max(8, top), left };
}

export function IssuePopup({ state, issue, anchor, onApply, onDismiss, onClose }: Props) {
  const t = useTranslations("proofreading");
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  useLayoutEffect(() => {
    const update = () => setPos(place(anchorRef.current() ?? state.anchor, ref.current?.offsetHeight ?? 200));
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [state, issue.key]);

  // From the keyboard, the popup takes the focus.
  useEffect(() => {
    setError(null);
    if (state.via !== "keyboard" && state.via !== "contextmenu") return;
    const first = ref.current?.querySelector<HTMLElement>("[data-popup-item]");
    first?.focus();
  }, [state, issue.key]);

  // A click anywhere else closes it (a click on another underline opens that one).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (ref.current?.contains(target)) return;
      if (target?.closest?.("[data-text-issue]")) return;
      onClose(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("[data-popup-item]") ?? []);
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const rtl = document.documentElement.dir === "rtl";
    // Right is forward in left-to-right text, back in right-to-left.
    const forward = e.key === "ArrowDown" || e.key === (rtl ? "ArrowLeft" : "ArrowRight");
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else next = forward ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next].focus();
  };

  const apply = (target: PlacedIssue, replacement: string) => {
    if (!onApply(target, replacement)) setError(t("popup.changed"));
  };

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={t("popup.label", { kind: t(`kind.${issue.kind}`), word: issue.annotation.text })}
      data-testid="proofreading-popup"
      className="fixed z-50 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-lg"
      style={{ width: WIDTH, maxWidth: "calc(100vw - 16px)", top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        // Tabbing out of it closes it; a click inside doesn't.
        const next = e.relatedTarget as Node | null;
        if (next && !ref.current?.contains(next)) onClose(false);
      }}
    >
      <IssueActions issue={issue} onApply={apply} onDismiss={onDismiss} error={error} />
    </div>,
    document.body,
  );
}
