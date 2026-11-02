"use client";

import { useState, type DragEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronUp, Download, FolderInput, Loader2, Paperclip } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { getAttachmentDisplayName } from "@/lib/attachment-name";
import { cn, formatFileSize } from "@/lib/utils";
import { noMediaSavingProps } from "@/lib/device-frame";
import { attachmentIcon } from "./attachment-chips";

export interface ReaderAttachmentItem {
  id: string;
  name: string | null;
  type: string;
  size: number;
  blobId?: string;
}

/** "bar": tiles under the header. "cards": larger previews under the message. */
export type ReaderAttachmentLayout = "bar" | "cards";

export interface AttachmentDragProps {
  draggable: boolean;
  onPointerEnter: () => void;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: (e: DragEvent<HTMLDivElement>) => void;
}

/** Past this many tiles the bar shows one row less and a "Show N more" tile. */
export const BAR_COLLAPSE_AT = 6;

/**
 * Splits a file name so the extension can stay visible while the rest is
 * cut short: "prototype-v3.png" → ["prototype-v3", ".png"]. Names without a
 * short extension come back whole.
 */
export function splitFileName(name: string): [stem: string, ext: string] {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || name.length - dot > 8) return [name, ""];
  return [name.slice(0, dot), name.slice(dot)];
}

interface ReaderAttachmentsProps<T extends ReaderAttachmentItem> {
  attachments: T[];
  layout?: ReaderAttachmentLayout;
  /** Object URLs of image attachments, keyed by attachment id. */
  thumbUrls: Record<string, string>;
  /** Whether a click on the attachment previews it instead of downloading it. */
  opensPreview: (attachment: T) => boolean;
  onOpen: (attachment: T) => void;
  onDownload: (attachment: T) => void;
  onDownloadAll: () => void;
  downloadingAll: boolean;
  /**
   * The account's device policy turned downloads off (Organisation >
   * Devices): previews stay, every way to save a copy goes.
   */
  downloadsOff?: boolean;
  /** Set when the Files app can take attachments. */
  onSaveToFiles?: (attachment: T) => void;
  /** Plugin actions for one attachment; renders nothing when no plugin offers any. */
  pluginMenu?: (attachment: T) => ReactNode;
  /**
   * Wraps one tile, so the viewer can add drag-out and the plugin frames
   * without this component knowing about blobs or plugins.
   */
  renderItem?: (attachment: T, tile: (drag: AttachmentDragProps) => ReactNode) => ReactNode;
  className?: string;
}

const NO_DRAG: AttachmentDragProps = {
  draggable: false,
  onPointerEnter: () => {},
  onDragStart: () => {},
  onDragEnd: () => {},
};

/**
 * The attachments of an open message: a summary line with "Download all",
 * then either a bar of equal tiles (preview, name, type, size and a download
 * button that is always there) or larger preview cards whose actions show
 * on hover, focus and touch screens.
 */
export function ReaderAttachments<T extends ReaderAttachmentItem>({
  attachments,
  layout = "bar",
  thumbUrls,
  opensPreview,
  onOpen,
  onDownload,
  onDownloadAll,
  downloadingAll,
  downloadsOff = false,
  onSaveToFiles,
  pluginMenu,
  renderItem,
  className,
}: ReaderAttachmentsProps<T>) {
  const t = useTranslations("email_viewer");
  const tFiles = useTranslations("files");
  const tDevice = useTranslations("device_policy");
  // Opens nothing: no preview, and downloads are off.
  const locked = (attachment: T) => downloadsOff && !opensPreview(attachment);
  const openLabel = (attachment: T, name: string) =>
    opensPreview(attachment) ? t("preview_named", { name }) : locked(attachment) ? tDevice("download_off_named", { name }) : t("download_named", { name });
  const [expanded, setExpanded] = useState(false);

  if (attachments.length === 0) return null;

  const totalSize = attachments.reduce((sum, a) => sum + (a.size || 0), 0);
  const collapses = layout === "bar" && attachments.length > BAR_COLLAPSE_AT;
  const shown = collapses && !expanded ? attachments.slice(0, BAR_COLLAPSE_AT - 1) : attachments;
  const hidden = collapses && !expanded ? attachments.slice(BAR_COLLAPSE_AT - 1) : [];

  const tile = (attachment: T, drag: AttachmentDragProps) => {
    const name = getAttachmentDisplayName(attachment.name, attachment.type);
    const [stem, ext] = splitFileName(name);
    const kind = ext ? ext.slice(1).toUpperCase() : "";
    const preview = opensPreview(attachment);
    return (
      <div
        data-testid="attachment"
        data-attachment-name={attachment.name ?? undefined}
        title={locked(attachment) ? tDevice("downloads_off") : `${preview ? tFiles("preview") : t("download")} ${name}`}
        draggable={drag.draggable}
        onPointerEnter={drag.onPointerEnter}
        onDragStart={drag.onDragStart}
        onDragEnd={drag.onDragEnd}
        className="group relative flex h-16 min-w-0 items-center gap-3 rounded-lg border border-border bg-card ps-2 pe-1 transition-colors hover:bg-muted/50"
      >
        <AttachmentThumb attachment={attachment} url={thumbUrls[attachment.id]} label={kind} />
        {/* The button covers the whole tile, so a click on the preview opens the file too. */}
        <button
          type="button"
          onClick={() => { if (!locked(attachment)) onOpen(attachment); }}
          aria-disabled={locked(attachment) || undefined}
          aria-label={openLabel(attachment, name)}
          className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 self-stretch text-start outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring"
        >
          <span className="flex min-w-0 text-sm text-foreground" dir="auto">
            <span className="truncate">{stem}</span>
            {ext && <span className="shrink-0">{ext}</span>}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {kind && <>{kind} · </>}
            <bdi>{formatFileSize(attachment.size)}</bdi>
          </span>
        </button>
        <div className="relative z-10 flex shrink-0 items-center">
          {onSaveToFiles && attachment.blobId && (
            <IconButton label={t("save_to_files.title")} onClick={() => onSaveToFiles(attachment)}>
              <FolderInput className="h-4 w-4" />
            </IconButton>
          )}
          {pluginMenu?.(attachment)}
          {!downloadsOff && (
          <IconButton
            label={t("download_named", { name })}
            title={t("download")}
            size="icon"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => onDownload(attachment)}
          >
            <Download className="h-4 w-4" />
          </IconButton>
          )}
        </div>
      </div>
    );
  };

  const card = (attachment: T, drag: AttachmentDragProps) => {
    const name = getAttachmentDisplayName(attachment.name, attachment.type);
    const [stem, ext] = splitFileName(name);
    const kind = ext ? ext.slice(1).toUpperCase() : "";
    const preview = opensPreview(attachment);
    const url = thumbUrls[attachment.id];
    const { icon: Icon, className: iconClass } = attachmentIcon(attachment.type, attachment.name);
    return (
      <div
        data-testid="attachment"
        data-attachment-name={attachment.name ?? undefined}
        title={locked(attachment) ? tDevice("downloads_off") : `${preview ? tFiles("preview") : t("download")} ${name}`}
        draggable={drag.draggable}
        onPointerEnter={drag.onPointerEnter}
        onDragStart={drag.onDragStart}
        onDragEnd={drag.onDragEnd}
        className="group relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors hover:bg-muted/50"
      >
        <div aria-hidden="true" className="h-32 bg-muted/60">
          {url ? (
            <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2">
              <Icon className={cn("h-10 w-10", iconClass)} />
              {kind && kind.length <= 5 && (
                <span className={cn("text-xs font-semibold leading-none", iconClass)}>{kind}</span>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => { if (!locked(attachment)) onOpen(attachment); }}
          aria-disabled={locked(attachment) || undefined}
          aria-label={openLabel(attachment, name)}
          className="flex min-w-0 flex-col gap-0.5 border-t border-border px-3 py-2.5 text-start outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring"
        >
          <span className="flex min-w-0 text-sm text-foreground" dir="auto">
            <span className="truncate">{stem}</span>
            {ext && <span className="shrink-0">{ext}</span>}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {kind && <>{kind} · </>}
            <bdi>{formatFileSize(attachment.size)}</bdi>
          </span>
        </button>
        {/* Over the preview, never over the name. Always shown where there is no hover. */}
        <div className="absolute end-2 top-2 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-background/90 p-0.5 opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto">
          {onSaveToFiles && attachment.blobId && (
            <IconButton label={t("save_to_files.title")} onClick={() => onSaveToFiles(attachment)}>
              <FolderInput className="h-4 w-4" />
            </IconButton>
          )}
          {pluginMenu?.(attachment)}
          {!downloadsOff && (
            <IconButton label={t("download_named", { name })} title={t("download")} onClick={() => onDownload(attachment)}>
              <Download className="h-4 w-4" />
            </IconButton>
          )}
        </div>
      </div>
    );
  };

  const draw = layout === "cards" ? card : tile;

  return (
    <section aria-label={t("attachments")} className={cn("flex flex-col gap-3", className)} data-testid="reader-attachments" data-layout={layout} {...noMediaSavingProps(downloadsOff)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          <Paperclip className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="truncate">
            <span className="font-medium text-foreground">{t("attachments_count", { count: attachments.length })}</span>
            {" · "}
            <bdi>{formatFileSize(totalSize)}</bdi>
          </span>
        </div>
        {downloadsOff && (
          <span className="text-xs text-muted-foreground" data-testid="attachments-downloads-off">{tDevice("downloads_off")}</span>
        )}
        {attachments.length > 1 && !downloadsOff && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onDownloadAll}
            disabled={downloadingAll}
            title={t("download_all")}
            className="shrink-0 gap-1.5 disabled:cursor-wait"
          >
            {downloadingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {t("download_all")}
          </Button>
        )}
      </div>

      <div className={cn(
        "grid",
        layout === "cards" ? "grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3" : "grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2",
      )}>
        {shown.map((attachment) => (
          <div key={attachment.id} className="flex min-w-0 flex-col gap-1">
            {renderItem
              ? renderItem(attachment, (drag) => draw(attachment, drag))
              : draw(attachment, NO_DRAG)}
          </div>
        ))}
        {hidden.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="flex h-16 min-w-0 items-center justify-between gap-3 rounded-lg border border-border px-4 text-start transition-colors hover:bg-muted/50"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-foreground">{t("attachments_show_more", { count: hidden.length })}</span>
              <span className="truncate text-xs text-muted-foreground" dir="auto">
                {hidden.map((a) => getAttachmentDisplayName(a.name, a.type)).join(", ")}
              </span>
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        )}
        {collapses && expanded && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="flex h-16 min-w-0 items-center justify-between gap-3 rounded-lg border border-border px-4 text-start text-sm text-foreground transition-colors hover:bg-muted/50"
          >
            {t("attachments_show_fewer")}
            <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * The image itself when there is a thumbnail, else the file type's icon over
 * its extension, in the type's colour.
 */
function AttachmentThumb({ attachment, url, label }: { attachment: ReaderAttachmentItem; url?: string; label: string }) {
  if (url) {
    return <img src={url} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-md bg-muted object-cover" />;
  }
  const { icon: Icon, className } = attachmentIcon(attachment.type, attachment.name);
  return (
    <div aria-hidden="true" className="flex h-12 w-12 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md bg-muted">
      <Icon className={cn("h-5 w-5", className)} />
      {label && label.length <= 5 && (
        <span className={cn("text-[0.625rem] font-semibold leading-none", className)}>{label}</span>
      )}
    </div>
  );
}
