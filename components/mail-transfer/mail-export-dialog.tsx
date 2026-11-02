"use client";

import { useId, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useEmailStore } from "@/stores/email-store";
import { useAuthStore } from "@/stores/auth-store";
import { isJobActive, useMailTransferStore, type ExportRequest } from "@/stores/mail-transfer-store";
import type { ExportFormat, ExportProgress } from "@/lib/mail-export/engine";
import { safeName } from "@/lib/mail-export/engine";
import { canPickSaveFile, canWritePrivateFile, memorySink, pickSaveFile, privateFileSink, sweepPrivateExports, type ExportSink } from "@/lib/mail-export/sinks";
import { formatFileSize } from "@/lib/utils";
import { formatClock, TransferBar, useFocusOnStage } from "./transfer-progress";
import { startExport } from "./start-export";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Where the file will go in this browser, said before the export starts. */
function saveMode(): "picker" | "download" | "memory" {
  if (canPickSaveFile()) return "picker";
  return canWritePrivateFile() ? "download" : "memory";
}

export function MailExportDialog({ request }: { request: ExportRequest }) {
  const t = useTranslations("mail_export");
  const locale = useLocale();
  const id = useId();
  const visible = useMailTransferStore((s) => s.visible);
  const job = useMailTransferStore((s) => s.job);
  const close = useMailTransferStore((s) => s.close);
  const hide = useMailTransferStore((s) => s.hide);
  const cancelJob = useMailTransferStore((s) => s.cancelJob);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const client = useAuthStore((s) => s.client);
  const username = useAuthStore((s) => s.username);
  const [format, setFormat] = useState<ExportFormat>("mbox");
  const [starting, setStarting] = useState(false);
  const mode = saveMode();

  const mailbox = request.mailboxId ? mailboxes.find((m) => m.id === request.mailboxId) : undefined;
  const folder = !!request.mailboxId;
  const progress = job?.kind === "export" ? job.progress : null;
  const active = isJobActive(job);
  const stageButton = useRef<HTMLButtonElement>(null);
  useFocusOnStage(stageButton, progress ? (active ? "running" : "ended") : "setup");

  if (!visible) return null;

  const onStart = async () => {
    if (!client || starting) return;
    if (folder && !mailbox) return;
    const zip = !folder || format === "eml";
    const base = folder ? safeName(mailbox!.name, "mail") : `${safeName(username ?? "mail", "mail")}-${today()}`;
    const name = `${base}.${zip ? "zip" : "mbox"}`;
    const mime = zip ? "application/zip" : "application/mbox";
    setStarting(true);
    let sink: ExportSink | null = null;
    try {
      // The save picker must open straight from the click.
      if (mode === "picker") {
        try {
          sink = await pickSaveFile(name, mime, zip ? ".zip" : ".mbox");
        } catch (error) {
          if ((error as { name?: string } | null)?.name === "AbortError") return;
          sink = null;
        }
      }
      if (!sink) {
        await sweepPrivateExports();
        sink = (await privateFileSink(name, mime)) ?? memorySink(name, mime);
      }
      startExport({
        format,
        accountId: mailbox?.accountId || client.getAccountId(),
        mailboxId: mailbox ? mailbox.originalId || mailbox.id : undefined,
        sink,
      });
    } finally {
      setStarting(false);
    }
  };

  const onClose = () => (active ? hide() : close());

  if (progress) {
    return (
      <Dialog
        isOpen
        onClose={onClose}
        size="full-on-phone"
        preventOutsideClose
        title={progress.phase === "done" ? t("done_title") : progress.phase === "cancelled" ? t("cancelled_title") : progress.phase === "failed" ? t("failed_title") : t("running_title")}
        testId="mail-export-dialog"
        footer={active ? (
          <>
            <Button ref={stageButton} variant="outline" onClick={hide}>{t("background")}</Button>
            <Button variant="destructive" onClick={() => cancelJob()} aria-describedby={`${id}-status`}>{t("cancel_export")}</Button>
          </>
        ) : (
          <>
            {progress.phase === "done" && progress.file?.download && (
              <Button variant="outline" onClick={() => progress.file?.download?.()} data-testid="mail-export-download">{t("download_again")}</Button>
            )}
            <Button ref={stageButton} onClick={() => close()}>{t("close")}</Button>
          </>
        )}
      >
        <ExportProgressBody progress={progress} t={t} locale={locale} statusId={`${id}-status`} />
      </Dialog>
    );
  }

  const formats: { value: ExportFormat; label: string; hint: string }[] = [
    { value: "mbox", label: folder ? t("format_mbox_folder") : t("format_mbox_account"), hint: t("hint_mbox") },
    { value: "eml", label: folder ? t("format_eml_folder") : t("format_eml_account"), hint: t("hint_eml") },
  ];

  return (
    <Dialog
      isOpen
      onClose={() => close()}
      size="full-on-phone"
      title={folder ? t("title_folder", { name: mailbox?.name ?? "" }) : t("title_account")}
      description={folder ? t("description_folder") : t("description_account")}
      testId="mail-export-dialog"
      footer={(
        <>
          <Button variant="outline" onClick={() => close()}>{t("cancel")}</Button>
          <Button onClick={() => void onStart()} disabled={starting || (folder && !mailbox)} data-testid="mail-export-start">{t("start")}</Button>
        </>
      )}
    >
      <div className="mt-4 space-y-5">
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-foreground">{t("format_label")}</legend>
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
                  data-testid={`mail-export-format-${f.value}`}
                />
                <span>
                  {f.label}
                  <span id={`${id}-${f.value}-hint`} className="block text-xs text-muted-foreground">{f.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <p className="text-xs text-muted-foreground">{t(`save_${mode}`)}</p>
      </div>
    </Dialog>
  );
}

type T = ReturnType<typeof useTranslations>;

function ExportProgressBody({ progress: p, t, locale, statusId }: { progress: ExportProgress; t: T; locale: string; statusId: string }) {
  const running = p.phase === "running" || p.phase === "paused";
  // The live region says only what changes the user's plans (paused, done);
  // the count beside it would otherwise be read out several times a second.
  let status: string;
  if (p.phase === "paused" && p.pausedUntil) status = t("paused", { time: formatClock(p.pausedUntil, locale) });
  else if (running) status = t("running_title");
  else status = t("summary_exported", { count: p.exported });
  const tooLarge = p.phase === "failed" && /larger than this browser can keep in memory/.test(p.error ?? "");
  return (
    <div className="mt-4 space-y-4">
      {running && <TransferBar fraction={p.total > 0 ? p.fraction : null} label={t("progress_label")} paused={p.phase === "paused"} />}
      {running && <p className="text-sm text-foreground tabular-nums" data-testid="mail-export-count">{t("status_exported", { count: p.exported, total: p.total })}</p>}
      <p id={statusId} role="status" aria-live="polite" className={running ? "text-sm text-muted-foreground" : "text-sm text-foreground"} data-testid="mail-export-status">{status}</p>
      {p.phase === "done" && p.file && (
        <p className="text-sm text-muted-foreground break-words" data-testid="mail-export-file">{t("summary_file", { name: p.file.name, size: formatFileSize(p.file.size) })}</p>
      )}
      {p.failed > 0 && (
        <div className="text-sm">
          <p className="font-medium text-destructive">{t("summary_failed", { count: p.failed })}</p>
          <ul className="mt-1 list-disc ps-5 text-muted-foreground">
            {p.failures.map((f, i) => <li key={i} className="break-words">{f.label || t("untitled")}: {f.reason}</li>)}
          </ul>
        </div>
      )}
      {p.phase === "failed" && <p className="text-sm text-destructive break-words">{tooLarge ? t("too_large") : p.error}</p>}
    </div>
  );
}
