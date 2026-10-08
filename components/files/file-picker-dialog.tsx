"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Check, ChevronRight, Folder, Loader2, Search, Users, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { debug } from "@/lib/debug";
import { cn, formatFileSize } from "@/lib/utils";
import { getFileIconByName } from "@/components/files/file-icons";
import { loadFilesSettings } from "@/components/files/files-settings-dialog";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { FileNode } from "@/lib/jmap/types";

// The level that holds what other people share with the user. JMAP ids are
// base64url (shared ones add an "accountId:" prefix), so "#" never collides.
const SHARED_WITH_ME = "#shared";

const MAX_SEARCH_RESULTS = 200;

interface FilePickerDialogProps {
  /** Client of the account whose files are listed. */
  client: IJMAPClient;
  onClose: () => void;
  /** Called with the chosen files, never folders. */
  onPick: (files: FileNode[]) => void;
}

// A FileNode is a folder iff it has no content blob (see isFolder in the file store).
function isFolder(node: FileNode): boolean {
  return node.blobId == null;
}

function byFolderThenName(a: FileNode, b: FileNode): number {
  if (isFolder(a) !== isFolder(b)) return isFolder(a) ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * Lets the user pick files from the Files app, for example to attach them to a
 * message (#1179). Lists the whole tree once and browses it locally, so it
 * leaves the Files app's own location and selection alone.
 */
export function FilePickerDialog({ client, onClose, onPick }: FilePickerDialogProps) {
  const t = useTranslations("files");
  const tComposer = useTranslations("email_composer");
  const [nodes, setNodes] = useState<FileNode[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Map<string, FileNode>>(() => new Map());
  const [showHidden] = useState(() => loadFilesSettings().showHiddenFiles);

  const modalRef = useFocusTrap({ isActive: true, onEscape: onClose, restoreFocus: true });

  useEffect(() => {
    let cancelled = false;
    client.listAllFileNodesAcrossAccounts().then(
      (list) => {
        if (!cancelled) setNodes(list);
      },
      (error) => {
        debug.error("Failed to list files for the picker:", error);
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, attempt]);

  const retry = () => {
    setNodes(null);
    setFailed(false);
    setAttempt((n) => n + 1);
  };

  const byId = useMemo(() => new Map((nodes ?? []).map((n) => [n.id, n])), [nodes]);

  // Shared nodes whose parent the user can't see, as in the Files app's
  // "Shared with me".
  const sharedRoots = useMemo(
    () => (nodes ?? []).filter((n) => n.isShared && (n.parentId == null || !byId.has(n.parentId))),
    [nodes, byId],
  );

  const here = trail.length > 0 ? trail[trail.length - 1].id : null;
  const needle = query.trim().toLowerCase();

  const entries = useMemo(() => {
    if (!nodes) return [];
    if (needle) {
      return nodes
        .filter((n) => !isFolder(n) && n.name.toLowerCase().includes(needle))
        .filter((n) => showHidden || !n.name.startsWith("."))
        .sort(byFolderThenName)
        .slice(0, MAX_SEARCH_RESULTS);
    }
    const level = here === SHARED_WITH_ME
      ? sharedRoots
      : nodes.filter((n) => (n.parentId ?? null) === here && (here !== null || !n.isShared));
    return level.filter((n) => showHidden || !n.name.startsWith(".")).sort(byFolderThenName);
  }, [nodes, needle, here, sharedRoots, showHidden]);

  // Where a search hit lives, e.g. "userb@example.org / Projects".
  const folderPath = (node: FileNode): string => {
    const names: string[] = [];
    const seen = new Set<string>();
    let parent = node.parentId ? byId.get(node.parentId) : undefined;
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      names.unshift(parent.name);
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    if (node.isShared && node.accountName) names.unshift(node.accountName);
    return names.join(" / ");
  };

  const openFolder = (id: string, name: string) => {
    setTrail((prev) => [...prev, { id, name }]);
    setQuery("");
  };

  const toggle = (node: FileNode) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(node.id)) next.delete(node.id);
      else next.set(node.id, node);
      return next;
    });
  };

  const folderRow = (key: string, name: string, icon: ReactNode, onOpen: () => void, detail?: string) => (
    <button
      key={key}
      type="button"
      onClick={onOpen}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-start text-sm hover:bg-muted transition-colors"
    >
      {icon}
      <span className="flex-1 min-w-0">
        <span className="block truncate">{name}</span>
        {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
      <ChevronRight className="w-4 h-4 shrink-0 text-muted-foreground rtl:rotate-180" />
    </button>
  );

  const fileRow = (node: FileNode, detail?: string) => {
    const checked = selected.has(node.id);
    return (
      <button
        key={node.id}
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={() => toggle(node)}
        className={cn(
          "w-full flex items-center gap-3 px-3 py-2 rounded-md text-start text-sm transition-colors",
          checked ? "bg-primary/10" : "hover:bg-muted",
        )}
      >
        <span
          className={cn(
            "w-4 h-4 rounded border flex items-center justify-center shrink-0",
            checked ? "bg-primary border-primary text-primary-foreground" : "border-border",
          )}
        >
          {checked && <Check className="w-3 h-3" />}
        </span>
        {getFileIconByName(node.name, "sm")}
        <span className="flex-1 min-w-0">
          <span className="block truncate">{node.name}</span>
          {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatFileSize(node.size)}</span>
      </button>
    );
  };

  const sharedBy = (node: FileNode) =>
    here === SHARED_WITH_ME && node.accountName ? t("shared_by", { name: node.accountName }) : undefined;

  let body: ReactNode;
  if (failed) {
    body = (
      <div className="flex flex-col items-center gap-3 py-10 text-sm text-muted-foreground">
        <AlertCircle className="w-6 h-6" />
        <p>{tComposer("files_picker.load_failed")}</p>
        <Button variant="outline" size="sm" onClick={retry}>{t("retry")}</Button>
      </div>
    );
  } else if (!nodes) {
    body = (
      <div className="flex justify-center py-10 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    );
  } else if (entries.length === 0 && !(here === null && !needle && sharedRoots.length > 0)) {
    body = (
      <p className="py-10 text-center text-sm text-muted-foreground">
        {needle ? t("no_results") : here === null ? t("empty_state_title") : tComposer("files_picker.empty_folder")}
      </p>
    );
  } else {
    body = (
      <div className="space-y-0.5">
        {here === null && !needle && sharedRoots.length > 0 && folderRow(
          SHARED_WITH_ME,
          t("shared_with_me"),
          <Users className="w-5 h-5 shrink-0 text-blue-500" />,
          () => openFolder(SHARED_WITH_ME, t("shared_with_me")),
        )}
        {entries.map((node) =>
          isFolder(node)
            ? folderRow(
                node.id,
                node.name,
                <Folder className="w-5 h-5 shrink-0 text-blue-500" />,
                () => openFolder(node.id, node.name),
                sharedBy(node),
              )
            : fileRow(node, needle ? folderPath(node) : sharedBy(node)),
        )}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 animate-in fade-in duration-150">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-picker-title"
        className="bg-background border border-border rounded-lg shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
        data-testid="file-picker-dialog"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 id="file-picker-title" className="text-sm font-semibold text-foreground">
            {tComposer("attach_from_files")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("cancel")}
            className="p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-2 border-b border-border space-y-2">
          <div className="relative">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("search_placeholder")}
              className="ps-9 h-9"
            />
          </div>
          {!needle && (
            <nav className="flex items-center gap-1 text-sm min-w-0 overflow-x-auto" aria-label={t("path")}>
              <button
                type="button"
                onClick={() => setTrail([])}
                className={cn(
                  "shrink-0 px-1.5 py-0.5 rounded hover:bg-muted",
                  trail.length === 0 ? "font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {t("breadcrumb_root")}
              </button>
              {trail.map((crumb, i) => (
                <span key={crumb.id} className="flex items-center gap-1 min-w-0">
                  <ChevronRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground rtl:rotate-180" />
                  <button
                    type="button"
                    onClick={() => setTrail(trail.slice(0, i + 1))}
                    className={cn(
                      "truncate max-w-[10rem] px-1.5 py-0.5 rounded hover:bg-muted",
                      i === trail.length - 1 ? "font-medium text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </nav>
          )}
        </div>

        <div className="flex-1 min-h-[12rem] overflow-y-auto p-2">{body}</div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <Button variant="outline" onClick={onClose}>{t("cancel")}</Button>
          <Button
            onClick={() => onPick([...selected.values()])}
            disabled={selected.size === 0}
            data-testid="file-picker-attach"
          >
            {tComposer("files_picker.attach", { count: selected.size })}
          </Button>
        </div>
      </div>
    </div>
  );
}
