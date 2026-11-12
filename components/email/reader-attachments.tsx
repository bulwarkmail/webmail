"use client";

import { useEffect, useState, type DragEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronUp, CloudUpload, Copy, Download, FolderInput, Loader2, Paperclip, Eye, Pencil } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuItem } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { isDesktopApp } from "@/lib/desktop/bridge";
import { IconButton } from "@/components/ui/icon-button";
import { getAttachmentDisplayName } from "@/lib/attachment-name";
import { cn, formatFileSize } from "@/lib/utils";
import { noMediaSavingProps } from "@/lib/device-frame";
import { ROW_ITEM_ATTR, ROW_MORE_ATTR, useFirstRowLimit } from "@/hooks/use-first-row-limit";
import { toast } from "@/stores/toast-store";
import { attachmentIcon } from "./attachment-chips";

export interface ReaderAttachmentItem {
  id: string;
  name: string | null;
  type: string;
  size: number;
  blobId?: string;
}

export interface AttachmentDragProps {
  draggable: boolean;
  onPointerEnter: () => void;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: (e: DragEvent<HTMLDivElement>) => void;
  /** The desktop app only. */
  onCopyAsFile?: () => Promise<boolean>;
}

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
  /** Object URLs of image attachments, keyed by attachment id. */
  thumbUrls: Record<string, string>;
  /**
   * Copies the file to the clipboard. Comes with the right-click menu the desktop app
   * has on an attachment; a browser has its own menu there and never gets this one.
   */
  onCopyFile?: (attachment: T) => void;
  /**
   * The desktop app's Edit: opens the file in its program. `canEdit` says no where the file
   * type or the organisation's rules keep it out.
   */
  onEdit?: (attachment: T) => void;
  canEdit?: (attachment: T) => boolean;
  /** Whether a click on the attachment previews it instead of downloading it. */
  opensPreview: (attachment: T) => boolean;
  onOpen: (attachment: T) => void;
  onDownload: (attachment: T) => void;
  onDownloadAll: () => void;
  /** "Save all to a folder": left out where the browser can't ask for one. */
  onSaveAllToFolder?: () => void;
  downloadingAll: boolean;
  /**
   * The account's device policy turned downloads off (Organisation >
   * Devices): previews stay, every way to save a copy goes.
   */
  downloadsOff?: boolean;
  /** Set when the Files app can take attachments. */
  onSaveToFiles?: (attachment: T) => void;
  /** Renames the attachment for saving a copy; left out while downloads are off. */
  onRename?: (attachment: T) => void;
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
 * The attachments of an open message, drawn right under its header: a
 * summary line with the bulk actions grouped at its end, then one row of
 * equal tiles (preview with the file type, name, size and a download button
 * that is always there; the other actions show on hover or focus, and always
 * on touch screens). Files that don't fit on that row wait behind a
 * "Show N more" tile, so the first lines of the body stay in view.
 */
export function ReaderAttachments<T extends ReaderAttachmentItem>({
  attachments,
  thumbUrls,
  opensPreview,
  onOpen,
  onDownload,
  onDownloadAll,
  onSaveAllToFolder,
  onCopyFile,
  onEdit,
  canEdit,
  downloadingAll,
  downloadsOff = false,
  onSaveToFiles,
  onRename,
  pluginMenu,
  renderItem,
  className,
}: ReaderAttachmentsProps<T>) {
  const t = useTranslations("email_viewer");
  const tFiles = useTranslations("files");
  const tDevice = useTranslations("device_policy");
  const tWindows = useTranslations("pwaWindows");
  const tDesktop = useTranslations("desktopUi.attachment");
  const tEdit = useTranslations("desktopEdit");
  const tRename = useTranslations("attachment_rename");
  const menu = useContextMenu<T>();
  const [desktopMenu, setDesktopMenu] = useState(false);
  useEffect(() => setDesktopMenu(isDesktopApp()), []);
  const menuTarget = menu.contextMenu.data;
  // Opens nothing: no preview, and downloads are off.
  const locked = (attachment: T) => downloadsOff && !opensPreview(attachment);
  const openLabel = (attachment: T, name: string) =>
    opensPreview(attachment) ? t("preview_named", { name }) : locked(attachment) ? tDevice("download_off_named", { name }) : t("download_named", { name });
  // One row of tiles; the rest behind "Show N more" until it is clicked,
  // for this message's files only.
  const listKey = attachments.map((a) => a.id).join("|");
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const expanded = expandedFor === listKey;
  const row = useFirstRowLimit(attachments.length, !expanded);

  if (attachments.length === 0) return null;

  const totalSize = attachments.reduce((sum, a) => sum + (a.size || 0), 0);
  const limit = expanded ? null : row.limit;
  const shown = limit === null ? attachments : attachments.slice(0, limit);
  const hidden = limit === null ? [] : attachments.slice(limit);

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
        className="group relative flex h-14 min-w-0 items-center gap-2.5 rounded-lg border border-border bg-card ps-2 pe-1 transition-colors hover:bg-muted/50"
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
          {/* The type is on the preview already. */}
          <span className="truncate text-xs text-muted-foreground">
            <bdi>{formatFileSize(attachment.size)}</bdi>
          </span>
        </button>
        <div className="relative z-10 flex shrink-0 items-center">
          {/* The less common actions wait for hover or focus, so a tile reads as one file with one download button. */}
          <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100">
            {onSaveToFiles && attachment.blobId && (
              <IconButton label={t("save_to_files.title")} className="text-muted-foreground hover:text-foreground" onClick={() => onSaveToFiles(attachment)}>
                <CloudUpload className="h-4 w-4" />
              </IconButton>
            )}
            {!downloadsOff && onRename && (
              <IconButton label={tRename("rename_named", { name })} title={tRename("rename")} className="text-muted-foreground hover:text-foreground" onClick={() => onRename(attachment)}>
                <Pencil className="h-4 w-4" />
              </IconButton>
            )}
            {pluginMenu?.(attachment)}
            {!downloadsOff && drag.onCopyAsFile && <CopyAsFileButton copy={drag.onCopyAsFile} />}
          </div>
          {!downloadsOff && (
            <IconButton
              label={t("download_named", { name })}
              title={t("download")}
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

  return (
    <section aria-label={t("attachments")} className={cn("@container flex flex-col gap-3", className)} data-testid="reader-attachments" {...noMediaSavingProps(downloadsOff)}>
      <div className="flex min-h-8 items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm text-muted-foreground">
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
          <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onDownloadAll}
            disabled={downloadingAll}
            title={t("download_all")}
            aria-label={t("download_all")}
            className="shrink-0 gap-1.5 whitespace-nowrap disabled:cursor-wait"
          >
            {downloadingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {/* Just the icon in a narrow pane, so the row stays one row. */}
            <span className={onSaveAllToFolder ? "hidden @md:inline" : undefined}>{t("download_all")}</span>
          </Button>
          {onSaveAllToFolder && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onSaveAllToFolder}
            disabled={downloadingAll}
            title={tWindows("save_all_to_folder")}
            aria-label={tWindows("save_all_to_folder")}
            className="shrink-0 gap-1.5 whitespace-nowrap disabled:cursor-wait"
            data-testid="attachments-save-to-folder"
          >
            <FolderInput className="h-4 w-4" />
            <span className="hidden @md:inline">{tWindows("save_all_to_folder")}</span>
          </Button>
          )}
          </div>
        )}
      </div>

      <div ref={row.ref} className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-2" data-testid="reader-attachments-row">
        {shown.map((attachment) => (
          <div key={attachment.id} {...{ [ROW_ITEM_ATTR]: "" }} className="flex min-w-0 flex-col gap-1" onContextMenu={desktopMenu ? (event) => menu.openContextMenu(event, attachment) : undefined}>
            {renderItem
              ? renderItem(attachment, (drag) => tile(attachment, drag))
              : tile(attachment, NO_DRAG)}
          </div>
        ))}
        {hidden.length > 0 && (
          <button
            type="button"
            {...{ [ROW_MORE_ATTR]: "" }}
            onClick={() => setExpandedFor(listKey)}
            className="flex h-14 min-w-0 items-center justify-between gap-3 rounded-lg border border-border px-4 text-start transition-colors hover:bg-muted/50"
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
        {expanded && (
          <button
            type="button"
            onClick={() => setExpandedFor(null)}
            className="flex h-14 min-w-0 items-center justify-between gap-3 rounded-lg border border-border px-4 text-start text-sm text-foreground transition-colors hover:bg-muted/50"
          >
            {t("attachments_show_fewer")}
            <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        )}
      </div>
      {desktopMenu && menuTarget && (
        <ContextMenu ref={menu.menuRef} isOpen={menu.contextMenu.isOpen} position={menu.contextMenu.position} onClose={menu.closeContextMenu}>
          {!locked(menuTarget) && (
            <ContextMenuItem icon={Eye} label={tDesktop("open")} onClick={() => { menu.closeContextMenu(); onOpen(menuTarget); }} />
          )}
          {!downloadsOff && (
            <ContextMenuItem icon={Download} label={tDesktop("save_as")} onClick={() => { menu.closeContextMenu(); onDownload(menuTarget); }} />
          )}
          {!downloadsOff && onRename && (
            <ContextMenuItem icon={Pencil} label={tRename("rename_menu")} onClick={() => { menu.closeContextMenu(); onRename(menuTarget); }} />
          )}
          {!downloadsOff && onEdit && canEdit?.(menuTarget) && (
            <ContextMenuItem icon={Pencil} label={tEdit("edit")} onClick={() => { menu.closeContextMenu(); onEdit(menuTarget); }} />
          )}
          {!downloadsOff && onCopyFile && (
            <ContextMenuItem icon={Copy} label={tDesktop("copy")} onClick={() => { menu.closeContextMenu(); onCopyFile(menuTarget); }} />
          )}
        </ContextMenu>
      )}
    </section>
  );
}

/**
 * The image itself when there is a thumbnail, else the file type's icon over
 * its extension, in the type's colour.
 */
/** The desktop app's "Copy as file", for pasting the attachment into Explorer or Finder. */
function CopyAsFileButton({ copy }: { copy: () => Promise<boolean> }) {
  const t = useTranslations("desktopOs");
  return (
    <IconButton
      label={t("copy_as_file")}
      className="text-muted-foreground hover:text-foreground"
      onClick={() => {
        void copy().then((ok) => {
          if (ok) toast.success(t("copied"));
          else toast.error(t("copy_failed"));
        }, () => toast.error(t("copy_failed")));
      }}
    >
      <Copy className="h-4 w-4" />
    </IconButton>
  );
}

function AttachmentThumb({ attachment, url, label }: { attachment: ReaderAttachmentItem; url?: string; label: string }) {
  if (url) {
    return <img src={url} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded-md bg-muted object-cover" />;
  }
  const { icon: Icon, className } = attachmentIcon(attachment.type, attachment.name);
  return (
    <div aria-hidden="true" className="flex h-10 w-10 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md bg-muted">
      <Icon className={cn("h-4 w-4", className)} />
      {label && label.length <= 5 && (
        <span className={cn("text-[0.5625rem] font-semibold leading-none", className)}>{label}</span>
      )}
    </div>
  );
}
