"use client";

import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { AlertTriangle, X } from "lucide-react";
import { useUpdateStore, selectBanner } from "@/stores/update-store";
import { cn } from "@/lib/utils";

// Single-line, low-key update notice. Lives next to the version badge on the
// login screen — deliberately understated so it doesn't distract from the
// auth flow. Red variants (security / deprecated) still use red text but
// stay the same compact shape.
export function UpdateNotice({ className }: { className?: string }) {
  const banner = useUpdateStore(useShallow(selectBanner));
  const dismiss = useUpdateStore((s) => s.dismiss);
  const startPolling = useUpdateStore((s) => s.startPolling);

  useEffect(() => {
    startPolling();
  }, [startPolling]);

  if (!banner) return null;

  const isRed = banner.variant === "red";

  const text =
    banner.severity === "security"
      ? `Security update${banner.latest ? `: ${banner.latest}` : ""}`
      : banner.severity === "deprecated"
        ? "Version no longer supported"
        : `Update available: ${banner.latest ?? ""}`;

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 text-[11px] leading-none",
        isRed
          ? "text-red-600 dark:text-red-400"
          : "text-muted-foreground/60 hover:text-muted-foreground transition-colors",
        className,
      )}
      role={isRed ? "alert" : "status"}
    >
      {isRed && <AlertTriangle className="w-3 h-3 flex-shrink-0" />}
      {banner.url ? (
        <a
          href={banner.url}
          target="_blank"
          rel="noopener noreferrer"
          className="underline-offset-2 hover:underline"
        >
          {text}
        </a>
      ) : (
        <span>{text}</span>
      )}
      {banner.dismissible && (
        <button
          type="button"
          onClick={dismiss}
          className="opacity-50 hover:opacity-100 transition-opacity flex-shrink-0"
          aria-label="Dismiss"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
