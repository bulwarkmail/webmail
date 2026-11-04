"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { downloadAllowed } from "@/lib/download-guard";
import { folderTree, safeName, type ExportFolder, type ExportFormat, type ExportProgress } from "@/lib/mail-export/engine";
import { MEMORY_EXPORT_LIMIT, openExportSink, spoolLimit } from "@/lib/mail-export/sinks";
import { scopeForAccount } from "@/lib/offline/offline-mode";
import { useOfflineStore } from "@/lib/offline/state";
import { getStore } from "@/lib/store/client/api";
import { formatFileSize } from "@/lib/utils";
import { useAccountStore } from "@/stores/account-store";
import { isJobActive, useMailTransferStore, type LocalExportRequest } from "@/stores/mail-transfer-store";
import { ExportProgressBody, saveMode } from "./mail-export-dialog";
import { localExportAllowed, localExportDecided, localExportReachable, localExportReader, primaryJmapAccount, startLocalExport } from "./start-local-export";
import { useFocusOnStage } from "./transfer-progress";

interface FolderRow {
  folder: ExportFolder;
  total: number;
  kept: number;
  bytes: number;
  keptBytes: number;
}

/** `free`: what the browser says is left for this site; null where it doesn't say. */
type Loaded = { jmap: string; rows: FolderRow[]; free: number | null };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** What an account keeps, folder by folder, for the question before an export starts. */
async function readFolders(account: string): Promise<Loaded> {
  const jmap = await primaryJmapAccount(account);
  if (!jmap) throw new Error("The account has no mail account in the store");
  const folders = folderTree(await localExportReader(account, jmap).getMailboxes());
  const rows: FolderRow[] = [];
  for (const folder of folders) {
    const params = { jmap, mailboxId: folder.mailboxId };
    const status = await getStore().area<{ total: number; kept: number }>(account, "mail.rawStatus", params);
    const size = await getStore().area<{ bytes: number; keptBytes: number }>(account, "mail.rawSize", params);
    rows.push({ folder, ...status, ...size });
  }
  return { jmap, rows, free: await freeRoom() };
}

async function freeRoom(): Promise<number | null> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (typeof estimate?.quota !== "number") return null;
    return Math.max(0, estimate.quota - (estimate.usage ?? 0));
  } catch {
    return null;
  }
}

/** Settings > Offline > Export kept mail: from the local store, also with no server. */
export function LocalExportDialog({ request }: { request: LocalExportRequest }) {
  const t = useTranslations("offlineExport");
  const tExport = useTranslations("mail_export");
  const tPolicy = useTranslations("device_policy");
  const locale = useLocale();
  const id = useId();
  const { account } = request;
  const visible = useMailTransferStore((s) => s.visible);
  const job = useMailTransferStore((s) => s.job);
  const close = useMailTransferStore((s) => s.close);
  const hide = useMailTransferStore((s) => s.hide);
  const cancelJob = useMailTransferStore((s) => s.cancelJob);
  const address = useAccountStore((s) => {
    const entry = s.accounts.find((candidate) => candidate.id === account);
    return entry?.email || entry?.username || account;
  });
  // Re-renders when the connection changes; what it means is asked below.
  useOfflineStore((s) => s.browserOffline);
  useOfflineStore((s) => s.downServers);
  const reachable = localExportReachable(account);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [format, setFormat] = useState<ExportFormat>("mbox");
  const [starting, setStarting] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const mode = saveMode();
  const progress = job?.kind === "export" ? job.progress : null;
  const active = isJobActive(job);
  const stageButton = useRef<HTMLButtonElement>(null);
  const allFolders = useRef<HTMLInputElement | null>(null);
  const knownFolders = useRef<ReadonlySet<string>>(new Set());
  useFocusOnStage(stageButton, progress ? (active ? "running" : "ended") : "setup");
  const inSetup = !progress;

  // Read again each time the setup shows, so a try online sees what's kept by then.
  useEffect(() => {
    if (!inSetup) return;
    let live = true;
    setLoadFailed(false);
    readFolders(account).then(
      (result) => {
        if (!live) return;
        // A folder that turned up since isn't one the person chose: after a try online
        // only "All folders" takes it in.
        const ids = result.rows.map((row) => row.folder.mailboxId);
        const known = knownFolders.current;
        knownFolders.current = new Set(ids);
        setExcluded((was) => (was.size === 0 ? was : new Set([...was, ...ids.filter((folderId) => !known.has(folderId))])));
        setLoaded(result);
      },
      () => { if (live) setLoadFailed(true); },
    );
    return () => { live = false; };
  }, [account, inSetup]);

  // The dialog opens before the folders are read, with only its footer to focus.
  const foldersShown = inSetup && loaded !== null;
  useEffect(() => {
    if (foldersShown) allFolders.current?.focus();
  }, [foldersShown]);

  /** Why a run stopped, in the user's language, whatever the error said. */
  function stopMessage(run: ExportProgress): string {
    if (run.errorCode === "ExportForbiddenError" || !localExportAllowed(account)) return tPolicy("export_blocked");
    if (run.errorCode === "ExportTooLargeError") return t("stopped_limit", { limit: formatFileSize(run.errorLimit ?? 0) });
    if (run.errorCode === "QuotaExceededError") return t("stopped_no_room");
    return t("failed_generic");
  }

  if (!visible) return null;

  if (progress) {
    const notKept = progress.notKept;
    const notKeptCount = (notKept?.attachments_off ?? 0) + (notKept?.not_kept ?? 0);
    const reason: unknown = job?.controller.signal.reason;
    const leftover = progress.leftover;
    const shown: ExportProgress = {
      ...progress,
      // Nothing from a server or a browser reaches the user in English.
      failures: progress.failures.map((failure) => ({ ...failure, reason: t("message_failed") })),
      ...(progress.phase === "failed" ? { error: stopMessage(progress) } : {}),
    };
    return (
      <Dialog
        isOpen
        onClose={() => (active ? hide() : close())}
        size="full-on-phone"
        preventOutsideClose
        title={progress.phase === "done" ? tExport("done_title") : progress.phase === "cancelled" ? tExport("cancelled_title") : progress.phase === "failed" ? tExport("failed_title") : tExport("running_title")}
        testId="local-export-dialog"
        footer={active ? (
          <>
            <Button ref={stageButton} variant="outline" onClick={hide}>{tExport("background")}</Button>
            <Button variant="destructive" onClick={() => cancelJob()} aria-describedby={`${id}-status`} data-testid="local-export-cancel">{tExport("cancel_export")}</Button>
          </>
        ) : (
          <>
            {progress.phase === "done" && progress.file?.download && (
              <Button variant="outline" onClick={() => progress.file?.download?.()} data-testid="mail-export-download">{tExport("download_again")}</Button>
            )}
            {notKeptCount > 0 && (
              <Button variant="outline" disabled={!reachable} onClick={() => useMailTransferStore.getState().open(request)} data-testid="local-export-retry">{t("retry")}</Button>
            )}
            <Button ref={stageButton} onClick={() => close()}>{tExport("close")}</Button>
          </>
        )}
      >
        <ExportProgressBody progress={shown} t={tExport} locale={locale} statusId={`${id}-status`} />
        {progress.phase === "cancelled" && reason === "policy" && <p className="mt-4 text-sm text-destructive" role="alert" data-testid="local-export-stop-reason">{tPolicy("export_blocked")}</p>}
        {progress.phase === "cancelled" && reason === "offline-off" && <p className="mt-4 text-sm text-destructive" role="alert" data-testid="local-export-stop-reason">{t("stopped_offline_off")}</p>}
        {progress.phase === "done" && progress.exported === 0 && progress.failed === 0 && <p className="mt-4 text-sm text-foreground" data-testid="local-export-wrote-nothing">{t("nothing_kept")}</p>}
        {leftover && <p className="mt-4 text-sm text-destructive break-words" role="alert" data-testid="local-export-leftover">{t("leftover_file", { name: leftover })}</p>}
        {notKeptCount > 0 && (
          <div className="mt-4 space-y-1 text-sm text-foreground" data-testid="local-export-not-kept">
            {!!notKept?.attachments_off && <p data-testid="local-export-not-kept-attachments">{t("not_kept_attachments_off", { count: notKept.attachments_off })}</p>}
            {!!notKept?.not_kept && <p data-testid="local-export-not-kept-missing">{t("not_kept_not_kept", { count: notKept.not_kept })}</p>}
            <p className="text-xs text-muted-foreground" data-testid="local-export-retry-hint">{reachable ? t("retry_online") : t("retry_offline")}</p>
          </div>
        )}
      </Dialog>
    );
  }

  const rows = loaded?.rows ?? [];
  const chosen = rows.filter((row) => !excluded.has(row.folder.mailboxId));
  const total = chosen.reduce((sum, row) => sum + row.total, 0);
  const kept = chosen.reduce((sum, row) => sum + row.kept, 0);
  const missing = total - kept;
  const single = chosen.length === 1;
  const attachmentsOff = !scopeForAccount(account).scope.attachments;
  // Offline with no original of anything: the save picker would ask where to put nothing.
  const nothingToWrite = total === 0 || (kept === 0 && !reachable);
  // What the run will need, against what this browser can give it. Asked up front: a
  // tab killed with no message after hours is the outcome to avoid.
  const needed = chosen.reduce((sum, row) => sum + (reachable ? row.bytes : row.keptBytes), 0);
  const limit = mode === "memory" ? MEMORY_EXPORT_LIMIT : mode === "download" ? spoolLimit() : Infinity;
  const overLimit = needed > limit;
  const noRoom = mode === "download" && loaded?.free != null && needed > loaded.free;

  const onStart = async () => {
    if (!loaded || starting || chosen.length === 0) return;
    // Before the picker, with nothing awaited, so the click still counts for it.
    if (!localExportAllowed(account)) {
      setRefused(localExportDecided(account) ? tPolicy("export_blocked") : t("policy_unknown"));
      downloadAllowed("export", account);
      return;
    }
    setRefused(null);
    const zip = !single || format === "eml";
    const base = single
      ? safeName(chosen[0].folder.path[chosen[0].folder.path.length - 1] ?? "", "mail")
      : `${safeName(address, "mail")}-${today()}`;
    setStarting(true);
    try {
      // The save picker must open straight from the click. In the desktop app it's the OS's own Save dialog.
      const sink = await openExportSink(`${base}.${zip ? "zip" : "mbox"}`, zip ? "application/zip" : "application/mbox", zip ? ".zip" : ".mbox");
      if (!sink) return;
      startLocalExport({ account, jmap: loaded.jmap, format, folders: chosen.map((row) => row.folder), sink });
    } finally {
      setStarting(false);
    }
  };

  const toggleFolder = (mailboxId: string, on: boolean) => {
    const next = new Set(excluded);
    if (on) next.delete(mailboxId);
    else next.add(mailboxId);
    setExcluded(next);
  };

  const formats: { value: ExportFormat; label: string; hint: string }[] = [
    { value: "mbox", label: single ? tExport("format_mbox_folder") : tExport("format_mbox_account"), hint: tExport("hint_mbox") },
    { value: "eml", label: single ? tExport("format_eml_folder") : tExport("format_eml_account"), hint: tExport("hint_eml") },
  ];

  return (
    <Dialog
      isOpen
      onClose={() => close()}
      size="full-on-phone"
      title={t("title")}
      description={t("description")}
      testId="local-export-dialog"
      footer={(
        <>
          <Button variant="outline" onClick={() => close()}>{tExport("cancel")}</Button>
          <Button onClick={() => void onStart()} disabled={starting || !loaded || nothingToWrite || overLimit || noRoom} data-testid="local-export-start">{tExport("start")}</Button>
        </>
      )}
    >
      <div className="mt-4 space-y-5">
        {loadFailed ? (
          <p className="text-sm text-destructive" role="alert" data-testid="local-export-load-failed">{t("load_failed")}</p>
        ) : !loaded ? (
          <p className="text-sm text-muted-foreground" role="status" data-testid="local-export-loading">{t("loading")}</p>
        ) : (
          <>
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-foreground">{t("folders_label")}</legend>
              <label className="flex items-center gap-2 py-1 text-sm font-medium text-foreground">
                <input
                  type="checkbox"
                  checked={excluded.size === 0}
                  ref={(input) => {
                    allFolders.current = input;
                    if (input) input.indeterminate = excluded.size > 0 && excluded.size < rows.length;
                  }}
                  onChange={(event) => setExcluded(event.target.checked ? new Set() : new Set(rows.map((row) => row.folder.mailboxId)))}
                  data-testid="local-export-all"
                />
                {t("all_folders")}
              </label>
              <ul className="max-h-56 overflow-y-auto rounded-md border border-border">
                {rows.map((row) => (
                  <li key={row.folder.mailboxId} className="border-b border-border last:border-b-0">
                    <label className="flex items-start gap-2 px-3 py-2 text-sm text-foreground">
                      <input
                        type="checkbox"
                        className="mt-0.5 shrink-0"
                        checked={!excluded.has(row.folder.mailboxId)}
                        onChange={(event) => toggleFolder(row.folder.mailboxId, event.target.checked)}
                        data-testid="local-export-folder"
                        data-folder={row.folder.path.join("/")}
                      />
                      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{row.folder.path.join(" / ")}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{t("folder_kept", { kept: row.kept, total: row.total })}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-foreground">{tExport("format_label")}</legend>
              <div className="space-y-2">
                {formats.map((f) => (
                  <label key={f.value} className="flex items-start gap-2 rounded-md border border-border p-3 text-sm text-foreground has-[:checked]:border-primary">
                    <input
                      type="radio"
                      name={`${id}-format`}
                      value={f.value}
                      checked={format === f.value}
                      onChange={() => setFormat(f.value)}
                      className="mt-0.5"
                      aria-describedby={`${id}-${f.value}-hint`}
                      data-testid={`local-export-format-${f.value}`}
                    />
                    <span>
                      {f.label}
                      <span id={`${id}-${f.value}-hint`} className="block text-xs text-muted-foreground">{f.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="space-y-1 text-sm text-foreground" role="status" aria-live="polite" data-testid="local-export-summary">
              {total === 0 ? (
                <p data-testid="local-export-nothing">{t("nothing_kept")}</p>
              ) : (
                <p data-testid="local-export-kept">{t("kept", { kept, total })}</p>
              )}
              {missing > 0 && (
                <p data-testid="local-export-missing" className={reachable ? undefined : "font-medium"}>
                  {reachable ? t("missing_online", { count: missing }) : t("missing_offline", { count: missing })}
                </p>
              )}
              {missing > 0 && !reachable && (
                <p className="text-xs text-muted-foreground" data-testid="local-export-reason">{attachmentsOff ? t("reason_attachments_off") : t("reason_not_kept")}</p>
              )}
              {overLimit && <p className="font-medium text-destructive" data-testid="local-export-over-limit">{t("over_limit", { limit: formatFileSize(limit), size: formatFileSize(needed) })}</p>}
              {noRoom && !overLimit && <p className="font-medium text-destructive" data-testid="local-export-no-room">{t("no_room", { size: formatFileSize(needed), free: formatFileSize(loaded?.free ?? 0) })}</p>}
              {refused && <p className="font-medium text-destructive" data-testid="local-export-refused">{refused}</p>}
            </div>
            <p className="text-xs text-muted-foreground">{tExport(`save_${mode}`)}</p>
          </>
        )}
      </div>
    </Dialog>
  );
}
