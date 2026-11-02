"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Plus, HardDrive, File, Folder, FolderOpen, ChevronRight, ChevronDown, Star, StarOff,
  Clock, Share2, Upload, FolderUp, FolderPlus, FilePlus, Pencil, Trash2, Download, Eye, X, FolderSearch, FolderInput,
} from "@/components/icons";
import { isTrashLocation } from "@/lib/files-trash";
import { IconButton } from "@/components/ui/icon-button";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { useContextMenu } from "@/hooks/use-context-menu";
import { cn } from "@/lib/utils";
import { sharedFilePages, type FileResource } from "@/stores/file-store";
import { getFileIconByName } from "@/components/files/file-icons";
import { anchorEvent, isInternalDrag, readDraggedNames } from "@/components/files/file-item-parts";

const COLLAPSED_KEY = "files-sidebar-collapsed";
const RECENT_LIMIT = 8;

function loadCollapsed(): Record<string, boolean> {
  try {
    const v = localStorage.getItem(COLLAPSED_KEY);
    return v ? JSON.parse(v) : {};
  } catch {
    return {};
  }
}

const ROW_STYLE = { paddingBlock: "var(--density-sidebar-py, 4px)" } as const;

function rowClass(active: boolean, dropTarget: boolean) {
  return cn(
    // 32px rows, 44px on touch (R1).
    "group w-full flex items-center gap-2 pe-3 text-sm transition-colors text-start min-h-8 pointer-coarse:min-h-11",
    active
      ? "bg-accent text-accent-foreground font-medium"
      : dropTarget
        ? "bg-primary/10 text-foreground ring-1 ring-inset ring-primary/40"
        : "text-foreground hover:bg-muted",
  );
}

type MenuTarget =
  | { kind: "root" }
  | { kind: "folder"; folder: FileResource; path: string }
  | { kind: "favorite"; path: string }
  | { kind: "recent"; id: string };

/** What a "new" or "upload" entry in a folder's menu creates there. */
export type CreateKind = "folder" | "text" | "files" | "dir";

export interface FilesSidebarProps {
  currentParentId: string | null;
  currentPath: string;
  /** Every known folder; the tree is built from their parent links. */
  allFolders: FileResource[];
  sharedRoots: FileResource[];
  favorites: string[];
  recentFiles: { name: string; id: string; timestamp: number }[];
  /** Hide the "+" menu, e.g. while browsing a folder the user may not write to. */
  canCreate: boolean;
  onNavigate: (path: string, resourceId?: string | null) => void;
  onOpenRecent: (id: string) => void;
  onUploadFiles: () => void;
  onUploadFolder: () => void;
  onNewFolder: () => void;
  onNewTextFile: () => void;
  /** The label of the new-file entries: "New file" when documents can be made too (#1393). */
  newFileLabel?: string;
  onToggleFavorite: (path: string) => void;
  /** Move dragged items from the open folder into a folder (null = the root). */
  onDropItems: (names: string[], targetId: string | null) => void;
  canShare: (resource: FileResource) => boolean;
  onShare: (resource: FileResource) => void;
  /** Open a folder, then start creating or uploading there. */
  onCreateIn: (path: string, id: string | null, kind: CreateKind) => void;
  onRenameFolder: (folder: FileResource) => void;
  /** Move to… for a folder of the own drive. */
  onMoveFolder?: (folder: FileResource) => void;
  /** Download a folder as a zip. */
  onDownloadFolder?: (folder: FileResource) => void;
  onDeleteFolder: (folder: FileResource) => void;
  /** Open the folder holding a recent file, with the file selected. */
  onRevealRecent: (id: string) => void;
  /** Left out when a device policy turned downloads off. */
  onDownloadRecent?: (id: string) => void;
  onRemoveRecent: (id: string) => void;
  /** Items in the trash; the entry shows their number. */
  trashCount?: number;
  onOpenTrash?: () => void;
  /** Delete items dragged onto the trash entry. */
  onDropToTrash?: (names: string[]) => void;
}

export function FilesSidebar({
  currentParentId,
  currentPath,
  allFolders,
  sharedRoots,
  favorites,
  recentFiles,
  canCreate,
  onNavigate,
  onOpenRecent,
  onUploadFiles,
  onUploadFolder,
  onNewFolder,
  onNewTextFile,
  newFileLabel,
  onToggleFavorite,
  onDropItems,
  canShare,
  onShare,
  onCreateIn,
  onRenameFolder,
  onMoveFolder,
  onDownloadFolder,
  onDeleteFolder,
  onRevealRecent,
  onDownloadRecent,
  onRemoveRecent,
  trashCount = 0,
  onOpenTrash,
  onDropToTrash,
}: FilesSidebarProps) {
  const t = useTranslations("files");
  const newMenu = useContextMenu<null>();
  const itemMenu = useContextMenu<MenuTarget>();
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const toggleSection = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, FileResource[]>();
    for (const folder of allFolders) {
      // Shared roots are listed in their own section, never under My files.
      if (folder.isShared && (folder.parentId ?? null) === null) continue;
      const key = folder.parentId ?? null;
      const list = map.get(key);
      if (list) list.push(folder);
      else map.set(key, [folder]);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [allFolders]);

  // Open the tree down to the folder on screen.
  useEffect(() => {
    if (!currentParentId) return;
    const parentOf = new Map(allFolders.map((f) => [f.id, f.parentId ?? null]));
    const chain: string[] = [];
    for (let id = parentOf.get(currentParentId) ?? null; id != null; id = parentOf.get(id) ?? null) {
      chain.push(id);
    }
    if (chain.length === 0) return;
    setExpanded((prev) => {
      if (chain.every((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      chain.forEach((id) => next.add(id));
      return next;
    });
  }, [currentParentId, allFolders]);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const dropProps = (key: string, targetId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!isInternalDrag(e) || targetId === currentParentId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropTarget(key);
    },
    onDragLeave: () => setDropTarget((cur) => (cur === key ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      if (!isInternalDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      const names = readDraggedNames(e);
      if (names.length > 0) onDropItems(names, targetId);
    },
  });

  const renderFolder = (folder: FileResource, parentPath: string, depth: number): React.ReactNode => {
    const path = parentPath === "/" ? `/${folder.name}` : `${parentPath}/${folder.name}`;
    const children = childrenByParent.get(folder.id) ?? [];
    const isOpen = expanded.has(folder.id);
    const active = folder.id === currentParentId;
    const Icon = isOpen && children.length > 0 ? FolderOpen : Folder;
    return (
      <div key={folder.id} role="listitem">
        <div
          className={rowClass(active, dropTarget === folder.id)}
          style={{ ...ROW_STYLE, paddingInlineStart: `${12 + depth * 14}px` }}
          onContextMenu={(e) => itemMenu.openContextMenu(e, { kind: "folder", folder, path })}
          {...dropProps(folder.id, folder.id)}
        >
          {children.length > 0 ? (
            <button
              type="button"
              onClick={() => toggleExpanded(folder.id)}
              aria-expanded={isOpen}
              className="flex items-center justify-center size-6 -ms-[7px] -me-[3px] -my-[3px] rounded hover:bg-foreground/10 text-muted-foreground shrink-0"
              aria-label={isOpen ? t("collapse_folder", { name: folder.name }) : t("expand_folder", { name: folder.name })}
            >
              {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </button>
          ) : (
            <span className="w-3.5 -ms-1 shrink-0" />
          )}
          <button
            type="button"
            onClick={() => onNavigate(path, folder.id)}
            aria-current={active ? "page" : undefined}
            className="flex items-center gap-2 flex-1 min-w-0 text-start"
            title={folder.ownerName ? t("shared_by", { name: folder.ownerName }) : folder.name}
          >
            <Icon className={cn("w-4 h-4 shrink-0", folder.isShared ? "text-primary" : "text-muted-foreground", active && "text-current")} />
            <span className="truncate">{folder.name}</span>
          </button>
        </div>
        {isOpen && children.length > 0 && (
          <div role="list">{children.map((child) => renderFolder(child, path, depth + 1))}</div>
        )}
      </div>
    );
  };

  const sectionHeader = (key: string, label: string, icon: React.ReactNode) => (
    <button
      type="button"
      onClick={() => toggleSection(key)}
      className="flex items-center gap-1 px-3 py-1 w-full text-start"
      aria-expanded={!collapsed[key]}
    >
      {collapsed[key]
        ? <ChevronRight className="w-3 h-3 text-muted-foreground" />
        : <ChevronDown className="w-3 h-3 text-muted-foreground" />}
      {icon}
      <span className="text-xs font-medium text-muted-foreground truncate">{label}</span>
    </button>
  );

  const rootFolders = childrenByParent.get(null) ?? [];
  const sharedFolders = sharedRoots.filter((r) => r.isDirectory);
  // Files shared on their own sit in no shared folder; each owner's are
  // listed on one page.
  const sharedPages = sharedFilePages(sharedRoots);
  const recent = recentFiles.slice(0, RECENT_LIMIT);
  const menuTarget = itemMenu.contextMenu.isOpen ? itemMenu.contextMenu.data : null;
  const run = (action: () => void) => {
    itemMenu.closeContextMenu();
    action();
  };
  // Folders shared with the user only take new items when the owner allows it.
  const mayWrite = (folder: FileResource) => !folder.isShared || !!folder.myRights?.mayAddChildren;
  const createItems = (path: string, id: string | null) => (
    <>
      <ContextMenuSeparator />
      <ContextMenuItem icon={FolderPlus} label={t("new_folder")} onClick={() => run(() => onCreateIn(path, id, "folder"))} />
      <ContextMenuItem icon={FilePlus} label={newFileLabel ?? t("new_text_file")} onClick={() => run(() => onCreateIn(path, id, "text"))} />
      <ContextMenuItem icon={Upload} label={t("upload_files")} onClick={() => run(() => onCreateIn(path, id, "files"))} />
      <ContextMenuItem icon={FolderUp} label={t("upload_folder")} onClick={() => run(() => onCreateIn(path, id, "dir"))} />
    </>
  );

  return (
    <div className="flex flex-col h-full bg-secondary">
      {/* Same h-14 box as the mail sidebar's account switcher, so the apps line up. */}
      <div className="px-3 h-14 box-content border-b border-border flex items-center justify-between flex-shrink-0">
        <span className="text-sm font-semibold truncate">{t("title")}</span>
        {canCreate && (
          <IconButton
            ref={newButtonRef}
            label={t("new")}
            className="flex-shrink-0"
            aria-haspopup="menu"
            aria-expanded={newMenu.contextMenu.isOpen}
            onMouseDown={(e) => { if (newMenu.contextMenu.isOpen) e.stopPropagation(); }}
            onClick={(e) => {
              if (newMenu.contextMenu.isOpen) newMenu.closeContextMenu();
              else newMenu.openContextMenu(anchorEvent(e.currentTarget, "end"), null);
            }}
          >
            <Plus />
          </IconButton>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto py-1" aria-label={t("folders")}>
        <div>
          <div
            className={rowClass(currentPath === "/" && currentParentId === null, dropTarget === "__root__")}
            style={{ ...ROW_STYLE, paddingInlineStart: "12px" }}
            onContextMenu={(e) => itemMenu.openContextMenu(e, { kind: "root" })}
            {...dropProps("__root__", null)}
          >
            {rootFolders.length > 0 ? (
              <button
                type="button"
                onClick={() => toggleSection("tree")}
                aria-expanded={!collapsed.tree}
                className="flex items-center justify-center size-6 -ms-[7px] -me-[3px] -my-[3px] rounded hover:bg-foreground/10 text-muted-foreground shrink-0"
                aria-label={collapsed.tree ? t("expand_folder", { name: t("my_files") }) : t("collapse_folder", { name: t("my_files") })}
              >
                {collapsed.tree ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
            ) : (
              <span className="w-3.5 -ms-1 shrink-0" />
            )}
            <button
              type="button"
              onClick={() => onNavigate("/", null)}
              aria-current={currentPath === "/" && currentParentId === null ? "page" : undefined}
              className="flex items-center gap-2 flex-1 min-w-0 text-start"
            >
              <HardDrive className="w-4 h-4 shrink-0" />
              <span className="truncate">{t("my_files")}</span>
            </button>
          </div>
          {!collapsed.tree && rootFolders.length > 0 && (
            <div role="list" aria-label={t("my_files")}>{rootFolders.map((folder) => renderFolder(folder, "/", 1))}</div>
          )}
        </div>

        {favorites.length > 0 && (
          <div className="mt-3">
            {sectionHeader("starred", t("favorites"), null)}
            {!collapsed.starred && favorites.map((path) => (
              <button
                key={path}
                type="button"
                onClick={() => onNavigate(path)}
                onContextMenu={(e) => itemMenu.openContextMenu(e, { kind: "favorite", path })}
                aria-current={currentPath === path ? "page" : undefined}
                className={rowClass(currentPath === path, false)}
                style={{ ...ROW_STYLE, paddingInlineStart: "26px" }}
                title={path}
              >
                <Star className="w-4 h-4 shrink-0 text-amber-400 fill-amber-400" />
                <span className="truncate">{path === "/" ? t("my_files") : path.split("/").pop()}</span>
              </button>
            ))}
          </div>
        )}

        {recent.length > 0 && (
          <div className="mt-3">
            {sectionHeader("recent", t("recent"), null)}
            {!collapsed.recent && recent.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => onOpenRecent(entry.id)}
                onContextMenu={(e) => itemMenu.openContextMenu(e, { kind: "recent", id: entry.id })}
                className={rowClass(false, false)}
                style={{ ...ROW_STYLE, paddingInlineStart: "26px" }}
                title={entry.name}
              >
                <span className="w-4 h-4 shrink-0 flex items-center justify-center [&>svg]:w-4 [&>svg]:h-4">
                  {getFileIconByName(entry.name, "sm")}
                </span>
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
          </div>
        )}

        {(sharedFolders.length > 0 || sharedPages.length > 0) && (
          <div className="mt-3">
            {sectionHeader("shared", t("shared_with_me"), <Share2 className="w-3 h-3 text-muted-foreground" />)}
            {!collapsed.shared && (
            <div role="list" aria-label={t("shared_with_me")}>
            {sharedFolders.map((folder) => renderFolder(folder, "/", 1))}
            {sharedPages.map((page) => {
              const name = t("shared_files_from", { name: page.ownerName });
              const active = page.id === currentParentId;
              return (
                <div key={page.id} role="listitem">
                  <div className={rowClass(active, false)} style={{ ...ROW_STYLE, paddingInlineStart: "26px" }}>
                    <span className="w-3.5 -ms-1 shrink-0" />
                    <button
                      type="button"
                      onClick={() => onNavigate(`/${name}`, page.id)}
                      aria-current={active ? "page" : undefined}
                      className="flex items-center gap-2 flex-1 min-w-0 text-start"
                      title={t("shared_by", { name: page.ownerName })}
                    >
                      <File className={cn("w-4 h-4 shrink-0 text-primary", active && "text-current")} />
                      <span className="truncate">{name}</span>
                    </button>
                  </div>
                </div>
              );
            })}
            </div>
            )}
          </div>
        )}

        {onOpenTrash && (
          <div className="mt-3">
            <button
              type="button"
              onClick={onOpenTrash}
              aria-current={isTrashLocation(currentParentId) ? "page" : undefined}
              className={rowClass(isTrashLocation(currentParentId), dropTarget === "__trash__")}
              style={{ ...ROW_STYLE, paddingInlineStart: "12px" }}
              onDragOver={(e) => {
                if (!isInternalDrag(e) || !onDropToTrash || isTrashLocation(currentParentId)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDropTarget("__trash__");
              }}
              onDragLeave={() => setDropTarget((cur) => (cur === "__trash__" ? null : cur))}
              onDrop={(e) => {
                if (!isInternalDrag(e) || !onDropToTrash) return;
                e.preventDefault();
                setDropTarget(null);
                const names = readDraggedNames(e);
                if (names.length > 0) onDropToTrash(names);
              }}
            >
              <span className="w-3.5 -ms-1 shrink-0" />
              <Trash2 className="w-4 h-4 shrink-0" />
              <span className="truncate flex-1">{t("trash")}</span>
              {trashCount > 0 && <span className="text-xs text-muted-foreground tabular-nums">{trashCount}</span>}
            </button>
          </div>
        )}

        {recent.length === 0 && favorites.length === 0 && (
          <p className="px-4 pt-4 text-xs text-muted-foreground flex items-start gap-1.5">
            <Clock className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>{t("sidebar_hint")}</span>
          </p>
        )}
      </nav>

      <ContextMenu ref={newMenu.menuRef} isOpen={newMenu.contextMenu.isOpen} position={newMenu.contextMenu.position} onClose={newMenu.closeContextMenu}>
        <ContextMenuItem icon={Upload} label={t("upload_files")} onClick={() => { newMenu.closeContextMenu(); onUploadFiles(); }} />
        <ContextMenuItem icon={FolderUp} label={t("upload_folder")} onClick={() => { newMenu.closeContextMenu(); onUploadFolder(); }} />
        <ContextMenuSeparator />
        <ContextMenuItem icon={FolderPlus} label={t("new_folder")} onClick={() => { newMenu.closeContextMenu(); onNewFolder(); }} />
        <ContextMenuItem icon={FilePlus} label={newFileLabel ?? t("new_text_file")} onClick={() => { newMenu.closeContextMenu(); onNewTextFile(); }} />
      </ContextMenu>

      <ContextMenu ref={itemMenu.menuRef} isOpen={itemMenu.contextMenu.isOpen} position={itemMenu.contextMenu.position} onClose={itemMenu.closeContextMenu}>
        {menuTarget?.kind === "root" && (
          <>
            <ContextMenuItem icon={FolderOpen} label={t("open")} onClick={() => run(() => onNavigate("/", null))} />
            {canCreate && createItems("/", null)}
          </>
        )}
        {menuTarget?.kind === "folder" && (() => {
          const { folder, path } = menuTarget;
          const starred = favorites.includes(path);
          const writable = mayWrite(folder);
          const isSharedRoot = !!folder.isShared && sharedRoots.some((r) => r.id === folder.id);
          const mayRename = !isSharedRoot && (folder.myRights?.mayRename ?? true);
          const mayDelete = !isSharedRoot && (folder.myRights?.mayDelete ?? true);
          return (
            <>
              <ContextMenuItem icon={FolderOpen} label={t("open")} onClick={() => run(() => onNavigate(path, folder.id))} />
              {writable && createItems(path, folder.id)}
              {/* The list's folder menu in the same order; Cut, Copy and
                  Details act on the list and are left out here (R6). */}
              {(!folder.isShared || canShare(folder)) && <ContextMenuSeparator />}
              {canShare(folder) && (
                <ContextMenuItem icon={Share2} label={t("share")} onClick={() => run(() => onShare(folder))} />
              )}
              {!folder.isShared && (
                <ContextMenuItem
                  icon={starred ? StarOff : Star}
                  label={starred ? t("unstar") : t("star")}
                  onClick={() => run(() => onToggleFavorite(path))}
                />
              )}
              <ContextMenuSeparator />
              {mayRename && (
                <ContextMenuItem icon={Pencil} label={t("rename")} onClick={() => run(() => onRenameFolder(folder))} />
              )}
              {onMoveFolder && !folder.isShared && mayRename && (
                <ContextMenuItem icon={FolderInput} label={t("move_to")} onClick={() => run(() => onMoveFolder(folder))} />
              )}
              {onDownloadFolder && (
                <ContextMenuItem icon={Download} label={t("download_zip")} onClick={() => run(() => onDownloadFolder(folder))} />
              )}
              {mayDelete && <ContextMenuSeparator />}
              {mayDelete && (
                <ContextMenuItem icon={Trash2} label={t("delete")} destructive onClick={() => run(() => onDeleteFolder(folder))} />
              )}
            </>
          );
        })()}
        {menuTarget?.kind === "favorite" && (
          <>
            <ContextMenuItem icon={FolderOpen} label={t("open")} onClick={() => run(() => onNavigate(menuTarget.path))} />
            <ContextMenuSeparator />
            <ContextMenuItem icon={StarOff} label={t("unstar")} onClick={() => run(() => onToggleFavorite(menuTarget.path))} />
          </>
        )}
        {menuTarget?.kind === "recent" && (
          <>
            <ContextMenuItem icon={Eye} label={t("open")} onClick={() => run(() => onOpenRecent(menuTarget.id))} />
            <ContextMenuItem icon={FolderSearch} label={t("show_in_folder")} onClick={() => run(() => onRevealRecent(menuTarget.id))} />
            {onDownloadRecent && (
              <ContextMenuItem icon={Download} label={t("download")} onClick={() => run(() => onDownloadRecent(menuTarget.id))} />
            )}
            <ContextMenuSeparator />
            <ContextMenuItem icon={X} label={t("remove_from_recent")} onClick={() => run(() => onRemoveRecent(menuTarget.id))} />
          </>
        )}
      </ContextMenu>
    </div>
  );
}
