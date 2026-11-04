"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Share2, Users } from "@/components/icons";
import { cn, formatFileSize } from "@/lib/utils";
import { getEffectiveTimeZone } from "@/lib/timezone";
import { getEffectiveLocale } from "@/i18n/detect-locale";
import { useSettingsStore } from "@/stores/settings-store";
import type { FileResource } from "@/stores/file-store";
import { getFileIconByName, getFolderIcon, getSymlinkIcon, isImageFile, type FileIconSize } from "@/components/files/file-icons";

/** How list and grid items draw their icon, from Settings > Files. */
export interface IconOptions {
  showIcons: boolean;
  coloredIcons: boolean;
  showThumbnails: boolean;
}

// Thumbnails download the whole image, so skip very large ones.
const MAX_THUMBNAIL_BYTES = 15 * 1024 * 1024;

// Blob ids name immutable content, so a thumbnail fetched once stays valid
// while the page lives; switching views or folders reuses it.
const thumbnailCache = new Map<string, Promise<string>>();

export function canShowThumbnail(resource: FileResource, options: IconOptions): boolean {
  return options.showThumbnails
    && !resource.isDirectory
    && !resource.isSymlink
    && !!resource.blobId
    && isImageFile(resource.name)
    && resource.contentLength <= MAX_THUMBNAIL_BYTES;
}

/**
 * An image file's preview, fetched once it scrolls into view. Renders
 * `fallback` until the image is ready, and keeps it when the fetch fails.
 */
export function Thumbnail({ resource, getImageUrl, className, wrapperClassName, fallback }: {
  resource: FileResource;
  getImageUrl: (name: string) => Promise<string>;
  className?: string;
  /** Sizes the box the image or fallback sits in. */
  wrapperClassName?: string;
  fallback: React.ReactNode;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "200px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !resource.blobId) return;
    let cancelled = false;
    const key = resource.blobId;
    let pending = thumbnailCache.get(key);
    if (!pending) {
      pending = getImageUrl(resource.name);
      thumbnailCache.set(key, pending);
      pending.catch(() => thumbnailCache.delete(key));
    }
    pending.then((url) => { if (!cancelled) setSrc(url); }).catch(() => {});
    return () => { cancelled = true; };
  }, [visible, resource.blobId, resource.name, getImageUrl]);

  return (
    <span ref={ref} className={cn("inline-flex items-center justify-center shrink-0", wrapperClassName)}>
      {src ? <img src={src} alt="" className={className} loading="lazy" draggable={false} /> : fallback}
    </span>
  );
}

/** A folder, symlink or file icon, or nothing when icons are turned off. */
export function ResourceIcon({ resource, size, options }: {
  resource: FileResource;
  size: FileIconSize;
  options: Pick<IconOptions, "showIcons" | "coloredIcons">;
}) {
  const t = useTranslations("files");
  if (!options.showIcons) return null;
  if (resource.isDirectory) return getFolderIcon(size, options.coloredIcons);
  if (resource.isSymlink) return getSymlinkIcon(size, t("symlink"));
  return getFileIconByName(resource.name, size, options.coloredIcons);
}

// A node shared out by the user (shareWith has entries) or a node shared
// *with* the user by another principal (isShared).
export function ShareBadge({ resource, t, className }: {
  resource: FileResource;
  t: (key: string, values?: Record<string, string>) => string;
  className?: string;
}) {
  const sharedOut = !!resource.shareWith && Object.keys(resource.shareWith).length > 0;
  if (resource.isShared) {
    const label = resource.ownerName ? t("shared_by", { name: resource.ownerName }) : t("shared_with_me");
    return (
      <Share2 className={cn("w-3.5 h-3.5 text-muted-foreground shrink-0", className)} aria-label={label}>
        <title>{label}</title>
      </Share2>
    );
  }
  if (sharedOut) {
    return (
      <Users className={cn("w-3.5 h-3.5 text-muted-foreground shrink-0", className)} aria-label={t("shared")}>
        <title>{t("shared")}</title>
      </Users>
    );
  }
  return null;
}

/**
 * A size that keeps its number before its unit ("6.7 KB") in a right-to-left
 * layout too, where the bidi algorithm would otherwise show "KB 6.7".
 */
export function FileSize({ bytes }: { bytes: number }) {
  return <bdi dir="ltr">{formatFileSize(bytes)}</bdi>;
}

/** Dates follow the app's language and 12/24-hour setting, as Mail's list does, not the browser's. */
function dateLocale(): { locale: string; hour12: boolean } {
  const locale = getEffectiveLocale();
  return { locale: locale === "en" ? "en-US" : locale, hour12: useSettingsStore.getState().timeFormat === "12h" };
}

/** Full date and time, for tooltips and the details panel. */
export function formatFullDate(value: string): string {
  if (!value) return "";
  try {
    const { locale, hour12 } = dateLocale();
    return new Date(value).toLocaleString(locale, {
      timeZone: getEffectiveTimeZone(),
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12,
    });
  } catch {
    return value;
  }
}

/** Short date for the list: the time today, day and month this year, the full date otherwise. */
export function formatShortDate(value: string, now = new Date()): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const timeZone = getEffectiveTimeZone();
  const dayKey = (d: Date) => d.toLocaleDateString("en-CA", { timeZone });
  try {
    const { locale, hour12 } = dateLocale();
    if (dayKey(date) === dayKey(now)) {
      return date.toLocaleTimeString(locale, { timeZone, hour: "2-digit", minute: "2-digit", hour12 });
    }
    const sameYear = date.toLocaleDateString("en-CA", { timeZone, year: "numeric" })
      === now.toLocaleDateString("en-CA", { timeZone, year: "numeric" });
    return date.toLocaleDateString(locale, {
      timeZone,
      day: "numeric",
      month: "short",
      ...(sameYear ? {} : { year: "numeric" }),
    });
  } catch {
    return value;
  }
}

// Items dragged inside the app carry their names under this type; external
// drags carry "Files" and mean an upload.
export const INTERNAL_DRAG_TYPE = "application/x-file-names";

export function isInternalDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(INTERNAL_DRAG_TYPE);
}

export function readDraggedNames(e: React.DragEvent): string[] {
  const raw = e.dataTransfer.getData(INTERNAL_DRAG_TYPE);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

/**
 * A file name split for cutting in the middle: the start gives way, the end
 * stays, so "IMG_20250611_1003.png" reads "IMG_20250…1003.png" and the
 * extension and the part that tells similar names apart stay in view. Short
 * names and folders' names (no extension) keep a shorter tail.
 */
export function splitNameForMiddleCut(name: string): { head: string; tail: string } {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
  const tailLength = Math.min(ext.length + 4, Math.floor(name.length / 2));
  if (name.length < 12 || tailLength <= 0) return { head: name, tail: "" };
  return { head: name.slice(0, name.length - tailLength), tail: name.slice(name.length - tailLength) };
}

/**
 * A name cut in the middle when there is no room (pim-21). The whole name is
 * the title; screen readers read it as one text.
 */
export function MiddleCutName({ name, title, className }: { name: string; title?: string; className?: string }) {
  const { head, tail } = splitNameForMiddleCut(name);
  return (
    <span className={cn("flex min-w-0", className)} title={title ?? name} dir="auto">
      <span className="truncate whitespace-pre">{head}</span>
      {tail && <span className="shrink-0 whitespace-pre">{tail}</span>}
    </span>
  );
}

/** Open a shared context menu as a dropdown under a button. */
export function anchorEvent(el: HTMLElement, align: "start" | "end" = "start"): React.MouseEvent {
  const rect = el.getBoundingClientRect();
  const rtl = typeof document !== "undefined" && document.dir === "rtl";
  const alignEnd = (align === "end") !== rtl;
  return {
    clientX: alignEnd ? rect.right - 200 : rect.left,
    clientY: rect.bottom + 4,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as React.MouseEvent;
}
