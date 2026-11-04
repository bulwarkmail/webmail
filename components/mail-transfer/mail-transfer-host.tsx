"use client";

import { useEffect, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Loader2, Pause } from "@/components/icons";
import { isJobActive, useMailTransferStore } from "@/stores/mail-transfer-store";
import { showTaskbarProgress } from "@/lib/desktop/taskbar-progress";
import { onDeviceWipe } from "@/lib/offline/wipe-registry";
import { onBeforeSignOut } from "@/lib/sign-out-cleanup";
import { clearCheckpointsFor } from "@/lib/mail-import/checkpoints";
import { dropExportFiles, sweepPrivateExports } from "@/lib/mail-export/sinks";
import { useAuthStore } from "@/stores/auth-store";
import { toast } from "@/stores/toast-store";
import { MailImportDialog } from "./mail-import-dialog";
import { MailExportDialog } from "./mail-export-dialog";
import { LocalExportDialog } from "./local-export-dialog";
import { formatClock } from "./transfer-progress";
import { forgetLocalImportFor, isDeviceOnlyClient, resumeLocalImport, stopTryingRefused } from "./local-import-job";

/** How long sign-out waits for a cancelled job to stop (its budget is 2 s). */
const SIGN_OUT_WAIT_MS = 1500;

/**
 * Stops the job of an account that goes, and frees what its export kept in this
 * browser. `all`: whoever's job it is. Another account's job goes on.
 */
async function stopJobOf(accountId: string): Promise<void> {
  // Finished exports waiting out their grace period, with the dialog long closed.
  dropExportFiles(accountId);
  const store = useMailTransferStore.getState();
  const job = store.job;
  if (!job || !(accountId === "all" || !job.scope || job.scope === accountId)) return;
  const forget = () => {
    const now = useMailTransferStore.getState();
    if (now.job?.controller === job.controller) now.close({ now: true });
  };
  if (isJobActive(job)) {
    store.cancelJob("signout");
    await Promise.race([job.finished, new Promise((resolve) => setTimeout(resolve, SIGN_OUT_WAIT_MS))]);
    // Still going after the wait: close() leaves a running job be, so it goes when it ends.
    if (isJobActive(useMailTransferStore.getState().job)) {
      void job.finished?.then(forget, forget);
      return;
    }
  }
  forget();
}

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
    await stopJobOf(accountId);
    await forgetLocalImportFor(accountId);
    if (accountId !== "all") await clearCheckpointsFor(accountId);
  }), []);

  // A wipe takes the same, and every spool no tab holds. `null` is everything on this device.
  useEffect(() => onDeviceWipe(async (account) => {
    await stopJobOf(account ?? "all");
    await forgetLocalImportFor(account ?? "all");
    await sweepPrivateExports({ force: account === null });
  }), []);

  // Export files a closed tab or a crash left in the browser's private
  // storage go when the app starts and when someone signs in.
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  useEffect(() => {
    if (!isJobActive(useMailTransferStore.getState().job)) void sweepPrivateExports();
  }, [activeAccountId]);

  // The desktop app shows a running export on its taskbar button.
  const jobPhase = job?.progress.phase ?? null;
  const jobFraction = job?.progress.fraction ?? 0;
  const onTaskbar = useRef(false);
  useEffect(() => {
    if (jobPhase === "running" || jobPhase === "paused") {
      onTaskbar.current = true;
      showTaskbarProgress(jobFraction, jobPhase === "paused" ? "paused" : "normal");
    } else if (onTaskbar.current) {
      onTaskbar.current = false;
      showTaskbarProgress(null);
    }
  }, [jobPhase, jobFraction]);

  // A job that ends while its dialog is hidden says so, with a way back to its summary.
  const tImport = useTranslations("mail_import");
  const tExport = useTranslations("mail_export");
  const tLocal = useTranslations("desktopImport");

  // The desktop app: an import from this computer that a quit, a crash or a restart cut off
  // goes on, after the shell asked. Once per account per run: "Not now" means not now.
  const client = useAuthStore((s) => s.client);
  const asked = useRef<string | null>(null);
  useEffect(() => {
    // The real client replaces a device-only one after a start, and this runs again then.
    if (!client || isDeviceOnlyClient(client)) return;
    const scope = activeAccountId ?? "default";
    if (asked.current === scope) return;
    asked.current = scope;
    void resumeLocalImport().then(({ outcome, thunderbirdRunning, refused, handPicked }) => {
      if (thunderbirdRunning) toast.warning(tLocal("thunderbird_running"));
      if (outcome === "gone") {
        toast.warning(refused?.length ? tLocal("files_refused", { names: refused.join(", ") }) : tLocal("resume_gone"));
      } else if (refused?.length) {
        toast.warning(tLocal("resume_refused", { names: refused.join(", ") }), {
          action: { label: tLocal("resume_stop_trying"), onClick: () => void stopTryingRefused(scope) },
        });
      }
      if (handPicked?.length) toast.warning(tLocal("resume_hand_picked", { names: handPicked.join(", ") }));
    }).catch(() => {});
    // The translator is a new function on every render in tests; the account is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, activeAccountId]);

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
    } else if (phase === "done" && job.progress.file) {
      toast.success(tExport("toast_done", { name: job.progress.file.name }), { action });
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
      {request?.kind === "local-export" && <LocalExportDialog request={request} />}
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
