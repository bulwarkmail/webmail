"use client";

import { useEffect, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Loader2, Pause } from "@/components/icons";
import { isJobActive, useMailTransferStore } from "@/stores/mail-transfer-store";
import { onBeforeSignOut } from "@/lib/sign-out-cleanup";
import { clearCheckpointsFor } from "@/lib/mail-import/checkpoints";
import { sweepPrivateExports } from "@/lib/mail-export/sinks";
import { useAuthStore } from "@/stores/auth-store";
import { toast } from "@/stores/toast-store";
import { MailImportDialog } from "./mail-import-dialog";
import { MailExportDialog } from "./mail-export-dialog";
import { formatClock } from "./transfer-progress";

/** How long sign-out waits for a cancelled job to stop (its budget is 2 s). */
const SIGN_OUT_WAIT_MS = 1500;

/**
 * Draws the mail import and export dialogs, and while it is hidden with a job running,
 * a chip in the corner that shows the progress and brings it back. Mounted
 * with the app, so a job outlives the menu or settings page that started it.
 */
export function MailTransferHost() {
  const request = useMailTransferStore((s) => s.request);
  const visible = useMailTransferStore((s) => s.visible);
  const job = useMailTransferStore((s) => s.job);

  // An account that signs out takes its running job, a finished export's
  // file in the browser's private storage, and its checkpoints with it.
  // Another account signing out leaves the job alone. The job's checkpoint
  // goes after the job has stopped, so a late write can't bring it back.
  useEffect(() => onBeforeSignOut(async (accountId) => {
    const store = useMailTransferStore.getState();
    const job = store.job;
    if (job && (accountId === "all" || !job.scope || job.scope === accountId)) {
      if (isJobActive(job)) {
        store.cancelJob("signout");
        await Promise.race([job.finished, new Promise((resolve) => setTimeout(resolve, SIGN_OUT_WAIT_MS))]);
      }
      useMailTransferStore.getState().close({ now: true });
    }
    if (accountId !== "all") await clearCheckpointsFor(accountId);
  }), []);

  // Export files a closed tab or a crash left in the browser's private
  // storage go when the app starts and when someone signs in.
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  useEffect(() => {
    if (!isJobActive(useMailTransferStore.getState().job)) void sweepPrivateExports();
  }, [activeAccountId]);

  // A job that ends while its dialog is hidden says so, with a way back to its summary.
  const tImport = useTranslations("mail_import");
  const tExport = useTranslations("mail_export");
  const lastPhase = useRef<string | undefined>(undefined);
  useEffect(() => {
    const phase = job?.progress.phase;
    const was = lastPhase.current;
    lastPhase.current = phase;
    if (!job || visible || (was !== "running" && was !== "paused")) return;
    if (phase !== "done" && phase !== "failed") return;
    const action = { label: (job.kind === "import" ? tImport : tExport)("toast_show"), onClick: () => useMailTransferStore.getState().show() };
    if (job.kind === "import") {
      if (phase === "done") toast.success(tImport("toast_done", { imported: job.progress.imported, failed: job.progress.failed }), { action });
      else toast.warning(tImport("toast_stopped"), { action });
    } else if (phase === "done") {
      toast.success(tExport("toast_done", { name: job.progress.file?.name ?? "" }), { action });
    } else {
      toast.warning(tExport("toast_stopped"), { action });
    }
    // The translators are new functions on every render in tests; the phase is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job, visible]);

  return (
    <>
      {request?.kind === "import" && <MailImportDialog request={request} />}
      {request?.kind === "export" && <MailExportDialog request={request} />}
      {!visible && isJobActive(job) && <TransferChip />}
    </>
  );
}

function TransferChip() {
  const tImport = useTranslations("mail_import");
  const tExport = useTranslations("mail_export");
  const locale = useLocale();
  const job = useMailTransferStore((s) => s.job);
  const show = useMailTransferStore((s) => s.show);
  if (!job) return null;
  const t = job.kind === "export" ? tExport : tImport;
  const p = job.progress;
  const paused = p.phase === "paused" && p.pausedUntil;
  const label = paused
    ? t("chip_paused", { time: formatClock(p.pausedUntil!, locale) })
    : t("chip", { percent: Math.round(p.fraction * 100) });
  return (
    <button
      type="button"
      onClick={show}
      className="fixed bottom-4 end-4 z-50 flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-sm shadow-lg hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
      data-testid="mail-transfer-chip"
    >
      {paused ? <Pause className="size-4 shrink-0 text-amber-600" aria-hidden="true" /> : <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />}
      <span className="truncate">{label}</span>
    </button>
  );
}
