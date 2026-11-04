"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
import {
  Upload, FolderPlus, Download, Trash2, Pencil, Copy, Clipboard, Scissors, Info, Pin, PinOff,
  FilePlus, CopyPlus, AlertCircle, FolderUp, Share2, SquarePen, Eye, FolderOpen,
  RefreshCw, Star, StarOff, Plus, CheckSquare, File, RotateCcw, FolderInput, ExternalLink,
} from "@/components/icons";
import { useIsFullDesktop, useIsMobile, useMediaQuery } from "@/hooks/use-media-query";
import { useContextMenu } from "@/hooks/use-context-menu";
import { useKeepFileOffline } from "@/hooks/use-keep-file-offline";
import { useRegisterCommands } from "@/lib/command-registry";
import { formatShortcutCombo } from "@/lib/shortcut-keys";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { PromptDialog } from "@/components/ui/prompt-dialog";
import { NewFileDialog } from "@/components/files/new-file-dialog";
import { FolderPickerDialog } from "@/components/files/folder-picker-dialog";
import { fileNameProblem } from "@/lib/file-name-rules";
import { EmptyFolder, NoSearchResults } from "@/components/files/file-empty-state";
import { EmptyState } from "@/components/ui/empty-state";
import { isAudioFile, isImageFile, isPdfFile, isTextFile, isVideoFile } from "@/components/files/file-icons";
import { useFilesSettings } from "@/components/files/files-settings";
import { FilesSidebar, type CreateKind } from "@/components/files/files-sidebar";
import { FilesHeader, type Crumb, type SortDir, type SortKey, type ViewMode } from "@/components/files/files-header";
import { FileGridView, FileListView, type FileItemHandlers } from "@/components/files/file-views";
import { FileDetailsPanel } from "@/components/files/file-details-panel";
import { INTERNAL_DRAG_TYPE, anchorEvent, isInternalDrag, readDraggedNames } from "@/components/files/file-item-parts";
import { ResizeHandle } from "@/components/layout/resize-handle";
import { AppMain } from "@/components/layout/app-landmarks";
import { useIsEmbedded } from "@/hooks/use-is-embedded";
import { getDroppedFilesAndFolders } from "@/lib/webdav/drop-utils";
import { useAppSidePanel } from "@/components/plugins/app-side-panel";
import { MAX_SIDE_PANEL_FILES } from "@/lib/plugin-sandbox/assistant/f.types";
import { resourceToView, useFileStore, isSharedFilesPage, sharedFilePages, type FileResource } from "@/stores/file-store";
import { TRASH_LOCATION, TRASH_PATH, isTrashLocation } from "@/lib/files-trash";
import { PluginActions, usePluginActions } from "@/components/plugins/plugin-actions";
import { toast } from "@/stores/toast-store";
import { ShareCollectionDialog } from "@/components/settings/share-collection-dialog";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { FileNodeRights } from "@/lib/jmap/types";
import type { FileResourceView } from "@/lib/plugin-types";
import { isAppShortcutBlocked, isArrowKeyWidgetTarget } from "@/lib/keyboard";
import { isSingleKeyShortcutOff } from "@/lib/single-key-shortcuts";
import { useDesktopCommands } from "@/lib/desktop/commands";
import { FilesListingSkeleton } from "@/components/boot-skeleton/files-skeleton";

const NO_FORMATS: string[] = [];

interface ClipboardState {
  mode: "cut" | "copy";
  ids: string[];
  names: string[];
  sourceParentId: string | null;
}

export interface AccountFolderEntry {
  accountId: string;
  label: string;
  email: string;
  avatarColor: string;
}

interface FileBrowserProps {
  currentPath: string;
  resources: FileResource[];
  isLoading: boolean;
  error: string | null;
  selectedResources: Set<string>;
  uploadProgress: { name: string; loaded: number; total: number; current: number; totalFiles: number } | null;
  clipboard: ClipboardState | null;
  onNavigate: (path: string, resourceId?: string | null) => void;
  onCreateFolder: (name: string) => Promise<void>;
  onUploadFiles: (files: File[]) => Promise<void>;
  onUploadFolder: (files: File[]) => Promise<void>;
  onCancelUpload: () => void;
  /** Delete: into the trash, or for good when in the trash or a shared drive. */
  onDelete: (name: string) => Promise<void>;
  onBatchDelete: (names: string[]) => Promise<void>;
  /** In the trash: put items back where they came from. */
  onRestore?: (names: string[]) => Promise<void>;
  /** In the trash: delete everything in it for good. */
  onEmptyTrash?: () => void;
  onRename: (oldName: string, newName: string) => Promise<void>;
  onDownload: (name: string) => Promise<void>;
  onBatchDownload: (names: string[]) => Promise<void>;
  /** Download items by id as one zip, e.g. a folder. */
  onDownloadZip?: (ids: string[], zipName: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onToggleSelect: (name: string) => void;
  onClearSelection: () => void;
  onSetSelection: (names: Set<string>) => void;
  onCut: (names: string[]) => void;
  onCopy: (names: string[]) => void;
  onPaste: () => Promise<void>;
  /** Move listed items into a folder by id (null = the root). */
  onMoveTo: (names: string[], targetId: string | null) => Promise<void>;
  /** Move a folder of the tree, which need not be listed, into a folder. */
  onMoveNode?: (id: string, targetId: string | null) => Promise<void>;
  onPreviewImage: (name: string) => void;
  onPreviewFile: (name: string) => void;
  /** WOPI document editing (#425): whether a file can open in the document editor. */
  isOfficeEditable?: (name: string) => boolean;
  onEditFile?: (name: string) => void;
  /** "New file": empty text, or a blank document of a format in `newFileFormats`. */
  onCreateFile: (name: string) => Promise<void>;
  /** Document formats a WOPI editor can create besides .txt (#1393). */
  newFileFormats?: string[];
  onDuplicate: (name: string) => Promise<void>;
  getImageUrl: (name: string) => Promise<string>;
  favorites: string[];
  recentFiles: { name: string; id: string; timestamp: number }[];
  onToggleFavorite: (path: string) => void;
  /** Open a recently used file wherever it now lives. */
  onOpenRecent: (id: string) => void;
  /** Sidebar actions on items that need not be in the open folder. */
  onRenameNode: (id: string, newName: string) => Promise<void>;
  onDeleteNode: (id: string, name: string) => Promise<void>;
  onDownloadNode: (id: string) => Promise<void>;
  /** A device policy turned downloads off (Organisation > Devices): every download action goes. */
  downloadsOff?: boolean;
  onRevealNode: (id: string) => Promise<void>;
  onRemoveRecent: (id: string) => void;
  /** Pro shell only: all connected accounts surfaced as top-level folders at the root. */
  accountFolders?: AccountFolderEntry[];
  onSelectAccount?: (accountId: string) => void;
  /** Pro shell only: when true, the root is a pure account picker - hide the file tools and don't render a regular listing. */
  accountPickerMode?: boolean;
  /** Pro shell only: label of the currently-attached account, shown as a breadcrumb segment after the root. */
  accountLabel?: string | null;
  /** JMAP client for the browsing account, used by the share dialog to list principals. */
  client?: IJMAPClient | null;
  /** Files account id of the browsing account; used to exclude self from the share picker. */
  ownAccountId?: string | null;
  /** True when the server supports JMAP Sharing (principals); gates the Share action. */
  sharingEnabled?: boolean;
  /** Add/update/remove a principal's share on a node. Set null rights to revoke. */
  onShare?: (id: string, principalId: string, rights: FileNodeRights | null) => Promise<void>;
  /** A file with no preview and no editor: shows its icon, size and Download (pim-16). Left out: it downloads. */
  onShowFileInfo?: (name: string) => void;
  /** The desktop app can open this file in its program. */
  canOpenInApp?: (resource: FileResource) => boolean;
  onOpenInApp?: (resource: FileResource) => void;
  /** A principal was given access to a node they couldn't see before. */
  onShared?: (resource: FileResource, principalId: string) => void;
}

function isPreviewable(name: string): boolean {
  return isImageFile(name) || isTextFile(name) || isPdfFile(name) || isAudioFile(name) || isVideoFile(name);
}

type MenuData = { kind: "item"; resource: FileResource } | { kind: "empty" } | { kind: "new" };

const SIDEBAR_DEFAULT_WIDTH = 256;

/** A folder's path ("/Documents/Taxes") from the folder list. */
function pathOfFolder(folders: FileResource[], folder: FileResource): string {
  const names = [folder.name];
  const byId = new Map(folders.map((f) => [f.id, f]));
  for (let cur = folder.parentId ? byId.get(folder.parentId) : undefined; cur && names.length < 64; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    names.unshift(cur.name);
  }
  return "/" + names.join("/");
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

export function FileBrowser({
  currentPath,
  resources,
  isLoading,
  error,
  selectedResources,
  uploadProgress,
  clipboard,
  onNavigate,
  onCreateFolder,
  onUploadFiles,
  onUploadFolder,
  onCancelUpload,
  onDelete,
  onBatchDelete,
  onRestore,
  onEmptyTrash,
  onRename,
  onDownload,
  onBatchDownload,
  onDownloadZip,
  onRefresh,
  onToggleSelect,
  onClearSelection,
  onSetSelection,
  onCut,
  onCopy,
  onPaste,
  onMoveTo,
  onMoveNode,
  onPreviewImage,
  onPreviewFile,
  isOfficeEditable,
  onEditFile,
  onCreateFile,
  newFileFormats = NO_FORMATS,
  onDuplicate,
  getImageUrl,
  favorites,
  recentFiles,
  onToggleFavorite,
  onOpenRecent,
  onRenameNode,
  onDeleteNode,
  onDownloadNode,
  downloadsOff = false,
  onRevealNode,
  onRemoveRecent,
  accountFolders,
  onSelectAccount,
  accountPickerMode,
  accountLabel,
  client,
  ownAccountId,
  sharingEnabled,
  onShare,
  onShowFileInfo,
  canOpenInApp,
  onOpenInApp,
  onShared,
}: FileBrowserProps) {
  const t = useTranslations("files");
  const tMenu = useTranslations("menuAudit");
  const tUx = useTranslations("ux_pim_files");
  // Menu entries that open a dialog end in "…".
  const newFileLabel = newFileFormats.length > 0 ? tMenu("files_new_file") : tMenu("files_new_text_file");
  const fileNameRules = useMemo(() => client?.getFileNameRules?.() ?? null, [client]);
  const validateFileName = useCallback((name: string) => {
    const problem = fileNameProblem(name, fileNameRules);
    if (!problem) return null;
    switch (problem.kind) {
      case "chars": return t("name_forbidden_chars", { chars: problem.chars });
      case "control": return t("name_control_chars");
      case "tooLong": return t("name_too_long");
      case "reserved": return t("name_reserved");
    }
  }, [fileNameRules, t]);

  // ---- Store-derived state ---------------------------------------------------
  const storeClient = useFileStore((s) => s.client);
  const sharedRoots = useFileStore((s) => s.sharedRoots);
  const loadSharedRoots = useFileStore((s) => s.loadSharedRoots);
  const allFolders = useFileStore((s) => s.allFolders);
  const hasListed = useFileStore((s) => s.hasListed);
  const currentParentId = useFileStore((s) => s.currentParentId);
  const pathStack = useFileStore((s) => s.pathStack);
  const trashCount = useFileStore((s) => s.trashCount);
  // The trash lists deleted items: they can be restored, previewed or
  // deleted for good, nothing else.
  const inTrash = isTrashLocation(currentParentId);
  useEffect(() => {
    if (storeClient) void loadSharedRoots();
  }, [storeClient, loadSharedRoots]);

  // ---- Settings --------------------------------------------------------------
  const [settings, updateSettings] = useFilesSettings();
  const [sortKey, setSortKey] = useState<SortKey>(() => settings.defaultSortKey);
  const [sortDir, setSortDir] = useState<SortDir>(() => settings.defaultSortDir);
  // A new default order (Settings > Files, another device) applies at once.
  useEffect(() => {
    setSortKey(settings.defaultSortKey);
    setSortDir(settings.defaultSortDir);
  }, [settings.defaultSortKey, settings.defaultSortDir]);
  const viewMode: ViewMode = settings.defaultViewMode;
  // The toggle and Settings > Files edit the same preference.
  const handleViewModeChange = useCallback((mode: ViewMode) => updateSettings({ defaultViewMode: mode }), [updateSettings]);
  const iconOptions = useMemo(() => ({
    showIcons: settings.showIcons,
    coloredIcons: settings.coloredIcons,
    showThumbnails: settings.showThumbnails,
  }), [settings.showIcons, settings.coloredIcons, settings.showThumbnails]);

  // ---- Layout ----------------------------------------------------------------
  // Below the full desktop the sidebar opens over the page.
  const isFullDesktop = useIsFullDesktop();
  const isNarrow = !isFullDesktop;
  const isMobile = useIsMobile();
  const touch = useMediaQuery("(pointer: coarse)") && isMobile;
  const [narrowSidebarOpen, setNarrowSidebarOpen] = useState(false);
  useEffect(() => { if (!isNarrow) setNarrowSidebarOpen(false); }, [isNarrow]);
  useEffect(() => { setNarrowSidebarOpen(false); }, [currentPath]);
  // Anything picked in the drawer closes it (R7).
  const fromDrawer = <A extends unknown[], R>(action: (...args: A) => R) => (...args: A): R => {
    setNarrowSidebarOpen(false);
    return action(...args);
  };
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = Number(localStorage.getItem("files-sidebar-width"));
      if (saved) return Math.max(180, Math.min(400, saved));
    }
    return SIDEBAR_DEFAULT_WIDTH;
  });
  const [isResizing, setIsResizing] = useState(false);
  const dragStartWidth = useRef(SIDEBAR_DEFAULT_WIDTH);
  const [showDetails, setShowDetails] = useState(() => {
    try { return localStorage.getItem("files-show-details") === "1"; } catch { return false; }
  });
  const toggleDetails = useCallback((open?: boolean) => {
    setShowDetails((v) => {
      const next = open ?? !v;
      try { localStorage.setItem("files-show-details", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // ---- Dialogs and transient UI ---------------------------------------------
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [showNewTextFile, setShowNewTextFile] = useState(false);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameFolder, setRenameFolder] = useState<FileResource | null>(null);
  const [shareTargetId, setShareTargetId] = useState<string | null>(null);
  // "Move to…": listed items by name, or a folder of the tree by id.
  const [moveTarget, setMoveTarget] = useState<{ names: string[] } | { folder: FileResource } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [focusedName, setFocusedName] = useState<string | null>(null);
  // The cursor outline follows a click or the arrow keys, but goes away once
  // the clicked item is deselected; while the keyboard is in use it stays.
  const [keyboardNav, setKeyboardNav] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const dragDepth = useRef(0);
  const anchorName = useRef<string | null>(null);
  const menu = useContextMenu<MenuData>();
  const tOffline = useTranslations("offlineStorage");
  const { keptOffline, canKeepOffline, toggleKeptOffline } = useKeepFileOffline(client);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSearchQuery("");
    setFocusedName(null);
    anchorName.current = null;
    if (scrollAreaRef.current) scrollAreaRef.current.scrollTop = 0;
  }, [currentPath]);

  // ---- Upload progress, shown as a toast like every other notice ----------------
  const uploadToastId = useRef<string | null>(null);
  const cancelUploadRef = useRef(onCancelUpload);
  cancelUploadRef.current = onCancelUpload;
  useEffect(() => {
    if (!uploadProgress) {
      if (uploadToastId.current) toast.dismiss(uploadToastId.current);
      uploadToastId.current = null;
      return;
    }
    const progress = uploadProgress.total > 0 ? uploadProgress.loaded / uploadProgress.total : null;
    const title = uploadProgress.totalFiles > 1
      ? t("uploading_count", { current: uploadProgress.current, total: uploadProgress.totalFiles })
      : t("uploading");
    const message = progress === null ? uploadProgress.name : `${uploadProgress.name} · ${Math.round(progress * 100)}%`;
    if (uploadToastId.current) {
      // Closing the toast only hides it; the upload carries on.
      toast.update(uploadToastId.current, { title, message, progress });
    } else {
      uploadToastId.current = toast.progress(title, {
        message,
        progress,
        action: { label: t("cancel"), onClick: () => cancelUploadRef.current() },
      });
    }
  }, [uploadProgress, t]);
  useEffect(() => () => {
    if (uploadToastId.current) toast.dismiss(uploadToastId.current);
  }, []);

  // ---- Sharing ---------------------------------------------------------------
  // A node is shareable when the server supports JMAP Sharing, the viewer owns
  // it (not a shared-with-me node), and holds the mayShare right (owned nodes
  // report full rights; treat missing myRights as allowed).
  const canShare = useCallback((r: FileResource | null | undefined): boolean =>
    !!(sharingEnabled && onShare && client && r && !r.isShared && !r.isSymlink && (r.myRights?.mayShare ?? true)),
    [sharingEnabled, onShare, client]);
  // Files have content to preview, open, download or duplicate. Folders and
  // symlinks don't: a symlink row only supports rename, move and delete.
  const hasContent = useCallback((name: string): boolean => {
    const r = resources.find((res) => res.name === name);
    return !!r && !r.isDirectory && !r.isSymlink;
  }, [resources]);
  // Looked up by id so the dialog shows the shares as they change. A folder
  // shared from the tree is usually not in the listing, so fall back to it.
  const shareTarget = shareTargetId
    ? resources.find((r) => r.id === shareTargetId) ?? allFolders.find((r) => r.id === shareTargetId) ?? null
    : null;

  // Whether the user may add items to the folder on screen. Nothing can be
  // put on a page listing files shared on their own.
  const currentFolder = currentParentId ? allFolders.find((f) => f.id === currentParentId) : null;
  const canCreate = !accountPickerMode && !isSharedFilesPage(currentParentId) && !inTrash
    && (currentFolder?.myRights?.mayAddChildren ?? true);

  // ---- Listing ---------------------------------------------------------------
  const displayResources = useMemo(() => {
    // In the trash the date column is when an item was deleted.
    let list = inTrash
      ? resources.map((r) => (r.trash?.deletedAt ? { ...r, lastModified: r.trash.deletedAt } : r))
      : resources;
    if (!settings.showHiddenFiles) list = list.filter((r) => !r.name.startsWith("."));
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter((r) => r.name.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => {
      // Folders always first
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      let cmp = 0;
      switch (sortKey) {
        case "name":
          cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
          break;
        case "size":
          cmp = a.contentLength - b.contentLength;
          break;
        case "modified":
          cmp = new Date(a.lastModified || 0).getTime() - new Date(b.lastModified || 0).getTime();
          break;
      }
      if (cmp === 0) cmp = a.name.localeCompare(b.name);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [resources, inTrash, settings.showHiddenFiles, searchQuery, sortKey, sortDir]);

  // Folders other principals shared with the user, listed at the root next to
  // the user's own (#1181).
  const sharedAtRoot = useMemo(() => {
    if (currentPath !== "/" || accountPickerMode) return [];
    const q = searchQuery.toLowerCase();
    return sharedRoots.filter((r) => r.isDirectory && (!q || r.name.toLowerCase().includes(q)));
  }, [currentPath, accountPickerMode, sharedRoots, searchQuery]);
  // Files shared on their own are listed on one page per owner.
  const sharedPagesAtRoot = useMemo(() => {
    if (currentPath !== "/" || accountPickerMode) return [];
    const q = searchQuery.toLowerCase();
    return sharedFilePages(sharedRoots)
      .map((page) => ({ ...page, name: t("shared_files_from", { name: page.ownerName }) }))
      .filter((page) => !q || page.name.toLowerCase().includes(q));
  }, [currentPath, accountPickerMode, sharedRoots, searchQuery, t]);

  const pathOf = useCallback((r: FileResource) => (currentPath === "/" ? `/${r.name}` : `${currentPath}/${r.name}`), [currentPath]);
  const starredPaths = useMemo(() => new Set(favorites), [favorites]);
  const cutNames = useMemo(() => new Set(clipboard?.mode === "cut" ? clipboard.names : []), [clipboard]);
  const selectedList = useMemo(() => displayResources.filter((r) => selectedResources.has(r.name)), [displayResources, selectedResources]);
  const singleSelected = selectedList.length === 1 ? selectedList[0] : null;
  // What plugins see of the selection (file-actions, file-preview-section).
  const selectedViews = useMemo(() => selectedList.map((r) => resourceToView(r, currentPath)), [selectedList, currentPath]);

  // The plugin side panel (app-side-panel), with the selected files and the
  // open folder. It shares its place with the details panel: opening it
  // folds the details, and while the details are open it steps aside here
  // only (the other views keep it as the user left it).
  const sidePanelContext = useMemo(() => ({
    ...(selectedViews.length > 0 ? { files: selectedViews.slice(0, MAX_SIDE_PANEL_FILES), fileCount: selectedViews.length } : {}),
    folder: { id: currentParentId ?? null, path: currentPath },
  }), [selectedViews, currentParentId, currentPath]);
  const sidePanel = useAppSidePanel({ view: "files", context: sidePanelContext, hidden: showDetails, onOpen: () => toggleDetails(false) });
  // Both stored open (the details here, the panel in any view): once the
  // panel shows here the details fold, so the two never sit side by side.
  const sidePanelDocks = sidePanel.docks;
  const sidePanelWanted = sidePanel.wantsOpen;
  const sidePanelSettled = useRef(false);
  useEffect(() => {
    if (sidePanelSettled.current || !sidePanelDocks) return;
    sidePanelSettled.current = true;
    if (showDetails && sidePanelWanted) toggleDetails(false);
  }, [sidePanelDocks, sidePanelWanted, showDetails, toggleDetails]);

  // ---- Breadcrumbs -----------------------------------------------------------
  const crumbs: Crumb[] = useMemo(() => {
    const segments = currentPath.split("/").filter(Boolean);
    // Inside a folder someone shared with the user, the trail starts there.
    const insideShared = !!pathStack[1]?.id?.includes(":");
    const list: Crumb[] = [{ id: null, name: insideShared ? t("shared_with_me") : t("my_files"), path: "/" }];
    if (inTrash) return [...list, { id: TRASH_LOCATION, name: t("trash"), path: TRASH_PATH }];
    segments.forEach((name, i) => {
      list.push({ id: pathStack[i + 1]?.id ?? null, name, path: "/" + segments.slice(0, i + 1).join("/") });
    });
    return list;
  }, [currentPath, pathStack, inTrash, t]);
  const folderName = crumbs[crumbs.length - 1].name;
  const folderNameRef = useRef(folderName);
  folderNameRef.current = folderName;

  const navigateCrumb = useCallback((crumb: Crumb) => {
    if (crumb.path === "/") {
      // Pro shell: the root detaches the account and returns to the picker.
      onNavigate("/");
      return;
    }
    if (crumb.id) onNavigate(crumb.path, crumb.id);
    else onNavigate(crumb.path);
  }, [onNavigate]);

  const navigateUp = useCallback(() => {
    if (crumbs.length < 2) return;
    const parent = crumbs[crumbs.length - 2];
    // Pro shell: going up from a top folder lands on the account's root, not
    // back on the account picker.
    if (parent.path === "/" && accountLabel) onNavigate("/", "__account_root__");
    else if (parent.path === "/") onNavigate("/", null);
    else navigateCrumb(parent);
  }, [crumbs, accountLabel, onNavigate, navigateCrumb]);

  // ---- Opening ---------------------------------------------------------------
  const openResource = useCallback((resource: FileResource) => {
    // A symlink has nothing to open (Stalwart 1.0).
    if (resource.isSymlink) return;
    // A deleted folder is restored before it is opened; a deleted file can be looked at.
    if (resource.trash && (resource.isDirectory || !isPreviewable(resource.name))) return;
    if (resource.isDirectory) {
      onNavigate(pathOf(resource), resource.id);
    } else if (isOfficeEditable?.(resource.name) && onEditFile) {
      onEditFile(resource.name);
    } else if (isImageFile(resource.name)) {
      onPreviewImage(resource.name);
    } else if (isPreviewable(resource.name)) {
      onPreviewFile(resource.name);
    } else if (onShowFileInfo) {
      onShowFileInfo(resource.name);
    } else {
      void onDownload(resource.name);
    }
  }, [onNavigate, pathOf, isOfficeEditable, onEditFile, onPreviewImage, onPreviewFile, onShowFileInfo, onDownload]);

  const previewResource = useCallback((resource: FileResource) => {
    if (isImageFile(resource.name)) onPreviewImage(resource.name);
    else onPreviewFile(resource.name);
  }, [onPreviewImage, onPreviewFile]);

  // Where a deleted item came from, as its row's tooltip in the trash.
  const trashNote = useCallback((r: FileResource): string | undefined => {
    if (!r.trash) return undefined;
    const from = r.trash.fromParentId;
    const folder = from ? allFolders.find((f) => f.id === from) : null;
    const path = from === null ? t("my_files") : folder ? pathOfFolder(allFolders, folder) : null;
    return path ? t("deleted_from", { folder: path }) : undefined;
  }, [allFolders, t]);

  // ---- Selection -------------------------------------------------------------
  const selectRange = useCallback((from: string, to: string, additive: boolean) => {
    const names = displayResources.map((r) => r.name);
    const a = names.indexOf(from);
    const b = names.indexOf(to);
    if (a === -1 || b === -1) return;
    const next = additive ? new Set(selectedResources) : new Set<string>();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(names[i]);
    onSetSelection(next);
  }, [displayResources, selectedResources, onSetSelection]);

  const handleSelectClick = useCallback((resource: FileResource, e: React.MouseEvent) => {
    setFocusedName(resource.name);
    setKeyboardNav(false);
    if (e.shiftKey && anchorName.current) {
      selectRange(anchorName.current, resource.name, e.ctrlKey || e.metaKey);
      return;
    }
    anchorName.current = resource.name;
    if (e.ctrlKey || e.metaKey) {
      onToggleSelect(resource.name);
    } else {
      onSetSelection(new Set([resource.name]));
    }
  }, [selectRange, onToggleSelect, onSetSelection]);

  const handleToggleSelect = useCallback((resource: FileResource) => {
    anchorName.current = resource.name;
    setFocusedName(resource.name);
    setKeyboardNav(false);
    onToggleSelect(resource.name);
  }, [onToggleSelect]);

  const selectAllVisible = useCallback(() => {
    onSetSelection(new Set(displayResources.map((r) => r.name)));
  }, [displayResources, onSetSelection]);

  const allSelected = displayResources.length > 0 && selectedList.length === displayResources.length;
  const someSelected = selectedList.length > 0;

  // ---- Deleting --------------------------------------------------------------
  const deleteNames = useCallback((names: string[]) => {
    if (names.length === 1) void onDelete(names[0]);
    else if (names.length > 1) void onBatchDelete(names);
  }, [onDelete, onBatchDelete]);

  const downloadNames = useCallback((names: string[]) => {
    const items = names.map((n) => resources.find((r) => r.name === n)).filter((r): r is FileResource => !!r && !r.isSymlink);
    // Folders come as one zip, with any files picked next to them.
    if (onDownloadZip && items.some((r) => r.isDirectory)) {
      const zipName = items.length === 1 ? items[0].name : folderNameRef.current;
      void onDownloadZip(items.map((r) => r.id), `${zipName}.zip`);
      return;
    }
    const files = names.filter(hasContent);
    if (files.length === 1) void onDownload(files[0]);
    else if (files.length > 1) void onBatchDownload(files);
  }, [resources, hasContent, onDownload, onBatchDownload, onDownloadZip]);

  // ---- Drag and drop ---------------------------------------------------------
  const moveNames = useCallback((names: string[], targetId: string | null) => {
    void onMoveTo(names, targetId);
  }, [onMoveTo]);

  const itemDragProps = useCallback((resource: FileResource) => ({
    draggable: !touch && !inTrash,
    onDragStart: (e: React.DragEvent) => {
      const names = selectedResources.has(resource.name) ? [...selectedResources] : [resource.name];
      e.dataTransfer.setData(INTERNAL_DRAG_TYPE, JSON.stringify(names));
      e.dataTransfer.effectAllowed = "move";
    },
    onDragOver: (e: React.DragEvent) => {
      if (!resource.isDirectory || !isInternalDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      setDropTarget(resource.name);
    },
    onDragLeave: () => setDropTarget((cur) => (cur === resource.name ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      if (!resource.isDirectory || !isInternalDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(null);
      const names = readDraggedNames(e).filter((n) => n !== resource.name);
      if (names.length > 0) moveNames(names, resource.id);
    },
  }), [touch, inTrash, selectedResources, moveNames]);

  const runUpload = useCallback(async (files: File[], asFolder: boolean) => {
    if (files.length === 0) return;
    if (asFolder) await onUploadFolder(files);
    else await onUploadFiles(files);
  }, [onUploadFiles, onUploadFolder]);

  const handleContentDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files") || !canCreate) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDraggingFiles(true);
  }, [canCreate]);
  const handleContentDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files") || !canCreate) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, [canCreate]);
  const handleContentDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDraggingFiles(false);
  }, []);
  const handleContentDrop = useCallback(async (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files") || !canCreate) return;
    e.preventDefault();
    dragDepth.current = 0;
    setIsDraggingFiles(false);
    const { files, hasDirectories } = await getDroppedFilesAndFolders(e.dataTransfer);
    await runUpload(files, hasDirectories);
  }, [canCreate, runUpload]);

  const handleInputChange = (asFolder: boolean) => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    await runUpload(files, asFolder);
  };

  // ---- Marquee (rubber-band) selection ----------------------------------------
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null);
  const marqueeInfo = useRef<{ initialSelection: Set<string> } | null>(null);

  const handleMarqueeMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0 || touch) return;
    const target = e.target as HTMLElement;
    if (target.closest("[data-resource], button, input, [role=columnheader], a")) return;
    const area = scrollAreaRef.current;
    if (!area) return;
    const rect = area.getBoundingClientRect();
    const x = e.clientX - rect.left + area.scrollLeft;
    const y = e.clientY - rect.top + area.scrollTop;
    const additive = e.ctrlKey || e.metaKey;
    marqueeInfo.current = { initialSelection: additive ? new Set(selectedResources) : new Set() };
    setMarquee({ startX: x, startY: y, currentX: x, currentY: y });
    if (!additive) onClearSelection();
    e.preventDefault();
  }, [touch, selectedResources, onClearSelection]);

  useEffect(() => {
    if (!marquee) return;
    const handleMove = (e: MouseEvent) => {
      const area = scrollAreaRef.current;
      const info = marqueeInfo.current;
      if (!area || !info) return;
      const rect = area.getBoundingClientRect();
      const x = e.clientX - rect.left + area.scrollLeft;
      const y = e.clientY - rect.top + area.scrollTop;
      setMarquee((prev) => (prev ? { ...prev, currentX: x, currentY: y } : null));
      const mx = Math.min(marquee.startX, x);
      const my = Math.min(marquee.startY, y);
      const mw = Math.abs(x - marquee.startX);
      const mh = Math.abs(y - marquee.startY);
      if (mw < 4 && mh < 4) return;
      const next = new Set(info.initialSelection);
      area.querySelectorAll("[data-resource]").forEach((el) => {
        const name = el.getAttribute("data-resource");
        if (!name) return;
        const r = el.getBoundingClientRect();
        const ex = r.left - rect.left + area.scrollLeft;
        const ey = r.top - rect.top + area.scrollTop;
        if (mx < ex + r.width && mx + mw > ex && my < ey + r.height && my + mh > ey) next.add(name);
      });
      onSetSelection(next);
    };
    const handleUp = () => {
      setMarquee(null);
      marqueeInfo.current = null;
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [marquee, onSetSelection]);

  // ---- Keyboard ----------------------------------------------------------------
  const moveFocus = useCallback((delta: number, extend: boolean) => {
    const names = displayResources.map((r) => r.name);
    if (names.length === 0) return;
    const current = focusedName ? names.indexOf(focusedName) : -1;
    const base = current === -1 ? (delta > 0 ? -1 : names.length) : current;
    const nextIndex = Math.max(0, Math.min(names.length - 1, base + delta));
    const name = names[nextIndex];
    setFocusedName(name);
    setKeyboardNav(true);
    if (extend && anchorName.current) {
      selectRange(anchorName.current, name, false);
    } else {
      anchorName.current = name;
      onSetSelection(new Set([name]));
    }
    // Real focus, not just a ring: screen readers follow DOM focus and read
    // the item (WCAG 4.1.2). Each item is a roving tab stop.
    const el = scrollAreaRef.current?.querySelector<HTMLElement>(`[data-resource="${CSS.escape(name)}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView?.({ block: "nearest" });
  }, [displayResources, focusedName, selectRange, onSetSelection]);

  // Columns in the grid's file section, for Up/Down.
  const gridColumns = useCallback((): number => {
    const area = scrollAreaRef.current;
    if (!area || !focusedName) return 1;
    const el = area.querySelector(`[data-resource="${CSS.escape(focusedName)}"]`);
    const row = el?.parentElement;
    if (!row) return 1;
    const tops = Array.from(row.children).map((c) => (c as HTMLElement).offsetTop);
    return Math.max(1, tops.filter((top) => top === tops[0]).length);
  }, [focusedName]);

  // Edit > Search files in the desktop app's menus.
  useDesktopCommands({ "edit.search": () => searchInputRef.current?.focus() }, { "edit.search": !accountPickerMode });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || isAppShortcutBlocked(e)) return;
      if (showNewFolder || showNewTextFile || renameTarget || renameFolder || shareTargetId || moveTarget) return;
      // A preview, editor or confirmation is open on top of the list.
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      if (accountPickerMode) return;
      const mod = e.ctrlKey || e.metaKey;
      const selected = selectedList.map((r) => r.name);

      // "/" as in Mail and Contacts; Ctrl/⌘+F as in a file manager.
      if ((mod && e.key.toLowerCase() === "f") || (e.key === "/" && !mod && !e.altKey && !isSingleKeyShortcutOff(e))) {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAllVisible();
        return;
      }
      if (inTrash && (mod || e.key === "F2") && ["c", "x", "v", "f2"].includes(e.key.toLowerCase())) return;
      if (mod && e.key.toLowerCase() === "c" && selected.length > 0) {
        if (window.getSelection()?.toString()) return;
        e.preventDefault();
        onCopy(selected);
        return;
      }
      if (mod && e.key.toLowerCase() === "x" && selected.length > 0) {
        e.preventDefault();
        onCut(selected);
        return;
      }
      if (mod && e.key.toLowerCase() === "v" && clipboard) {
        e.preventDefault();
        void onPaste();
        return;
      }
      if (e.key === "Escape") {
        // The details panel over the list closes first (innermost layer, R8).
        if (showDetails && isNarrow) toggleDetails(false);
        else if (searchQuery) setSearchQuery("");
        else if (selected.length > 0) onClearSelection();
        return;
      }
      // Backspace deletes too, as in Mail (⌘⌫ on a Mac); Alt+↑ goes up.
      if ((e.key === "Delete" || e.key === "Backspace") && selected.length > 0) {
        e.preventDefault();
        deleteNames(selected);
        return;
      }
      if (e.key === "F2" && singleSelected) {
        e.preventDefault();
        setRenameTarget(singleSelected.name);
        return;
      }
      // Enter opens the selected item, or the one Tab put the focus on.
      const enterTarget = singleSelected
        ?? (selected.length === 0 && focusedName && (e.target as HTMLElement | null)?.dataset?.resource === focusedName
          ? displayResources.find((r) => r.name === focusedName) ?? null
          : null);
      if (e.key === "Enter" && enterTarget) {
        e.preventDefault();
        openResource(enterTarget);
        return;
      }
      if (e.key === " " && focusedName) {
        e.preventDefault();
        onToggleSelect(focusedName);
        return;
      }
      if (e.altKey && e.key === "ArrowUp" && currentPath !== "/") {
        e.preventDefault();
        navigateUp();
        return;
      }
      // A slider, tabs or a menu keeps its own arrows; the files grid itself
      // is the widget these arrows belong to.
      const inOwnList = e.target instanceof Node && !!scrollAreaRef.current?.contains(e.target);
      if (e.key.startsWith("Arrow") && !inOwnList && isArrowKeyWidgetTarget(e)) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = viewMode === "grid" ? gridColumns() : 1;
        moveFocus(e.key === "ArrowDown" ? step : -step, e.shiftKey);
        return;
      }
      if (viewMode === "grid" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.preventDefault();
        const rtl = document.dir === "rtl";
        moveFocus((e.key === "ArrowRight") !== rtl ? 1 : -1, e.shiftKey);
        return;
      }
      if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        moveFocus(e.key === "Home" ? -Infinity : Infinity, e.shiftKey);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    showNewFolder, showNewTextFile, renameTarget, renameFolder, shareTargetId, moveTarget, accountPickerMode, selectedList, singleSelected, inTrash,
    showDetails, isNarrow, toggleDetails,
    selectAllVisible, onCopy, onCut, onPaste, clipboard, searchQuery, onClearSelection, deleteNames, openResource,
    focusedName, onToggleSelect, currentPath, navigateUp, viewMode, gridColumns, moveFocus, displayResources,
  ]);

  // ---- Context menu ----------------------------------------------------------
  const openMenu = menu.openContextMenu;
  const openItemMenu = useCallback((e: React.MouseEvent, resource: FileResource) => {
    // Acting on an item outside the selection makes it the selection, like a
    // desktop file manager.
    if (!selectedResources.has(resource.name)) {
      onSetSelection(new Set([resource.name]));
      anchorName.current = resource.name;
    }
    setFocusedName(resource.name);
    setKeyboardNav(false);
    const target = e.currentTarget as HTMLElement | null;
    // The "..." button opens the menu under itself; a right-click at the pointer.
    if (e.type === "click" && target) openMenu(anchorEvent(target, "end"), { kind: "item", resource });
    else openMenu(e, { kind: "item", resource });
  }, [selectedResources, onSetSelection, openMenu]);

  const closeMenu = menu.closeContextMenu;
  const menuData = menu.contextMenu.data;
  const menuSelection = menuData?.kind === "item" && selectedResources.has(menuData.resource.name) && selectedResources.size > 1
    ? selectedList
    : menuData?.kind === "item" ? [menuData.resource] : [];

  // Items move within the own drive; a shared drive's folders are not in the picker.
  const canMove = !inTrash && !accountPickerMode && !currentParentId?.includes(":");

  const renderItemMenu = (resource: FileResource) => {
    if (inTrash) {
      const names = menuSelection.map((r) => r.name);
      const one = menuSelection.length === 1 ? menuSelection[0] : null;
      return (
        <>
          {onRestore && (
            <ContextMenuItem icon={RotateCcw} label={t("restore")} onClick={() => { closeMenu(); void onRestore(names); }} />
          )}
          {one && !one.isDirectory && !one.isSymlink && isPreviewable(one.name) && (
            <ContextMenuItem icon={Eye} label={t("preview")} onClick={() => { closeMenu(); previewResource(one); }} />
          )}
          {one && !one.isDirectory && !one.isSymlink && !downloadsOff && (
            <ContextMenuItem icon={Download} label={t("download")} onClick={() => { closeMenu(); void onDownload(one.name); }} />
          )}
          <ContextMenuSeparator />
          <ContextMenuItem icon={Trash2} label={t("delete_forever")} destructive onClick={() => { closeMenu(); deleteNames(names); }} />
        </>
      );
    }
    if (menuSelection.length > 1) {
      const names = menuSelection.map((r) => r.name);
      const fileCount = menuSelection.filter((r) => !r.isDirectory && !r.isSymlink).length;
      const withFolders = !!onDownloadZip && menuSelection.some((r) => r.isDirectory);
      return (
        <>
          {(fileCount > 0 || withFolders) && !downloadsOff && (
            <ContextMenuItem
              icon={Download}
              label={withFolders ? t("download_zip") : t("download_count", { count: fileCount })}
              onClick={() => { closeMenu(); downloadNames(names); }}
            />
          )}
          {canMove && (
            <ContextMenuItem icon={FolderInput} label={t("move_to")} onClick={() => { closeMenu(); setMoveTarget({ names }); }} />
          )}
          <ContextMenuItem icon={Scissors} label={t("cut")} shortcut={formatShortcutCombo("Mod + X")} onClick={() => { closeMenu(); onCut(names); }} />
          {menuSelection.some((r) => !r.isSymlink) && (
            <ContextMenuItem icon={Copy} label={t("copy")} shortcut={formatShortcutCombo("Mod + C")} onClick={() => { closeMenu(); onCopy(names); }} />
          )}
          <ContextMenuSeparator />
          <ContextMenuItem icon={Trash2} label={t("delete_count", { count: names.length })} destructive onClick={() => { closeMenu(); deleteNames(names); }} />
          <FilePluginMenuEntries files={menuSelection.map((r) => resourceToView(r, currentPath))} onRan={closeMenu} />
        </>
      );
    }
    const path = pathOf(resource);
    const starred = starredPaths.has(path);
    return (
      <>
        {/* R6 order, the same as the folder tree's menu: Open, Edit, Share,
            Star, Rename, Duplicate, Move to…, Cut, Copy, Download, Details, Delete. */}
        {resource.isDirectory ? (
          <ContextMenuItem icon={FolderOpen} label={t("open")} onClick={() => { closeMenu(); openResource(resource); }} />
        ) : resource.isSymlink ? null : (
          <>
            {isPreviewable(resource.name) && (
              <ContextMenuItem icon={Eye} label={t("preview")} onClick={() => { closeMenu(); previewResource(resource); }} />
            )}
            {isOfficeEditable?.(resource.name) && onEditFile && (
              <ContextMenuItem icon={SquarePen} label={t("office_edit")} onClick={() => { closeMenu(); onEditFile(resource.name); }} />
            )}
            {/* Neither previewed nor edited here: Open shows what there is (pim-16). */}
            {!isPreviewable(resource.name) && !(isOfficeEditable?.(resource.name) && onEditFile) && onShowFileInfo && (
              <ContextMenuItem icon={File} label={t("open")} onClick={() => { closeMenu(); onShowFileInfo(resource.name); }} />
            )}
            {canOpenInApp?.(resource) && onOpenInApp && (
              <ContextMenuItem icon={ExternalLink} label={tUx("open_in_app")} onClick={() => { closeMenu(); onOpenInApp(resource); }} />
            )}
          </>
        )}
        {canKeepOffline(resource) && (
          <ContextMenuItem
            icon={keptOffline.has(resource.id) ? PinOff : Pin}
            label={keptOffline.has(resource.id) ? tOffline("unpin") : tOffline("keep_offline")}
            onClick={() => { closeMenu(); void toggleKeptOffline(resource); }}
          />
        )}
        {(canShare(resource) || (resource.isDirectory && !resource.isShared)) && <ContextMenuSeparator />}
        {canShare(resource) && (
          <ContextMenuItem icon={Share2} label={tMenu("files_share")} onClick={() => { closeMenu(); setShareTargetId(resource.id); }} />
        )}
        {resource.isDirectory && !resource.isShared && (
          <ContextMenuItem
            icon={starred ? StarOff : Star}
            label={starred ? t("unstar") : t("star")}
            onClick={() => { closeMenu(); onToggleFavorite(path); }}
          />
        )}
        <ContextMenuSeparator />
        <ContextMenuItem icon={Pencil} label={t("rename")} shortcut="F2" onClick={() => { closeMenu(); setRenameTarget(resource.name); }} />
        {!resource.isDirectory && !resource.isSymlink && (
          <ContextMenuItem icon={CopyPlus} label={t("duplicate")} onClick={() => { closeMenu(); void onDuplicate(resource.name); }} />
        )}
        {canMove && (
          <ContextMenuItem icon={FolderInput} label={t("move_to")} onClick={() => { closeMenu(); setMoveTarget({ names: [resource.name] }); }} />
        )}
        <ContextMenuItem icon={Scissors} label={t("cut")} shortcut={formatShortcutCombo("Mod + X")} onClick={() => { closeMenu(); onCut([resource.name]); }} />
        {!resource.isSymlink && (
          <ContextMenuItem icon={Copy} label={t("copy")} shortcut={formatShortcutCombo("Mod + C")} onClick={() => { closeMenu(); onCopy([resource.name]); }} />
        )}
        {resource.isDirectory && onDownloadZip && !downloadsOff && (
          <ContextMenuItem icon={Download} label={t("download_zip")} onClick={() => { closeMenu(); downloadNames([resource.name]); }} />
        )}
        {!resource.isDirectory && !resource.isSymlink && !downloadsOff && (
          <ContextMenuItem icon={Download} label={t("download")} onClick={() => { closeMenu(); void onDownload(resource.name); }} />
        )}
        <ContextMenuItem icon={Info} label={t("details")} onClick={() => { closeMenu(); toggleDetails(true); }} />
        <ContextMenuSeparator />
        <ContextMenuItem icon={Trash2} label={t("delete")} shortcut="Del" destructive onClick={() => { closeMenu(); deleteNames([resource.name]); }} />
        <FilePluginMenuEntries
          files={[resourceToView(resource, currentPath)]}
          mimeType={resource.isDirectory ? "" : resource.contentType}
          onRan={closeMenu}
        />
      </>
    );
  };

  const newItems = (
    <>
      <ContextMenuItem icon={Upload} label={tMenu("files_upload_files")} onClick={() => { closeMenu(); fileInputRef.current?.click(); }} />
      <ContextMenuItem icon={FolderUp} label={tMenu("files_upload_folder")} onClick={() => { closeMenu(); folderInputRef.current?.click(); }} />
      <ContextMenuSeparator />
      <ContextMenuItem icon={FolderPlus} label={tMenu("files_new_folder")} onClick={() => { closeMenu(); setShowNewFolder(true); }} />
      <ContextMenuItem icon={FilePlus} label={newFileLabel} onClick={() => { closeMenu(); setShowNewTextFile(true); }} />
    </>
  );

  const handlers: FileItemHandlers = useMemo(() => ({
    onSelectClick: handleSelectClick,
    onToggleSelect: handleToggleSelect,
    onOpen: openResource,
    onContextMenu: openItemMenu,
    onDownload: downloadsOff ? undefined : (r) => void onDownload(r.name),
    onShare: (r) => setShareTargetId(r.id),
    canShare,
    dragProps: itemDragProps,
    // Tab onto an item: the arrows go on from there.
    onFocusItem: (r) => setFocusedName(r.name),
  }), [handleSelectClick, handleToggleSelect, openResource, openItemMenu, onDownload, downloadsOff, canShare, itemDragProps]);

  const handleSort = useCallback((key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  }, [sortKey]);

  // A sidebar entry's "New folder" / "Upload" acts on that folder: open it first.
  const createIn = useCallback((path: string, id: string | null, kind: CreateKind) => {
    if (id !== currentParentId) onNavigate(path, id);
    if (kind === "folder") setShowNewFolder(true);
    else if (kind === "text") setShowNewTextFile(true);
    else if (kind === "files") fileInputRef.current?.click();
    else folderInputRef.current?.click();
  }, [currentParentId, onNavigate]);

  // ---- Command palette ---------------------------------------------------------
  const tSidebar = useTranslations("sidebar");
  const tShell = useTranslations("shell");
  const isEmbedded = useIsEmbedded();
  useRegisterCommands(tSidebar("files"), [
    { id: "upload-files", label: tMenu("files_upload_files"), icon: Upload, run: () => fileInputRef.current?.click(), when: () => canCreate },
    { id: "upload-folder", label: tMenu("files_upload_folder"), icon: FolderUp, run: () => folderInputRef.current?.click(), when: () => canCreate },
    { id: "new-folder", label: tMenu("files_new_folder"), icon: FolderPlus, run: () => setShowNewFolder(true), when: () => canCreate },
    { id: "new-text-file", label: newFileLabel, icon: FilePlus, run: () => setShowNewTextFile(true), when: () => canCreate },
    { id: "trash", label: t("trash"), icon: Trash2, run: () => onNavigate(TRASH_PATH, TRASH_LOCATION), when: () => !inTrash && !accountPickerMode },
    { id: "empty-trash", label: t("empty_trash"), icon: Trash2, run: () => onEmptyTrash?.(), when: () => inTrash && trashCount > 0 && !!onEmptyTrash },
    { id: "refresh", label: t("refresh"), icon: RefreshCw, run: () => void onRefresh() },
  ]);

  // ---- Rendering -------------------------------------------------------------
  const sidebar = !accountPickerMode && (
    <FilesSidebar
      currentParentId={currentParentId}
      currentPath={currentPath}
      allFolders={allFolders}
      sharedRoots={sharedRoots}
      favorites={favorites}
      recentFiles={recentFiles}
      canCreate={canCreate}
      onNavigate={onNavigate}
      onOpenRecent={onOpenRecent}
      onUploadFiles={fromDrawer(() => fileInputRef.current?.click())}
      onUploadFolder={fromDrawer(() => folderInputRef.current?.click())}
      onNewFolder={fromDrawer(() => setShowNewFolder(true))}
      onNewTextFile={fromDrawer(() => setShowNewTextFile(true))}
      newFileLabel={newFileLabel}
      onToggleFavorite={onToggleFavorite}
      onDropItems={moveNames}
      canShare={canShare}
      onShare={fromDrawer((r: FileResource) => setShareTargetId(r.id))}
      onCreateIn={fromDrawer(createIn)}
      onRenameFolder={fromDrawer(setRenameFolder)}
      onDownloadFolder={onDownloadZip && !downloadsOff ? (folder: FileResource) => void onDownloadZip([folder.id], `${folder.name}.zip`) : undefined}
      onMoveFolder={onMoveNode ? fromDrawer((folder: FileResource) => setMoveTarget({ folder })) : undefined}
      onDeleteFolder={fromDrawer((folder: FileResource) => void onDeleteNode(folder.id, folder.name))}
      onRevealRecent={fromDrawer((id: string) => void onRevealNode(id))}
      onDownloadRecent={downloadsOff ? undefined : fromDrawer((id: string) => void onDownloadNode(id))}
      onRemoveRecent={onRemoveRecent}
      trashCount={trashCount}
      onOpenTrash={fromDrawer(() => onNavigate(TRASH_PATH, TRASH_LOCATION))}
      onDropToTrash={(names) => deleteNames(names)}
    />
  );

  const showEmpty = !isLoading && !error && displayResources.length === 0 && sharedAtRoot.length === 0 && sharedPagesAtRoot.length === 0;

  const listing = (() => {
    if (accountPickerMode) {
      return accountFolders && accountFolders.length > 0 && onSelectAccount ? (
        <div className="p-4">
          <h2 className="text-xs font-medium text-muted-foreground mb-2 px-0.5">{t("choose_account")}</h2>
          <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(14rem,1fr))]">
            {accountFolders.map((acc) => (
              <button
                key={`__account__:${acc.accountId}`}
                onClick={() => onSelectAccount(acc.accountId)}
                title={acc.email}
                className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/60 transition-colors text-start min-w-0"
              >
                <Avatar name={acc.label} email={acc.email} size="md" fallbackColor={acc.avatarColor} className="shrink-0" />
                <div className="min-w-0 flex flex-col">
                  <span className="truncate text-sm font-medium">{acc.label || acc.email}</span>
                  {acc.label && acc.label !== acc.email && (
                    <span className="truncate text-xs text-muted-foreground">{acc.email}</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-center h-full">
          <p className="text-sm text-muted-foreground">{t("no_accounts")}</p>
        </div>
      );
    }
    // Until the first listing is in, an empty list means "not loaded yet".
    if ((isLoading || !hasListed) && resources.length === 0) return <FilesListingSkeleton view={viewMode} />;
    if (showEmpty && searchQuery) return <NoSearchResults query={searchQuery} onClear={() => setSearchQuery("")} />;
    if (showEmpty && inTrash) {
      return <EmptyState icon={Trash2} title={t("trash_empty_title")} description={t("trash_empty_hint")} />;
    }
    if (showEmpty) {
      return (
        <EmptyFolder
          isRoot={currentPath === "/"}
          canCreate={canCreate}
          onUpload={() => fileInputRef.current?.click()}
          onCreateFolder={() => setShowNewFolder(true)}
        />
      );
    }
    const viewProps = {
      resources: displayResources,
      selected: selectedResources,
      focusedName: focusedName && (keyboardNav || selectedResources.has(focusedName)) ? focusedName : null,
      // The one item Tab lands on: the last one moved to, else the first.
      tabStopName: focusedName && displayResources.some((r) => r.name === focusedName)
        ? focusedName
        : displayResources[0]?.name ?? null,
      dropTarget,
      cutNames,
      starredPaths,
      pathOf,
      touch,
      iconOptions,
      getImageUrl,
      handlers,
      itemNote: inTrash ? trashNote : undefined,
    };
    return (
      <>
        {displayResources.length > 0 && (viewMode === "grid" ? (
          <FileGridView {...viewProps} />
        ) : (
          <FileListView
            {...viewProps}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            allSelected={allSelected}
            someSelected={someSelected}
            onToggleAll={() => (allSelected ? onClearSelection() : selectAllVisible())}
            dateLabel={inTrash ? t("deleted") : undefined}
          />
        ))}
        {(sharedAtRoot.length > 0 || sharedPagesAtRoot.length > 0) && (
          <SharedWithMe
            folders={sharedAtRoot}
            pages={sharedPagesAtRoot}
            onOpen={(r) => onNavigate(`/${r.name}`, r.id)}
            iconOptions={iconOptions}
          />
        )}
      </>
    );
  })();

  const detailsPanel = showDetails && !accountPickerMode && (
    <FileDetailsPanel
      resource={singleSelected}
      selection={selectedList}
      folderName={folderName}
      folderItems={displayResources}
      path={singleSelected ? pathOf(singleSelected) : currentPath}
      isStarred={singleSelected ? starredPaths.has(pathOf(singleSelected)) : false}
      canShare={canShare(singleSelected)}
      canPreview={!!singleSelected && !singleSelected.isSymlink && isPreviewable(singleSelected.name)}
      canEdit={!!singleSelected && !singleSelected.isSymlink && !!onEditFile && !!isOfficeEditable?.(singleSelected.name)}
      pluginFile={singleSelected ? selectedViews[0] : null}
      iconOptions={iconOptions}
      getImageUrl={getImageUrl}
      onClose={() => toggleDetails(false)}
      onOpen={() => singleSelected && (singleSelected.isDirectory ? openResource(singleSelected) : previewResource(singleSelected))}
      onEdit={() => singleSelected && onEditFile?.(singleSelected.name)}
      onDownload={downloadsOff ? undefined : () => singleSelected && void onDownload(singleSelected.name)}
      onShare={() => singleSelected && setShareTargetId(singleSelected.id)}
      onToggleStar={() => singleSelected && onToggleFavorite(pathOf(singleSelected))}
      className={cn(
        "flex-shrink-0",
        isNarrow ? "absolute inset-y-0 end-0 z-30 w-80 max-w-[85%] shadow-xl" : "w-72",
      )}
    />
  );

  const selectionActions = selectedList.length > 0 && inTrash ? {
    count: selectedList.length,
    fileCount: 0,
    canOpen: false,
    canRename: false,
    canShare: false,
    trash: true,
    onRestore: onRestore ? () => void onRestore(selectedList.map((r) => r.name)) : undefined,
    onOpen: () => {},
    onDownload: () => {},
    onShare: () => {},
    onRename: () => {},
    onCut: () => {},
    onCopy: () => {},
    onDelete: () => deleteNames(selectedList.map((r) => r.name)),
    onClear: onClearSelection,
    pluginFiles: [],
  } : selectedList.length > 0 ? {
    count: selectedList.length,
    // Folders download as a zip. None with downloads turned off: no Download button.
    fileCount: downloadsOff ? 0 : selectedList.filter((r) => !r.isSymlink && (!r.isDirectory || !!onDownloadZip)).length,
    canOpen: !!singleSelected && !singleSelected.isSymlink
      && (singleSelected.isDirectory || isPreviewable(singleSelected.name) || !!isOfficeEditable?.(singleSelected.name)),
    canRename: !!singleSelected,
    canShare: !!singleSelected && canShare(singleSelected),
    onOpen: () => singleSelected && openResource(singleSelected),
    onDownload: () => downloadNames(selectedList.map((r) => r.name)),
    onShare: () => singleSelected && setShareTargetId(singleSelected.id),
    onRename: () => singleSelected && setRenameTarget(singleSelected.name),
    onMoveTo: canMove ? () => setMoveTarget({ names: selectedList.map((r) => r.name) }) : undefined,
    onCut: () => onCut(selectedList.map((r) => r.name)),
    onCopy: () => onCopy(selectedList.map((r) => r.name)),
    onDelete: () => deleteNames(selectedList.map((r) => r.name)),
    onClear: onClearSelection,
    pluginFiles: selectedViews,
    pluginMimeType: singleSelected ? (singleSelected.isDirectory ? "" : singleSelected.contentType) : undefined,
  } : null;

  return (
    // Clips the closed drawer, so it never sits over the nav rail.
    <div className="relative flex flex-1 min-h-0 overflow-hidden">
      {/* Folder sidebar: in flow on desktop, a drawer on narrow panes */}
      {sidebar && isNarrow && narrowSidebarOpen && (
        <div className="absolute inset-0 bg-black/50 z-40" onClick={() => setNarrowSidebarOpen(false)} />
      )}
      {sidebar && (isNarrow ? (
        <div
          data-testid="files-sidebar-drawer"
          data-pane="sidebar"
          className={cn(
            "absolute inset-y-0 start-0 z-50 w-72 border-e border-border",
            "transform transition-[transform,visibility] duration-300 ease-in-out",
            !narrowSidebarOpen && "invisible -translate-x-full rtl:translate-x-full",
          )}
          // Closed, the drawer is out of reach: no clicks, no Tab stops.
          inert={!narrowSidebarOpen}
        >
          {sidebar}
        </div>
      ) : (
        <>
          <div
            data-pane="sidebar"
            className={cn("border-e border-border flex-shrink-0", !isResizing && "transition-[width] duration-300")}
            style={{ width: `${sidebarWidth}px` }}
          >
            {sidebar}
          </div>
          <ResizeHandle
            pane="sidebar"
            value={sidebarWidth}
            min={180}
            max={400}
            onResizeStart={() => { dragStartWidth.current = sidebarWidth; setIsResizing(true); }}
            onResize={(delta) => setSidebarWidth(Math.max(180, Math.min(400, dragStartWidth.current + delta)))}
            onResizeEnd={() => {
              setIsResizing(false);
              localStorage.setItem("files-sidebar-width", String(sidebarWidth));
            }}
            onDoubleClick={() => { setSidebarWidth(SIDEBAR_DEFAULT_WIDTH); localStorage.setItem("files-sidebar-width", String(SIDEBAR_DEFAULT_WIDTH)); }}
          />
        </>
      ))}

      <AppMain
        embedded={isEmbedded}
        heading={tShell("heading", { place: folderName, app: tSidebar("files") })}
        className="flex flex-col flex-1 min-w-0"
      >
        <FilesHeader
          crumbs={crumbs}
          accountLabel={accountLabel}
          onNavigateCrumb={navigateCrumb}
          onNavigateAccountRoot={() => onNavigate("/", "__account_root__")}
          onDropOnCrumb={moveNames}
          onMenuClick={isNarrow && sidebar ? () => setNarrowSidebarOpen((v) => !v) : undefined}
          menuOpen={narrowSidebarOpen}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          searchInputRef={searchInputRef}
          sortKey={sortKey}
          sortDir={sortDir}
          onSortChange={(key, dir) => { setSortKey(key); setSortDir(dir); }}
          viewMode={viewMode}
          onViewModeChange={handleViewModeChange}
          showDetails={showDetails}
          onToggleDetails={() => toggleDetails()}
          clipboardCount={clipboard?.names.length ?? 0}
          onPaste={() => void onPaste()}
          onRefresh={() => void onRefresh()}
          isLoading={isLoading}
          compact={isMobile}
          toolsHidden={accountPickerMode}
          selection={selectionActions}
          emptyTrash={inTrash && onEmptyTrash ? { onEmpty: onEmptyTrash, disabled: trashCount === 0 } : undefined}
          panelToggle={sidePanel.toggle}
        />

        {error && (
          <div role="alert" className="mx-4 mt-3 px-3 py-2 rounded-md bg-destructive/10 text-destructive text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="flex-1">{error}</span>
            <Button variant="ghost" size="xs" className="text-destructive hover:text-destructive shrink-0" onClick={() => void onRefresh()}>
              <RefreshCw className="w-3.5 h-3.5 me-1" />
              {t("retry")}
            </Button>
          </div>
        )}

        <div ref={sidePanel.rowRef} className="relative flex flex-1 min-h-0">
          <div
            ref={scrollAreaRef}
            className="relative flex-1 min-w-0 overflow-y-auto max-md:pb-20"
            onMouseDown={handleMarqueeMouseDown}
            onContextMenu={(e) => {
              if (accountPickerMode || (e.target as HTMLElement).closest("[data-resource]")) return;
              menu.openContextMenu(e, { kind: "empty" });
            }}
            onClick={(e) => {
              // With a mouse, pressing on empty space already cleared the
              // selection, and the click that ends a drag-select lands here
              // too: clearing again would drop what was just selected.
              if (touch && e.target === e.currentTarget && selectedResources.size > 0) onClearSelection();
            }}
            onDragEnter={handleContentDragEnter}
            onDragOver={handleContentDragOver}
            onDragLeave={handleContentDragLeave}
            onDrop={handleContentDrop}
          >
            {listing}

            {marquee && (
              <div
                className="absolute border border-primary/50 bg-primary/10 pointer-events-none z-20 rounded-sm"
                style={{
                  left: Math.min(marquee.startX, marquee.currentX),
                  top: Math.min(marquee.startY, marquee.currentY),
                  width: Math.abs(marquee.currentX - marquee.startX),
                  height: Math.abs(marquee.currentY - marquee.startY),
                }}
              />
            )}
          </div>

          {isDraggingFiles && (
            <div className="absolute inset-2 z-30 rounded-xl border-2 border-dashed border-primary bg-primary/5 flex items-center justify-center pointer-events-none">
              <div className="text-center bg-background/90 rounded-lg px-5 py-4 shadow-sm">
                <Upload className="w-8 h-8 text-primary mx-auto mb-2" />
                <p className="text-sm font-medium">{t("drop_to_upload", { folder: folderName })}</p>
              </div>
            </div>
          )}

          {/* Over the list on a narrow pane: a backdrop that closes it, as for the drawer. */}
          {detailsPanel && isNarrow && (
            <div className="absolute inset-0 z-20 bg-black/30" aria-hidden onClick={() => toggleDetails(false)} />
          )}
          {detailsPanel}

          {isNarrow && canCreate && !selectionActions && (
            <Button
              size="icon-lg"
              className="absolute bottom-4 end-4 z-20 rounded-full shadow-lg"
              aria-label={t("new")}
              onClick={(e) => menu.openContextMenu(anchorEvent(e.currentTarget, "end"), { kind: "new" })}
            >
              <Plus className="w-5 h-5" />
            </Button>
          )}

          {sidePanel.panel}
        </div>
      </AppMain>

      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleInputChange(false)} />
      <input
        ref={folderInputRef}
        type="file"
        className="hidden"
        onChange={handleInputChange(true)}
        {...({ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
      />

      <ContextMenu ref={menu.menuRef} isOpen={menu.contextMenu.isOpen} position={menu.contextMenu.position} onClose={closeMenu}>
        {menuData?.kind === "item" && renderItemMenu(menuData.resource)}
        {menuData?.kind === "new" && newItems}
        {menuData?.kind === "empty" && (
          <>
            {canCreate && newItems}
            {clipboard && canCreate && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem icon={Clipboard} label={t("paste")} shortcut={formatShortcutCombo("Mod + V")} onClick={() => { closeMenu(); void onPaste(); }} />
              </>
            )}
            <ContextMenuSeparator />
            {displayResources.length > 0 && (
              <ContextMenuItem icon={CheckSquare} label={t("select_all")} shortcut={formatShortcutCombo("Mod + A")} onClick={() => { closeMenu(); selectAllVisible(); }} />
            )}
            <ContextMenuItem icon={RefreshCw} label={t("refresh")} onClick={() => { closeMenu(); void onRefresh(); }} />
          </>
        )}
      </ContextMenu>

      <PromptDialog
        isOpen={showNewFolder}
        onClose={() => setShowNewFolder(false)}
        title={t("new_folder")}
        placeholder={t("new_folder_name")}
        confirmText={t("create")}
        cancelText={t("cancel")}
        validate={validateFileName}
        onSubmit={(name) => void onCreateFolder(name)}
      />

      <NewFileDialog
        isOpen={showNewTextFile}
        onClose={() => setShowNewTextFile(false)}
        formats={newFileFormats}
        validate={validateFileName}
        onSubmit={(name) => void onCreateFile(name)}
      />

      <PromptDialog
        isOpen={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title={t("rename_title")}
        placeholder={t("new_name")}
        defaultValue={renameTarget ?? ""}
        // A file keeps its extension unless the user means to change it.
        selectBaseName={!resources.find((r) => r.name === renameTarget)?.isDirectory}
        confirmText={t("save")}
        cancelText={t("cancel")}
        validate={validateFileName}
        onSubmit={(newName) => {
          if (renameTarget !== null && newName !== renameTarget) void onRename(renameTarget, newName);
        }}
      />

      <PromptDialog
        isOpen={renameFolder !== null}
        onClose={() => setRenameFolder(null)}
        title={t("rename_title")}
        placeholder={t("new_name")}
        defaultValue={renameFolder?.name ?? ""}
        confirmText={t("save")}
        cancelText={t("cancel")}
        validate={validateFileName}
        onSubmit={(newName) => {
          if (renameFolder && newName !== renameFolder.name) void onRenameNode(renameFolder.id, newName);
        }}
      />

      <FolderPickerDialog
        isOpen={moveTarget !== null}
        onClose={() => setMoveTarget(null)}
        title={t("move_to_title")}
        confirmText={t("move_here")}
        folders={allFolders.filter((f) => !f.isShared && !f.id.includes(":"))}
        excludeIds={new Set(moveTarget && "folder" in moveTarget
          ? [moveTarget.folder.id]
          : (moveTarget?.names ?? []).map((n) => resources.find((r) => r.name === n)).filter((r) => r?.isDirectory).map((r) => r!.id))}
        currentId={moveTarget && "folder" in moveTarget ? moveTarget.folder.parentId ?? null : currentParentId}
        onPick={(targetId) => {
          if (!moveTarget) return;
          if ("folder" in moveTarget) void onMoveNode?.(moveTarget.folder.id, targetId);
          else void onMoveTo(moveTarget.names, targetId);
        }}
      />

      {shareTarget && client && onShare && (
        <ShareCollectionDialog
          client={client}
          kind="file"
          collectionName={shareTarget.name}
          shareWith={shareTarget.shareWith}
          ownAccountId={ownAccountId || ""}
          onShare={async (principalId, rights) => {
            const added = !!rights && !shareTarget.shareWith?.[principalId];
            await onShare(shareTarget.id, principalId, rights as FileNodeRights | null);
            // Someone new can see it now: offer to tell them (pim-26).
            if (added) onShared?.(shareTarget, principalId);
          }}
          onClose={() => setShareTargetId(null)}
        />
      )}
    </div>
  );
}

function SharedWithMe({ folders, pages, onOpen, iconOptions }: {
  folders: FileResource[];
  /** Pages of files shared on their own, one per owner. */
  pages: { id: string; name: string; ownerName: string }[];
  onOpen: (r: { id: string; name: string }) => void;
  iconOptions: { showIcons: boolean; coloredIcons: boolean };
}) {
  const t = useTranslations("files");
  return (
    <section aria-label={t("shared_with_me")} className="px-4 pt-5 pb-4">
      <h2 className="text-xs font-medium text-muted-foreground mb-2 px-0.5 flex items-center gap-1.5">
        <Share2 className="w-3 h-3" />
        {t("shared_with_me")}
      </h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2">
        {folders.map((folder) => (
          <button
            key={folder.id}
            type="button"
            onClick={() => onOpen(folder)}
            title={folder.ownerName ? t("shared_by", { name: folder.ownerName }) : folder.name}
            className="flex items-center gap-2.5 h-12 px-3 rounded-lg border border-border hover:bg-muted/60 transition-colors text-start min-w-0"
          >
            {iconOptions.showIcons && <FolderOpen className={cn("w-5 h-5 shrink-0", iconOptions.coloredIcons ? "text-primary" : "text-muted-foreground")} />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{folder.name}</span>
              {folder.ownerName && <span className="block truncate text-xs text-muted-foreground">{folder.ownerName}</span>}
            </span>
          </button>
        ))}
        {pages.map((page) => (
          <button
            key={page.id}
            type="button"
            onClick={() => onOpen(page)}
            title={t("shared_by", { name: page.ownerName })}
            className="flex items-center gap-2.5 h-12 px-3 rounded-lg border border-border hover:bg-muted/60 transition-colors text-start min-w-0"
          >
            {iconOptions.showIcons && <File className={cn("w-5 h-5 shrink-0", iconOptions.coloredIcons ? "text-primary" : "text-muted-foreground")} />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{page.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{page.ownerName}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** Plugin entries at the end of a file's menu, after a separator when there are any. */
function FilePluginMenuEntries({ files, mimeType, onRan }: { files: FileResourceView[]; mimeType?: string; onRan: () => void }) {
  const hasActions = usePluginActions("file-actions", { mimeType }).length > 0;
  if (!hasActions) return null;
  return (
    <>
      <ContextMenuSeparator />
      <PluginActions surface="file-actions" variant="menu" context={{ files }} mimeType={mimeType} onRan={onRan} />
    </>
  );
}
