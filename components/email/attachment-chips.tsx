"use client";

import { useEffect, useState, type ReactNode } from "react";
import { FileText, FileSpreadsheet, FileImage, FileVideo, FileAudio, FileArchive, File as FileIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { stripBidiControls } from "@/lib/bidi";
import { isReportPart } from "@/lib/attachment-visibility";
import type { Attachment, Email } from "@/lib/jmap/types";
import type { LoadListAttachments } from "@/lib/list-attachments";
import { useSettingsStore } from "@/stores/settings-store";

/**
 * A message can carry a dozen inline images — signature logos, tracking
 * pixels, spacers a couple of hundred bytes each — none of which anyone
 * wants to download. Only parts the sender actually attached belong in
 * the list, so anything marked inline or referenced by a Content-ID is
 * dropped, and so are the report parts of a bounce or read receipt, which
 * the reader does not list either.
 */
export function realAttachments(attachments?: Attachment[]): Attachment[] {
  if (!attachments?.length) return [];
  return attachments.filter(
    (a) => a.disposition !== "inline" && !a.cid && !!a.name && !isReportPart(a.type),
  );
}

// `badge` fills the square Mountain View draws behind a white glyph, as Gmail does.
// The MIME type decides first; the extension catches parts sent as
// application/octet-stream. Only the extension is matched, so a name like
// "startup.docx" is not taken for a tar archive.
const ICON_BY_TYPE: { mime: RegExp; ext: string[]; icon: typeof FileIcon; className: string; badge: string }[] = [
  { mime: /^image\//, ext: ["jpg", "jpeg", "png", "gif", "svg", "webp", "bmp", "heic", "avif"], icon: FileImage, className: "text-violet-600 dark:text-violet-400", badge: "bg-red-600" },
  { mime: /^video\//, ext: ["mp4", "avi", "mov", "wmv", "mkv", "webm"], icon: FileVideo, className: "text-pink-600 dark:text-pink-400", badge: "bg-red-600" },
  { mime: /^audio\//, ext: ["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus"], icon: FileAudio, className: "text-purple-600 dark:text-purple-400", badge: "bg-red-600" },
  { mime: /pdf/, ext: ["pdf"], icon: FileText, className: "text-red-600 dark:text-red-400", badge: "bg-red-600" },
  { mime: /sheet|excel|csv/, ext: ["xls", "xlsx", "ods", "csv", "tsv", "numbers"], icon: FileSpreadsheet, className: "text-emerald-600 dark:text-emerald-400", badge: "bg-emerald-600" },
  { mime: /zip|compress|x-tar|rar|7z|bzip|xz|zstd/, ext: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst"], icon: FileArchive, className: "text-amber-600 dark:text-amber-400", badge: "bg-zinc-500" },
  { mime: /word|presentation|powerpoint|opendocument|rtf|^text\//, ext: ["doc", "docx", "odt", "rtf", "ppt", "pptx", "odp", "txt", "md"], icon: FileText, className: "text-sky-600 dark:text-sky-400", badge: "bg-blue-600" },
];

const OTHER_ICON = { icon: FileIcon, className: "text-muted-foreground", badge: "bg-zinc-500" };

/** The icon and its colours for an attachment, shared by the list chips and the reader. */
export function attachmentIcon(type?: string | null, name?: string | null): { icon: typeof FileIcon; className: string; badge: string } {
  const mime = (type || "").toLowerCase();
  const dot = (name || "").lastIndexOf(".");
  const ext = dot >= 0 ? (name || "").slice(dot + 1).toLowerCase() : "";
  const byMime = mime && mime !== "application/octet-stream" ? ICON_BY_TYPE.find((e) => e.mime.test(mime)) : undefined;
  return byMime ?? ICON_BY_TYPE.find((e) => e.ext.includes(ext)) ?? OTHER_ICON;
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

// Shared by the chips, the space a loading row holds for them and the
// verification-code chip, so all of them are the same height.
export const CHIP_BOX_CLASS = "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs";
export const CHIP_ICON_CLASS = "h-3.5 w-3.5 flex-shrink-0";

// Mountain View's chips are Gmail's: a pill with a filled square in front.
export const MV_CHIP_BOX_CLASS = "inline-flex h-8 items-center gap-2 rounded-full border border-border ps-3 pe-4 text-sm";
export const MV_CHIP_BADGE_CLASS = "inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[3px] text-white";
export const MV_CHIP_BADGE_ICON_CLASS = "h-3 w-3";

export type ChipVariant = "default" | "mountain-view";

interface AttachmentChipsProps {
  attachments?: Attachment[];
  onOpen: (attachment: Attachment) => void;
  /** How many chips to show before collapsing the rest into a count. */
  max?: number;
  /** A chip drawn ahead of the attachments in the same row (the verification code). */
  leading?: ReactNode;
  variant?: ChipVariant;
  className?: string;
}

export function AttachmentChips({ attachments, onOpen, max = 2, leading, variant = "default", className }: AttachmentChipsProps) {
  const mv = variant === "mountain-view";
  const real = realAttachments(attachments);
  if (!real.length && !leading) return null;

  // Next to a leading chip one attachment is all that still fits on the line.
  const shown = real.slice(0, leading ? Math.min(max, 1) : max);
  const overflow = real.length - shown.length;

  return (
    <div className={cn("flex items-center flex-wrap", mv ? "gap-2" : "gap-1.5", className)}>
      {leading}
      {shown.map((a) => {
        const { icon: Icon, className: iconClass, badge } = attachmentIcon(a.type, a.name);
        return (
          <button
            key={a.blobId + a.partId}
            type="button"
            // The row itself opens the message; a chip must not do both.
            onClick={(e) => { e.stopPropagation(); onOpen(a); }}
            onDoubleClick={(e) => e.stopPropagation()}
            title={stripBidiControls(a.name ?? "")}
            className={mv
              ? cn(MV_CHIP_BOX_CLASS, "max-w-[14rem] bg-transparent text-foreground hover:bg-muted")
              : cn(CHIP_BOX_CLASS, "max-w-[12rem] bg-background/60 text-foreground hover:bg-muted hover:text-foreground")}
          >
            {mv ? (
              <span className={cn(MV_CHIP_BADGE_CLASS, badge)}>
                <Icon className={MV_CHIP_BADGE_ICON_CLASS} />
              </span>
            ) : (
              <Icon className={cn(CHIP_ICON_CLASS, iconClass)} />
            )}
            <span className="truncate">{shortName(stripBidiControls(a.name ?? ""))}</span>
          </button>
        );
      })}
      {overflow > 0 && (
        <span className={cn(
          "border border-border text-muted-foreground tabular-nums",
          mv ? "inline-flex h-8 items-center rounded-full px-3 text-sm" : "rounded-md px-1.5 py-0.5 text-xs",
        )}>
          +{overflow}
        </span>
      )}
    </div>
  );
}

/**
 * Attachment parts for a list row. List requests no longer carry
 * `attachments` (#1089), so a row with a paperclip loads its own once it is
 * mounted; an email that already has them (thread expansion, demo data) is
 * used as is. `undefined` while the answer is still out.
 */
export function useListAttachments(email: Email, load?: LoadListAttachments): Attachment[] | undefined {
  const needsLoad = !!load && !!email.hasAttachment && !email.attachments;
  // The list unmounts rows that scroll away. One that comes back finds its
  // answer cached and takes it in the first render, so it mounts at its full
  // height instead of growing a frame later and making the list correct
  // the scroll position under the reader.
  // `attachments: null` is "asked, no answer yet".
  const [loaded, setLoaded] = useState<{ id: string; attachments: Attachment[] | null } | null>(() => {
    const cached = needsLoad ? load?.peek?.(email) : undefined;
    return cached ? { id: email.id, attachments: cached } : null;
  });

  useEffect(() => {
    if (!needsLoad || !load) return;
    const id = email.id;
    let answered = false;
    const cancel = load(email, (attachments) => {
      answered = true;
      setLoaded((prev) => prev?.id === id && prev.attachments === attachments ? prev : { id, attachments });
    });
    // The peek ran during render, before the list's owner had caught up with
    // a view change, so it may have read another account's entry for the
    // same id. The loader's answer is the real one; without one yet, wait.
    if (!answered) setLoaded({ id, attachments: null });
    return cancel;
    // The row's email object is replaced on every keyword change; only a
    // different message needs a different answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsLoad, load, email.id]);

  if (email.attachments) return email.attachments;
  if (loaded?.id === email.id) return loaded.attachments ?? undefined;
  // A row the list keeps for another message (see useRowSlots) starts with
  // the last one's state: read the cache for this one, as a new row does in
  // its first render, or the paperclip showed for a frame on a message
  // whose parts are all inline.
  return (needsLoad ? load?.peek?.(email) : undefined) ?? undefined;
}

/**
 * Whether a list row shows the paperclip. Stalwart sets `hasAttachment` for
 * inline images too (a logo in a notification mail), which the viewer never
 * lists, so once the parts are in the flag only counts if one of them is a
 * real attachment. Until then the server's flag stands.
 */
export function useListHasAttachment(email: Email, load?: LoadListAttachments): boolean {
  const attachments = useListAttachments(email, load);
  if (!email.hasAttachment) return false;
  return attachments === undefined || realAttachments(attachments).length > 0;
}

/**
 * Whether a list row will draw a chip row for this email, counting the room
 * it holds while the parts load. Lets the list estimate a row's height
 * before it has measured it. Once the parts are in, they decide: a mail
 * whose only parts are inline images draws no chips.
 */
export function listRowShowsChips(email: Email, load?: LoadListAttachments): boolean {
  if (email.attachments) return realAttachments(email.attachments).length > 0;
  if (!load || !email.hasAttachment) return false;
  const loaded = load.peek?.(email);
  return loaded ? realAttachments(loaded).length > 0 : true;
}

interface ListAttachmentChipsProps extends Omit<AttachmentChipsProps, "attachments"> {
  email: Email;
  load?: LoadListAttachments;
}

export function ListAttachmentChips({ email, load, ...chipProps }: ListAttachmentChipsProps) {
  const showAttachmentChips = useSettingsStore((state) => state.showAttachmentChips);
  const attachments = useListAttachments(email, load);
  if (!showAttachmentChips) {
    return chipProps.leading ? <div className={cn("flex items-center gap-1.5", chipProps.className)}>{chipProps.leading}</div> : null;
  }
  if (attachments === undefined && load && email.hasAttachment) {
    // Hold a chip's height until the parts arrive, so the row does not grow
    // under the reader when they do. A leading chip holds it just as well.
    if (chipProps.leading) {
      return <div className={cn("flex items-center gap-1.5", chipProps.className)}>{chipProps.leading}</div>;
    }
    return (
      <div aria-hidden className={cn("flex", chipProps.className)}>
        <span className={cn(chipProps.variant === "mountain-view" ? MV_CHIP_BOX_CLASS : CHIP_BOX_CLASS, "invisible")}>
          <span className={chipProps.variant === "mountain-view" ? MV_CHIP_BADGE_CLASS : CHIP_ICON_CLASS} />
          <span>&nbsp;</span>
        </span>
      </div>
    );
  }
  return <AttachmentChips attachments={attachments} {...chipProps} />;
}
