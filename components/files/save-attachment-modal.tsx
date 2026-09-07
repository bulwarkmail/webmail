"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { X, Loader2, Folder, ChevronRight, Check } from "lucide-react";
import type { FileNode } from "@/lib/jmap/types";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import { toast } from "@/stores/toast-store";
import { isFolder } from "@/stores/file-store";

export interface SaveAttachmentBlobRef {
  /** Client that can read this blob - may differ from `client` in unified/multi-account views. */
  client: IJMAPClient;
  accountId: string;
  blobId: string;
  name: string;
  type: string;
  size: number;
}

interface SaveAttachmentModalProps {
  /** Client owning the Files account the attachment is being saved into. */
  client: IJMAPClient;
  source: SaveAttachmentBlobRef;
  onClose: () => void;
}

interface Crumb {
  id: string | null;
  name: string;
}

export function SaveAttachmentModal({ client, source, onClose }: SaveAttachmentModalProps) {
  const t = useTranslations("files.save_attachment");
  const tFiles = useTranslations("files");
  const tCommon = useTranslations("common");
  const tForm = useTranslations("calendar.form");

  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: null, name: tFiles("breadcrumb_root") }]);
  const [folders, setFolders] = useState<FileNode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const currentParentId = crumbs[crumbs.length - 1]?.id ?? null;

  const loadFolders = useCallback(async (parentId: string | null) => {
    setIsLoading(true);
    setError(null);
    try {
      const nodes = await client.listFileNodes(parentId);
      setFolders(nodes.filter(isFolder).sort((a, b) => a.name.localeCompare(b.name)));
    } catch {
      setError(t("load_error"));
    } finally {
      setIsLoading(false);
    }
  }, [client, t]);

  useEffect(() => {
    loadFolders(currentParentId);
    // Only the current folder id should re-trigger a fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentParentId]);

  const enterFolder = (folder: FileNode) => {
    setCrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
  };

  const jumpToCrumb = (index: number) => {
    setCrumbs((prev) => prev.slice(0, index + 1));
  };

  const handleSaveHere = useCallback(async () => {
    setIsSaving(true);
    setError(null);
    try {
      const filesAccountId = client.getFilesAccountId();
      // A blob id only resolves within the account it was uploaded/received
      // in (JMAP blobs are account-scoped) - reuse it directly when the
      // attachment already lives in the Files account (the common case), and
      // only fall back to a real fetch + re-upload when it doesn't.
      const canReuseBlob = source.client === client && source.accountId === filesAccountId;
      if (canReuseBlob) {
        await client.createFileNode(source.name, source.blobId, source.type, source.size, currentParentId);
      } else {
        const blob = await source.client.fetchBlob(source.blobId, source.name, source.type, source.accountId);
        const file = new File([blob], source.name, { type: source.type || blob.type });
        const uploaded = await client.uploadBlob(file, { accountId: filesAccountId });
        await client.createFileNode(source.name, uploaded.blobId, uploaded.type || source.type, uploaded.size, currentParentId);
      }
      toast.success(t("success", { name: source.name }));
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : t("save_error");
      setError(message);
      toast.error(t("save_error"));
    } finally {
      setIsSaving(false);
    }
  }, [client, source, currentParentId, t, onClose]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" onClick={onClose} aria-hidden="true" />
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("title")}
        className="relative bg-background border border-border rounded-lg shadow-xl w-full max-w-md mx-4 max-h-[80vh] flex flex-col animate-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{t("title")}</h2>
            <p className="text-xs text-muted-foreground truncate">{source.name}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-muted transition-colors duration-150 text-muted-foreground hover:text-foreground flex-shrink-0"
            aria-label={tCommon("close")}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex items-center gap-1 px-6 py-2 border-b border-border text-sm overflow-x-auto">
          {crumbs.map((crumb, index) => (
            <span key={crumb.id ?? "root"} className="flex items-center gap-1 flex-shrink-0">
              {index > 0 && <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
              <button
                onClick={() => jumpToCrumb(index)}
                disabled={index === crumbs.length - 1}
                className="px-1.5 py-0.5 rounded hover:bg-muted disabled:hover:bg-transparent disabled:text-foreground disabled:font-medium text-muted-foreground transition-colors"
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2 min-h-[200px]">
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-primary mb-3" />
              <p className="text-sm text-muted-foreground">{t("loading")}</p>
            </div>
          ) : folders.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">{t("no_folders")}</p>
          ) : (
            <div className="space-y-0.5">
              {folders.map((folder) => (
                <button
                  key={folder.id}
                  onClick={() => enterFolder(folder)}
                  className="w-full flex items-center gap-2.5 py-2 px-2 rounded-md hover:bg-muted/50 text-start transition-colors"
                >
                  <Folder className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <span className="text-sm truncate flex-1">{folder.name}</span>
                  <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div className="mx-6 mb-2 text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border">
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            {tForm("cancel")}
          </Button>
          <Button onClick={handleSaveHere} disabled={isSaving || isLoading}>
            {isSaving ? (
              <Loader2 className="w-4 h-4 me-1 animate-spin" />
            ) : (
              <Check className="w-4 h-4 me-1" />
            )}
            {t("save_here", { folder: crumbs[crumbs.length - 1]?.name ?? tFiles("breadcrumb_root") })}
          </Button>
        </div>
      </div>
    </div>
  );
}
