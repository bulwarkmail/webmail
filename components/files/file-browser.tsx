"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
import {
  Upload, FolderPlus, Download, Trash2, Pencil, Copy, Clipboard, Scissors, Info,
  FilePlus, CopyPlus, AlertCircle, FolderUp, Share2, SquarePen, Eye, FolderOpen,
  RefreshCw, Star, StarOff, Plus, CheckSquare, NotebookPen, Link as LinkIcon, LayoutGrid,
} from "@/components/icons";
import { useIsDesktop, useIsMobile, useMediaQuery } from "@/hooks/use-media-query";
import { useContextMenu } from "@/hooks/use-context-menu";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { NewFolderDialog } from "@/components/files/new-folder-dialog";
import { RenameDialog } from "@/components/files/rename-dialog";
import { fileNameProblem } from "@/lib/file-name-rules";
import { EmptyFolder, NoSearchResults } from "@/components/files/file-empty-state";
import { getFileIconByName, isAudioFile, isImageFile, isPdfFile, isTextFile, isVideoFile } from "@/components/files/file-icons";
import { loadFilesSettings, saveFilesSettings, type FilesSettings } from "@/components/files/files-settings";
import { FilesSidebar, type CreateKind } from "@/components/files/files-sidebar";
import { FilesHeader, type Crumb, type SortDir, type SortKey, type ViewMode } from "@/components/files/files-header";
import { FileGridView, FileListView, type FileItemHandlers } from "@/components/files/file-views";
import { FileDetailsPanel } from "@/components/files/file-details-panel";
import { INTERNAL_DRAG_TYPE, anchorEvent, isInternalDrag, readDraggedNames } from "@/components/files/file-item-parts";
import { ResizeHandle } from "@/components/layout/resize-handle";
import { getDroppedFilesAndFolders } from "@/lib/webdav/drop-utils";
import { resourceToView, useFileStore, type FileResource } from "@/stores/file-store";
import { PluginActions, usePluginActions } from "@/components/plugins/plugin-actions";
import { toast } from "@/stores/toast-store";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";
import { useSettingsStore } from "@/stores/settings-store";
import { useSplitResize } from "@/components/xenaxio/use-split-resize";
import { SPLIT_DEFAULT, splitStyle } from "@/lib/xenaxio/split";
import { ShareCollectionDialog } from "@/components/settings/share-collection-dialog";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { FileNodeRights } from "@/lib/jmap/types";
import type { FileResourceView } from "@/lib/plugin-types";
import { useXT } from "@/lib/xenaxio/i18n";
import { useCopyFileLink } from "@/components/xenaxio/use-copy-file-link";
import { useAddFileToProject } from "@/components/xenaxio/projects/add-to-project";
import { defaultNoteName } from "@/lib/xenaxio/notes";

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
  onDelete: (name: string) => Promise<void>;
  onBatchDelete: (names: string[]) => Promise<void>;
  onRename: (oldName: string, newName: string) => Promise<void>;
  onDownload: (name: string) => Promise<void>;
  onBatchDownload: (names: string[]) => Promise<void>;
  onRefresh: () => Promise<void>;
  onToggleSelect: (name: string) => void;
  onClearSelection: () => void;
  onSetSelection: (names: Set<string>) => void;
  onCut: (names: string[]) => void;
  onCopy: (names: string[]) => void;
  onPaste: () => Promise<void>;
  /** Move listed items into a folder by id (null = the root). */
  onMoveTo: (names: string[], targetId: string | null) => Promise<void>;
  onPreviewImage: (name: string) => void;
  onPreviewFile: (name: string) => void;
  /** WOPI document editing (#425): whether a file can open in the document editor. */
  isOfficeEditable?: (name: string) => boolean;
  onEditFile?: (name: string) => void;
  onCreateTextFile: (name: string) => Promise<void>;
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
  /** xenaxio step 116: opens a file a colleague shared on its own (listed under "Shared with me"). */
  onOpenSharedFile?: (resource: FileResource) => void;
}

function isPreviewable(name: string): boolean {
  return isImageFile(name) || isTextFile(name) || isPdfFile(name) || isAudioFile(name) || isVideoFile(name);
}

type MenuData = { kind: "item"; resource: FileResource } | { kind: "empty" } | { kind: "new" };

const SIDEBAR_DEFAULT_WIDTH = 256;
const clampSidebarWidth = (width: number) => Math.max(180, Math.min(400, Math.round(width)));

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
  onRename,
  onDownload,
  onBatchDownload,
  onRefresh,
  onToggleSelect,
  onClearSelection,
  onSetSelection,
  onCut,
  onCopy,
  onPaste,
  onMoveTo,
  onPreviewImage,
  onPreviewFile,
  isOfficeEditable,
  onEditFile,
  onCreateTextFile,
  onDuplicate,
  getImageUrl,
  favorites,
  recentFiles,
  onToggleFavorite,
  onOpenRecent,
  onRenameNode,
  onDeleteNode,
  onDownloadNode,
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
  onOpenSharedFile,
}: FileBrowserProps) {
  const t = useTranslations("files");
  const xt = useXT();
  const copyFileLink = useCopyFileLink();
  // xenaxio step 118: "Zu Projekt hinzufügen".
  const [addToProject, addToProjectDialog] = useAddFileToProject();
  const fileNameRules = useMemo(() => client?.getFileNameRules?.() ?? null, [client]);
  const validateFileName = useCallback((name: string) => {
    const problem = fileNameProblem(name, fileNameRules);
    if (!problem) return null;
    return problem.kind === "chars" ? t("name_forbidden_chars", { chars: problem.chars }) : t("name_reserved");
  }, [fileNameRules, t]);

  // ---- Store-derived state ---------------------------------------------------
  const storeClient = useFileStore((s) => s.client);
  const sharedRoots = useFileStore((s) => s.sharedRoots);
  const loadSharedRoots = useFileStore((s) => s.loadSharedRoots);
  const allFolders = useFileStore((s) => s.allFolders);
  const hasListed = useFileStore((s) => s.hasListed);
  const currentParentId = useFileStore((s) => s.currentParentId);
  const pathStack = useFileStore((s) => s.pathStack);
  useEffect(() => {
    if (storeClient) void loadSharedRoots();
  }, [storeClient, loadSharedRoots]);

  // ---- Settings --------------------------------------------------------------
  const [settings, setSettings] = useState<FilesSettings>(loadFilesSettings);
  const [sortKey, setSortKey] = useState<SortKey>(() => settings.defaultSortKey);
  const [sortDir, setSortDir] = useState<SortDir>(() => settings.defaultSortDir);
  useEffect(() => {
    const reload = () => {
      const next = loadFilesSettings();
      setSettings(next);
      setSortKey(next.defaultSortKey);
      setSortDir(next.defaultSortDir);
    };
    const handleStorage = (e: StorageEvent) => { if (e.key === "files-settings") reload(); };
    // StorageEvent fires cross-tab, the custom event same-tab
    window.addEventListener("storage", handleStorage);
    window.addEventListener("files-settings-changed", reload);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("files-settings-changed", reload);
    };
  }, []);
  const viewMode: ViewMode = settings.defaultViewMode;
  const handleViewModeChange = useCallback((mode: ViewMode) => {
    // The toggle and Settings > Files edit the same preference.
    const next = { ...loadFilesSettings(), defaultViewMode: mode };
    setSettings(next);
    saveFilesSettings(next);
  }, []);
  const iconOptions = useMemo(() => ({
    showIcons: settings.showIcons,
    coloredIcons: settings.coloredIcons,
    showThumbnails: settings.showThumbnails,
  }), [settings.showIcons, settings.coloredIcons, settings.showThumbnails]);

  // ---- Layout ----------------------------------------------------------------
  const isDesktop = useIsDesktop();
  const isNarrow = !isDesktop;
  const isMobile = useIsMobile();
  const touch = useMediaQuery("(pointer: coarse)") && isMobile;
  const [narrowSidebarOpen, setNarrowSidebarOpen] = useState(false);
  useEffect(() => { if (!isNarrow) setNarrowSidebarOpen(false); }, [isNarrow]);
  useEffect(() => { setNarrowSidebarOpen(false); }, [currentPath]);
  // xenaxio (step 114): the folder column's width lives in the settings (on the server);
  // a width this browser kept before is used until the first drag saves one.
  const savedSidebarWidth = useSettingsStore((s) => s.filesSidebarWidth);
  const sidebarWidthOf = (saved: number | null) => {
    if (saved !== null) return clampSidebarWidth(saved);
    if (typeof window !== "undefined") {
      const legacy = Number(localStorage.getItem("files-sidebar-width"));
      if (legacy) return clampSidebarWidth(legacy);
    }
    return SIDEBAR_DEFAULT_WIDTH;
  };
  const [sidebarWidth, setSidebarWidth] = useState(() => sidebarWidthOf(savedSidebarWidth));
  const [isResizing, setIsResizing] = useState(false);
  const dragStartWidth = useRef(sidebarWidth);
  const liveSidebarWidth = useRef(sidebarWidth);
  liveSidebarWidth.current = sidebarWidth;
  // A width saved on another device arrives with the settings.
  useEffect(() => {
    if (isResizing) return;
    const width = sidebarWidthOf(savedSidebarWidth);
    dragStartWidth.current = width;
    setSidebarWidth(width);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the saved width changes
  }, [savedSidebarWidth]);
  const saveSidebarWidth = (width: number | null) => {
    useSettingsStore.getState().updateSetting("filesSidebarWidth", width);
    try { localStorage.removeItem("files-sidebar-width"); } catch { /* ignore */ }
  };
  const [showDetails, setShowDetails] = useState(() => {
    try { return localStorage.getItem("files-show-details") === "1"; } catch { return false; }
  });
  // xenaxio (step 114): the Details panel's width is changed with a divider and kept in the settings (on the server).
  const detailsAreaRef = useRef<HTMLDivElement>(null);
  const filesDetailsWidth = useSettingsStore((s) => s.filesDetailsWidth);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const detailsSplit = useSplitResize({
    areaRef: detailsAreaRef,
    saved: filesDetailsWidth ?? SPLIT_DEFAULT,
    onSave: (value) => updateSetting("filesDetailsWidth", value === null ? null : Math.round(value)),
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
  // Xenaxio step 115: the same dialog makes a note ("Notiz 2026-11-01.md").
  const [newTextName, setNewTextName] = useState("new-file.txt");
  const newTextFile = useCallback(() => { setNewTextName("new-file.txt"); setShowNewTextFile(true); }, []);
  const newNote = useCallback(() => { setNewTextName(defaultNoteName(xt("notes.default_name"))); setShowNewTextFile(true); }, [xt]);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameFolder, setRenameFolder] = useState<FileResource | null>(null);
  const [shareTargetId, setShareTargetId] = useState<string | null>(null);
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
    !!(sharingEnabled && onShare && client && r && !r.isShared && (r.myRights?.mayShare ?? true)),
    [sharingEnabled, onShare, client]);
  // Looked up by id so the dialog shows the shares as they change. A folder
  // shared from the tree is usually not in the listing, so fall back to it.
  const shareTarget = shareTargetId
    ? resources.find((r) => r.id === shareTargetId) ?? allFolders.find((r) => r.id === shareTargetId) ?? null
    : null;

  // Whether the user may add items to the folder on screen.
  const currentFolder = currentParentId ? allFolders.find((f) => f.id === currentParentId) : null;
  const canCreate = !accountPickerMode && (currentFolder?.myRights?.mayAddChildren ?? true);

  // ---- Listing ---------------------------------------------------------------
  const displayResources = useMemo(() => {
    let list = resources;
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
  }, [resources, settings.showHiddenFiles, searchQuery, sortKey, sortDir]);

  // Folders other principals shared with the user, listed at the root next to
  // the user's own (#1181).
  const sharedAtRoot = useMemo(() => {
    if (currentPath !== "/" || accountPickerMode) return [];
    const q = searchQuery.toLowerCase();
    // xenaxio step 116: files shared on their own are listed too, when they can be opened here.
    return sharedRoots.filter((r) => (r.isDirectory || !!onOpenSharedFile) && (!q || r.name.toLowerCase().includes(q)));
  }, [currentPath, accountPickerMode, sharedRoots, searchQuery, onOpenSharedFile]);

  const pathOf = useCallback((r: FileResource) => (currentPath === "/" ? `/${r.name}` : `${currentPath}/${r.name}`), [currentPath]);
  const starredPaths = useMemo(() => new Set(favorites), [favorites]);
  const cutNames = useMemo(() => new Set(clipboard?.mode === "cut" ? clipboard.names : []), [clipboard]);
  const selectedList = useMemo(() => displayResources.filter((r) => selectedResources.has(r.name)), [displayResources, selectedResources]);
  const singleSelected = selectedList.length === 1 ? selectedList[0] : null;
  // What plugins see of the selection (file-actions, file-preview-section).
  const selectedViews = useMemo(() => selectedList.map((r) => resourceToView(r, currentPath)), [selectedList, currentPath]);
  // Xenaxio: choosing a file opens the details panel (player, transcript), on wide screens.
  const autoDetailsId = XENAXIO_BFF && !isNarrow && singleSelected && !singleSelected.isDirectory ? singleSelected.id : null;
  useEffect(() => {
    if (autoDetailsId) toggleDetails(true);
  }, [autoDetailsId, toggleDetails]);

  // ---- Breadcrumbs -----------------------------------------------------------
  const crumbs: Crumb[] = useMemo(() => {
    const segments = currentPath.split("/").filter(Boolean);
    // Inside a folder someone shared with the user, the trail starts there.
    const insideShared = !!pathStack[1]?.id?.includes(":");
    const list: Crumb[] = [{ id: null, name: insideShared ? t("shared_with_me") : t("my_files"), path: "/" }];
    segments.forEach((name, i) => {
      list.push({ id: pathStack[i + 1]?.id ?? null, name, path: "/" + segments.slice(0, i + 1).join("/") });
    });
    return list;
  }, [currentPath, pathStack, t]);
  const folderName = crumbs[crumbs.length - 1].name;

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
    if (resource.isDirectory) {
      onNavigate(pathOf(resource), resource.id);
    } else if (isOfficeEditable?.(resource.name) && onEditFile) {
      onEditFile(resource.name);
    } else if (isImageFile(resource.name)) {
      onPreviewImage(resource.name);
    } else if (isPreviewable(resource.name)) {
      onPreviewFile(resource.name);
    } else {
      void onDownload(resource.name);
    }
  }, [onNavigate, pathOf, isOfficeEditable, onEditFile, onPreviewImage, onPreviewFile, onDownload]);

  const previewResource = useCallback((resource: FileResource) => {
    if (isImageFile(resource.name)) onPreviewImage(resource.name);
    else onPreviewFile(resource.name);
  }, [onPreviewImage, onPreviewFile]);

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
    const files = names.filter((n) => !resources.find((r) => r.name === n)?.isDirectory);
    if (files.length === 1) void onDownload(files[0]);
    else if (files.length > 1) void onBatchDownload(files);
  }, [resources, onDownload, onBatchDownload]);

  // ---- Drag and drop ---------------------------------------------------------
  const moveNames = useCallback((names: string[], targetId: string | null) => {
    void onMoveTo(names, targetId);
  }, [onMoveTo]);

  const itemDragProps = useCallback((resource: FileResource) => ({
    draggable: !touch,
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
  }), [touch, selectedResources, moveNames]);

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
    scrollAreaRef.current?.querySelector(`[data-resource="${CSS.escape(name)}"]`)?.scrollIntoView?.({ block: "nearest" });
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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (showNewFolder || showNewTextFile || renameTarget || renameFolder || shareTargetId) return;
      // A preview, editor or confirmation is open on top of the list.
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      if (accountPickerMode) return;
      const mod = e.ctrlKey || e.metaKey;
      const selected = selectedList.map((r) => r.name);

      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAllVisible();
        return;
      }
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
        if (searchQuery) setSearchQuery("");
        else if (selected.length > 0) onClearSelection();
        return;
      }
      if (e.key === "Delete" && selected.length > 0) {
        e.preventDefault();
        deleteNames(selected);
        return;
      }
      if (e.key === "F2" && singleSelected) {
        e.preventDefault();
        setRenameTarget(singleSelected.name);
        return;
      }
      if (e.key === "Enter" && singleSelected) {
        e.preventDefault();
        openResource(singleSelected);
        return;
      }
      if (e.key === " " && focusedName) {
        e.preventDefault();
        onToggleSelect(focusedName);
        return;
      }
      if ((e.key === "Backspace" || (e.altKey && e.key === "ArrowUp")) && currentPath !== "/") {
        e.preventDefault();
        navigateUp();
        return;
      }
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
    showNewFolder, showNewTextFile, renameTarget, renameFolder, shareTargetId, accountPickerMode, selectedList, singleSelected,
    selectAllVisible, onCopy, onCut, onPaste, clipboard, searchQuery, onClearSelection, deleteNames, openResource,
    focusedName, onToggleSelect, currentPath, navigateUp, viewMode, gridColumns, moveFocus,
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

  const renderItemMenu = (resource: FileResource) => {
    if (menuSelection.length > 1) {
      const names = menuSelection.map((r) => r.name);
      const fileCount = menuSelection.filter((r) => !r.isDirectory).length;
      return (
        <>
          {fileCount > 0 && (
            <ContextMenuItem icon={Download} label={t("download_count", { count: fileCount })} onClick={() => { closeMenu(); downloadNames(names); }} />
          )}
          <ContextMenuItem icon={Scissors} label={t("cut")} shortcut="Ctrl+X" onClick={() => { closeMenu(); onCut(names); }} />
          <ContextMenuItem icon={Copy} label={t("copy")} shortcut="Ctrl+C" onClick={() => { closeMenu(); onCopy(names); }} />
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
        {resource.isDirectory ? (
          <ContextMenuItem icon={FolderOpen} label={t("open")} onClick={() => { closeMenu(); openResource(resource); }} />
        ) : (
          <>
            {isOfficeEditable?.(resource.name) && onEditFile && (
              <ContextMenuItem icon={SquarePen} label={t("office_edit")} onClick={() => { closeMenu(); onEditFile(resource.name); }} />
            )}
            {isPreviewable(resource.name) && (
              <ContextMenuItem icon={Eye} label={t("preview")} onClick={() => { closeMenu(); previewResource(resource); }} />
            )}
            <ContextMenuItem icon={Download} label={t("download")} onClick={() => { closeMenu(); void onDownload(resource.name); }} />
          </>
        )}
        <ContextMenuSeparator />
        {canShare(resource) && (
          <ContextMenuItem icon={Share2} label={t("share")} onClick={() => { closeMenu(); setShareTargetId(resource.id); }} />
        )}
        <ContextMenuItem icon={LinkIcon} label={xt("file_link.copy")} onClick={() => { closeMenu(); copyFileLink(resource); }} />
        {addToProject && !resource.isDirectory && (
          <ContextMenuItem icon={LayoutGrid} label={xt("projects.add_to")} onClick={() => { closeMenu(); addToProject(resource); }} />
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
        {!resource.isDirectory && (
          <ContextMenuItem icon={CopyPlus} label={t("duplicate")} onClick={() => { closeMenu(); void onDuplicate(resource.name); }} />
        )}
        <ContextMenuItem icon={Scissors} label={t("cut")} shortcut="Ctrl+X" onClick={() => { closeMenu(); onCut([resource.name]); }} />
        <ContextMenuItem icon={Copy} label={t("copy")} shortcut="Ctrl+C" onClick={() => { closeMenu(); onCopy([resource.name]); }} />
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
      <ContextMenuItem icon={Upload} label={t("upload_files")} onClick={() => { closeMenu(); fileInputRef.current?.click(); }} />
      <ContextMenuItem icon={FolderUp} label={t("upload_folder")} onClick={() => { closeMenu(); folderInputRef.current?.click(); }} />
      <ContextMenuSeparator />
      <ContextMenuItem icon={FolderPlus} label={t("new_folder")} onClick={() => { closeMenu(); setShowNewFolder(true); }} />
      <ContextMenuItem icon={NotebookPen} label={xt("notes.new_note")} onClick={() => { closeMenu(); newNote(); }} />
      <ContextMenuItem icon={FilePlus} label={t("new_text_file")} onClick={() => { closeMenu(); newTextFile(); }} />
    </>
  );

  const handlers: FileItemHandlers = useMemo(() => ({
    onSelectClick: handleSelectClick,
    onToggleSelect: handleToggleSelect,
    onOpen: openResource,
    onContextMenu: openItemMenu,
    onDownload: (r) => void onDownload(r.name),
    onShare: (r) => setShareTargetId(r.id),
    canShare,
    dragProps: itemDragProps,
    onShowDetails: (r) => {
      onSetSelection(new Set([r.name]));
      toggleDetails(true);
    },
  }), [handleSelectClick, handleToggleSelect, openResource, openItemMenu, onDownload, canShare, itemDragProps, onSetSelection, toggleDetails]);

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
    else if (kind === "text") newTextFile();
    else if (kind === "note") newNote();
    else if (kind === "files") fileInputRef.current?.click();
    else folderInputRef.current?.click();
  }, [currentParentId, onNavigate, newTextFile, newNote]);

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
      onUploadFiles={() => fileInputRef.current?.click()}
      onUploadFolder={() => folderInputRef.current?.click()}
      onNewFolder={() => setShowNewFolder(true)}
      onNewTextFile={newTextFile}
      onNewNote={newNote}
      onToggleFavorite={onToggleFavorite}
      onDropItems={moveNames}
      canShare={canShare}
      onShare={(r) => setShareTargetId(r.id)}
      onCopyLink={copyFileLink}
      onCreateIn={createIn}
      onRenameFolder={setRenameFolder}
      onDeleteFolder={(folder) => void onDeleteNode(folder.id, folder.name)}
      onRevealRecent={(id) => void onRevealNode(id)}
      onDownloadRecent={(id) => void onDownloadNode(id)}
      onRemoveRecent={onRemoveRecent}
    />
  );

  const showEmpty = !isLoading && !error && displayResources.length === 0 && sharedAtRoot.length === 0;

  const listing = (() => {
    if (accountPickerMode) {
      return accountFolders && accountFolders.length > 0 && onSelectAccount ? (
        <div className="p-4">
          <h3 className="text-xs font-medium text-muted-foreground mb-2 px-0.5">{t("choose_account")}</h3>
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
    if ((isLoading || !hasListed) && resources.length === 0) return <ListSkeleton />;
    if (showEmpty && searchQuery) return <NoSearchResults query={searchQuery} onClear={() => setSearchQuery("")} />;
    if (showEmpty) {
      return (
        <EmptyFolder
          isRoot={currentPath === "/"}
          canCreate={canCreate}
          onUpload={() => fileInputRef.current?.click()}
          onCreateFolder={() => setShowNewFolder(true)}
          onNewNote={newNote}
          newNoteLabel={xt("notes.new_note")}
        />
      );
    }
    const viewProps = {
      resources: displayResources,
      selected: selectedResources,
      focusedName: focusedName && (keyboardNav || selectedResources.has(focusedName)) ? focusedName : null,
      dropTarget,
      cutNames,
      starredPaths,
      pathOf,
      touch,
      iconOptions,
      getImageUrl,
      handlers,
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
          />
        ))}
        {sharedAtRoot.length > 0 && (
          <SharedWithMe
            folders={sharedAtRoot}
            onOpen={(r) => (r.isDirectory ? onNavigate(`/${r.name}`, r.id) : onOpenSharedFile?.(r))}
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
      canPreview={!!singleSelected && isPreviewable(singleSelected.name)}
      canEdit={!!singleSelected && !!onEditFile && !!isOfficeEditable?.(singleSelected.name)}
      pluginFile={singleSelected ? selectedViews[0] : null}
      iconOptions={iconOptions}
      getImageUrl={getImageUrl}
      onClose={() => toggleDetails(false)}
      onOpen={() => singleSelected && (singleSelected.isDirectory ? openResource(singleSelected) : previewResource(singleSelected))}
      onEdit={() => singleSelected && onEditFile?.(singleSelected.name)}
      onDownload={() => singleSelected && void onDownload(singleSelected.name)}
      onShare={() => singleSelected && setShareTargetId(singleSelected.id)}
      onCopyLink={() => singleSelected && copyFileLink(singleSelected)}
      onToggleStar={() => singleSelected && onToggleFavorite(pathOf(singleSelected))}
      className={cn(
        "flex-shrink-0",
        isNarrow ? "absolute inset-y-0 end-0 z-30 w-80 max-w-[85%] shadow-xl" : "w-full",
      )}
    />
  );

  const selectionActions = selectedList.length > 0 ? {
    count: selectedList.length,
    fileCount: selectedList.filter((r) => !r.isDirectory).length,
    canOpen: !!singleSelected && (singleSelected.isDirectory || isPreviewable(singleSelected.name) || !!isOfficeEditable?.(singleSelected.name)),
    canRename: !!singleSelected,
    canShare: !!singleSelected && canShare(singleSelected),
    onOpen: () => singleSelected && openResource(singleSelected),
    onDownload: () => downloadNames(selectedList.map((r) => r.name)),
    onShare: () => singleSelected && setShareTargetId(singleSelected.id),
    onRename: () => singleSelected && setRenameTarget(singleSelected.name),
    onCut: () => onCut(selectedList.map((r) => r.name)),
    onCopy: () => onCopy(selectedList.map((r) => r.name)),
    onDelete: () => deleteNames(selectedList.map((r) => r.name)),
    onClear: onClearSelection,
    pluginFiles: selectedViews,
    pluginMimeType: singleSelected ? (singleSelected.isDirectory ? "" : singleSelected.contentType) : undefined,
  } : null;

  return (
    <div className="relative flex flex-1 min-h-0">
      {/* Folder sidebar: in flow on desktop, a drawer on narrow panes */}
      {sidebar && isNarrow && narrowSidebarOpen && (
        <div className="absolute inset-0 bg-black/50 z-40" onClick={() => setNarrowSidebarOpen(false)} />
      )}
      {sidebar && (isNarrow ? (
        <div
          className={cn(
            "absolute inset-y-0 start-0 z-50 w-72 border-e border-border",
            "transform transition-transform duration-300 ease-in-out",
            !narrowSidebarOpen && "-translate-x-full rtl:translate-x-full",
          )}
          aria-hidden={!narrowSidebarOpen}
        >
          {sidebar}
        </div>
      ) : (
        <>
          <div
            className={cn("border-e border-border flex-shrink-0", !isResizing && "transition-[width] duration-300")}
            style={{ width: `${sidebarWidth}px` }}
          >
            {sidebar}
          </div>
          <ResizeHandle
            onResizeStart={() => { dragStartWidth.current = sidebarWidth; setIsResizing(true); }}
            onResize={(delta) => {
              const next = clampSidebarWidth(dragStartWidth.current + delta);
              liveSidebarWidth.current = next;
              setSidebarWidth(next);
            }}
            onResizeEnd={() => {
              setIsResizing(false);
              saveSidebarWidth(liveSidebarWidth.current);
              // An arrow key (no drag start) moves on from here.
              dragStartWidth.current = liveSidebarWidth.current;
            }}
            onDoubleClick={() => { setSidebarWidth(SIDEBAR_DEFAULT_WIDTH); dragStartWidth.current = SIDEBAR_DEFAULT_WIDTH; saveSidebarWidth(null); }}
          />
        </>
      ))}

      <div className="flex flex-col flex-1 min-w-0">
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
          onNew={canCreate && !isNarrow ? (el) => menu.openContextMenu(anchorEvent(el, "start"), { kind: "new" }) : undefined}
        />

        {error && (
          <div role="alert" className="mx-4 mt-3 px-3 py-2 rounded-md bg-destructive/10 text-destructive text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="flex-1">{error}</span>
            <Button variant="ghost" size="sm" className="h-7 text-destructive hover:text-destructive shrink-0" onClick={() => void onRefresh()}>
              <RefreshCw className="w-3.5 h-3.5 me-1" />
              {t("retry")}
            </Button>
          </div>
        )}

        <div ref={detailsAreaRef} className="relative flex flex-1 min-h-0">
          <div
            ref={scrollAreaRef}
            className="relative flex-1 min-w-0 overflow-y-auto"
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

          {detailsPanel && !isNarrow ? (
            <>
              <ResizeHandle testId="files-details-resize" {...detailsSplit.handle} />
              <div className="flex flex-shrink-0" style={splitStyle(detailsSplit.percent)} data-details-width={Math.round(detailsSplit.percent)}>
                {detailsPanel}
              </div>
            </>
          ) : (
            detailsPanel
          )}

          {isNarrow && canCreate && !selectionActions && (
            <Button
              size="icon"
              className="absolute bottom-4 end-4 z-20 h-12 w-12 rounded-full shadow-lg"
              aria-label={t("new")}
              onClick={(e) => menu.openContextMenu(anchorEvent(e.currentTarget, "end"), { kind: "new" })}
            >
              <Plus className="w-5 h-5" />
            </Button>
          )}

        </div>
      </div>

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
                <ContextMenuItem icon={Clipboard} label={t("paste")} shortcut="Ctrl+V" onClick={() => { closeMenu(); void onPaste(); }} />
              </>
            )}
            <ContextMenuSeparator />
            {displayResources.length > 0 && (
              <ContextMenuItem icon={CheckSquare} label={t("select_all")} shortcut="Ctrl+A" onClick={() => { closeMenu(); selectAllVisible(); }} />
            )}
            <ContextMenuItem icon={RefreshCw} label={t("refresh")} onClick={() => { closeMenu(); void onRefresh(); }} />
          </>
        )}
      </ContextMenu>
      {addToProjectDialog}

      {showNewFolder && (
        <NewFolderDialog
          onConfirm={async (name: string) => {
            await onCreateFolder(name);
            setShowNewFolder(false);
          }}
          onCancel={() => setShowNewFolder(false)}
          validate={validateFileName}
        />
      )}

      {showNewTextFile && (
        <RenameDialog
          currentName={newTextName}
          title={newTextName.endsWith(".md") ? xt("notes.new_note") : t("new_text_file")}
          label={t("file_name")}
          onConfirm={async (name: string) => {
            await onCreateTextFile(name);
            setShowNewTextFile(false);
          }}
          onCancel={() => setShowNewTextFile(false)}
          validate={validateFileName}
        />
      )}

      {renameTarget && (
        <RenameDialog
          currentName={renameTarget}
          onConfirm={async (newName: string) => {
            await onRename(renameTarget, newName);
            setRenameTarget(null);
          }}
          onCancel={() => setRenameTarget(null)}
          validate={validateFileName}
        />
      )}

      {renameFolder && (
        <RenameDialog
          currentName={renameFolder.name}
          onConfirm={async (newName: string) => {
            await onRenameNode(renameFolder.id, newName);
            setRenameFolder(null);
          }}
          onCancel={() => setRenameFolder(null)}
          validate={validateFileName}
        />
      )}

      {shareTarget && client && onShare && (
        <ShareCollectionDialog
          client={client}
          kind="file"
          collectionName={shareTarget.name}
          shareWith={shareTarget.shareWith}
          ownAccountId={ownAccountId || ""}
          onShare={async (principalId, rights) => {
            await onShare(shareTarget.id, principalId, rights as FileNodeRights | null);
          }}
          onClose={() => setShareTargetId(null)}
          onCopyLink={() => copyFileLink(shareTarget)}
        />
      )}
    </div>
  );
}

function SharedWithMe({ folders, onOpen, iconOptions }: {
  folders: FileResource[];
  onOpen: (r: FileResource) => void;
  iconOptions: { showIcons: boolean; coloredIcons: boolean };
}) {
  const t = useTranslations("files");
  return (
    <section aria-label={t("shared_with_me")} className="px-4 pt-5 pb-4">
      <h3 className="text-xs font-medium text-muted-foreground mb-2 px-0.5 flex items-center gap-1.5">
        <Share2 className="w-3 h-3" />
        {t("shared_with_me")}
      </h3>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2">
        {folders.map((folder) => (
          <button
            key={folder.id}
            type="button"
            onClick={() => onOpen(folder)}
            title={folder.ownerName ? t("shared_by", { name: folder.ownerName }) : folder.name}
            className="flex items-center gap-2.5 h-12 px-3 rounded-lg border border-border hover:bg-muted/60 transition-colors text-start min-w-0"
          >
            {iconOptions.showIcons && (folder.isDirectory
              ? <FolderOpen className={cn("w-5 h-5 shrink-0", iconOptions.coloredIcons ? "text-primary" : "text-muted-foreground")} />
              : <span className="w-5 h-5 shrink-0 flex items-center justify-center [&>svg]:w-5 [&>svg]:h-5">{getFileIconByName(folder.name, "sm")}</span>)}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{folder.name}</span>
              {folder.ownerName && <span className="block truncate text-xs text-muted-foreground">{folder.ownerName}</span>}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function ListSkeleton() {
  return (
    <div className="px-4" aria-hidden>
      <div className="h-9 border-b border-border" />
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="h-10 flex items-center gap-3 border-b border-border/60">
          <div className="w-4 h-4 rounded bg-muted animate-pulse" />
          <div className="w-5 h-5 rounded bg-muted animate-pulse" />
          <div className="h-3.5 rounded bg-muted animate-pulse" style={{ width: `${30 + ((i * 37) % 35)}%` }} />
        </div>
      ))}
    </div>
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
