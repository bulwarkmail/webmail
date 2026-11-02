"use client";

import { useEffect, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, Download, X } from "@/components/icons";
import { IconButton } from "@/components/ui/icon-button";
import { useFocusTrap } from "@/hooks/use-focus-trap";

export interface PreviewNeighbours {
  /** The previous and next previewable file of the folder, if any. */
  previous?: string | null;
  next?: string | null;
  onGo: (name: string) => void;
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
  children: ReactNode;
}

/**
 * The one frame both file previews use (images and everything else): the
 * same dim backdrop, a header with the name, Download and Close, ←/→ to the
 * previous and next file of the folder, Escape to close.
 */
export function PreviewShell({ name, onClose, onDownload, actions, neighbours, closeOnBackdrop = true, children }: PreviewShellProps) {
  const t = useTranslations("files");
  // Tab stays in the preview and the focus goes back to the file that was
  // opened when it closes. Escape is the listener below.
  const shellRef = useFocusTrap({ isActive: true, restoreFocus: true });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
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
  }, [onClose, neighbours]);

  return (
    <div
      ref={shellRef}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      className="fixed inset-0 z-50 flex flex-col bg-black/80"
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      {/* Full-screen under `viewport-fit=cover`: the bar pads itself out of
          the iOS status bar (#936). The insets are physical, so pl/pr. */}
      <div
        className="flex items-center justify-between gap-2 pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))] pt-[calc(0.75rem+env(safe-area-inset-top))] pb-3 bg-background/90 backdrop-blur border-b border-border"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-medium truncate" title={name}>{name}</h3>
        <div className="flex items-center gap-1 shrink-0">
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
          <IconButton label={t("close_preview")} onClick={onClose}>
            <X />
          </IconButton>
        </div>
      </div>
      {children}
    </div>
  );
}
