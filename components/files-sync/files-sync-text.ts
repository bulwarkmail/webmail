import type { FilesRoot } from "@/lib/desktop/types";
import type { FilesSyncActivityKind, FilesSyncItemStatus } from "@/lib/files-sync/types";

/** The engine's message keys, under `files_sync.errors.`. */
export const FILES_SYNC_ERROR_KEYS = [
  "offline", "server_refused", "too_large", "name_invalid", "disk_full", "denied", "busy", "quota", "not_found", "policy", "failed",
] as const;

/**
 * The key inside the `files_sync` namespace for an engine message key. The engine may
 * write `offline`, `errors.offline` or `files_sync.errors.offline`; anything unknown
 * reads as `failed`, so a new key never shows raw.
 */
export function filesSyncErrorKey(key: string | undefined | null): string {
  const last = (key ?? "").split(".").pop() ?? "";
  return `errors.${(FILES_SYNC_ERROR_KEYS as readonly string[]).includes(last) ? last : "failed"}`;
}

export const FILES_SYNC_ACTIVITY_KINDS: readonly FilesSyncActivityKind[] = [
  "uploaded", "downloaded", "folder-created", "renamed", "moved", "deleted", "trashed",
  "conflict", "renamed-for-disk", "too-large", "waiting", "mass-delete", "error",
];

export const FILES_SYNC_ITEM_STATES: readonly FilesSyncItemStatus[] = ["synced", "syncing", "pending", "error", "online-only"];

/** "Show in Explorer", "Show in Finder", "Show in file manager". */
export function showInKey(platform: string | undefined | null): string {
  if (platform === "win32") return "show_in.explorer";
  if (platform === "darwin") return "show_in.finder";
  return "show_in.file_manager";
}

/** The name of a root to show: the drive's, or the last part of the folder's path. */
export function rootName(root: FilesRoot, driveName: string): string {
  if (root.kind === "drive") return driveName;
  const parts = root.path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? root.path;
}

/** A time as "14:05" today and "3 Nov, 14:05" before. */
export function syncTimeOptions(at: number, now = Date.now()): { hour: "numeric"; minute: "2-digit"; day?: "numeric"; month?: "short" } {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" };
}
