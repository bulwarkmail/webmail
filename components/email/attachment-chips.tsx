"use client";

import { FileText, FileSpreadsheet, FileImage, FileArchive, File as FileIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Attachment } from "@/lib/jmap/types";

/**
 * A message can carry a dozen inline images — signature logos, tracking
 * pixels, spacers a couple of hundred bytes each — none of which anyone
 * wants to download. Only parts the sender actually attached belong in
 * the list, so anything marked inline or referenced by a Content-ID is
 * dropped.
 */
export function realAttachments(attachments?: Attachment[]): Attachment[] {
  if (!attachments?.length) return [];
  return attachments.filter(
    (a) => a.disposition !== "inline" && !a.cid && !!a.name,
  );
}

const ICON_BY_TYPE: { match: RegExp; icon: typeof FileIcon; className: string }[] = [
  { match: /^image\//, icon: FileImage, className: "text-violet-600 dark:text-violet-400" },
  { match: /pdf/, icon: FileText, className: "text-red-600 dark:text-red-400" },
  { match: /sheet|excel|csv/, icon: FileSpreadsheet, className: "text-emerald-600 dark:text-emerald-400" },
  { match: /zip|compress|tar|rar|7z/, icon: FileArchive, className: "text-amber-600 dark:text-amber-400" },
  { match: /word|document|rtf|text\//, icon: FileText, className: "text-sky-600 dark:text-sky-400" },
];

function iconFor(type: string, name: string) {
  const probe = `${type || ""} ${name || ""}`.toLowerCase();
  return ICON_BY_TYPE.find((e) => e.match.test(probe)) ?? { icon: FileIcon, className: "text-muted-foreground" };
}

/** Long names are unreadable truncated at the tail — the extension is the
 *  most identifying part, so keep it and elide the middle. */
function shortName(name: string, max = 18): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : "";
  const head = name.slice(0, Math.max(1, max - ext.length - 1));
  return `${head}…${ext}`;
}

interface AttachmentChipsProps {
  attachments?: Attachment[];
  onOpen: (attachment: Attachment) => void;
  /** How many chips to show before collapsing the rest into a count. */
  max?: number;
  className?: string;
}

export function AttachmentChips({ attachments, onOpen, max = 2, className }: AttachmentChipsProps) {
  const real = realAttachments(attachments);
  if (!real.length) return null;

  const shown = real.slice(0, max);
  const overflow = real.length - shown.length;

  return (
    <div className={cn("flex items-center gap-1.5 flex-wrap", className)}>
      {shown.map((a) => {
        const { icon: Icon, className: iconClass } = iconFor(a.type, a.name ?? "");
        return (
          <button
            key={a.blobId + a.partId}
            type="button"
            // The row itself opens the message; a chip must not do both.
            onClick={(e) => { e.stopPropagation(); onOpen(a); }}
            onDoubleClick={(e) => e.stopPropagation()}
            title={a.name}
            className="inline-flex max-w-[12rem] items-center gap-1.5 rounded-md border border-border bg-background/60 px-2 py-0.5 text-xs text-foreground/80 hover:bg-muted hover:text-foreground"
          >
            <Icon className={cn("h-3.5 w-3.5 flex-shrink-0", iconClass)} />
            <span className="truncate">{shortName(a.name ?? "")}</span>
          </button>
        );
      })}
      {overflow > 0 && (
        <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground tabular-nums">
          +{overflow}
        </span>
      )}
    </div>
  );
}
