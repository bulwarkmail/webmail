"use client";

import { useEffect, type RefObject } from "react";
import { cn } from "@/lib/utils";

/**
 * Keeps the focus in the dialog when its buttons change under it: Import or
 * Export turns into the progress view, then into the summary, and the button
 * that had the focus is gone. `stage` names the view; `target` is the button
 * to focus in it.
 */
export function useFocusOnStage(target: RefObject<HTMLElement | null>, stage: string): void {
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    const dialog = el.closest('[role="dialog"], [role="alertdialog"]');
    if (!dialog || !dialog.contains(document.activeElement)) el.focus();
  }, [target, stage]);
}

/** The bar of an import or export, 0 to 1; indeterminate while nothing is known. */
export function TransferBar({ fraction, label, paused }: { fraction: number | null; label: string; paused?: boolean }) {
  const percent = fraction === null ? null : Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className="h-2 w-full rounded-full bg-primary/15 overflow-hidden"
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-300",
          paused ? "bg-amber-500" : "bg-primary",
          percent === null && "w-1/3 animate-pulse",
        )}
        style={percent === null ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}

/** A server limit in the server's own unit: Stalwart's 50000000 bytes are "50 MB" (not the 48 MB of a 1024-based size). */
export function serverMegabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** "14:00", or a date and time when the moment isn't today. */
export function formatClock(ms: number, locale: string, now = Date.now()): string {
  const date = new Date(ms);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  return new Intl.DateTimeFormat(locale, sameDay ? { hour: "2-digit", minute: "2-digit" } : { dateStyle: "medium", timeStyle: "short" }).format(date);
}
