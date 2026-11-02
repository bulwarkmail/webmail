"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { FileArchive, FileText, Upload, X } from "@/components/icons";
import { useEmailStore } from "@/stores/email-store";
import { useAuthStore } from "@/stores/auth-store";
import { isJobActive, useMailTransferStore, type ImportRequest } from "@/stores/mail-transfer-store";
import { checkpointKey, readCheckpoint } from "@/lib/mail-import/checkpoints";
import { hasFolders, sniffFormat, type ImportFormat, type SkipReason } from "@/lib/mail-import/sources";
import type { ImportProgress } from "@/lib/mail-import/engine";
import type { Mailbox } from "@/lib/jmap/types";
import { formatFileSize, getMailboxPath } from "@/lib/utils";
import { formatClock, serverMegabytes, TransferBar, useFocusOnStage } from "./transfer-progress";
import { startImport } from "./start-import";

const ACCEPT = ".eml,.zip,.mbox,.mbx,.pst,.ost,message/rfc822,application/zip,application/mbox";
const TOP = "\u0000top";
const SKIP_ORDER: SkipReason[] = ["too_large", "deleted", "embedded", "unreadable", "contact", "calendar", "other"];

interface Picked {
  file: File;
  format: ImportFormat;
  folders: boolean;
}

function mailboxValue(m: Mailbox): string {
  return m.id;
}

export function MailImportDialog({ request }: { request: ImportRequest }) {
  const t = useTranslations("mail_import");
  const locale = useLocale();
  const id = useId();
  const visible = useMailTransferStore((s) => s.visible);
  const job = useMailTransferStore((s) => s.job);
  const close = useMailTransferStore((s) => s.close);
  const hide = useMailTransferStore((s) => s.hide);
  const cancelJob = useMailTransferStore((s) => s.cancelJob);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const client = useAuthStore((s) => s.client);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const fileInput = useRef<HTMLInputElement>(null);
  const chooseButton = useRef<HTMLButtonElement>(null);

  const targets = useMemo(
    () => mailboxes
      .filter((m) => m.myRights?.mayAddItems !== false)
      .map((m) => ({
        mailbox: m,
        label: (m.isShared && m.accountName ? `${m.accountName} › ` : "") + getMailboxPath(m, mailboxes),
      }))
      .sort((a, b) => Number(!!a.mailbox.isShared) - Number(!!b.mailbox.isShared) || a.label.localeCompare(b.label)),
    [mailboxes],
  );
  const initialTarget = request.mailboxId && targets.some((x) => x.mailbox.id === request.mailboxId)
    ? request.mailboxId
    : targets.find((x) => x.mailbox.role === "inbox" && !x.mailbox.isShared)?.mailbox.id ?? targets[0]?.mailbox.id ?? TOP;

  const [picked, setPicked] = useState<Picked[]>([]);
  const [target, setTarget] = useState<string>(initialTarget);
  const [keepFolders, setKeepFolders] = useState(true);
  const [resume, setResume] = useState(true);
  const [resumable, setResumable] = useState(0);
  const [checking, setChecking] = useState(false);

  const anyFolders = picked.some((p) => p.folders);
  const targetMailbox = targets.find((x) => x.mailbox.id === target)?.mailbox;
  const accountId = targetMailbox?.accountId || client?.getAccountId() || "";
  const targetId = target === TOP ? null : targetMailbox ? targetMailbox.originalId || targetMailbox.id : null;
  const effectiveKeep = anyFolders && keepFolders;

  // Opened from Settings, the mail view may not have loaded the folders yet.
  useEffect(() => {
    if (client && mailboxes.length === 0) void useEmailStore.getState().fetchMailboxes(client).catch(() => {});
  }, [client, mailboxes.length]);

  // Keep the choice valid when the folders arrive or the files change.
  useEffect(() => {
    const valid = target === TOP ? anyFolders : targets.some((x) => x.mailbox.id === target);
    if (!valid && target !== initialTarget) setTarget(initialTarget);
  }, [targets, target, anyFolders, initialTarget]);

  // An earlier import of the same file into the same place that stopped part way.
  useEffect(() => {
    let current = true;
    if (picked.length === 0 || !accountId) { setResumable(0); setChecking(false); return; }
    // Import waits for this: starting before it knows would throw the checkpoint away.
    setChecking(true);
    void Promise.all(picked.map((p) => readCheckpoint(checkpointKey({
      scope: activeAccountId ?? "default", accountId, target: targetId, keepFolders: effectiveKeep, file: p.file,
    })))).then((found) => {
      if (!current) return;
      setResumable(found.reduce((n, c) => n + (c?.done ?? 0) + (c?.ahead?.length ?? 0), 0));
      setChecking(false);
    }, () => { if (current) setChecking(false); });
    return () => { current = false; };
  }, [picked, accountId, targetId, effectiveKeep, activeAccountId]);

  const addFiles = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    const next = await Promise.all(files.map(async (file) => {
      const format = await sniffFormat(file);
      return { file, format, folders: await hasFolders(file, format) };
    }));
    setPicked((prev) => [...prev, ...next.filter((n) => !prev.some((p) => p.file.name === n.file.name && p.file.size === n.file.size))]);
  };

  const formatName = (format: ImportFormat) => t(`format_${format}`);
  const progress = job?.kind === "import" ? job.progress : null;
  const active = isJobActive(job);
  const stageButton = useRef<HTMLButtonElement>(null);
  useFocusOnStage(stageButton, progress ? (active ? "running" : "ended") : "setup");

  const onStart = () => {
    if (picked.length === 0 || !accountId) return;
    if (target === TOP && !effectiveKeep) return;
    startImport({
      files: picked.map((p) => ({ file: p.file, format: p.format })),
      accountId,
      targetMailboxId: targetId,
      keepFolders: effectiveKeep,
      resume: resume && resumable > 0,
    });
  };

  const onClose = () => (active ? hide() : close());

  if (!visible) return null;

  if (progress) {
    return (
      <Dialog
        isOpen
        onClose={onClose}
        size="full-on-phone"
        preventOutsideClose
        title={progressTitle(t, progress)}
        testId="mail-import-dialog"
        footer={active ? (
          <>
            <Button ref={stageButton} variant="outline" onClick={hide}>{t("background")}</Button>
            <Button variant="destructive" onClick={() => cancelJob()} aria-describedby={`${id}-status`}>{t("cancel_import")}</Button>
          </>
        ) : (
          <Button ref={stageButton} onClick={() => close()}>{t("close")}</Button>
        )}
      >
        <ProgressBody progress={progress} t={t} locale={locale} statusId={`${id}-status`} />
      </Dialog>
    );
  }

  const canStart = picked.length > 0 && !!accountId && !checking && !(target === TOP && !effectiveKeep);

  return (
    <Dialog
      isOpen
      onClose={() => close()}
      size="full-on-phone"
      title={t("title")}
      description={t("description")}
      testId="mail-import-dialog"
      initialFocus={chooseButton}
      footer={(
        <>
          <Button variant="outline" onClick={() => close()}>{t("cancel")}</Button>
          <Button onClick={onStart} disabled={!canStart} data-testid="mail-import-start">{t("start")}</Button>
        </>
      )}
    >
      <div className="mt-4 space-y-5">
        <div>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="mail-import-file"
            onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }}
          />
          <Button ref={chooseButton} variant="outline" onClick={() => fileInput.current?.click()}>
            <Upload className="me-2" aria-hidden="true" />
            {t("choose_files")}
          </Button>
          {picked.length > 0 && (
            <ul className="mt-3 divide-y divide-border rounded-md border border-border" aria-label={t("chosen_files")}>
              {picked.map((p, i) => (
                <li key={`${p.file.name}:${p.file.size}`} className="flex items-center gap-3 px-3 py-2 text-sm">
                  {p.format === "eml" ? <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <FileArchive className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-foreground">{p.file.name}</span>
                    <span className="block text-xs text-muted-foreground">{formatName(p.format)} · {formatFileSize(p.file.size)}</span>
                  </span>
                  <IconButton
                    label={t("remove_file", { name: p.file.name })}
                    onClick={() => setPicked((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <X aria-hidden="true" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <label htmlFor={`${id}-target`} className="mb-1 block text-sm font-medium text-foreground">{t("target_label")}</label>
          <select
            id={`${id}-target`}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            data-testid="mail-import-target"
          >
            {anyFolders && <option value={TOP}>{t("target_top")}</option>}
            {targets.map((x) => <option key={x.mailbox.id} value={mailboxValue(x.mailbox)}>{x.label}</option>)}
          </select>
        </div>

        {anyFolders && (
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="mt-0.5 rounded border-border"
              checked={keepFolders}
              onChange={(e) => {
                setKeepFolders(e.target.checked);
                if (!e.target.checked && target === TOP) setTarget(initialTarget === TOP ? targets[0]?.mailbox.id ?? TOP : initialTarget);
              }}
              aria-describedby={`${id}-keep-hint`}
            />
            <span>
              {t("keep_folders")}
              <span id={`${id}-keep-hint`} className="block text-xs text-muted-foreground">
                {t("keep_folders_hint")}
                {target === TOP && <> {t("keep_folders_top_hint")}</>}
              </span>
            </span>
          </label>
        )}

        {resumable > 0 && (
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input type="checkbox" className="mt-0.5 rounded border-border" checked={resume} onChange={(e) => setResume(e.target.checked)} />
            <span>{t("resume", { count: resumable })}</span>
          </label>
        )}

        {picked.some((p) => p.format === "pst") && <p className="text-xs text-muted-foreground">{t("pst_note")}</p>}
        <p className="text-xs text-muted-foreground">{t("quota_note")}</p>
      </div>
    </Dialog>
  );
}

type T = ReturnType<typeof useTranslations>;

const PST_ERRORS = ["encrypted", "not_pst", "unreadable", "worker"];
const IMPORT_ERRORS = ["over_quota", "forbidden", "failures", "network", "busy"];

/** Why an import stopped, in words; anything else as the server or browser said it. */
function errorText(t: T, error: string): string {
  const pst = /^pst:(\w+):/.exec(error)?.[1];
  if (pst && PST_ERRORS.includes(pst)) return t(`pst_error_${pst}`);
  const own = /^import:(\w+)$/.exec(error)?.[1];
  if (own && IMPORT_ERRORS.includes(own)) return t(`error_${own}`);
  return error;
}

function progressTitle(t: T, p: ImportProgress): string {
  if (p.phase === "done") return t("done_title");
  if (p.phase === "cancelled") return t("cancelled_title");
  if (p.phase === "failed") return t("failed_title");
  return t("running_title");
}

function ProgressBody({ progress: p, t, locale, statusId }: { progress: ImportProgress; t: T; locale: string; statusId: string }) {
  const running = p.phase === "running" || p.phase === "paused";
  const skipped = SKIP_ORDER.filter((r) => (p.skipped[r] ?? 0) > 0);
  let status: string;
  if (p.phase === "paused" && p.pausedUntil) {
    const time = formatClock(p.pausedUntil, locale);
    status = p.quota?.files && p.quota.bytes
      ? t("paused", { time, files: p.quota.files, size: serverMegabytes(p.quota.bytes) })
      : t("paused_generic", { time });
  } else if (running) {
    status = p.fileName ? t("reading_file", { name: p.fileName }) : t("running_title");
  } else {
    status = t("summary_imported", { count: p.imported });
  }
  return (
    <div className="mt-4 space-y-4">
      {running && <TransferBar fraction={p.fraction} label={t("progress_label")} paused={p.phase === "paused"} />}
      <p className="text-sm text-foreground tabular-nums" data-testid="mail-import-count">
        {running ? t("status_imported", { count: p.imported }) : null}
      </p>
      <p id={statusId} role="status" aria-live="polite" className="text-sm text-muted-foreground" data-testid="mail-import-status">
        {status}
      </p>
      {!running && (
        <div className="space-y-3 text-sm">
          {p.foldersCreated > 0 && <p>{t("summary_folders", { count: p.foldersCreated })}</p>}
          {skipped.length > 0 && (
            <div>
              <p className="font-medium">{t("summary_skipped")}</p>
              <ul className="mt-1 list-disc ps-5 text-muted-foreground">
                {skipped.map((r) => <li key={r}>{t(`skip_${r}`, { count: p.skipped[r] ?? 0 })}</li>)}
              </ul>
            </div>
          )}
          {p.failed > 0 && (
            <div>
              <p className="font-medium text-destructive">{t("summary_failed", { count: p.failed })}</p>
              <ul className="mt-1 list-disc ps-5 text-muted-foreground">
                {p.failures.map((f, i) => (
                  <li key={i} className="break-words">{f.label || t("untitled")}: {f.reason === "invalid" ? t("failure_invalid") : f.reason}</li>
                ))}
              </ul>
            </div>
          )}
          {p.phase === "cancelled" && <p className="text-muted-foreground">{t("cancelled_hint")}</p>}
          {p.phase === "done" && (p.retryable ?? 0) > 0 && <p className="text-muted-foreground">{t("retry_hint")}</p>}
          {p.phase === "failed" && p.error && <p className="text-destructive break-words">{errorText(t, p.error)}</p>}
        </div>
      )}
    </div>
  );
}
