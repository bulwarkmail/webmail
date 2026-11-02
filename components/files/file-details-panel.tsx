"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { X, Download, Share2, Star, StarOff, FolderOpen, Eye, SquarePen, Files } from "@/components/icons";
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
  resource, selection, folderName, folderItems, path, isStarred, canShare, canPreview, canEdit,
  iconOptions, getImageUrl, onClose, onOpen, onEdit, onDownload, onShare, onToggleStar, className, pluginFile,
}: FileDetailsPanelProps) {
  const t = useTranslations("files");
  const pluginProps = useMemo(() => (pluginFile ? { file: pluginFile } : null), [pluginFile]);

  const header = (
    <div className="flex items-center justify-between px-4 h-11 border-b border-border flex-shrink-0">
      <h2 className="text-sm font-semibold">{t("details")}</h2>
      <Button variant="ghost" size="icon" className="h-7 w-7 -me-1.5" onClick={onClose} aria-label={t("close_details")}>
        <X className="w-4 h-4" />
      </Button>
    </div>
  );

  const shell = (body: React.ReactNode) => (
    <aside aria-label={t("details")} className={cn("flex flex-col bg-background border-s border-border", className)}>
      {header}
      <div className="flex-1 overflow-y-auto">{body}</div>
    </aside>
  );

  if (!resource) {
    const items = selection.length > 1 ? selection : folderItems;
    const folders = items.filter((r) => r.isDirectory).length;
    const files = items.length - folders;
    return shell(
      <div className="p-4 space-y-5">
        <div className="aspect-[4/3] rounded-lg bg-muted/50 flex items-center justify-center">
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

  return shell(
    <div className="p-4 space-y-5">
      <div className="aspect-[4/3] rounded-lg bg-muted/50 flex items-center justify-center overflow-hidden">
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
      <div className="flex flex-wrap gap-2">
        {resource.isDirectory ? (
          <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={onOpen}>
            <FolderOpen className="w-4 h-4" />{t("open")}
          </Button>
        ) : canEdit ? (
          <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={onEdit}>
            <SquarePen className="w-4 h-4" />{t("office_edit")}
          </Button>
        ) : canPreview ? (
          <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={onOpen}>
            <Eye className="w-4 h-4" />{t("preview")}
          </Button>
        ) : null}
        {!resource.isDirectory && !resource.isSymlink && onDownload && (
          <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={onDownload}>
            <Download className="w-4 h-4" />{t("download")}
          </Button>
        )}
        {canShare && (
          <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={onShare}>
            <Share2 className="w-4 h-4" />{t("share")}
          </Button>
        )}
        {resource.isDirectory && !resource.isShared && (
          <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={onToggleStar}>
            {isStarred ? <StarOff className="w-4 h-4" /> : <Star className="w-4 h-4" />}
            {isStarred ? t("unstar") : t("star")}
          </Button>
        )}
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
    </div>,
  );
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("break-all", mono && "font-mono text-xs mt-0.5")}>{value}</dd>
    </div>
  );
}
