"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Home,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useFileStore, type FileResource } from "@/stores/file-store";

interface FolderNode {
  id: string;
  name: string;
  path: string;
}

interface FolderTreeSidebarProps {
  currentPath: string;
  onNavigate: (path: string, resourceId?: string | null) => void;
  listByParentId: (parentId: string | null) => Promise<FileResource[]>;
  width?: number;
  isResizing?: boolean;
}

export function FolderTreeSidebar({ currentPath, onNavigate, listByParentId, width = 256, isResizing }: FolderTreeSidebarProps) {
  const t = useTranslations("files");
  const client = useFileStore(s => s.client);
  const [rootChildren, setRootChildren] = useState<FolderNode[] | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set(["root"]));
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  // Cache: parentId (or "root") -> FolderNode[]
  const [childrenCache, setChildrenCache] = useState<Map<string, FolderNode[]>>(new Map());
  // Map folder path -> id for reverse lookup
  const pathToIdRef = useRef<Map<string, string>>(new Map());

  const loadChildren = useCallback(async (parentId: string | null, parentPath: string) => {
    const cacheKey = parentId ?? "root";
    // Skip if already loading or cached
    if (childrenCache.has(cacheKey)) return;

    setLoadingIds(prev => new Set(prev).add(cacheKey));
    try {
      const resources = await listByParentId(parentId);
      const folders = resources
        .filter(r => r.isDirectory)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(r => {
          const folderPath = parentPath === "/" ? `/${r.name}` : `${parentPath}/${r.name}`;
          pathToIdRef.current.set(folderPath, r.id);
          return {
            id: r.id,
            name: r.name,
            path: folderPath,
          };
        });

      // Don't cache empty root results - empty root likely means client wasn't ready yet
      if (folders.length > 0 || parentId !== null) {
        setChildrenCache(prev => new Map(prev).set(cacheKey, folders));
      }

      if (parentId === null) {
        setRootChildren(folders);
      }
    } catch {
      // Silently fail
    } finally {
      setLoadingIds(prev => {
        const next = new Set(prev);
        next.delete(cacheKey);
        return next;
      });
    }
  }, [childrenCache, listByParentId]);

  // Load root folders when client is available (handles page refresh timing)
  useEffect(() => {
    if (client) {
      loadChildren(null, "/");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  // Auto-expand along the current path when navigating
  useEffect(() => {
    if (currentPath === "/") return;
    const segments = currentPath.split("/").filter(Boolean);

    // Walk down the path and expand + load each ancestor
    let ancestorPath = "";
    for (let i = 0; i < segments.length; i++) {
      ancestorPath = "/" + segments.slice(0, i + 1).join("/");
      const folderId = pathToIdRef.current.get(ancestorPath);
      if (folderId) {
        setExpandedIds(prev => {
          if (prev.has(folderId)) return prev;
          return new Set(prev).add(folderId);
        });
        if (!childrenCache.has(folderId)) {
          loadChildren(folderId, ancestorPath);
        }
      }
    }
  }, [currentPath, childrenCache, loadChildren]);

  const handleToggleExpand = useCallback(async (folderId: string, folderPath: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });

    if (!childrenCache.has(folderId)) {
      await loadChildren(folderId, folderPath);
    }
  }, [childrenCache, loadChildren]);

  const handleFolderClick = useCallback((path: string, id: string | null) => {
    onNavigate(path, id);
  }, [onNavigate]);

  return (
    <div
      className={cn(
        "border-r border-border bg-secondary overflow-hidden shrink-0 hidden lg:flex flex-col",
        !isResizing && "transition-[width] duration-300"
      )}
      style={{ width: `${width}px` }}
    >
      <div className="flex-1 overflow-y-auto py-1">
        {/* Root / Home entry */}
        <div
          style={{ paddingBlock: "var(--density-sidebar-py)" }}
          className={cn(
            "group w-full flex items-center max-lg:min-h-[44px] text-sm transition-all duration-200 px-2",
            currentPath === "/"
              ? "bg-accent text-accent-foreground"
              : "hover:bg-muted text-foreground",
            "font-medium"
          )}
        >
          <button
            onClick={() => handleFolderClick("/", null)}
            className="flex items-center px-1 rounded transition-colors duration-150 flex-1 text-left"
            style={{ paddingBlock: "var(--density-sidebar-py)", paddingLeft: "24px" }}
          >
            <Home className={cn("w-4 h-4 flex-shrink-0 mr-2 transition-colors")} />
            <span className="truncate">{t("breadcrumb_root")}</span>
          </button>
        </div>

        {/* Folder tree */}
        {rootChildren === null && loadingIds.has("root") ? (
          <div className="px-3 py-2 space-y-2">
            <div className="h-4 w-24 bg-muted animate-pulse rounded" />
            <div className="h-4 w-20 bg-muted animate-pulse rounded" />
            <div className="h-4 w-28 bg-muted animate-pulse rounded" />
          </div>
        ) : (
          rootChildren?.map(folder => (
            <FolderTreeItem
              key={folder.id}
              node={folder}
              depth={0}
              currentPath={currentPath}
              expandedIds={expandedIds}
              loadingIds={loadingIds}
              childrenCache={childrenCache}
              onToggleExpand={handleToggleExpand}
              onFolderClick={handleFolderClick}
              onLoadChildren={loadChildren}
            />
          ))
        )}
      </div>
    </div>
  );
}

function FolderTreeItem({
  node,
  depth,
  currentPath,
  expandedIds,
  loadingIds,
  childrenCache,
  onToggleExpand,
  onFolderClick,
  onLoadChildren,
}: {
  node: FolderNode;
  depth: number;
  currentPath: string;
  expandedIds: Set<string>;
  loadingIds: Set<string>;
  childrenCache: Map<string, FolderNode[]>;
  onToggleExpand: (folderId: string, folderPath: string) => void;
  onFolderClick: (path: string, id: string | null) => void;
  onLoadChildren: (parentId: string, parentPath: string) => Promise<void>;
}) {
  const isExpanded = expandedIds.has(node.id);
  const isSelected = currentPath === node.path;
  const _isLoading = loadingIds.has(node.id);
  const children = childrenCache.get(node.id);
  const hasChildren = children !== undefined && children.length > 0;
  const indentPx = depth * 16;
  const Icon = isExpanded && hasChildren ? FolderOpen : Folder;

  // Eagerly load children on mount to know if subfolders exist
  useEffect(() => {
    if (children === undefined && !loadingIds.has(node.id)) {
      onLoadChildren(node.id, node.path);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div
        style={{ paddingBlock: "var(--density-sidebar-py)" }}
        className={cn(
          "group w-full flex items-center max-lg:min-h-[44px] text-sm transition-all duration-200 px-2",
          isSelected
            ? "bg-accent text-accent-foreground"
            : "hover:bg-muted text-foreground",
          depth === 0 && "font-medium"
        )}
      >
        {/* Expand/collapse chevron */}
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand(node.id, node.path);
            }}
            className={cn(
              "p-0.5 rounded mr-1 transition-all duration-200",
              "hover:bg-muted active:bg-accent"
            )}
            style={{ marginLeft: `${indentPx}px` }}
          >
            {isExpanded ? (
              <ChevronDown className="w-3 h-3 text-muted-foreground" />
            ) : (
              <ChevronRight className="w-3 h-3 text-muted-foreground" />
            )}
          </button>
        ) : null}

        {/* Folder name */}
        <button
          onClick={() => onFolderClick(node.path, node.id)}
          className="flex items-center px-1 rounded transition-colors duration-150 flex-1 text-left"
          style={{
            paddingBlock: "var(--density-sidebar-py)",
            paddingLeft: hasChildren ? "4px" : `${indentPx + 24}px`,
          }}
        >
          <Icon className={cn(
            "w-4 h-4 flex-shrink-0 mr-2 transition-colors",
            isExpanded && hasChildren && "text-primary",
            !hasChildren && depth > 0 && "text-muted-foreground"
          )} />
          <span className="truncate">{node.name}</span>
        </button>
      </div>

      {/* Children */}
      {isExpanded && children && (
        <div className="relative">
          {children.map(child => (
            <FolderTreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              currentPath={currentPath}
              expandedIds={expandedIds}
              loadingIds={loadingIds}
              childrenCache={childrenCache}
              onToggleExpand={onToggleExpand}
              onFolderClick={onFolderClick}
              onLoadChildren={onLoadChildren}
            />
          ))}
        </div>
      )}
    </>
  );
}
