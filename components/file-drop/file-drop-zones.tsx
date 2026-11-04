"use client";

import { forwardRef, type ComponentType, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { CalendarPlus, FolderInput, ImageIcon, MailOpen, Paperclip, SquarePen, Upload, UserPlus } from "@/components/icons";
import type { FileDropNote, FileDropZone, FileDropZoneId } from "@/lib/file-drop/zones";
import { cn, formatFileSize } from "@/lib/utils";

const ICONS: Record<FileDropZoneId, ComponentType<{ className?: string }>> = {
  "attach-here": Paperclip,
  "insert-inline": ImageIcon,
  "new-message": SquarePen,
  upload: Upload,
  calendar: CalendarPlus,
  contacts: UserPlus,
  "open-eml": MailOpen,
  "import-eml": FolderInput,
};

export function useZoneText() {
  const t = useTranslations("fileDrop");
  const label = (zone: FileDropZone): string => {
    switch (zone.id) {
      case "attach-here": return t("zone_attach_here");
      case "insert-inline": return t("zone_insert_inline");
      case "new-message": return t("zone_new_message");
      case "upload": return zone.folder ? t("zone_upload_folder", { folder: zone.folder }) : t("zone_upload_files");
      case "calendar": return t("zone_calendar");
      case "contacts": return t("zone_contacts");
      case "open-eml": return t("zone_open_eml");
      case "import-eml": return t("zone_import_eml", { folder: zone.folder ?? "" });
    }
  };
  const note = (value: FileDropNote | undefined): string | null => {
    if (!value) return null;
    switch (value.key) {
      case "note_limit_message": return t("note_limit_message", { size: formatFileSize(value.size) });
      case "note_limit_file": return t("note_limit_file", { size: formatFileSize(value.size) });
      case "note_kept_offline": return t("note_kept_offline");
      case "note_needs_connection": return t("note_needs_connection");
    }
  };
  return { label, note };
}

interface ZoneCardProps {
  zone: FileDropZone;
  label: string;
  note: string | null;
  active?: boolean;
  /** "button" in the dialog; a plain region during a drag, which nothing can focus. */
  as?: "button" | "div";
  onClick?: () => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLElement>) => void;
  children?: ReactNode;
}

/** One big choice: the same look as a drop target and as a button. */
export const ZoneCard = forwardRef<HTMLButtonElement & HTMLDivElement, ZoneCardProps>(function ZoneCard(
  { zone, label, note, active = false, as = "div", onClick, onKeyDown },
  ref,
) {
  const Icon = ICONS[zone.id];
  const className = cn(
    "group flex min-h-36 flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-6 text-center transition-colors select-none",
    zone.disabled
      ? "border-border bg-muted/40 text-muted-foreground cursor-not-allowed"
      : active
        ? "border-primary bg-primary/10 text-foreground ring-4 ring-primary/20"
        : "border-border bg-background/90 text-foreground hover:border-primary/60",
    as === "button" && !zone.disabled && "focus-visible:outline-none focus-visible:border-primary focus-visible:ring-4 focus-visible:ring-primary/30",
  );
  const content = (
    <>
      <Icon className={cn("h-10 w-10", zone.disabled ? "text-muted-foreground" : active ? "text-primary" : "text-muted-foreground group-hover:text-primary")} />
      <span className="text-lg font-semibold leading-snug">{label}</span>
      {note && <span className="text-sm text-muted-foreground">{note}</span>}
    </>
  );
  if (as === "button") {
    return (
      <button
        ref={ref}
        type="button"
        className={className}
        data-drop-zone={zone.id}
        aria-disabled={zone.disabled || undefined}
        onClick={zone.disabled ? undefined : onClick}
        onKeyDown={onKeyDown}
      >
        {content}
      </button>
    );
  }
  return (
    <div
      ref={ref}
      className={className}
      data-drop-zone={zone.id}
      data-active={active || undefined}
      data-disabled={zone.disabled || undefined}
      role="group"
      aria-label={note ? `${label}. ${note}` : label}
    >
      {content}
    </div>
  );
});

/** Two zones side by side, three in a row, four as two by two (a row on a wide window). */
export function zoneGridClass(count: number): string {
  if (count <= 1) return "grid-cols-1 max-w-md";
  if (count === 2) return "grid-cols-1 sm:grid-cols-2 max-w-3xl";
  if (count === 3) return "grid-cols-1 sm:grid-cols-3 max-w-5xl";
  return "grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 max-w-6xl";
}
