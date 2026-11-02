"use client";

import { useId, useLayoutEffect, useMemo, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { X, Download, Share2, Star, StarOff, FolderOpen, Eye, SquarePen, Files } from "@/components/icons";
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { IconButton } from '@/components/ui/icon-button';
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { FileResource } from "@/stores/file-store";
import type { FileResourceView } from "@/lib/plugin-types";
import { PluginSlot } from "@/components/plugins/plugin-slot";
import {
  FileSize, ResourceIcon, Thumbnail, canShowThumbnail, formatFullDate, type IconOptions,
} from "@/components/files/file-item-parts";

interface FileDetailsPanelProps {
  /** The one selected item, or null. */
  resource: FileResource | null;
  /** A narrow-pane overlay: contains focus and returns it to the opener. */
  overlay?: boolean;
  /** Everything selected, when more than one item is. */
  selection: FileResource[];
  /** The folder on screen, summarised when nothing is selected. */
  folderName: string;
  folderItems: FileResource[];
  path: string;
  isStarred: boolean;
  canShare: boolean;
  canPreview: boolean;
  canEdit: boolean;
  iconOptions: IconOptions;
  getImageUrl: (name: string) => Promise<string>;
  onClose: () => void;
  onOpen: () => void;
  onEdit: () => void;
  /** Left out when a device policy turned downloads off. */
  onDownload?: () => void;
  onShare: () => void;
  onToggleStar: () => void;
  className?: string;
  /** The one selected item as plugins see it (file-preview-section). */
  pluginFile?: FileResourceView | null;
}

function kindOf(resource: FileResource, t: (key: string, values?: Record<string, string>) => string): string {
  if (resource.isDirectory) return t("folder");
  if (resource.isSymlink) return t("symlink");
  const dot = resource.name.lastIndexOf(".");
  const ext = dot > 0 ? resource.name.slice(dot + 1).toUpperCase() : "";
  return ext ? t("file_kind", { ext }) : (resource.contentType || t("file"));
}

function totalSize(items: FileResource[]): number {
  return items.reduce((sum, r) => sum + (r.isDirectory || r.isSymlink ? 0 : r.contentLength), 0);
}

export function FileDetailsPanel({
  resource, overlay = false, selection, folderName, folderItems, path, isStarred, canShare, canPreview, canEdit,
  iconOptions, getImageUrl, onClose, onOpen, onEdit, onDownload, onShare, onToggleStar, className, pluginFile,
}: FileDetailsPanelProps) {
  const t = useTranslations("files");
  const headingId = useId();
  const panelRef = useFocusTrap({isActive: overlay, onEscape: onClose, restoreFocus: true});
  useLayoutEffect(() => {
    const opener = document.activeElement;
    const panel = panelRef.current;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected &&
        (document.activeElement === document.body || panel?.contains(document.activeElement))) {
        opener.focus({preventScroll: true});
      }
    };
  }, [panelRef]);
  const pluginProps = useMemo(() => (pluginFile ? { file: pluginFile } : null), [pluginFile]);

  const header = (
    <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
      <h2 id={headingId} className="text-sm font-semibold">{t("details")}</h2>
      <IconButton label={t("close_details")} onClick={onClose}><X/></IconButton>
    </div>
  );

  const shell = (body: ReactNode, actions?: ReactNode) => (
    <div ref={panelRef} role={overlay ? "dialog" : "complementary"}
      aria-modal={overlay || undefined} aria-labelledby={headingId} data-memail-file-details=""
      onKeyDown={(event) => {
        if (overlay || event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
        const target = event.target as HTMLElement;
        if (target.closest('[role="dialog"], [role="menu"]')) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      className={cn("flex min-h-0 min-w-0 flex-col border-s border-border bg-background", className)}>
      {header}
      <div data-memail-file-detail-content="" role="region" aria-label={t("details")} tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto outline-none focus-inset">{body}</div>
      {actions && <div data-memail-file-detail-actions="" role="group" aria-label={t("toolbar")}
        className="max-h-[45%] shrink-0 overflow-y-auto border-t border-border bg-background p-3">{actions}</div>}
    </div>
  );

  if (!resource) {
    const items = selection.length > 1 ? selection : folderItems;
    const folders = items.filter((r) => r.isDirectory).length;
    const files = items.length - folders;
    return shell(
      <div className="p-4 space-y-4">
        <div className="aspect-video max-h-40 rounded-xl bg-muted/40 flex items-center justify-center">
          {selection.length > 1
            ? <Files className="w-14 h-14 text-muted-foreground" />
            : <FolderOpen className="w-14 h-14 text-primary" />}
        </div>
        <div>
          <p className="font-medium break-words">
            {selection.length > 1 ? t("selected_count", { count: selection.length }) : folderName}
          </p>
          <p className="text-sm text-muted-foreground">{t("folder_summary", { folders, files })}</p>
        </div>
        <dl className="space-y-3 text-sm">
          <Row label={t("size")} value={<FileSize bytes={totalSize(items)} />} />
          {selection.length <= 1 && <Row label={t("path")} value={path} mono />}
        </dl>
        {selection.length <= 1 && (
          <p className="text-xs text-muted-foreground">{t("details_hint")}</p>
        )}
      </div>,
    );
  }

  const sharedWith = resource.shareWith ? Object.keys(resource.shareWith).length : 0;
  const sharing = resource.isShared
    ? (resource.ownerName ? t("shared_by", { name: resource.ownerName }) : t("shared_with_me"))
    : sharedWith > 0 ? t("shared_with_count", { count: sharedWith }) : t("only_you");
  const bigIcon = <ResourceIcon resource={resource} size="xl" options={{ showIcons: true, coloredIcons: iconOptions.coloredIcons }} />;

  const actions = (
    <div className="grid grid-cols-2 gap-2">
        {resource.isDirectory ? (
          <Button size="sm" className="h-auto min-h-9 min-w-0 gap-1.5 whitespace-normal py-2" onClick={onOpen}>
            <FolderOpen className="w-4 h-4" />{t("open")}
          </Button>
        ) : canEdit ? (
          <Button size="sm" className="h-auto min-h-9 min-w-0 gap-1.5 whitespace-normal py-2" onClick={onEdit}>
            <SquarePen className="w-4 h-4" />{t("office_edit")}
          </Button>
        ) : canPreview ? (
          <Button size="sm" className="h-auto min-h-9 min-w-0 gap-1.5 whitespace-normal py-2" onClick={onOpen}>
            <Eye className="w-4 h-4" />{t("preview")}
          </Button>
        ) : null}
        {!resource.isDirectory && !resource.isSymlink && onDownload && (
          <Button size="sm" variant="outline" className="h-auto min-h-9 min-w-0 gap-1.5 whitespace-normal py-2" onClick={onDownload}>
            <Download className="w-4 h-4" />{t("download")}
          </Button>
        )}
        {canShare && (
          <Button size="sm" variant="outline" className="h-auto min-h-9 min-w-0 gap-1.5 whitespace-normal py-2" onClick={onShare}>
            <Share2 className="w-4 h-4" />{t("share")}
          </Button>
        )}
        {resource.isDirectory && !resource.isShared && (
          <Button size="sm" variant="outline" className="h-auto min-h-9 min-w-0 gap-1.5 whitespace-normal py-2" onClick={onToggleStar} aria-pressed={isStarred}>
            {isStarred ? <StarOff className="w-4 h-4" /> : <Star className="w-4 h-4" />}
            {isStarred ? t("unstar") : t("star")}
          </Button>
        )}
      </div>
  );

  return shell(
    <div className="p-4 space-y-4">
      <div className="aspect-video max-h-40 rounded-xl bg-muted/40 flex items-center justify-center overflow-hidden">
        {canShowThumbnail(resource, iconOptions) ? (
          <Thumbnail
            resource={resource}
            getImageUrl={getImageUrl}
            wrapperClassName="w-full h-full"
            className="w-full h-full object-contain"
            fallback={bigIcon}
          />
        ) : bigIcon}
      </div>
      <div>
        <p className="font-medium break-words">{resource.name}</p>
        <p className="text-sm text-muted-foreground">{kindOf(resource, t)}</p>
      </div>
      <dl className="space-y-3 text-sm">
        <Row
          label={t("type")}
          value={resource.isDirectory || resource.isSymlink ? kindOf(resource, t) : (resource.contentType || kindOf(resource, t))}
        />
        {!resource.isDirectory && !resource.isSymlink && <Row label={t("size")} value={<FileSize bytes={resource.contentLength} />} />}
        {resource.lastModified && <Row label={t("modified")} value={formatFullDate(resource.lastModified)} />}
        <Row label={t("sharing")} value={sharing} />
        <Row label={t("path")} value={path} mono />
      </dl>
      {pluginProps && <PluginSlot name="file-preview-section" className="w-full" extraProps={pluginProps} />}
    </div>, actions,
  );
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 break-words leading-5 [overflow-wrap:anywhere]", mono && "font-mono text-xs")}>{value}</dd>
    </div>
  );
}
