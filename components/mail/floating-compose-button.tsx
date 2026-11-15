"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { PenSquare } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type FloatingComposeKind = "phone" | "mv-phone" | "pane" | "desktop";

/**
 * How far the list has to move before the desktop button changes shape, so a
 * trackpad's last few pixels of momentum don't make it flicker.
 */
const SCROLL_STEP = 4;

/**
 * Compose over the bottom end corner of the message list. On a desktop it
 * carries its label, and folds to the round icon while the list scrolls down,
 * so it covers less of the rows going past; scrolling back up, or reaching
 * the top, unfolds it again.
 */
export function FloatingComposeButton({ kind, onCompose }: { kind: FloatingComposeKind; onCompose: () => void }) {
  const t = useTranslations();
  const ref = useRef<HTMLButtonElement>(null);
  const [folded, setFolded] = useState(false);

  useEffect(() => {
    if (kind !== "desktop") return;
    // The list's scroller is a sibling's descendant, and scroll events don't
    // bubble: listen in the capture phase on the pane the button sits in.
    const pane = ref.current?.parentElement;
    if (!pane) return;
    const last = new WeakMap<EventTarget, number>();
    const onScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const top = target.scrollTop;
      const before = last.get(target) ?? 0;
      if (Math.abs(top - before) < SCROLL_STEP) return;
      last.set(target, top);
      setFolded(top > before && top > SCROLL_STEP);
    };
    pane.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => pane.removeEventListener("scroll", onScroll, { capture: true });
  }, [kind]);

  const labelled = kind === "mv-phone" || (kind === "desktop" && !folded);
  return (
    <Button
      ref={ref}
      onClick={onCompose}
      className={cn(
        // Under the drawer's backdrop (z-40), which comes earlier in the page.
        "absolute z-30 shadow-lg bottom-4 end-4",
        kind === "mv-phone" && "h-14 gap-3 rounded-2xl px-5",
        kind === "phone" && "h-14 w-14 rounded-full",
        kind === "pane" && "h-12 w-12 rounded-full",
        kind === "desktop" && "h-12 rounded-full transition-[padding,gap] duration-200",
        kind === "desktop" && (folded ? "w-12 px-0 gap-0" : "gap-2 ps-4 pe-5"),
      )}
      aria-label={t("sidebar.compose")}
      title={t("sidebar.compose_hint")}
      data-tour="compose-button"
      data-floating-compose={kind}
    >
      <PenSquare className={kind === "phone" || kind === "mv-phone" ? "h-6 w-6" : "h-5 w-5"} />
      {labelled && <span className="text-sm font-medium">{t("sidebar.compose")}</span>}
    </Button>
  );
}
