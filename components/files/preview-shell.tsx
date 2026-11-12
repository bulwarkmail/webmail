"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, Download, Puzzle, X } from "@/components/icons";
import { IconButton } from "@/components/ui/icon-button";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useCloseBesideControls } from "@/hooks/use-close-beside-controls";

export interface PreviewNeighbours {
  /** The previous and next previewable file of the folder, if any. */
  previous?: string | null;
  next?: string | null;
  onGo: (name: string) => void;
}

/** A backdrop click this soon after the preview opened is part of the click that opened it. */
export const BACKDROP_GRACE_MS = 400;

/**
 * `onClose` for a click on the area around the content. The rest of the
 * click that opened the preview (a double-click's second click, a
 * triple-click) is ignored, so it can't close the preview again (pim-3).
 */
export function useBackdropClose(onClose: () => void): () => void {
  const openedAt = useRef(0);
  useEffect(() => {
    openedAt.current = Date.now();
  }, []);
  return useCallback(() => {
    if (Date.now() - openedAt.current < BACKDROP_GRACE_MS) return;
    onClose();
  }, [onClose]);
}

interface PreviewShellProps {
  name: string;
  onClose: () => void;
  /** Left out: no download button (a device policy turned downloads off). */
  onDownload?: () => void;
  /** Extra header buttons before Download (e.g. "Open in new tab"). */
  actions?: ReactNode;
  neighbours?: PreviewNeighbours;
  /** Click on the dark area around the content closes the preview. */
  closeOnBackdrop?: boolean;
  /**
   * Who opened the file, when it wasn't the user ("Opened by the plugin X"):
   * a line of its own under the name, which stays on one line, so a long name
   * can't push it out of view.
   */
  source?: string;
  children: ReactNode;
}

/**
 * The one frame both file previews use (images and everything else): the
 * same dim backdrop, a header with the name, Download and Close, ←/→ to the
 * previous and next file of the folder, Escape to close.
 */
export function PreviewShell({ name, onClose, onDownload, actions, neighbours, closeOnBackdrop = true, source, children }: PreviewShellProps) {
  const t = useTranslations("files");
  const sourceId = useId();
  const closeFromBackdrop = useBackdropClose(onClose);
  // Tab stays in the preview and the focus goes back to the file that was
  // opened when it closes. Escape is the listener below.
  const shellRef = useFocusTrap({ isActive: true, restoreFocus: true });
  // Its own close goes to the bar's start when the window's close is at its end.
  const [bar, setBar] = useState<HTMLDivElement | null>(null);
  const closeFirst = useCloseBesideControls(bar);
  const close = (
    <IconButton label={t("close_preview")} onClick={onClose} className="shrink-0">
      <X />
    </IconButton>
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // A dialog opened from the preview (Import to a mail folder…) sits on top
        // and closes first; the preview stays.
        const target = e.target instanceof Element ? e.target : null;
        const above = target?.closest('[role="dialog"], [role="alertdialog"]');
        if (above && shellRef.current && !shellRef.current.contains(above)) return;
        e.stopPropagation();
        onClose();
        return;
      }
    };
    // The arrows after the content's own keys: a zoomed image pans with them
    // and takes the key (preventDefault), the frame goes to the next file.
    const onArrow = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !neighbours || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest("input, textarea, [contenteditable=true]")) return;
      const rtl = document.dir === "rtl";
      const forward = rtl ? "ArrowLeft" : "ArrowRight";
      const back = rtl ? "ArrowRight" : "ArrowLeft";
      if (e.key === forward && neighbours.next) {
        e.preventDefault();
        neighbours.onGo(neighbours.next);
      } else if (e.key === back && neighbours.previous) {
        e.preventDefault();
        neighbours.onGo(neighbours.previous);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("keydown", onArrow);
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("keydown", onArrow);
    };
  }, [onClose, neighbours, shellRef]);

  return (
    <div
      ref={shellRef}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      aria-describedby={source ? sourceId : undefined}
      className="fixed inset-0 z-50 flex flex-col bg-black/80"
      onClick={closeOnBackdrop ? closeFromBackdrop : undefined}
    >
      {/* Full-screen under `viewport-fit=cover`: the bar pads itself out of
          the iOS status bar (#936). The insets are physical, so pl/pr. */}
      <div
        ref={setBar}
        data-window-top-row=""
        className="flex items-center justify-between gap-2 pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))] pt-[calc(0.75rem+var(--app-top-inset))] pb-3 bg-background/90 backdrop-blur border-b border-border"
        onClick={(e) => e.stopPropagation()}
      >
        {closeFirst && close}
        {source ? (
          <div className="min-w-0">
            <h3 className="text-sm font-medium truncate" title={name}>{name}</h3>
            <p id={sourceId} className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground" data-preview-source="">
              <Puzzle className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
              <span className="truncate">{source}</span>
            </p>
          </div>
        ) : (
          <h3 className="text-sm font-medium truncate" title={name}>{name}</h3>
        )}
        <div className="flex items-center gap-1 shrink-0 ms-auto">
          {neighbours && (
            <>
              <IconButton label={t("previous_file")} disabled={!neighbours.previous} onClick={() => neighbours.previous && neighbours.onGo(neighbours.previous)}>
                <ChevronLeft />
              </IconButton>
              <IconButton label={t("next_file")} disabled={!neighbours.next} onClick={() => neighbours.next && neighbours.onGo(neighbours.next)}>
                <ChevronRight />
              </IconButton>
            </>
          )}
          {actions}
          {onDownload && (
            <IconButton label={t("download")} onClick={onDownload}>
              <Download />
            </IconButton>
          )}
        </div>
        {!closeFirst && close}
      </div>
      {children}
    </div>
  );
}
