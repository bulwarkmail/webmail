"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { FolderPickerDialog } from "@/components/files/folder-picker-dialog";
import { toast } from "@/stores/toast-store";
import { fileNodeKind } from "@/lib/jmap/filenode-kind";
import { TRASH_FOLDER_NAME } from "@/lib/files-trash";
import { saveBlobsToFiles } from "@/lib/files-save";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { FileNode } from "@/lib/jmap/types";

/** What Save to Files needs of an attachment: its blob, name, type and size. */
export interface SaveableAttachment {
  name?: string | null;
  type?: string | null;
  size: number;
  blobId?: string | null;
}

interface SaveToFilesDialogProps {
  /** The attachment to save; the dialog is open while it is set. */
  attachment: SaveableAttachment | null;
  /** The mail login's client; its Files account takes the file. */
  client: IJMAPClient;
  /**
   * The JMAP account the attachment's blob is in, when not the Files
   * account (a shared or group mailbox of the same login): the blob is
   * copied over first with Blob/copy.
   */
  blobAccountId?: string;
  onClose: () => void;
}

// Nothing is "where the items already are": every folder, My files too, can be picked.
const NO_CURRENT_FOLDER = "#none";

/** The path of a folder from the picker's list ('/' for My files), for plugins. */
function folderPathOf(folders: { id: string; name: string; parentId: string | null }[], id: string | null): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const names: string[] = [];
  const seen = new Set<string>();
  for (let at = id ? byId.get(id) : undefined; at && !seen.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) {
    seen.add(at.id);
    names.unshift(at.name);
  }
  return `/${names.join("/")}`;
}

/**
 * "Save to Files" for an attachment: pick a folder with the Files app's
 * folder picker. The attachment's blob is already on the server, so it is
 * filed by blobId with no download or upload; from another account of the
 * login it is copied into the Files account first (Blob/copy, RFC 8620 §6.3).
 */
export function SaveToFilesDialog({ attachment, client, blobAccountId, onClose }: SaveToFilesDialogProps) {
  const t = useTranslations("email_viewer.save_to_files");
  const tFiles = useTranslations("files");
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const isOpen = !!attachment;
  // Read in the effect without making it re-run (and reload) on a new `t`.
  const loadFailed = useRef(t("load_failed"));
  loadFailed.current = t("load_failed");

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setNodes([]);
    client.listAllFileNodes().then(
      (list) => { if (!cancelled) setNodes(list); },
      (error) => {
        console.error("Failed to list folders for Save to Files:", error);
        if (!cancelled) toast.error(loadFailed.current);
      },
    );
    return () => { cancelled = true; };
  }, [isOpen, client]);

  // Own folders only, without the hidden ones (the Files trash among them).
  const folders = useMemo(
    () => nodes
      .filter((n) => fileNodeKind(n) === "directory" && !n.isShared && !n.name.startsWith(".") && n.name !== TRASH_FOLDER_NAME)
      .map((n) => ({ id: n.id, name: n.name, parentId: n.parentId ?? null })),
    [nodes],
  );

  const save = async (parentId: string | null) => {
    if (!attachment?.blobId) return;
    const folderName = parentId ? (folders.find((f) => f.id === parentId)?.name ?? "") : tFiles("my_files");
    try {
      const { saved } = await saveBlobsToFiles(
        [{ blobId: attachment.blobId, name: attachment.name, type: attachment.type, size: attachment.size }],
        { client, parentId, path: folderPathOf(folders, parentId), blobAccountId },
      );
      // A plugin stopped it (onBeforeFileUpload); it says why itself.
      if (saved.length === 0) return;
      toast.success(t("saved"), t("saved_to", { folder: folderName }));
    } catch (error) {
      console.error("Failed to save the attachment to Files:", error);
      toast.error(t("failed"), error instanceof Error ? error.message : undefined);
    }
  };

  return (
    <FolderPickerDialog
      isOpen={isOpen}
      onClose={onClose}
      title={t("title")}
      confirmText={t("save_here")}
      folders={folders}
      currentId={NO_CURRENT_FOLDER}
      // My files, ready to take it: Save here works without a pick first.
      initialSelectedId={null}
      onPick={(parentId) => void save(parentId)}
    />
  );
}
