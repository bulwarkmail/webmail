"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
import {
  Folder, File, Upload, FolderPlus, Download, Trash2,
  Pencil, RefreshCw, Home, ChevronRight, MoreVertical,
  Search, ArrowUp, ArrowDown, X, LayoutGrid, LayoutList,
  Copy, Clipboard, Scissors, Info, Image as ImageIcon,
  FilePlus, CopyPlus, FileText, FileAudio, FileVideo,
  AlertCircle, Star, Clock, FolderUp,
  FileArchive, FileSpreadsheet, Presentation, FileCode,
  Box, PenTool, Terminal as TerminalIcon, Database, Type as TypeIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn, formatFileSize } from "@/lib/utils";
import { NewFolderDialog } from "@/components/files/new-folder-dialog";
import { RenameDialog } from "@/components/files/rename-dialog";
import { FileUploadArea } from "@/components/files/file-upload-area";
import { loadFilesSettings } from "@/components/files/files-settings-dialog";
import type { FolderLayout } from "@/components/files/files-settings-dialog";
import { FolderTreeSidebar } from "@/components/files/folder-tree-sidebar";
import { ResizeHandle } from "@/components/layout/resize-handle";
import { getDroppedFilesAndFolders } from "@/lib/webdav/drop-utils";
import type { FileResource } from "@/stores/file-store";

type SortKey = "name" | "size" | "modified";
type SortDir = "asc" | "desc";
type ViewMode = "list" | "grid";

interface ClipboardState {
  mode: "cut" | "copy";
  ids: string[];
  names: string[];
  sourceParentId: string | null;
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
  onSelectResource: (name: string | null) => void;
  onToggleSelect: (name: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onSetSelection: (names: Set<string>) => void;
  onCut: (names: string[]) => void;
  onCopy: (names: string[]) => void;
  onPaste: () => Promise<void>;
  onMoveToFolder: (names: string[], targetFolder: string) => Promise<void>;
  onMoveToParent: (names: string[]) => Promise<void>;
  onPreviewImage: (name: string) => void;
  onPreviewFile: (name: string) => void;
  onShowDetails: (name: string) => void;
  onCreateTextFile: (name: string) => Promise<void>;
  onDuplicate: (name: string) => Promise<void>;
  getImageUrl: (name: string) => Promise<string>;
  listPath: (path: string) => Promise<FileResource[]>;
  listByParentId: (parentId: string | null) => Promise<FileResource[]>;
  favorites: string[];
  recentFiles: { name: string; id: string; timestamp: number }[];
  onToggleFavorite: (path: string) => void;
  showDetails: boolean;
  onToggleDetails: () => void;
  detailResource: FileResource | null;
}

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "svg", "webp", "bmp", "ico", "avif"]);

function isImageFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return IMAGE_EXTENSIONS.has(ext);
}

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "xml", "html", "htm", "css", "js", "ts",
  "jsx", "tsx", "py", "rb", "java", "c", "cpp", "h", "hpp", "go", "rs",
  "sh", "bash", "zsh", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "log", "csv", "sql", "graphql", "vue", "svelte", "astro", "php", "pl",
  "swift", "kt", "scala", "r", "lua", "vim",
]);

function isTextFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const baseName = name.toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || ["dockerfile", "makefile", "readme", "license", "changelog"].includes(baseName);
}

const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "flac", "aac", "m4a", "wma", "opus"]);
function isAudioFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return AUDIO_EXTENSIONS.has(ext);
}

const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "ogv", "mov", "avi", "mkv", "m4v"]);
function isVideoFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return VIDEO_EXTENSIONS.has(ext);
}

const PDF_EXTENSIONS = new Set(["pdf"]);
function isPdfFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return PDF_EXTENSIONS.has(ext);
}

const VECTOR_EXTENSIONS = new Set(["svg", "ai", "eps", "ps", "sketch", "fig", "xd", "gvdesign"]);
function isVectorFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return VECTOR_EXTENSIONS.has(ext);
}

const THREE_D_EXTENSIONS = new Set([
  "obj", "fbx", "gltf", "glb", "stl", "3mf", "step", "stp", "iges", "igs",
  "blend", "3ds", "dae", "usdz", "usd", "usda", "usdc", "ply", "wrl",
  "c4d", "max", "ma", "mb", "dwg", "dxf",
]);
function is3DFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return THREE_D_EXTENSIONS.has(ext);
}

const EXECUTABLE_EXTENSIONS = new Set([
  "exe", "msi", "dmg", "app", "appimage", "deb", "rpm", "snap", "flatpak",
  "bat", "cmd", "com", "scr", "ps1", "apk", "ipa", "jar", "run",
]);
function isExecutableFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return EXECUTABLE_EXTENSIONS.has(ext);
}

const ARCHIVE_EXTENSIONS = new Set([
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "lz", "lzma",
  "tgz", "tbz2", "txz", "cab", "iso", "img",
]);
function isArchiveFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return ARCHIVE_EXTENSIONS.has(ext);
}

const SPREADSHEET_EXTENSIONS = new Set(["xls", "xlsx", "ods", "numbers", "tsv"]);
function isSpreadsheetFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return SPREADSHEET_EXTENSIONS.has(ext);
}

const PRESENTATION_EXTENSIONS = new Set(["ppt", "pptx", "odp", "key"]);
function isPresentationFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return PRESENTATION_EXTENSIONS.has(ext);
}

const FONT_EXTENSIONS = new Set(["ttf", "otf", "woff", "woff2", "eot"]);
function isFontFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return FONT_EXTENSIONS.has(ext);
}

const DATABASE_EXTENSIONS = new Set(["db", "sqlite", "sqlite3", "mdb", "accdb"]);
function isDatabaseFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return DATABASE_EXTENSIONS.has(ext);
}

function isPreviewable(name: string): boolean {
  return isImageFile(name) || isTextFile(name) || isPdfFile(name) || isAudioFile(name) || isVideoFile(name);
}

function getFileIconByName(name: string, size: "sm" | "lg") {
  const cls = size === "sm" ? "w-5 h-5" : "w-10 h-10";
  if (isVectorFile(name)) return <PenTool className={`${cls} text-orange-500`} />;
  if (is3DFile(name)) return <Box className={`${cls} text-cyan-500`} />;
  if (isImageFile(name)) return <ImageIcon className={`${cls} text-emerald-500`} />;
  if (isAudioFile(name)) return <FileAudio className={`${cls} text-purple-500`} />;
  if (isVideoFile(name)) return <FileVideo className={`${cls} text-pink-500`} />;
  if (isArchiveFile(name)) return <FileArchive className={`${cls} text-amber-600`} />;
  if (isExecutableFile(name)) return <TerminalIcon className={`${cls} text-red-500`} />;
  if (isSpreadsheetFile(name)) return <FileSpreadsheet className={`${cls} text-green-600`} />;
  if (isPresentationFile(name)) return <Presentation className={`${cls} text-orange-600`} />;
  if (isFontFile(name)) return <TypeIcon className={`${cls} text-indigo-500`} />;
  if (isDatabaseFile(name)) return <Database className={`${cls} text-slate-500`} />;
  if (isPdfFile(name)) return <FileText className={`${cls} text-red-600`} />;
  if (isTextFile(name)) return <FileCode className={`${cls} text-yellow-600`} />;
  return <File className={`${cls} text-muted-foreground`} />;
}

function getFileIcon(resource: FileResource) {
  if (resource.isDirectory) {
    return <Folder className="w-5 h-5 text-blue-500" />;
  }
  return getFileIconByName(resource.name, "sm");
}

function getGridIcon(resource: FileResource) {
  if (resource.isDirectory) {
    return <Folder className="w-10 h-10 text-blue-500" />;
  }
  return getFileIconByName(resource.name, "lg");
}

function Thumbnail({ name, getImageUrl: fetchUrl, size = "sm" }: {
  name: string;
  getImageUrl: (n: string) => Promise<string>;
  size?: "sm" | "lg";
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchUrl(name).then(url => { if (!cancelled) setSrc(url); }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [name, fetchUrl]);

  if (failed || !src) {
    return size === "sm"
      ? <ImageIcon className="w-5 h-5 text-emerald-500" />
      : <ImageIcon className="w-10 h-10 text-emerald-500" />;
  }

  const cls = size === "sm"
    ? "w-5 h-5 rounded object-cover"
    : "w-10 h-10 rounded object-cover";

  return <img src={src} alt={name} className={cls} loading="lazy" />;
}

function formatDate(dateString: string): string {
  if (!dateString) return "";
  try {
    return new Date(dateString).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateString;
  }
}

function SkeletonRow() {
  return (
    <tr className="border-b border-border">
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-3">
          <div className="w-4 h-4 shrink-0" />
          <div className="w-5 h-5 rounded bg-muted animate-pulse shrink-0" />
          <div className="h-4 rounded bg-muted animate-pulse w-40" />
        </div>
      </td>
      <td className="px-4 py-2.5 hidden md:table-cell">
        <div className="h-4 rounded bg-muted animate-pulse w-14" />
      </td>
      <td className="px-4 py-2.5 hidden lg:table-cell">
        <div className="h-4 rounded bg-muted animate-pulse w-32" />
      </td>
      <td className="px-2 py-2.5">
        <div className="h-4 w-4 rounded bg-muted animate-pulse" />
      </td>
    </tr>
  );
}

export function FileBrowser({
  currentPath,
  resources,
  isLoading,
  error,
  selectedResources,
  uploadProgress,
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
  onSelectResource,
  onToggleSelect,
  onSelectAll,
  onClearSelection,
  onSetSelection,
  onCut,
  onCopy,
  onPaste,
  onMoveToFolder,
  onMoveToParent,
  onPreviewImage,
  onPreviewFile,
  onShowDetails,
  onCreateTextFile,
  onDuplicate,
  getImageUrl,
  listPath,
  listByParentId,
  favorites,
  recentFiles,
  onToggleFavorite,
  showDetails,
  onToggleDetails,
  detailResource,
  clipboard,
}: FileBrowserProps) {
  const t = useTranslations("files");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; name: string } | null>(null);
  const [emptyContextMenu, setEmptyContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [showNewTextFile, setShowNewTextFile] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("files-view-mode") as ViewMode) || "list";
    }
    return "list";
  });
  const [showThumbnails, setShowThumbnails] = useState(() => loadFilesSettings().showThumbnails);
  const [folderLayout, setFolderLayout] = useState<FolderLayout>(() => loadFilesSettings().folderLayout);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("files-sidebar-width");
      if (saved) return Math.max(180, Math.min(400, Number(saved)));
    }
    return 256;
  });
  const [isResizing, setIsResizing] = useState(false);
  const dragStartWidth = useRef(256);
  const [dragTarget, setDragTarget] = useState<string | null>(null);

  // Sync showThumbnails and folderLayout when settings change
  useEffect(() => {
    const reloadSettings = () => {
      const s = loadFilesSettings();
      setShowThumbnails(s.showThumbnails);
      setFolderLayout(s.folderLayout);
    };
    const handleStorage = (e: StorageEvent) => {
      if (e.key === "files-settings") reloadSettings();
    };
    // StorageEvent fires cross-tab, custom event fires same-tab
    window.addEventListener("storage", handleStorage);
    window.addEventListener("files-settings-changed", reloadSettings);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("files-settings-changed", reloadSettings);
    };
  }, []);
  const [breadcrumbDropdown, setBreadcrumbDropdown] = useState<{
    path: string;
    folders: FileResource[];
    x: number;
    y: number;
  } | null>(null);
  const [marquee, setMarquee] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);
  const marqueeRef = useRef<{
    additive: boolean;
    initialSelection: Set<string>;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Reset search when navigating
  useEffect(() => {
    setSearchQuery("");
  }, [currentPath]);

  // Focus search input when shown
  useEffect(() => {
    if (showSearch) searchInputRef.current?.focus();
  }, [showSearch]);

  // Persist view mode
  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    localStorage.setItem("files-view-mode", mode);
  }, []);

  // Filter and sort resources
  const displayResources = useMemo(() => {
    let filtered = resources;
    // In sidebar mode, folders are shown in the sidebar tree - hide them from the main list
    if (folderLayout === "sidebar") {
      filtered = filtered.filter(r => !r.isDirectory);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(r => r.name.toLowerCase().includes(q));
    }

    const sorted = [...filtered].sort((a, b) => {
      // Directories always first
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;

      let cmp = 0;
      switch (sortKey) {
        case "name":
          cmp = a.name.localeCompare(b.name);
          break;
        case "size":
          cmp = a.contentLength - b.contentLength;
          break;
        case "modified":
          cmp = new Date(a.lastModified || 0).getTime() - new Date(b.lastModified || 0).getTime();
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [resources, searchQuery, sortKey, sortDir, folderLayout]);

  // Build breadcrumb segments
  const breadcrumbs = currentPath === '/'
    ? [{ name: t("breadcrumb_root"), path: '/' }]
    : [
        { name: t("breadcrumb_root"), path: '/' },
        ...currentPath.split('/').filter(Boolean).map((segment, i, arr) => ({
          name: segment,
          path: '/' + arr.slice(0, i + 1).join('/'),
        })),
      ];

  const handleNavigateUp = useCallback(() => {
    if (currentPath === '/') return;
    const segments = currentPath.split('/').filter(Boolean);
    segments.pop();
    const parentPath = segments.length === 0 ? '/' : '/' + segments.join('/');
    onNavigate(parentPath, null);
  }, [currentPath, onNavigate]);

  const handleResourceClick = (resource: FileResource, e: React.MouseEvent) => {
    if (resource.isDirectory) {
      // Ctrl/Cmd+click on directories also toggles selection
      if (e.ctrlKey || e.metaKey) {
        onToggleSelect(resource.name);
        return;
      }
      const newPath = currentPath === '/'
        ? `/${resource.name}`
        : `${currentPath}/${resource.name}`;
      onNavigate(newPath, resource.id);
    } else {
      if (e.ctrlKey || e.metaKey) {
        onToggleSelect(resource.name);
      } else if (e.shiftKey && resources.length > 0) {
        // Shift+click range select
        handleShiftSelect(resource.name);
      } else {
        onSelectResource(resource.name === [...selectedResources][0] && selectedResources.size === 1 ? null : resource.name);
      }
    }
  };

  const handleShiftSelect = (targetName: string) => {
    const lastSelected = [...selectedResources].pop();
    if (!lastSelected) {
      onToggleSelect(targetName);
      return;
    }
    const names = displayResources.map(r => r.name);
    const startIdx = names.indexOf(lastSelected);
    const endIdx = names.indexOf(targetName);
    if (startIdx === -1 || endIdx === -1) return;
    const from = Math.min(startIdx, endIdx);
    const to = Math.max(startIdx, endIdx);
    for (let i = from; i <= to; i++) {
      if (!selectedResources.has(names[i])) {
        onToggleSelect(names[i]);
      }
    }
  };

  // Marquee (rubber-band) selection
  const handleMarqueeMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('[data-resource]') || target.closest('input') || target.closest('button') || target.closest('thead')) return;

    const scrollArea = scrollAreaRef.current;
    if (!scrollArea) return;

    const rect = scrollArea.getBoundingClientRect();
    const x = e.clientX - rect.left + scrollArea.scrollLeft;
    const y = e.clientY - rect.top + scrollArea.scrollTop;

    const additive = e.ctrlKey || e.metaKey;
    marqueeRef.current = {
      additive,
      initialSelection: additive ? new Set(selectedResources) : new Set(),
    };

    setMarquee({ startX: x, startY: y, currentX: x, currentY: y });

    if (!additive) {
      onClearSelection();
    }

    e.preventDefault();
  }, [selectedResources, onClearSelection]);

  useEffect(() => {
    if (!marquee) return;

    const handleMouseMove = (e: MouseEvent) => {
      const scrollArea = scrollAreaRef.current;
      if (!scrollArea) return;

      const rect = scrollArea.getBoundingClientRect();
      const x = e.clientX - rect.left + scrollArea.scrollLeft;
      const y = e.clientY - rect.top + scrollArea.scrollTop;

      setMarquee(prev => prev ? { ...prev, currentX: x, currentY: y } : null);

      // Calculate marquee rect
      const info = marqueeRef.current;
      if (!info) return;

      const mx = Math.min(marquee.startX, x);
      const my = Math.min(marquee.startY, y);
      const mw = Math.abs(x - marquee.startX);
      const mh = Math.abs(y - marquee.startY);

      // Find intersecting items
      const elements = scrollArea.querySelectorAll('[data-resource]');
      const containerRect = scrollArea.getBoundingClientRect();
      const newSelection = new Set(info.initialSelection);

      elements.forEach(el => {
        const name = el.getAttribute('data-resource');
        if (!name) return;
        const elRect = el.getBoundingClientRect();
        const elX = elRect.left - containerRect.left + scrollArea.scrollLeft;
        const elY = elRect.top - containerRect.top + scrollArea.scrollTop;

        if (mx < elX + elRect.width && mx + mw > elX && my < elY + elRect.height && my + mh > elY) {
          newSelection.add(name);
        }
      });

      onSetSelection(newSelection);
    };

    const handleMouseUp = () => {
      setMarquee(null);
      marqueeRef.current = null;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [marquee, onSetSelection]);

  const handleResourceDoubleClick = (resource: FileResource) => {
    if (resource.isDirectory) {
      const newPath = currentPath === '/'
        ? `/${resource.name}`
        : `${currentPath}/${resource.name}`;
      onNavigate(newPath, resource.id);
    } else if (isPreviewable(resource.name)) {
      if (isImageFile(resource.name)) {
        onPreviewImage(resource.name);
      } else {
        onPreviewFile(resource.name);
      }
    } else {
      onDownload(resource.name);
    }
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only show upload overlay for external file drags, not internal resource drags
    if (e.dataTransfer.types.includes("Files")) {
      setIsDraggingOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);

    setIsUploading(true);
    try {
      const { files, hasDirectories } = await getDroppedFilesAndFolders(e.dataTransfer);
      if (files.length > 0) {
        if (hasDirectories) {
          await onUploadFolder(files);
        } else {
          await onUploadFiles(files);
        }
      }
    } finally {
      setIsUploading(false);
    }
  }, [onUploadFiles, onUploadFolder]);

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      setIsUploading(true);
      try {
        await onUploadFiles(files);
      } finally {
        setIsUploading(false);
      }
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleFolderInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) {
      setIsUploading(true);
      try {
        await onUploadFolder(files);
      } finally {
        setIsUploading(false);
      }
    }
    if (folderInputRef.current) {
      folderInputRef.current.value = '';
    }
  };

  const contextMenuRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = (e: React.MouseEvent, name: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, name });
  };

  // Adjust context menu position to stay within viewport
  useEffect(() => {
    if (contextMenu && contextMenuRef.current) {
      const menu = contextMenuRef.current;
      const rect = menu.getBoundingClientRect();
      let { x, y } = contextMenu;
      let adjusted = false;

      if (x + rect.width > window.innerWidth) {
        x = window.innerWidth - rect.width - 8;
        adjusted = true;
      }
      if (y + rect.height > window.innerHeight) {
        y = window.innerHeight - rect.height - 8;
        adjusted = true;
      }

      if (adjusted) {
        setContextMenu({ ...contextMenu, x, y });
      }
    }
  }, [contextMenu]);

  const handleContainerClick = () => {
    if (contextMenu) setContextMenu(null);
    if (emptyContextMenu) setEmptyContextMenu(null);
    if (breadcrumbDropdown) setBreadcrumbDropdown(null);
  };

  const handleBreadcrumbRightClick = async (e: React.MouseEvent, crumbPath: string) => {
    e.preventDefault();
    e.stopPropagation();
    const parentPath = crumbPath === '/' ? '/' : '/' + crumbPath.split('/').filter(Boolean).slice(0, -1).join('/') || '/';
    try {
      const items = await listPath(parentPath === '/' ? '/' : parentPath);
      const folders = items.filter(r => r.isDirectory);
      setBreadcrumbDropdown({ path: parentPath, folders, x: e.clientX, y: e.clientY });
    } catch {
      // ignore
    }
  };

  const handleSortClick = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const SortIndicator = ({ column }: { column: SortKey }) => {
    if (sortKey !== column) return null;
    return sortDir === "asc"
      ? <ArrowUp className="w-3 h-3 inline ml-1" />
      : <ArrowDown className="w-3 h-3 inline ml-1" />;
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't capture when typing in inputs or dialogs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (showNewFolder || renameTarget) return;

      // Ctrl+F / Cmd+F: toggle search
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setShowSearch(v => !v);
        return;
      }

      // Ctrl+A / Cmd+A: select all
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        onSelectAll();
        return;
      }

      // Ctrl+C / Cmd+C: copy selected
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        if (selectedResources.size > 0) {
          e.preventDefault();
          onCopy([...selectedResources]);
        }
        return;
      }

      // Ctrl+X / Cmd+X: cut selected
      if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
        if (selectedResources.size > 0) {
          e.preventDefault();
          onCut([...selectedResources]);
        }
        return;
      }

      // Ctrl+V / Cmd+V: paste
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        if (clipboard) {
          e.preventDefault();
          onPaste();
        }
        return;
      }

      // Escape: clear selection, close search
      if (e.key === 'Escape') {
        if (showSearch) { setShowSearch(false); setSearchQuery(""); }
        else if (selectedResources.size > 0) onClearSelection();
        return;
      }

      // Delete: delete selected
      if (e.key === 'Delete') {
        if (selectedResources.size === 1) {
          onDelete([...selectedResources][0]);
        } else if (selectedResources.size > 1) {
          onBatchDelete([...selectedResources]);
        }
        return;
      }

      // F2: rename selected (single)
      if (e.key === 'F2' && selectedResources.size === 1) {
        setRenameTarget([...selectedResources][0]);
        return;
      }

      // Enter: open selected directory or download selected file
      if (e.key === 'Enter' && selectedResources.size === 1) {
        const name = [...selectedResources][0];
        const resource = resources.find(r => r.name === name);
        if (resource?.isDirectory) {
          const newPath = currentPath === '/'
            ? `/${resource.name}`
            : `${currentPath}/${resource.name}`;
          onNavigate(newPath, resource.id);
        } else if (resource) {
          onDownload(resource.name);
        }
        return;
      }

      // Backspace: navigate up
      if (e.key === 'Backspace' && currentPath !== '/') {
        handleNavigateUp();
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedResources, resources, currentPath, showSearch, showNewFolder, renameTarget, onDelete, onBatchDelete, onSelectAll, onClearSelection, onNavigate, onDownload, onCut, onCopy, onPaste, clipboard, handleNavigateUp]);

  const allSelected = resources.length > 0 && selectedResources.size === resources.length;
  const someSelected = selectedResources.size > 0 && !allSelected;

  return (
    <div
      ref={containerRef}
      className="flex flex-col flex-1 min-h-0"
      onClick={handleContainerClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      tabIndex={-1}
    >
      {/* Toolbar */}
      <div role="toolbar" aria-label={t("toolbar")} className="flex items-center gap-2 px-4 py-2 border-b border-border bg-background">
        {/* Breadcrumbs */}
        <nav aria-label={t("breadcrumb_root")} className="flex items-center gap-1 text-sm flex-1 min-w-0 overflow-x-auto">
          {breadcrumbs.map((crumb, i) => (
            <span key={crumb.path} className="flex items-center gap-1 shrink-0">
              {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
              <button
                onClick={() => onNavigate(crumb.path)}
                onContextMenu={(e) => handleBreadcrumbRightClick(e, crumb.path)}
                className={cn(
                  "px-1.5 py-0.5 rounded hover:bg-muted transition-colors",
                  i === breadcrumbs.length - 1
                    ? "font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {i === 0 ? <Home className="w-4 h-4" /> : crumb.name}
              </button>
            </span>
          ))}
        </nav>

        {/* Action buttons */}
        <div className="flex items-center gap-1 shrink-0">
          {selectedResources.size > 1 && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-8"
                onClick={() => onBatchDownload([...selectedResources].filter(n => !resources.find(r => r.name === n)?.isDirectory))}
              >
                <Download className="w-4 h-4 mr-1" />
                {t("download")} ({[...selectedResources].filter(n => !resources.find(r => r.name === n)?.isDirectory).length})
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-destructive hover:text-destructive"
                onClick={() => onBatchDelete([...selectedResources])}
              >
                <Trash2 className="w-4 h-4 mr-1" />
                {t("delete")} ({selectedResources.size})
              </Button>
            </>
          )}
          {clipboard && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={onPaste}
            >
              <Clipboard className="w-4 h-4 mr-1" />
              {t("paste")} ({clipboard.names.length})
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setShowSearch(v => !v)}
            title={t("search_placeholder")}
          >
            <Search className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-8 w-8", viewMode === "grid" && "bg-muted")}
            onClick={() => handleViewModeChange(viewMode === "list" ? "grid" : "list")}
            title={viewMode === "list" ? t("grid_view") : t("list_view")}
          >
            {viewMode === "list" ? <LayoutGrid className="w-4 h-4" /> : <LayoutList className="w-4 h-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-8 w-8", showDetails && "bg-muted")}
            onClick={onToggleDetails}
            title={t("details")}
          >
            <Info className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-8 w-8", favorites.includes(currentPath) && "text-yellow-500")}
            onClick={() => onToggleFavorite(currentPath)}
            title={t("toggle_favorite")}
          >
            <Star className={cn("w-4 h-4", favorites.includes(currentPath) && "fill-current")} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => fileInputRef.current?.click()}
            title={t("upload")}
            disabled={isUploading}
          >
            <Upload className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => folderInputRef.current?.click()}
            title={t("upload_folder")}
            disabled={isUploading}
          >
            <FolderUp className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setShowNewFolder(true)}
            title={t("new_folder")}
          >
            <FolderPlus className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setShowNewTextFile(true)}
            title={t("new_text_file")}
          >
            <FilePlus className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onRefresh}
            title={t("refresh")}
            aria-label={t("refresh")}
            disabled={isLoading}
          >
            <RefreshCw className={cn("w-4 h-4", isLoading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Search bar */}
      {showSearch && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-muted/30">
          <Search className="w-4 h-4 text-muted-foreground shrink-0" />
          <input
            ref={searchInputRef}
            type="search"
            role="searchbox"
            aria-label={t("search_placeholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("search_placeholder")}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setShowSearch(false);
                setSearchQuery("");
              }
            }}
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery("")} className="text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
      />
      {/* Hidden folder input */}
      <input
        ref={folderInputRef}
        type="file"
        className="hidden"
        onChange={handleFolderInputChange}
        {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
      />

      {/* Error display with retry */}
      {error && (
        <div className="px-4 py-2 bg-destructive/10 text-destructive text-sm border-b border-destructive/20 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-destructive hover:text-destructive shrink-0"
            onClick={onRefresh}
          >
            <RefreshCw className="w-3.5 h-3.5 mr-1" />
            {t("retry")}
          </Button>
        </div>
      )}

      {/* Drag overlay */}
      {isDraggingOver && (
        <div className="absolute inset-0 z-50 bg-primary/5 border-2 border-dashed border-primary rounded-lg flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <Upload className="w-12 h-12 text-primary mx-auto mb-2" />
            <p className="text-sm font-medium text-primary">{t("drop_files_here")}</p>
          </div>
        </div>
      )}

      {/* Upload progress */}
      {uploadProgress && (
        <div className="px-4 py-2 border-b border-primary/20 bg-primary/5">
          <div className="flex items-center gap-2 text-sm text-primary mb-1">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            <span className="truncate">
              {t("uploading")} {uploadProgress.name}
              {uploadProgress.totalFiles > 1 && (
                <span className="text-muted-foreground ml-1">
                  ({uploadProgress.current}/{uploadProgress.totalFiles})
                </span>
              )}
            </span>
            <span className="ml-auto tabular-nums shrink-0 flex items-center gap-2">
              {uploadProgress.total > 0
                ? `${Math.round((uploadProgress.loaded / uploadProgress.total) * 100)}%`
                : "…"}
              <button
                onClick={onCancelUpload}
                className="text-xs text-destructive hover:text-destructive/80 underline"
              >
                {t("cancel")}
              </button>
            </span>
          </div>
          <div className="h-1 bg-primary/20 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: uploadProgress.total > 0
                ? `${(uploadProgress.loaded / uploadProgress.total) * 100}%`
                : '0%' }}
            />
          </div>
        </div>
      )}

      {/* File list */}
      <div className="flex-1 min-h-0 flex relative">
        {/* Folder tree sidebar (when layout is sidebar) */}
        {folderLayout === "sidebar" && (
          <>
            <FolderTreeSidebar
              currentPath={currentPath}
              onNavigate={onNavigate}
              listByParentId={listByParentId}
              width={sidebarWidth}
              isResizing={isResizing}
            />
            <ResizeHandle
              onResizeStart={() => { dragStartWidth.current = sidebarWidth; setIsResizing(true); }}
              onResize={(delta) => setSidebarWidth(Math.max(180, Math.min(400, dragStartWidth.current + delta)))}
              onResizeEnd={() => {
                setIsResizing(false);
                localStorage.setItem("files-sidebar-width", String(sidebarWidth));
              }}
              onDoubleClick={() => { setSidebarWidth(256); localStorage.setItem("files-sidebar-width", "256"); }}
            />
          </>
        )}
        {/* Favorites & Recent sidebar (when layout is inline) */}
        {folderLayout === "inline" && (favorites.length > 0 || recentFiles.length > 0) && (
          <div className="w-48 border-r border-border bg-background overflow-y-auto shrink-0 hidden lg:block">
            {favorites.length > 0 && (
              <div className="p-3">
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1">
                  <Star className="w-3 h-3" />
                  {t("favorites")}
                </h4>
                <div className="space-y-0.5">
                  {favorites.map((fav) => (
                    <button
                      key={fav}
                      onClick={() => onNavigate(fav)}
                      className={cn(
                        "w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-muted transition-colors text-left",
                        currentPath === fav && "bg-muted font-medium"
                      )}
                    >
                      <Folder className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                      <span className="truncate">{fav === '/' ? t("breadcrumb_root") : fav.split('/').pop()}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {recentFiles.length > 0 && (
              <div className="p-3 border-t border-border">
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {t("recent")}
                </h4>
                <div className="space-y-0.5">
                  {recentFiles.slice(0, 10).map((recent) => (
                    <button
                      key={recent.id}
                      className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-muted transition-colors text-left"
                      title={recent.name}
                    >
                      <File className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span className="truncate">{recent.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        <div
          ref={scrollAreaRef}
          className="flex-1 min-w-0 overflow-y-auto relative"
          onMouseDown={handleMarqueeMouseDown}
        >
        {isLoading && resources.length === 0 ? (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 sticky top-0 z-10">
              <tr className="border-b border-border">
                <th className="text-left px-4 py-2 font-medium text-muted-foreground">
                  <div className="flex items-center gap-3">
                    <div className="w-4 h-4" />
                    {t("name")}
                  </div>
                </th>
                <th className="text-left px-4 py-2 font-medium text-muted-foreground hidden md:table-cell w-24">{t("size")}</th>
                <th className="text-left px-4 py-2 font-medium text-muted-foreground hidden lg:table-cell w-44">{t("modified")}</th>
                <th className="w-10 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </tbody>
          </table>
        ) : resources.length === 0 && !searchQuery && currentPath === '/' ? (
          <FileUploadArea
            onUpload={async (files: File[]) => {
              setIsUploading(true);
              try {
                await onUploadFiles(files);
              } finally {
                setIsUploading(false);
              }
            }}
            onUploadFolder={async (files: File[]) => {
              setIsUploading(true);
              try {
                await onUploadFolder(files);
              } finally {
                setIsUploading(false);
              }
            }}
            onCreateFolder={() => setShowNewFolder(true)}
            onCreateTextFile={() => setShowNewTextFile(true)}
          />
        ) : viewMode === "grid" ? (
          /* ======= GRID VIEW ======= */
          <div className="p-4" role="grid" aria-label={t("file_list")}>
            {currentPath !== '/' && !searchQuery && (
              <div
                className={cn(
                  "inline-flex flex-col items-center gap-2 p-3 rounded-lg cursor-pointer transition-colors w-28",
                  dragTarget === '..' ? "bg-primary/5 ring-1 ring-primary/40" : "hover:bg-muted/50"
                )}
                onClick={handleNavigateUp}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes("application/x-file-names")) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setDragTarget('..');
                  }
                }}
                onDragLeave={() => setDragTarget(null)}
                onDrop={async (e) => {
                  e.preventDefault();
                  setDragTarget(null);
                  const raw = e.dataTransfer.getData("application/x-file-names");
                  if (!raw) return;
                  const names: string[] = JSON.parse(raw);
                  await onMoveToParent(names);
                }}
              >
                <Folder className="w-10 h-10 text-muted-foreground" />
                <span className="text-xs text-muted-foreground truncate w-full text-center">..</span>
              </div>
            )}
            {displayResources.length === 0 && searchQuery ? (
              <p className="px-4 py-8 text-center text-muted-foreground text-sm">{t("no_results")}</p>
            ) : (
              <div
                className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2"
                onContextMenu={(e) => {
                  if ((e.target as HTMLElement).closest('[data-resource]')) return;
                  e.preventDefault();
                  setEmptyContextMenu({ x: e.clientX, y: e.clientY });
                }}
              >
                {displayResources.map((resource) => (
                  <div
                    key={resource.id}
                    data-resource={resource.name}
                    draggable
                    onDragStart={(e) => {
                      const names = selectedResources.has(resource.name) ? [...selectedResources] : [resource.name];
                      e.dataTransfer.setData("application/x-file-names", JSON.stringify(names));
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(e) => {
                      if (resource.isDirectory) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        setDragTarget(resource.name);
                      }
                    }}
                    onDragLeave={() => setDragTarget(null)}
                    onDrop={async (e) => {
                      e.preventDefault();
                      setDragTarget(null);
                      if (!resource.isDirectory) return;
                      const raw = e.dataTransfer.getData("application/x-file-names");
                      if (!raw) return;
                      const names: string[] = JSON.parse(raw);
                      if (names.includes(resource.name)) return;
                      await onMoveToFolder(names, resource.name);
                    }}
                    className={cn(
                      "flex flex-col items-center gap-2 p-3 rounded-lg cursor-pointer transition-colors relative group",
                      selectedResources.has(resource.name)
                        ? "bg-primary/10 ring-1 ring-primary/30"
                        : dragTarget === resource.name
                          ? "bg-primary/5 ring-1 ring-primary/40"
                          : "hover:bg-muted/50",
                      clipboard?.mode === "cut" && clipboard.names.includes(resource.name) && "opacity-50"
                    )}
                    onClick={(e) => handleResourceClick(resource, e)}
                    onDoubleClick={() => handleResourceDoubleClick(resource)}
                    onContextMenu={(e) => handleContextMenu(e, resource.name)}
                  >
                    <input
                      type="checkbox"
                      checked={selectedResources.has(resource.name)}
                      onChange={() => onToggleSelect(resource.name)}
                      className="w-3.5 h-3.5 rounded border-border accent-primary cursor-pointer absolute top-2 left-2 opacity-0 group-hover:opacity-100 data-[checked=true]:opacity-100"
                      data-checked={selectedResources.has(resource.name)}
                      onClick={(e) => e.stopPropagation()}
                    />
                    {showThumbnails && isImageFile(resource.name)
                      ? <Thumbnail name={resource.name} getImageUrl={getImageUrl} size="lg" />
                      : getGridIcon(resource)}
                    <span className="text-xs truncate w-full text-center" title={resource.name}>
                      {resource.name}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          /* ======= LIST VIEW ======= */
          <table
            aria-label={t("file_list")}
            className="w-full text-sm"
            onContextMenu={(e) => {
              if ((e.target as HTMLElement).closest('tr[data-resource]')) return;
              e.preventDefault();
              setEmptyContextMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            <thead className="bg-muted/50 sticky top-0 z-10">
              <tr className="border-b border-border">
                <th className="text-left px-4 py-2 font-medium text-muted-foreground">
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(el) => { if (el) el.indeterminate = someSelected; }}
                      onChange={() => allSelected ? onClearSelection() : onSelectAll()}
                      className="w-4 h-4 rounded border-border accent-primary cursor-pointer"
                      onClick={(e) => e.stopPropagation()}
                    />
                    <button onClick={() => handleSortClick("name")} className="hover:text-foreground transition-colors">
                      {t("name")}
                      <SortIndicator column="name" />
                    </button>
                  </div>
                </th>
                <th className="text-left px-4 py-2 font-medium text-muted-foreground hidden md:table-cell w-24">
                  <button onClick={() => handleSortClick("size")} className="hover:text-foreground transition-colors">
                    {t("size")}
                    <SortIndicator column="size" />
                  </button>
                </th>
                <th className="text-left px-4 py-2 font-medium text-muted-foreground hidden lg:table-cell w-44">
                  <button onClick={() => handleSortClick("modified")} className="hover:text-foreground transition-colors">
                    {t("modified")}
                    <SortIndicator column="modified" />
                  </button>
                </th>
                <th className="w-10 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {currentPath !== '/' && !searchQuery && (
                <tr
                  className={cn(
                    "border-b border-border cursor-pointer transition-colors",
                    dragTarget === '..' ? "bg-primary/5 ring-1 ring-primary/40" : "hover:bg-muted/50"
                  )}
                  onClick={handleNavigateUp}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes("application/x-file-names")) {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setDragTarget('..');
                    }
                  }}
                  onDragLeave={() => setDragTarget(null)}
                  onDrop={async (e) => {
                    e.preventDefault();
                    setDragTarget(null);
                    const raw = e.dataTransfer.getData("application/x-file-names");
                    if (!raw) return;
                    const names: string[] = JSON.parse(raw);
                    await onMoveToParent(names);
                  }}
                >
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <div className="w-4 h-4" />
                      <Folder className="w-5 h-5 text-muted-foreground" />
                      <span className="text-muted-foreground">..</span>
                    </div>
                  </td>
                  <td className="hidden md:table-cell" />
                  <td className="hidden lg:table-cell" />
                  <td />
                </tr>
              )}
              {displayResources.length === 0 && searchQuery ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground text-sm">
                    {t("no_results")}
                  </td>
                </tr>
              ) : displayResources.map((resource) => (
                <tr
                  key={resource.id}
                  data-resource={resource.name}
                  aria-selected={selectedResources.has(resource.name)}
                  draggable
                  onDragStart={(e) => {
                    const names = selectedResources.has(resource.name) ? [...selectedResources] : [resource.name];
                    e.dataTransfer.setData("application/x-file-names", JSON.stringify(names));
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    if (resource.isDirectory) {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setDragTarget(resource.name);
                    }
                  }}
                  onDragLeave={() => setDragTarget(null)}
                  onDrop={async (e) => {
                    e.preventDefault();
                    setDragTarget(null);
                    if (!resource.isDirectory) return;
                    const raw = e.dataTransfer.getData("application/x-file-names");
                    if (!raw) return;
                    const names: string[] = JSON.parse(raw);
                    if (names.includes(resource.name)) return;
                    await onMoveToFolder(names, resource.name);
                  }}
                  className={cn(
                    "border-b border-border cursor-pointer transition-colors",
                    selectedResources.has(resource.name)
                      ? "bg-primary/10"
                      : dragTarget === resource.name
                        ? "bg-primary/5 ring-1 ring-primary/40"
                        : "hover:bg-muted/50",
                    clipboard?.mode === "cut" && clipboard.names.includes(resource.name) && "opacity-50"
                  )}
                  onClick={(e) => handleResourceClick(resource, e)}
                  onDoubleClick={() => handleResourceDoubleClick(resource)}
                  onContextMenu={(e) => handleContextMenu(e, resource.name)}
                >
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3 min-w-0">
                      <input
                        type="checkbox"
                        checked={selectedResources.has(resource.name)}
                        onChange={() => onToggleSelect(resource.name)}
                        className="w-4 h-4 rounded border-border accent-primary cursor-pointer shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      />
                      {showThumbnails && isImageFile(resource.name)
                        ? <Thumbnail name={resource.name} getImageUrl={getImageUrl} size="sm" />
                        : getFileIcon(resource)}
                      <span className="truncate">{resource.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground hidden md:table-cell tabular-nums">
                    {resource.isDirectory ? "-" : formatFileSize(resource.contentLength)}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground hidden lg:table-cell tabular-nums">
                    {formatDate(resource.lastModified)}
                  </td>
                  <td className="px-2 py-2.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleContextMenu(e, resource.name);
                      }}
                      className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <MoreVertical className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Context menu */}
        {contextMenu && (
          <div
            ref={contextMenuRef}
            role="menu"
            aria-label={t("context_menu")}
            className="fixed z-50 bg-background border border-border rounded-lg shadow-lg py-1 min-w-[160px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {!resources.find(r => r.name === contextMenu.name)?.isDirectory && isPreviewable(contextMenu.name) && (
              <button
                className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
                onClick={() => {
                  if (isImageFile(contextMenu.name)) {
                    onPreviewImage(contextMenu.name);
                  } else {
                    onPreviewFile(contextMenu.name);
                  }
                  setContextMenu(null);
                }}
              >
                <ImageIcon className="w-4 h-4" />
                {t("preview")}
              </button>
            )}
            {!resources.find(r => r.name === contextMenu.name)?.isDirectory && (
              <button
                className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
                onClick={() => {
                  onDownload(contextMenu.name);
                  setContextMenu(null);
                }}
              >
                <Download className="w-4 h-4" />
                {t("download")}
              </button>
            )}
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
              onClick={() => {
                onCut([contextMenu.name]);
                setContextMenu(null);
              }}
            >
              <Scissors className="w-4 h-4" />
              {t("cut")}
            </button>
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
              onClick={() => {
                onCopy([contextMenu.name]);
                setContextMenu(null);
              }}
            >
              <Copy className="w-4 h-4" />
              {t("copy")}
            </button>
            {clipboard && (
              <button
                className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
                onClick={() => {
                  onPaste();
                  setContextMenu(null);
                }}
              >
                <Clipboard className="w-4 h-4" />
                {t("paste")}
              </button>
            )}
            {!resources.find(r => r.name === contextMenu.name)?.isDirectory && (
              <button
                className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
                onClick={() => {
                  onDuplicate(contextMenu.name);
                  setContextMenu(null);
                }}
              >
                <CopyPlus className="w-4 h-4" />
                {t("duplicate")}
              </button>
            )}
            <div className="h-px bg-border my-1" />
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
              onClick={() => {
                onShowDetails(contextMenu.name);
                setContextMenu(null);
              }}
            >
              <Info className="w-4 h-4" />
              {t("details")}
            </button>
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
              onClick={() => {
                setRenameTarget(contextMenu.name);
                setContextMenu(null);
              }}
            >
              <Pencil className="w-4 h-4" />
              {t("rename")}
            </button>
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted text-destructive transition-colors text-left"
              onClick={() => {
                onDelete(contextMenu.name);
                setContextMenu(null);
              }}
            >
              <Trash2 className="w-4 h-4" />
              {t("delete")}
            </button>
          </div>
        )}

        {/* Empty-area context menu */}
        {emptyContextMenu && (
          <div
            role="menu"
            aria-label={t("context_menu")}
            className="fixed z-50 bg-background border border-border rounded-lg shadow-lg py-1 min-w-[160px]"
            style={{ left: emptyContextMenu.x, top: emptyContextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
              onClick={() => {
                setShowNewFolder(true);
                setEmptyContextMenu(null);
              }}
            >
              <FolderPlus className="w-4 h-4" />
              {t("new_folder")}
            </button>
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
              onClick={() => {
                setShowNewTextFile(true);
                setEmptyContextMenu(null);
              }}
            >
              <FilePlus className="w-4 h-4" />
              {t("new_text_file")}
            </button>
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
              onClick={() => {
                fileInputRef.current?.click();
                setEmptyContextMenu(null);
              }}
            >
              <Upload className="w-4 h-4" />
              {t("upload")}
            </button>
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
              onClick={() => {
                folderInputRef.current?.click();
                setEmptyContextMenu(null);
              }}
            >
              <FolderUp className="w-4 h-4" />
              {t("upload_folder")}
            </button>
            {clipboard && (
              <>
                <div className="h-px bg-border my-1" />
                <button
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
                  onClick={() => {
                    onPaste();
                    setEmptyContextMenu(null);
                  }}
                >
                  <Clipboard className="w-4 h-4" />
                  {t("paste")}
                </button>
              </>
            )}
            <div className="h-px bg-border my-1" />
            <button
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
              onClick={() => {
                onRefresh();
                setEmptyContextMenu(null);
              }}
            >
              <RefreshCw className="w-4 h-4" />
              {t("refresh")}
            </button>
          </div>
        )}

        {/* Breadcrumb dropdown */}
        {breadcrumbDropdown && (
          <div
            role="menu"
            aria-label={t("breadcrumb_root")}
            className="fixed z-50 bg-background border border-border rounded-lg shadow-lg py-1 min-w-[180px] max-h-64 overflow-y-auto"
            style={{ left: breadcrumbDropdown.x, top: breadcrumbDropdown.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {breadcrumbDropdown.folders.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">{t("no_results")}</p>
            ) : (
              breadcrumbDropdown.folders.map((folder) => {
                const folderPath = breadcrumbDropdown.path === '/'
                  ? `/${folder.name}`
                  : `${breadcrumbDropdown.path}/${folder.name}`;
                return (
                  <button
                    key={folder.id}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
                    onClick={() => {
                      onNavigate(folderPath, folder.id);
                      setBreadcrumbDropdown(null);
                    }}
                  >
                    <Folder className="w-4 h-4 text-blue-500 shrink-0" />
                    <span className="truncate">{folder.name}</span>
                  </button>
                );
              })
            )}
          </div>
        )}

        {/* Marquee selection rectangle */}
        {marquee && (
          <div
            className="absolute border border-primary/50 bg-primary/10 pointer-events-none z-20"
            style={{
              left: Math.min(marquee.startX, marquee.currentX),
              top: Math.min(marquee.startY, marquee.currentY),
              width: Math.abs(marquee.currentX - marquee.startX),
              height: Math.abs(marquee.currentY - marquee.startY),
            }}
          />
        )}
        </div>

        {/* Details sidebar */}
        {showDetails && detailResource && (
          <div role="complementary" aria-label={t("details")} className="w-64 border-l border-border bg-background p-4 overflow-y-auto shrink-0 hidden md:block">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-medium">{t("details")}</h3>
              <button onClick={onToggleDetails} className="text-muted-foreground hover:text-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex flex-col items-center gap-3 mb-4">
              {detailResource.isDirectory
                ? <Folder className="w-12 h-12 text-blue-500" />
                : getFileIconByName(detailResource.name, "lg")}
              <p className="text-sm font-medium text-center break-all">{detailResource.name}</p>
            </div>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-muted-foreground text-xs">{t("type")}</dt>
                <dd>{detailResource.isDirectory ? t("folder") : (detailResource.contentType || t("file"))}</dd>
              </div>
              {!detailResource.isDirectory && (
                <div>
                  <dt className="text-muted-foreground text-xs">{t("size")}</dt>
                  <dd className="tabular-nums">{formatFileSize(detailResource.contentLength)}</dd>
                </div>
              )}
              {detailResource.lastModified && (
                <div>
                  <dt className="text-muted-foreground text-xs">{t("modified")}</dt>
                  <dd className="tabular-nums">{formatDate(detailResource.lastModified)}</dd>
                </div>
              )}
              <div>
                <dt className="text-muted-foreground text-xs">{t("path")}</dt>
                <dd className="text-xs break-all font-mono">
                  {currentPath === "/" ? `/${detailResource.name}` : `${currentPath}/${detailResource.name}`}
                </dd>
              </div>
            </dl>
          </div>
        )}
      </div>

      {/* New folder dialog */}
      {showNewFolder && (
        <NewFolderDialog
          onConfirm={async (name: string) => {
            await onCreateFolder(name);
            setShowNewFolder(false);
          }}
          onCancel={() => setShowNewFolder(false)}
        />
      )}

      {/* New text file dialog */}
      {showNewTextFile && (
        <RenameDialog
          currentName="new-file.txt"
          title={t("new_text_file")}
          label={t("file_name")}
          onConfirm={async (name: string) => {
            await onCreateTextFile(name);
            setShowNewTextFile(false);
          }}
          onCancel={() => setShowNewTextFile(false)}
        />
      )}

      {/* Rename dialog */}
      {renameTarget && (
        <RenameDialog
          currentName={renameTarget}
          onConfirm={async (newName: string) => {
            await onRename(renameTarget, newName);
            setRenameTarget(null);
          }}
          onCancel={() => setRenameTarget(null)}
        />
      )}
    </div>
  );
}
