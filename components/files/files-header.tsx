"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import {
  Menu, ChevronRight, Search, X, ArrowUpDown, Check, LayoutGrid, LayoutList,
  PanelRight, Download, Trash2, Scissors, Copy, Pencil, Share2, Clipboard,
  MoreHorizontal, FolderOpen, Folder, ArrowUp, ArrowDown, RefreshCw, RotateCcw, FolderInput,
} from "@/components/icons";
import { Button, TOUCH_HIT_AREA } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ToolbarButton, ToolbarSearch, TOOLBAR_ACTIVE } from "@/components/ui/toolbar";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { useMediaQuery } from "@/hooks/use-media-query";
import { PhoneHeaderActions } from "@/components/layout/phone-header-actions";
import { cn } from "@/lib/utils";
import { anchorEvent, isInternalDrag, readDraggedNames } from "@/components/files/file-item-parts";
import { PluginActions } from "@/components/plugins/plugin-actions";
import type { FileResourceView } from "@/lib/plugin-types";

export type SortKey = "name" | "size" | "modified";
export type SortDir = "asc" | "desc";
export type ViewMode = "list" | "grid";

export interface Crumb {
  /** Folder id; null for the root. */
  id: string | null;
  name: string;
  path: string;
}

interface SelectionActions {
  count: number;
  /** Files among the selection, for the download count. */
  fileCount: number;
  canOpen: boolean;
  canRename: boolean;
  canShare: boolean;
  onOpen: () => void;
  onDownload: () => void;
  onShare: () => void;
  onRename: () => void;
  /** Move to… a folder picked from the tree; undefined where items can't move. */
  onMoveTo?: () => void;
  onCut: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onClear: () => void;
  /** The selection as plugins see it (file-actions). */
  pluginFiles: FileResourceView[];
  /** The one selected item's type, so plugins can offer type-specific actions; undefined for several. */
  pluginMimeType?: string;
  /** Items in the trash: Restore and Delete permanently, nothing else. */
  trash?: boolean;
  onRestore?: () => void;
}

interface FilesHeaderProps {
  crumbs: Crumb[];
  /** Pro shell: a label between the root and the account's folders. */
  accountLabel?: string | null;
  onNavigateCrumb: (crumb: Crumb) => void;
  onNavigateAccountRoot?: () => void;
  onDropOnCrumb: (names: string[], targetId: string | null) => void;
  onMenuClick?: () => void;
  menuOpen?: boolean;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  sortKey: SortKey;
  sortDir: SortDir;
  onSortChange: (key: SortKey, dir: SortDir) => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  showDetails: boolean;
  onToggleDetails: () => void;
  clipboardCount: number;
  onPaste: () => void;
  onRefresh: () => void;
  isLoading: boolean;
  compact: boolean;
  /** Hide the tools that only apply to a folder listing (Pro account picker). */
  toolsHidden?: boolean;
  selection: SelectionActions | null;
  /** In the trash: the Empty trash button. */
  emptyTrash?: { onEmpty: () => void; disabled: boolean };
  /** The plugin side panel's button, after the details button (desktop and tablet). */
  panelToggle?: ReactNode;
}

const MAX_VISIBLE_CRUMBS = 3;

export function FilesHeader({
  crumbs,
  accountLabel,
  onNavigateCrumb,
  onNavigateAccountRoot,
  onDropOnCrumb,
  onMenuClick,
  menuOpen,
  searchQuery,
  onSearchChange,
  searchInputRef,
  sortKey,
  sortDir,
  onSortChange,
  viewMode,
  onViewModeChange,
  showDetails,
  onToggleDetails,
  clipboardCount,
  onPaste,
  onRefresh,
  isLoading,
  compact,
  toolsHidden,
  selection,
  emptyTrash,
  panelToggle,
}: FilesHeaderProps) {
  const t = useTranslations("files");
  const sortMenu = useContextMenu<null>();
  const overflowMenu = useContextMenu<Crumb[]>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [dropCrumb, setDropCrumb] = useState<string | null>(null);
  // A phone's row has no room for the path next to every tool: sort, view and details go in the ⋮.
  const narrow = useMediaQuery("(max-width: 30rem)") && compact;
  const toolsRef = useRef<HTMLDivElement>(null);

  const headerClass = "flex items-center gap-1 px-3 h-14 box-content border-b border-border min-w-0 flex-shrink-0";
  // The row is px-3; the margin puts the button where the reader has it (px-4, lg:px-6).
  const toggleSlot = panelToggle ? <div className="flex items-center shrink-0 me-1 lg:me-3" data-panel-toggle-slot="">{panelToggle}</div> : null;

  if (selection) {
    return (
      <div role="toolbar" aria-label={t("selection_actions")} className={cn(headerClass, "bg-accent/40")}>
        <IconButton label={t("clear_selection")} onClick={selection.onClear}>
          <X />
        </IconButton>
        <span className="text-sm font-medium me-2 whitespace-nowrap" aria-live="polite">
          {t("selected_count", { count: selection.count })}
        </span>
        <div className="flex items-center gap-0.5 min-w-0 overflow-x-auto">
          {selection.trash ? (
            <>
              {selection.onRestore && (
                <ToolButton icon={RotateCcw} label={t("restore")} onClick={selection.onRestore} compact />
              )}
              <ToolButton icon={Trash2} label={t("delete_forever")} onClick={selection.onDelete} compact destructive />
            </>
          ) : (
          <>
          {/* All icons with a tooltip, as in Mail's selection bar: one kind of button. */}
          {selection.canOpen && (
            <ToolButton icon={FolderOpen} label={t("open")} onClick={selection.onOpen} compact />
          )}
          {selection.fileCount > 0 && (
            <ToolButton icon={Download} label={t("download")} onClick={selection.onDownload} compact />
          )}
          {selection.canShare && (
            <ToolButton icon={Share2} label={t("share")} onClick={selection.onShare} compact />
          )}
          {selection.canRename && (
            <ToolButton icon={Pencil} label={t("rename")} onClick={selection.onRename} compact />
          )}
          {selection.onMoveTo && (
            <ToolButton icon={FolderInput} label={t("move_to")} onClick={selection.onMoveTo} compact />
          )}
          <ToolButton icon={Scissors} label={t("cut")} onClick={selection.onCut} compact />
          <ToolButton icon={Copy} label={t("copy")} onClick={selection.onCopy} compact />
          {!compact && <ToolButton icon={Trash2} label={t("delete")} onClick={selection.onDelete} compact destructive />}
          {!compact && <SelectionPluginActions files={selection.pluginFiles} mimeType={selection.pluginMimeType} />}
          </>
          )}
        </div>
        {/* Outside the scrolling row, so Delete and the "more" button never scroll out of sight. */}
        {compact && !selection.trash && <ToolButton icon={Trash2} label={t("delete")} onClick={selection.onDelete} compact destructive />}
        {compact && !selection.trash && <SelectionPluginActions files={selection.pluginFiles} mimeType={selection.pluginMimeType} overflow />}
        <div className="flex-1" />
        {!narrow && <DetailsToggle showDetails={showDetails} onToggle={onToggleDetails} label={t("details")} />}
        {toggleSlot}
      </div>
    );
  }

  // Deep paths keep the root and the last folders; the rest go in a menu.
  // A phone only fits the folder you are in, with the way up in the menu.
  const onlyLast = narrow ? crumbs.length > 1 : compact && crumbs.length > 2;
  const hidden = onlyLast
    ? crumbs.slice(0, -1)
    : crumbs.length > MAX_VISIBLE_CRUMBS + 1 ? crumbs.slice(1, crumbs.length - MAX_VISIBLE_CRUMBS + 1) : [];
  const visible = onlyLast
    ? crumbs.slice(-1)
    : hidden.length > 0 ? [crumbs[0], ...crumbs.slice(crumbs.length - MAX_VISIBLE_CRUMBS + 1)] : crumbs;

  const crumbDropProps = (crumb: Crumb, isLast: boolean) => isLast ? {} : {
    onDragOver: (e: React.DragEvent) => {
      if (!isInternalDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropCrumb(crumb.path);
    },
    onDragLeave: () => setDropCrumb((cur) => (cur === crumb.path ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropCrumb(null);
      const names = readDraggedNames(e);
      if (names.length > 0) onDropOnCrumb(names, crumb.id);
    },
  };

  const renderCrumb = (crumb: Crumb, index: number) => {
    const isLast = crumb === crumbs[crumbs.length - 1];
    return (
      <li key={`${crumb.id ?? "root"}:${crumb.path}`} className="flex items-center min-w-0 shrink first:shrink-0 last:shrink-[0.25]">
        {index > 0 && <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden />}
        <button
          type="button"
          onClick={() => onNavigateCrumb(crumb)}
          aria-current={isLast ? "page" : undefined}
          title={crumb.name}
          className={cn(
            "px-1.5 py-1 rounded-md transition-colors truncate max-w-[16rem]",
            isLast ? "font-semibold text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted",
            dropCrumb === crumb.path && "bg-primary/10 text-foreground ring-1 ring-primary/40",
          )}
          {...crumbDropProps(crumb, isLast)}
        >
          {crumb.name}
        </button>
      </li>
    );
  };

  const searchField = (
    <ToolbarSearch
      ref={searchInputRef}
      className={compact ? "flex-1" : "w-56"}
      role="searchbox"
      aria-label={t("search_placeholder")}
      placeholder={t("search_placeholder")}
      autoComplete="off"
      shortcut="/"
      value={searchQuery}
      onChange={(e) => onSearchChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          onSearchChange("");
          if (compact) setSearchOpen(false);
          (e.target as HTMLInputElement).blur();
        }
      }}
      autoFocus={compact}
      onClear={() => { onSearchChange(""); if (compact) setSearchOpen(false); }}
      clearLabel={t("clear_search")}
      alwaysShowClear={compact}
    />
  );


  if (compact && searchOpen && !toolsHidden) {
    return (
      <div className={headerClass}>
        {searchField}
      </div>
    );
  }

  return (
    <div role="toolbar" aria-label={t("toolbar")} className={headerClass}>
      {onMenuClick && (
        <ToolbarButton
          label={t("open_folder_tree")}
          onClick={onMenuClick}
          aria-expanded={menuOpen}
        >
          <Menu />
        </ToolbarButton>
      )}

      <nav aria-label={t("breadcrumbs")} className="flex-1 min-w-0">
        <ol className="flex items-center text-sm min-w-0">
          {!onlyLast && visible.slice(0, 1).map((c) => renderCrumb(c, 0))}
          {accountLabel && !onlyLast && (
            <li className="flex items-center min-w-0 shrink-0">
              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden />
              <button
                type="button"
                onClick={onNavigateAccountRoot}
                className="px-1.5 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted truncate max-w-[12rem]"
              >
                {accountLabel}
              </button>
            </li>
          )}
          {hidden.length > 0 && (
            <li className="flex items-center shrink-0">
              {!onlyLast && <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden />}
              <button
                type="button"
                className="px-1.5 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                aria-label={t("show_path")}
                aria-haspopup="menu"
                onClick={(e) => overflowMenu.openContextMenu(anchorEvent(e.currentTarget), hidden)}
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
            </li>
          )}
          {(onlyLast ? visible : visible.slice(1)).map((c, i) => renderCrumb(c, i + 1))}
        </ol>
      </nav>

      {!toolsHidden && (
        <div ref={toolsRef} className="flex items-center gap-1 shrink-0">
          {emptyTrash && (
            <Button
              variant="outline"
              size="xs"
              className="gap-1.5 text-destructive hover:text-destructive"
              onClick={emptyTrash.onEmpty}
              disabled={emptyTrash.disabled}
              title={t("empty_trash")}
            >
              <Trash2 className="w-4 h-4" />
              <span className={cn(compact && "sr-only")}>{t("empty_trash")}</span>
            </Button>
          )}
          {clipboardCount > 0 && (
            <Button variant="outline" size="xs" className="gap-1.5" onClick={onPaste} title={t("paste_here")}>
              <Clipboard className="w-4 h-4" />
              <span className={cn(compact && "sr-only")}>{t("paste_count", { count: clipboardCount })}</span>
            </Button>
          )}
          {compact ? (
            <ToolbarButton label={t("search_placeholder")} onClick={() => setSearchOpen(true)}>
              <Search />
            </ToolbarButton>
          ) : searchField}
          {!narrow && <ToolbarButton
            label={t("sort_by")}
            active={sortMenu.contextMenu.isOpen}
            aria-haspopup="menu"
            aria-expanded={sortMenu.contextMenu.isOpen}
            onMouseDown={(e) => { if (sortMenu.contextMenu.isOpen) e.stopPropagation(); }}
            onClick={(e) => {
              if (sortMenu.contextMenu.isOpen) sortMenu.closeContextMenu();
              else sortMenu.openContextMenu(anchorEvent(e.currentTarget, "end"), null);
            }}
          >
            <ArrowUpDown />
          </ToolbarButton>}
          {!narrow && <div className="flex items-center h-8 rounded-md border border-input p-0.5 shrink-0" role="radiogroup" aria-label={t("view_mode")}>
            {([["list", LayoutList, t("list_view")], ["grid", LayoutGrid, t("grid_view")]] as const).map(([mode, Icon, label]) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={viewMode === mode}
                aria-label={label}
                title={label}
                onClick={() => onViewModeChange(mode)}
                className={cn(
                  "h-full w-7 flex items-center justify-center rounded transition-colors",
                  // A 44px hit area on touch, as every Button has (R1).
                  TOUCH_HIT_AREA,
                  viewMode === mode ? TOOLBAR_ACTIVE : "text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
              >
                <Icon className="w-4 h-4" />
              </button>
            ))}
          </div>}
          {!compact && (
            <ToolbarButton label={t("refresh")} onClick={onRefresh} disabled={isLoading}>
              <RefreshCw className={cn(isLoading && "animate-spin [animation-direction:reverse]")} />
            </ToolbarButton>
          )}
          {!narrow && <DetailsToggle showDetails={showDetails} onToggle={onToggleDetails} label={t("details")} />}
          {toggleSlot}
          <PhoneHeaderActions
            below="md"
            menuItems={(close) => (
              <>
                {narrow && <ContextMenuItem icon={ArrowUpDown} label={t("sort_by")} onClick={() => { close(); if (toolsRef.current) sortMenu.openContextMenu(anchorEvent(toolsRef.current, "end"), null); }} />}
                {narrow && (viewMode === "list"
                  ? <ContextMenuItem icon={LayoutGrid} label={t("grid_view")} onClick={() => { close(); onViewModeChange("grid"); }} />
                  : <ContextMenuItem icon={LayoutList} label={t("list_view")} onClick={() => { close(); onViewModeChange("list"); }} />)}
                {narrow && <ContextMenuItem icon={PanelRight} label={t("details")} onClick={() => { close(); onToggleDetails(); }} />}
                {/* The phone header has no room for Refresh as a button. */}
                <ContextMenuItem icon={RefreshCw} label={t("refresh")} onClick={() => { close(); onRefresh(); }} disabled={isLoading} />
              </>
            )}
          />
        </div>
      )}

      <ContextMenu ref={sortMenu.menuRef} isOpen={sortMenu.contextMenu.isOpen} position={sortMenu.contextMenu.position} onClose={sortMenu.closeContextMenu}>
        {([["name", t("name")], ["modified", t("modified")], ["size", t("size")]] as const).map(([key, label]) => (
          <SortItem
            key={key}
            label={label}
            checked={sortKey === key}
            onClick={() => { onSortChange(key, sortKey === key ? sortDir : key === "name" ? "asc" : "desc"); sortMenu.closeContextMenu(); }}
          />
        ))}
        <ContextMenuSeparator />
        <SortItem
          icon={ArrowUp}
          label={t("settings_ascending")}
          checked={sortDir === "asc"}
          onClick={() => { onSortChange(sortKey, "asc"); sortMenu.closeContextMenu(); }}
        />
        <SortItem
          icon={ArrowDown}
          label={t("settings_descending")}
          checked={sortDir === "desc"}
          onClick={() => { onSortChange(sortKey, "desc"); sortMenu.closeContextMenu(); }}
        />
      </ContextMenu>

      <ContextMenu ref={overflowMenu.menuRef} isOpen={overflowMenu.contextMenu.isOpen} position={overflowMenu.contextMenu.position} onClose={overflowMenu.closeContextMenu}>
        {(overflowMenu.contextMenu.data ?? []).map((crumb) => (
          <ContextMenuItem
            key={crumb.path}
            icon={Folder}
            label={crumb.name}
            onClick={() => { overflowMenu.closeContextMenu(); onNavigateCrumb(crumb); }}
          />
        ))}
      </ContextMenu>
    </div>
  );
}

function ToolButton({ icon: Icon, label, onClick, compact, destructive }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  compact?: boolean;
  destructive?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      size={compact ? "icon-sm" : "xs"}
      className={cn("shrink-0", !compact && "gap-1.5", destructive && "text-destructive hover:text-destructive hover:bg-destructive/10")}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <Icon className="w-4 h-4" />
      {!compact && <span>{label}</span>}
    </Button>
  );
}

function DetailsToggle({ showDetails, onToggle, label }: { showDetails: boolean; onToggle: () => void; label: string }) {
  return (
    <ToolbarButton label={label} active={showDetails} onClick={onToggle} aria-pressed={showDetails}>
      <PanelRight />
    </ToolbarButton>
  );
}

function SortItem({ label, checked, onClick, icon: Icon }: {
  label: string;
  checked: boolean;
  onClick: () => void;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      onClick={onClick}
      className="w-full px-3 py-1.5 text-sm text-start flex items-center gap-2 hover:bg-muted focus:outline-none focus:bg-muted"
    >
      <span className="w-4 h-4 shrink-0 flex items-center justify-center">
        {checked && <Check className="w-4 h-4" />}
      </span>
      {Icon && <Icon className="w-3.5 h-3.5 text-muted-foreground" />}
      <span className="flex-1">{label}</span>
    </button>
  );
}

/**
 * Plugin buttons in the selection toolbar, icon-only like the app's own. On
 * phones the toolbar has no room for them: they go behind one "more" button.
 */
function SelectionPluginActions({ files, mimeType, overflow }: { files: FileResourceView[]; mimeType?: string; overflow?: boolean }) {
  const context = useMemo(() => ({ files }), [files]);
  return <PluginActions surface="file-actions" context={context} mimeType={mimeType} compact overflow={overflow} className="flex-nowrap gap-0.5 flex-shrink-0" />;
}
