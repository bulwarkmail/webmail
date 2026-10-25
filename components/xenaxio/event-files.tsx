"use client";

// Step 32: files of a meeting. The assistant links them to the event as
// "enclosure" links: href names the part of the invitation email (cid:), and
// on the organizer's own event blobId points at the file in "Dateien", so it
// downloads from there. Invitations from others carry the file in their email;
// files given as web addresses open in a new tab.
import { useState } from "react";
import { Paperclip } from "@/components/icons";
import type { CalendarLink } from "@/lib/jmap/types";
import { safeHttpUrl } from "@/lib/xenaxio/brand";
import { useXT } from "@/lib/xenaxio/i18n";
import { useAuthStore } from "@/stores/auth-store";

type FileLink = CalendarLink & { blobId?: string | null };

/** Links of an event that are files, in a stable order. */
export function eventFiles(links: Record<string, CalendarLink> | null | undefined): FileLink[] {
  return Object.entries(links ?? {})
    .filter(([, l]) => l && (l.rel === "enclosure" || (l as FileLink).blobId))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, l]) => l as FileLink);
}

export function EventFiles({ links }: { links: Record<string, CalendarLink> | null | undefined }) {
  const t = useXT();
  const client = useAuthStore((s) => s.client);
  const [failed, setFailed] = useState(false);
  const files = eventFiles(links);
  if (files.length === 0) return null;

  const download = async (file: FileLink) => {
    if (!client || !file.blobId) return;
    setFailed(false);
    try {
      await client.downloadBlob(file.blobId, file.title || "download", file.contentType || "application/octet-stream");
    } catch {
      setFailed(true);
    }
  };

  return (
    <div className="flex items-start gap-2.5">
      <Paperclip className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" aria-label={t("event_files.title")} />
      <div className="min-w-0 space-y-0.5 text-sm">
        {files.map((file, i) => {
          const name = file.title || (file.href ?? "").replace(/^cid:/, "");
          const web = file.blobId ? "" : safeHttpUrl(file.href);
          if (web) {
            return (
              <a key={`${file.href}-${i}`} href={web} target="_blank" rel="noopener noreferrer" className="block max-w-full truncate text-primary hover:underline">
                {name}
              </a>
            );
          }
          return file.blobId ? (
            <button
              key={`${file.blobId}-${i}`}
              type="button"
              onClick={() => void download(file)}
              className="block max-w-full truncate text-left text-primary hover:underline"
              title={t("event_files.download", { name })}
            >
              {name}
            </button>
          ) : (
            <p key={`${file.href}-${i}`} className="truncate text-foreground">
              {name} <span className="text-muted-foreground">({t("event_files.in_invitation")})</span>
            </p>
          );
        })}
        {failed && <p className="text-xs text-destructive">{t("event_files.failed")}</p>}
      </div>
    </div>
  );
}
