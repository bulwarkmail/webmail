"use client";

// xenaxio step 127 A and step 124 B: files attached to a record or to a task. The
// platform keeps them with the record's rights (who sees the record sees its files);
// people who change the record add them by dropping or choosing; pictures show a
// preview; pictures and PDFs open in the browser, everything else downloads. "Save in
// Files" puts a copy into the person's own Files (their mailbox account).
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { Download, FileText, FolderInput, Paperclip, Trash } from "@/components/icons";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { errorText } from "@/lib/xenaxio/api";
import { useXT } from "@/lib/xenaxio/i18n";
import { type ObjectFile, objectFileUrl, projectsApi, uploadObjectFile } from "@/lib/xenaxio/projects";
import { useAuthStore } from "@/stores/auth-store";
import { toast } from "@/stores/toast-store";

const PREVIEW = /^image\/(png|jpeg|gif|webp)$/;
const OPENS = (type: string) => PREVIEW.test(type) || type === "application/pdf";
const MAX_BYTES = 50 * 1024 * 1024;

export function fileSize(bytes: number, locale: string): string {
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  return `${n.toLocaleString(locale, { maximumFractionDigits: u === 0 ? 0 : 1 })} ${units[u]}`;
}

/** Copies a file of a record into the person's own Files (the root folder). */
async function saveInFiles(objectId: string, f: ObjectFile): Promise<void> {
  const client = useAuthStore.getState().client;
  if (!client) throw new Error("no_client");
  const res = await fetch(objectFileUrl(objectId, f.id), { credentials: "same-origin" });
  if (!res.ok) throw new Error("download_failed");
  const blob = new File([await res.blob()], f.name, { type: f.type });
  const { blobId, type } = await client.uploadBlob(blob);
  await client.createFileNode(f.name, blobId, type || f.type || "application/octet-stream", f.size, null);
}

export function Attachments({ objectId, taskId, canEdit, onChanged, compact = false }: { objectId: string; taskId?: string | null; canEdit: boolean; onChanged?: () => void; compact?: boolean }) {
  const t = useXT();
  const locale = useLocale();
  const [files, setFiles] = useState<ObjectFile[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [removing, setRemoving] = useState<ObjectFile | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    projectsApi
      .files(objectId, taskId)
      .then((r) => setFiles(r.files))
      .catch((err: unknown) => toast.error(errorText(t, err)));
  }, [objectId, taskId, t]);
  useEffect(load, [load]);

  const add = async (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      if (file.size > MAX_BYTES) {
        toast.error(t("errors.object_file_too_large"));
        continue;
      }
      setBusy(file.name);
      try {
        await uploadObjectFile(objectId, file, taskId);
      } catch (err) {
        toast.error(errorText(t, err));
      }
    }
    setBusy(null);
    load();
    onChanged?.();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (canEdit && e.dataTransfer.files.length) void add(e.dataTransfer.files);
  };

  const copy = async (f: ObjectFile) => {
    try {
      await saveInFiles(objectId, f);
      toast.success(t("projects.file_saved", { name: f.name }));
    } catch (err) {
      toast.error(errorText(t, err));
    }
  };

  if (!files) return null;
  if (!canEdit && files.length === 0) return null;

  return (
    <div
      className={cn("space-y-1.5 text-sm", over && "rounded-md ring-2 ring-primary/40")}
      onDragOver={(e) => {
        if (!canEdit) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{t("projects.files")}</span>
        {files.length > 0 && <span className="text-xs tabular-nums text-muted-foreground">{files.length}</span>}
      </div>
      {files.length > 0 && (
        <ul className={cn("grid gap-2", !compact && "sm:grid-cols-2")}>
          {files.map((f) => (
            <li key={f.id} className="group flex items-center gap-2 rounded-md border border-border p-1.5">
              {PREVIEW.test(f.type) ? (
                <img src={objectFileUrl(objectId, f.id, true)} alt="" className="h-10 w-10 shrink-0 rounded object-cover" loading="lazy" />
              ) : (
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded bg-muted text-muted-foreground" aria-hidden="true">
                  <FileText className="h-5 w-5" />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <a
                  href={objectFileUrl(objectId, f.id, OPENS(f.type))}
                  {...(OPENS(f.type) ? { target: "_blank", rel: "noopener noreferrer" } : { download: f.name })}
                  className="block truncate hover:underline"
                  title={f.name}
                >
                  {f.name}
                </a>
                <span className="block truncate text-xs text-muted-foreground">
                  {fileSize(f.size, locale)}
                  {f.createdBy ? ` · ${f.createdBy.name}` : ""}
                </span>
              </span>
              <span className="flex shrink-0 gap-0.5 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                <a href={objectFileUrl(objectId, f.id)} download={f.name} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`${t("projects.file_download")}: ${f.name}`}>
                  <Download className="h-4 w-4" />
                </a>
                <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => void copy(f)} aria-label={`${t("projects.file_to_dateien")}: ${f.name}`} title={t("projects.file_to_dateien")}>
                  <FolderInput className="h-4 w-4" />
                </button>
                {f.can.delete && (
                  <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive" onClick={() => setRemoving(f)} aria-label={`${t("projects.file_delete")}: ${f.name}`}>
                    <Trash className="h-4 w-4" />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <>
          <button
            type="button"
            onClick={() => input.current?.click()}
            disabled={busy !== null}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground hover:border-primary/50 hover:text-foreground disabled:opacity-60"
          >
            <Paperclip className="h-4 w-4" />
            {busy ? t("projects.files_uploading", { name: busy }) : t("projects.files_drop")}
          </button>
          <input ref={input} type="file" multiple className="hidden" aria-label={t("projects.files_add")} onChange={(e) => e.target.files && void add(e.target.files).finally(() => (e.target.value = ""))} />
        </>
      )}
      <ConfirmDialog
        isOpen={!!removing}
        onClose={() => setRemoving(null)}
        title={t("projects.file_delete")}
        message={t("projects.file_delete_text", { name: removing?.name ?? "" })}
        variant="destructive"
        confirmText={t("projects.file_delete")}
        onConfirm={() => {
          const gone = removing;
          setRemoving(null);
          if (!gone) return;
          projectsApi
            .deleteFile(objectId, gone.id)
            .then(() => {
              load();
              onChanged?.();
            })
            .catch((err: unknown) => toast.error(errorText(t, err)));
        }}
      />
    </div>
  );
}
