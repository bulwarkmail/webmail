"use client";

import { useRef } from "react";
import { useTranslations } from "next-intl";
import { ArrowUp, ArrowDown, MoreVertical, Download, Share2, Star, Check } from "@/components/icons";
import { cn } from "@/lib/utils";
import { IconButton } from "@/components/ui/icon-button";
import type { FileResource } from "@/stores/file-store";
import {
  FileSize, MiddleCutName, ResourceIcon, ShareBadge, Thumbnail, canShowThumbnail, formatFullDate, formatShortDate,
  type IconOptions,
} from "@/components/files/file-item-parts";
import { FilesSyncBadge } from "@/components/files-sync/files-sync-item";
import type { SortDir, SortKey } from "@/components/files/files-header";
import { TOUCH_HIT_AREA } from "@/components/ui/button";
import { FILE_LIST_COLUMNS } from "./file-list-layout";

export interface FileItemHandlers {
  /** Selection click (plain, Ctrl/Cmd, Shift) on the item body. */
  onSelectClick: (resource: FileResource, e: React.MouseEvent) => void;
  onToggleSelect: (resource: FileResource) => void;
  onOpen: (resource: FileResource) => void;
  onContextMenu: (e: React.MouseEvent, resource: FileResource) => void;
  /** Left out when a device policy turned downloads off. */
  onDownload?: (resource: FileResource) => void;
  onShare: (resource: FileResource) => void;
  canShare: (resource: FileResource) => boolean;
  dragProps: (resource: FileResource) => React.HTMLAttributes<HTMLElement> & { draggable?: boolean };
  /** The item itself (not a button in it) took focus. */
  onFocusItem: (resource: FileResource) => void;
}

export interface FileViewProps {
  resources: FileResource[];
  selected: Set<string>;
  focusedName: string | null;
  /** The item that takes Tab; the arrow keys move focus from there. */
  tabStopName: string | null;
  dropTarget: string | null;
  cutNames: Set<string>;
  starredPaths: Set<string>;
  pathOf: (resource: FileResource) => string;
  /** Touch layout: tap opens, long-press selects, checkboxes appear once selecting. */
  touch: boolean;
  iconOptions: IconOptions;
  getImageUrl: (name: string) => Promise<string>;
  handlers: FileItemHandlers;
  /** A line about an item, as its tooltip (where a deleted item came from). */
  itemNote?: (resource: FileResource) => string | undefined;
}

const LONG_PRESS_MS = 450;

/**
 * Touch handling shared by rows and tiles: a tap opens the item (or toggles
 * it while selecting), a long press selects it.
 */
function useTouchPress(touch: boolean, selecting: boolean, resource: FileResource, handlers: FileItemHandlers) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  if (!touch) return {};
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse") return;
      longPressed.current = false;
      cancel();
      timer.current = setTimeout(() => {
        longPressed.current = true;
        handlers.onToggleSelect(resource);
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS);
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onPointerMove: (e: React.PointerEvent) => { if (Math.abs(e.movementX) + Math.abs(e.movementY) > 4) cancel(); },
    onClickCapture: (e: React.MouseEvent) => {
      if (longPressed.current) {
        longPressed.current = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if ((e.target as HTMLElement).closest("[data-item-action]")) return;
      e.preventDefault();
      e.stopPropagation();
      if (selecting) handlers.onToggleSelect(resource);
      else handlers.onOpen(resource);
    },
    // A long press also fires contextmenu on Android; it already selected.
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };
}

function SelectBox({ checked, visible, onToggle, label }: {
  checked: boolean;
  visible: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      data-item-action
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cn(
        "w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-opacity",
        // A 44px hit area on touch, as every Button has (R1).
        TOUCH_HIT_AREA,
        checked ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/50 bg-background",
        // Shown on hover, and also when the keyboard is in the item or on a
        // touch screen, where there is no hover (WCAG 2.4.7).
        visible || checked ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
      )}
    >
      {checked && <Check className="w-3 h-3" strokeWidth={3} />}
    </button>
  );
}

function SortHeader({ label, column, sortKey, sortDir, onSort, className }: {
  label: string;
  column: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sortKey === column;
  return (
    <div role="columnheader" aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"} className={className}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn("inline-flex items-center gap-1 hover:text-foreground transition-colors", active && "text-foreground")}
      >
        {label}
        {active && (sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
      </button>
    </div>
  );
}

const LIST_COLUMNS = FILE_LIST_COLUMNS;

export function FileListView({
  resources, selected, focusedName, tabStopName, dropTarget, cutNames, starredPaths, pathOf, touch, iconOptions, getImageUrl, handlers,
  sortKey, sortDir, onSort, allSelected, someSelected, onToggleAll, itemNote, dateLabel,
}: FileViewProps & {
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  allSelected: boolean;
  someSelected: boolean;
  onToggleAll: () => void;
  /** The date column's heading, "Modified" unless told otherwise. */
  dateLabel?: string;
}) {
  const t = useTranslations("files");
  const selecting = selected.size > 0;
  return (
    <div role="grid" aria-label={t("file_list")} aria-multiselectable className="text-sm">
      <div
        role="row"
        className={cn(LIST_COLUMNS, "sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-4 h-9 text-xs font-medium text-muted-foreground")}
      >
        <div role="columnheader" className="flex items-center">
          <SelectBox
            checked={allSelected}
            visible={selecting || !touch}
            onToggle={onToggleAll}
            label={allSelected ? t("clear_selection") : t("select_all")}
          />
          {someSelected && !allSelected && <span className="sr-only">{t("selected_count", { count: selected.size })}</span>}
        </div>
        <SortHeader label={t("name")} column="name" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <SortHeader label={dateLabel ?? t("modified")} column="modified" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="hidden md:block" />
        <SortHeader label={t("size")} column="size" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="hidden sm:block text-end" />
        <div role="columnheader" className="w-[4.75rem]"><span className="sr-only">{t("context_menu")}</span></div>
      </div>
      {resources.map((resource) => (
        <FileListRow
          key={resource.id}
          resource={resource}
          isSelected={selected.has(resource.name)}
          isFocused={focusedName === resource.name}
          isTabStop={tabStopName === resource.name}
          isDropTarget={dropTarget === resource.name}
          isCut={cutNames.has(resource.name)}
          isStarred={resource.isDirectory && starredPaths.has(pathOf(resource))}
          selecting={selecting}
          touch={touch}
          iconOptions={iconOptions}
          getImageUrl={getImageUrl}
          handlers={handlers}
          note={itemNote?.(resource)}
        />
      ))}
    </div>
  );
}

function FileListRow({ resource, isSelected, isFocused, isTabStop, isDropTarget, isCut, isStarred, selecting, touch, iconOptions, getImageUrl, handlers, note }: {
  resource: FileResource;
  isSelected: boolean;
  isFocused: boolean;
  isTabStop: boolean;
  isDropTarget: boolean;
  isCut: boolean;
  isStarred: boolean;
  selecting: boolean;
  touch: boolean;
  iconOptions: IconOptions;
  getImageUrl: (name: string) => Promise<string>;
  handlers: FileItemHandlers;
  note?: string;
}) {
  const t = useTranslations("files");
  const tMenu = useTranslations("menuAudit");
  const touchProps = useTouchPress(touch, selecting, resource, handlers);
  const icon = <ResourceIcon resource={resource} size="sm" options={iconOptions} />;
  return (
    <div
      role="row"
      aria-selected={isSelected}
      data-resource={resource.name}
      tabIndex={isTabStop ? 0 : -1}
      onFocus={(e) => { if (e.target === e.currentTarget) handlers.onFocusItem(resource); }}
      {...handlers.dragProps(resource)}
      onClick={(e) => handlers.onSelectClick(resource, e)}
      onDoubleClick={() => handlers.onOpen(resource)}
      onContextMenu={(e) => handlers.onContextMenu(e, resource)}
      {...touchProps}
      className={cn(
        LIST_COLUMNS,
        "group px-4 border-b border-border/60 cursor-default select-none transition-colors outline-none",
        touch ? "min-h-[52px] py-1.5" : "h-10",
        isSelected ? "bg-selection" : isDropTarget ? "bg-primary/10 ring-1 ring-inset ring-primary/50" : "hover:bg-muted/60",
        isFocused && "ring-1 ring-inset ring-ring/60",
        isCut && "opacity-50",
      )}
    >
      <div role="gridcell" className={cn("flex items-center", touch && !selecting && "hidden")}>
        <SelectBox checked={isSelected} visible={selecting} onToggle={() => handlers.onToggleSelect(resource)} label={t("select_item", { name: resource.name })} />
      </div>
      <div role="gridcell" className={cn("flex items-center gap-3 min-w-0", touch && !selecting && "col-span-2")}>
        {canShowThumbnail(resource, iconOptions) ? (
          <Thumbnail
            resource={resource}
            getImageUrl={getImageUrl}
            wrapperClassName="w-6 h-6"
            className="w-6 h-6 rounded object-cover"
            fallback={icon}
          />
        ) : icon}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            {/* Plain text, as in grid view and a file manager: a click selects
                the row, a double-click or Enter opens it, a tap on touch opens
                it (useTouchPress). A link here opened on the first click of a
                double-click, and the second closed the preview again (pim-3). */}
            <span
              className={cn("truncate text-start", resource.isDirectory && "font-medium")}
              title={note ? `${resource.name}\n${note}` : resource.name}
            >
              {resource.name}
            </span>
            {isStarred && <Star className="w-3.5 h-3.5 shrink-0 text-amber-400 fill-amber-400" aria-label={t("favorites")} />}
            <ShareBadge resource={resource} t={t} />
            <FilesSyncBadge nodeId={resource.id} />
          </div>
          {touch && (
            <div className="text-xs text-muted-foreground truncate">
              {note && <>{note} · </>}
              {formatShortDate(resource.lastModified)}
              {!resource.isDirectory && !resource.isSymlink && <> · <FileSize bytes={resource.contentLength} /></>}
            </div>
          )}
        </div>
      </div>
      <div role="gridcell" className="hidden md:block text-muted-foreground tabular-nums truncate" title={formatFullDate(resource.lastModified)}>
        {!touch && formatShortDate(resource.lastModified)}
      </div>
      <div role="gridcell" className="hidden sm:block text-muted-foreground tabular-nums text-end">
        {!touch && (resource.isDirectory || resource.isSymlink ? "—" : <FileSize bytes={resource.contentLength} />)}
      </div>
      <div role="gridcell" className="flex items-center justify-end gap-0.5 w-[4.75rem]">
        {!touch && !resource.isDirectory && !resource.isSymlink && handlers.onDownload && (
          <RowAction icon={Download} label={t("download")} onClick={() => handlers.onDownload?.(resource)} />
        )}
        {!touch && handlers.canShare(resource) && (
          <RowAction icon={Share2} label={tMenu("files_share_button")} onClick={() => handlers.onShare(resource)} />
        )}
        <IconButton
          data-item-action
          label={t("more_actions", { name: resource.name })}
          title={t("context_menu")}
          onClick={(e) => { e.stopPropagation(); handlers.onContextMenu(e, resource); }}
          onDoubleClick={(e) => e.stopPropagation()}
          className="text-muted-foreground hover:text-foreground"
        >
          <MoreVertical />
        </IconButton>
      </div>
    </div>
  );
}

function RowAction({ icon: Icon, label, onClick }: { icon: React.ComponentType<{ className?: string }>; label: string; onClick: () => void }) {
  return (
    <IconButton
      data-item-action
      label={label}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onDoubleClick={(e) => e.stopPropagation()}
      className="text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
    >
      <Icon />
    </IconButton>
  );
}

export function FileGridView({
  resources, selected, focusedName, tabStopName, dropTarget, cutNames, starredPaths, pathOf, touch, iconOptions, getImageUrl, handlers,
}: FileViewProps) {
  const t = useTranslations("files");
  const folders = resources.filter((r) => r.isDirectory);
  const files = resources.filter((r) => !r.isDirectory);
  const selecting = selected.size > 0;
  const common = { touch, iconOptions, getImageUrl, handlers, selecting };
  return (
    <div role="grid" aria-label={t("file_list")} aria-multiselectable className="p-4 space-y-5">
      {folders.length > 0 && (
        // A row group, not a <section>: a grid holds rows and row groups only.
        // The group carries the name, so the visible heading is hidden from
        // screen readers rather than read twice.
        <div role="rowgroup" aria-label={t("folders")}>
          <h3 aria-hidden="true" className="text-xs font-medium text-muted-foreground mb-2 px-0.5">{t("folders")}</h3>
          <div role="row" className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2">
            {folders.map((resource) => (
              <FolderTile
                key={resource.id}
                resource={resource}
                isSelected={selected.has(resource.name)}
                isFocused={focusedName === resource.name}
                isTabStop={tabStopName === resource.name}
                isDropTarget={dropTarget === resource.name}
                isCut={cutNames.has(resource.name)}
                isStarred={starredPaths.has(pathOf(resource))}
                {...common}
              />
            ))}
          </div>
        </div>
      )}
      {files.length > 0 && (
        <div role="rowgroup" aria-label={t("files_heading")}>
          {folders.length > 0 && <h3 aria-hidden="true" className="text-xs font-medium text-muted-foreground mb-2 px-0.5">{t("files_heading")}</h3>}
          <div role="row" className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3">
            {files.map((resource) => (
              <FileTile
                key={resource.id}
                resource={resource}
                isSelected={selected.has(resource.name)}
                isFocused={focusedName === resource.name}
                isTabStop={tabStopName === resource.name}
                isCut={cutNames.has(resource.name)}
                {...common}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface TileProps {
  resource: FileResource;
  isSelected: boolean;
  isFocused: boolean;
  isTabStop: boolean;
  isCut: boolean;
  selecting: boolean;
  touch: boolean;
  iconOptions: IconOptions;
  getImageUrl: (name: string) => Promise<string>;
  handlers: FileItemHandlers;
}

function FolderTile({ resource, isSelected, isFocused, isTabStop, isDropTarget, isCut, isStarred, selecting, touch, iconOptions, handlers }: TileProps & { isDropTarget: boolean; isStarred: boolean }) {
  const t = useTranslations("files");
  const touchProps = useTouchPress(touch, selecting, resource, handlers);
  return (
    <div
      role="gridcell"
      aria-selected={isSelected}
      data-resource={resource.name}
      tabIndex={isTabStop ? 0 : -1}
      onFocus={(e) => { if (e.target === e.currentTarget) handlers.onFocusItem(resource); }}
      {...handlers.dragProps(resource)}
      onClick={(e) => handlers.onSelectClick(resource, e)}
      onDoubleClick={() => handlers.onOpen(resource)}
      onContextMenu={(e) => handlers.onContextMenu(e, resource)}
      {...touchProps}
      className={cn(
        "group relative flex items-center gap-2.5 h-11 ps-3 pe-1 rounded-lg border cursor-default select-none transition-colors",
        isSelected ? "border-primary/60 bg-selection" : isDropTarget ? "border-primary bg-primary/10" : "border-border bg-background hover:bg-muted/60",
        isFocused && "ring-2 ring-ring/50",
        isCut && "opacity-50",
      )}
    >
      {(selecting || !touch) && (
        <span className={cn("absolute -top-1.5 -start-1.5", !(selecting || isSelected) && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100")}>
          <SelectBox checked={isSelected} visible onToggle={() => handlers.onToggleSelect(resource)} label={t("select_item", { name: resource.name })} />
        </span>
      )}
      <ResourceIcon resource={resource} size="sm" options={iconOptions} />
      <span className="flex-1 min-w-0 truncate text-start text-sm font-medium" title={resource.name}>
        {resource.name}
      </span>
      {isStarred && <Star className="w-3.5 h-3.5 shrink-0 text-amber-400 fill-amber-400" aria-label={t("favorites")} />}
      <ShareBadge resource={resource} t={t} />
      <IconButton
        data-item-action
        label={t("more_actions", { name: resource.name })}
        onClick={(e) => { e.stopPropagation(); handlers.onContextMenu(e, resource); }}
        onDoubleClick={(e) => e.stopPropagation()}
        className={cn("text-muted-foreground hover:text-foreground", !touch && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100")}
      >
        <MoreVertical />
      </IconButton>
    </div>
  );
}

function FileTile({ resource, isSelected, isFocused, isTabStop, isCut, selecting, touch, iconOptions, getImageUrl, handlers }: TileProps) {
  const t = useTranslations("files");
  const touchProps = useTouchPress(touch, selecting, resource, handlers);
  const bigIcon = <ResourceIcon resource={resource} size="xl" options={iconOptions} />;
  return (
    <div
      role="gridcell"
      aria-selected={isSelected}
      data-resource={resource.name}
      tabIndex={isTabStop ? 0 : -1}
      onFocus={(e) => { if (e.target === e.currentTarget) handlers.onFocusItem(resource); }}
      {...handlers.dragProps(resource)}
      onClick={(e) => handlers.onSelectClick(resource, e)}
      onDoubleClick={() => handlers.onOpen(resource)}
      onContextMenu={(e) => handlers.onContextMenu(e, resource)}
      {...touchProps}
      className={cn(
        "group relative flex flex-col rounded-lg border overflow-hidden cursor-default select-none transition-colors",
        isSelected ? "border-primary/60 bg-selection" : "border-border bg-background hover:bg-muted/60",
        isFocused && "ring-2 ring-ring/50",
        isCut && "opacity-50",
      )}
    >
      <div className="aspect-[4/3] bg-muted/50 flex items-center justify-center overflow-hidden border-b border-border/60">
        {canShowThumbnail(resource, iconOptions) ? (
          <Thumbnail
            resource={resource}
            getImageUrl={getImageUrl}
            wrapperClassName="w-full h-full"
            className="w-full h-full object-cover"
            fallback={bigIcon}
          />
        ) : bigIcon}
      </div>
      {(selecting || !touch) && (
        <span className={cn("absolute top-2 start-2", !(selecting || isSelected) && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100")}>
          <SelectBox checked={isSelected} visible onToggle={() => handlers.onToggleSelect(resource)} label={t("select_item", { name: resource.name })} />
        </span>
      )}
      <div className="flex items-center gap-1 ps-2.5 pe-1 py-1.5 min-w-0">
        <div className="min-w-0 flex-1">
          <MiddleCutName name={resource.name} className="w-full text-start text-sm" />
          <div className="flex items-center gap-1 text-xs text-muted-foreground min-w-0">
            <span className="truncate">
              {!resource.isSymlink && <><FileSize bytes={resource.contentLength} /> · </>}{formatShortDate(resource.lastModified)}
            </span>
            <ShareBadge resource={resource} t={t} className="w-3 h-3" />
            <FilesSyncBadge nodeId={resource.id} className="w-3 h-3" />
          </div>
        </div>
        <IconButton
          data-item-action
          label={t("more_actions", { name: resource.name })}
          onClick={(e) => { e.stopPropagation(); handlers.onContextMenu(e, resource); }}
          onDoubleClick={(e) => e.stopPropagation()}
          className={cn("text-muted-foreground hover:text-foreground shrink-0", !touch && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100")}
        >
          <MoreVertical />
        </IconButton>
      </div>
    </div>
  );
}
