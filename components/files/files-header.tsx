"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Menu, ChevronRight, Search, X, ArrowUpDown, Check, LayoutGrid, LayoutList,
  PanelRight, Download, Trash2, Scissors, Copy, Pencil, Share2, Clipboard,
  MoreHorizontal, FolderOpen, Folder, ArrowUp, ArrowDown, RefreshCw, Plus,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
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
  onCut: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onClear: () => void;
  /** The selection as plugins see it (file-actions). */
  pluginFiles: FileResourceView[];
  /** The one selected item's type, so plugins can offer type-specific actions; undefined for several. */
  pluginMimeType?: string;
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
  /** Xenaxio step 115: "+ Neu" opens the create menu (on a phone the round "+" does). */
  onNew?: (anchor: HTMLElement) => void;
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
  onNew,
}: FilesHeaderProps) {
  const t = useTranslations("files");
  const sortMenu = useContextMenu<null>();
  const overflowMenu = useContextMenu<Crumb[]>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [dropCrumb, setDropCrumb] = useState<string | null>(null);

  const headerClass = "flex items-center gap-1 px-3 border-b border-border min-w-0 flex-shrink-0";
  const headerStyle = { paddingBlock: "var(--density-header-py)" };

  if (selection) {
    return (
      <div role="toolbar" aria-label={t("selection_actions")} className={cn(headerClass, "bg-accent/40")} style={headerStyle}>
        <Button variant="ghost" size="icon" className="h-8 w-8 -ms-1" onClick={selection.onClear} aria-label={t("clear_selection")} title={t("clear_selection")}>
          <X className="w-4 h-4" />
        </Button>
        <span className="text-sm font-medium me-2 whitespace-nowrap" aria-live="polite">
          {t("selected_count", { count: selection.count })}
        </span>
        <div className="flex items-center gap-0.5 min-w-0 overflow-x-auto">
          {selection.canOpen && (
            <ToolButton icon={FolderOpen} label={t("open")} onClick={selection.onOpen} compact={compact} />
          )}
          {selection.fileCount > 0 && (
            <ToolButton icon={Download} label={t("download")} onClick={selection.onDownload} compact={compact} />
          )}
          {selection.canShare && (
            <ToolButton icon={Share2} label={t("share")} onClick={selection.onShare} compact={compact} />
          )}
          {selection.canRename && (
            <ToolButton icon={Pencil} label={t("rename")} onClick={selection.onRename} compact />
          )}
          <ToolButton icon={Scissors} label={t("cut")} onClick={selection.onCut} compact />
          <ToolButton icon={Copy} label={t("copy")} onClick={selection.onCopy} compact />
          <ToolButton icon={Trash2} label={t("delete")} onClick={selection.onDelete} compact destructive />
          {!compact && <SelectionPluginActions files={selection.pluginFiles} mimeType={selection.pluginMimeType} />}
        </div>
        {/* Outside the scrolling row, so the "more" button never scrolls out of sight. */}
        {compact && <SelectionPluginActions files={selection.pluginFiles} mimeType={selection.pluginMimeType} overflow />}
        <div className="flex-1" />
        <DetailsToggle showDetails={showDetails} onToggle={onToggleDetails} label={t("details")} />
      </div>
    );
  }

  // Deep paths keep the root and the last folders; the rest go in a menu.
  const hidden = crumbs.length > MAX_VISIBLE_CRUMBS + 1 ? crumbs.slice(1, crumbs.length - MAX_VISIBLE_CRUMBS + 1) : [];
  const visible = hidden.length > 0 ? [crumbs[0], ...crumbs.slice(crumbs.length - MAX_VISIBLE_CRUMBS + 1)] : crumbs;

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
      <li key={`${crumb.id ?? "root"}:${crumb.path}`} className="flex items-center min-w-0 shrink-0 last:shrink">
        {index > 0 && <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0 rtl:rotate-180" aria-hidden />}
        <button
          type="button"
          onClick={() => onNavigateCrumb(crumb)}
          aria-current={isLast ? "page" : undefined}
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
    <div className={cn("relative", compact ? "flex-1" : "w-56")}>
      <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
      <input
        ref={searchInputRef}
        type="search"
        role="searchbox"
        aria-label={t("search_placeholder")}
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onSearchChange("");
            if (compact) setSearchOpen(false);
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder={t("search_placeholder")}
        autoFocus={compact}
        className="w-full h-8 rounded-md border border-input bg-background ps-8 pe-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
      />
      {(searchQuery || compact) && (
        <button
          type="button"
          onClick={() => { onSearchChange(""); if (compact) setSearchOpen(false); }}
          className="absolute end-1.5 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-muted text-muted-foreground"
          aria-label={t("clear_search")}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );

  if (compact && searchOpen && !toolsHidden) {
    return (
      <div className={headerClass} style={headerStyle}>
        {searchField}
      </div>
    );
  }

  return (
    <div role="toolbar" aria-label={t("toolbar")} className={headerClass} style={headerStyle}>
      {onMenuClick && (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 -ms-1 shrink-0"
          onClick={onMenuClick}
          aria-label={t("open_folder_tree")}
          aria-expanded={menuOpen}
        >
          <Menu className="w-4 h-4" />
        </Button>
      )}

      <nav aria-label={t("breadcrumbs")} className="flex-1 min-w-0">
        <ol className="flex items-center text-sm min-w-0">
          {visible.slice(0, 1).map((c) => renderCrumb(c, 0))}
          {accountLabel && (
            <li className="flex items-center min-w-0 shrink-0">
              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0 rtl:rotate-180" aria-hidden />
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
              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0 rtl:rotate-180" aria-hidden />
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
          {visible.slice(1).map((c, i) => renderCrumb(c, i + 1))}
        </ol>
      </nav>

      {!toolsHidden && (
        <div className="flex items-center gap-1 shrink-0">
          {onNew && !compact && (
            <Button size="sm" className="h-8 gap-1.5 me-1" aria-haspopup="menu" onClick={(e) => onNew(e.currentTarget)}>
              <Plus className="w-4 h-4" />
              {t("new")}
            </Button>
          )}
          {clipboardCount > 0 && (
            <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={onPaste} title={t("paste_here")}>
              <Clipboard className="w-4 h-4" />
              <span className={cn(compact && "sr-only")}>{t("paste_count", { count: clipboardCount })}</span>
            </Button>
          )}
          {compact ? (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSearchOpen(true)} aria-label={t("search_placeholder")}>
              <Search className="w-4 h-4" />
            </Button>
          ) : searchField}
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-8 w-8", sortMenu.contextMenu.isOpen && "bg-accent")}
            aria-label={t("sort_by")}
            title={t("sort_by")}
            aria-haspopup="menu"
            aria-expanded={sortMenu.contextMenu.isOpen}
            onMouseDown={(e) => { if (sortMenu.contextMenu.isOpen) e.stopPropagation(); }}
            onClick={(e) => {
              if (sortMenu.contextMenu.isOpen) sortMenu.closeContextMenu();
              else sortMenu.openContextMenu(anchorEvent(e.currentTarget, "end"), null);
            }}
          >
            <ArrowUpDown className="w-4 h-4" />
          </Button>
          <div className="flex items-center rounded-md border border-border p-0.5" role="radiogroup" aria-label={t("view_mode")}>
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
                  "h-6 w-7 flex items-center justify-center rounded transition-colors",
                  viewMode === mode ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="w-4 h-4" />
              </button>
            ))}
          </div>
          {!compact && (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onRefresh} disabled={isLoading} aria-label={t("refresh")} title={t("refresh")}>
              <RefreshCw className={cn("w-4 h-4", isLoading && "animate-spin")} />
            </Button>
          )}
          <DetailsToggle showDetails={showDetails} onToggle={onToggleDetails} label={t("details")} />
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
      size={compact ? "icon" : "sm"}
      className={cn("h-8 shrink-0", compact ? "w-8" : "gap-1.5 px-2.5", destructive && "text-destructive hover:text-destructive hover:bg-destructive/10")}
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
    <Button
      variant="ghost"
      size="icon"
      className={cn("h-8 w-8 shrink-0", showDetails && "bg-accent text-accent-foreground")}
      onClick={onToggle}
      aria-label={label}
      aria-pressed={showDetails}
      title={label}
    >
      <PanelRight className="w-4 h-4" />
    </Button>
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
