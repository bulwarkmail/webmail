"use client";

import { useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, HardDrive } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface PickerFolder {
  id: string;
  name: string;
  parentId: string | null;
}

interface FolderPickerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called with the chosen folder; null is the root ("My files"). */
  onPick: (folderId: string | null) => void;
  title: string;
  confirmText: string;
  /** Every folder of the drive; the tree is built from their parent links. */
  folders: PickerFolder[];
  /** Folders that can't be picked, with what is below them (what is being moved). */
  excludeIds?: Set<string>;
  /** The folder that is pre-selected and can't be picked (where the items already are). */
  currentId?: string | null;
  /** A folder selected and ready to pick when the dialog opens; null is My files. */
  initialSelectedId?: string | null;
  /**
   * Offers "New folder" in the selected folder: makes it and answers it (or null), and the
   * caller adds it to `folders`; it's selected then. `newFolderName` is the name it starts with.
   */
  onCreateFolder?: (parentId: string | null, name: string) => Promise<PickerFolder | null>;
  newFolderName?: string;
}

const ROOT = "";

/**
 * Picks a folder of the user's drive, e.g. to move items there: the folder
 * tree with My files at the top, browsed with the mouse or the arrow keys.
 */
export function FolderPickerDialog({
  isOpen, onClose, onPick, title, confirmText, folders, excludeIds, currentId = null, initialSelectedId, onCreateFolder, newFolderName = "",
}: FolderPickerDialogProps) {
  const t = useTranslations("files");
  const [selected, setSelected] = useState<string | null>(
    initialSelectedId === undefined ? null : (initialSelectedId ?? ROOT),
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([ROOT]));
  const listRef = useRef<HTMLDivElement>(null);
  /** The name of a folder being made, or null while nobody is. */
  const [making, setMaking] = useState<string | null>(null);
  const [makeBusy, setMakeBusy] = useState(false);
  const [makeFailed, setMakeFailed] = useState(false);

  const childrenOf = useMemo(() => {
    const map = new Map<string, PickerFolder[]>();
    for (const folder of folders) {
      if (excludeIds?.has(folder.id)) continue;
      const key = folder.parentId ?? ROOT;
      const list = map.get(key) ?? [];
      list.push(folder);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return map;
  }, [folders, excludeIds]);

  // The rows on screen: the root, then every folder whose parents are open.
  const rows = useMemo(() => {
    const out: { id: string; name: string; depth: number; hasChildren: boolean }[] = [
      { id: ROOT, name: t("my_files"), depth: 0, hasChildren: (childrenOf.get(ROOT)?.length ?? 0) > 0 },
    ];
    const walk = (parent: string, depth: number) => {
      if (!expanded.has(parent)) return;
      for (const folder of childrenOf.get(parent) ?? []) {
        out.push({ id: folder.id, name: folder.name, depth, hasChildren: (childrenOf.get(folder.id)?.length ?? 0) > 0 });
        walk(folder.id, depth + 1);
      }
    };
    walk(ROOT, 1);
    return out;
  }, [childrenOf, expanded, t]);

  const current = currentId ?? ROOT;
  const canPick = selected !== null && selected !== current;

  const toggle = (id: string, open?: boolean) => setExpanded((prev) => {
    const next = new Set(prev);
    if (open ?? !next.has(id)) next.add(id);
    else next.delete(id);
    return next;
  });

  const focusRow = (id: string) => {
    setSelected(id);
    listRef.current?.querySelector<HTMLElement>(`[data-folder-id="${CSS.escape(id)}"]`)?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const index = rows.findIndex((r) => r.id === (selected ?? current));
    const row = rows[index];
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const openKey = rtl ? "ArrowLeft" : "ArrowRight";
    const closeKey = rtl ? "ArrowRight" : "ArrowLeft";
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) focusRow(next.id);
    } else if (e.key === openKey && row?.hasChildren) {
      e.preventDefault();
      toggle(row.id, true);
    } else if (e.key === closeKey && row) {
      e.preventDefault();
      if (row.hasChildren && expanded.has(row.id)) toggle(row.id, false);
    }
  };

  const pick = () => {
    if (!canPick) return;
    onPick(selected === ROOT ? null : selected);
    onClose();
  };

  const make = () => {
    const name = making?.trim();
    if (!onCreateFolder || !name || makeBusy) return;
    const parent = selected === null || selected === ROOT ? null : selected;
    setMakeBusy(true);
    setMakeFailed(false);
    void onCreateFolder(parent, name).then((folder) => {
      if (!folder) {
        setMakeFailed(true);
        return;
      }
      setMaking(null);
      toggle(parent ?? ROOT, true);
      setSelected(folder.id);
    }, () => setMakeFailed(true)).finally(() => setMakeBusy(false));
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      onSubmit={(e) => { e.preventDefault(); pick(); }}
      footer={
        <>
          {onCreateFolder && making === null && (
            <Button type="button" variant="ghost" className="me-auto gap-1.5" onClick={() => { setMakeFailed(false); setMaking(newFolderName); }} data-testid="folder-picker-new">
              <FolderPlus className="w-4 h-4" />{t("new_folder")}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>{t("cancel")}</Button>
          <Button type="submit" disabled={!canPick}>{confirmText}</Button>
        </>
      }
    >
      {making !== null && (
        <div className="mt-4 flex items-center gap-2">
          <input
            autoFocus
            aria-label={t("new_folder")}
            value={making}
            onChange={(e) => setMaking(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); make(); }
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setMaking(null); }
            }}
            className="flex-1 min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            data-testid="folder-picker-new-name"
          />
          <Button type="button" size="sm" disabled={!making.trim() || makeBusy} onClick={make}>{t("create")}</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setMaking(null)}>{t("cancel")}</Button>
        </div>
      )}
      {makeFailed && <p role="alert" className="mt-2 text-sm text-destructive">{t("create_folder_error")}</p>}
      <div
        ref={listRef}
        role="tree"
        aria-label={t("folders")}
        onKeyDown={onKeyDown}
        className="mt-4 max-h-80 overflow-y-auto rounded-md border border-border py-1"
      >
        {rows.map((row) => {
          const isOpen = expanded.has(row.id);
          const isSelected = (selected ?? current) === row.id;
          const isCurrent = row.id === current;
          const Icon = row.id === ROOT ? HardDrive : isOpen && row.hasChildren ? FolderOpen : Folder;
          return (
            <div
              key={row.id || "root"}
              role="treeitem"
              aria-selected={isSelected}
              aria-expanded={row.hasChildren ? isOpen : undefined}
              aria-disabled={isCurrent || undefined}
              data-folder-id={row.id}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => setSelected(row.id)}
              onDoubleClick={() => { if (row.id !== current) { onPick(row.id === ROOT ? null : row.id); onClose(); } }}
              className={cn(
                "flex items-center gap-1.5 pe-3 h-9 text-sm cursor-default select-none outline-none focus-inset",
                isSelected ? "bg-selection" : "hover:bg-muted",
                isCurrent && "text-muted-foreground",
              )}
              style={{ paddingInlineStart: `${8 + row.depth * 16}px` }}
            >
              {row.hasChildren ? (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={isOpen ? t("collapse_folder", { name: row.name }) : t("expand_folder", { name: row.name })}
                  onClick={(e) => { e.stopPropagation(); toggle(row.id); }}
                  className="p-0.5 rounded hover:bg-foreground/10 text-muted-foreground shrink-0"
                >
                  {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                </button>
              ) : (
                <span className="w-[18px] shrink-0" />
              )}
              <Icon className="w-4 h-4 shrink-0 text-primary" />
              <span className="truncate" title={row.name}>{row.name}</span>
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
