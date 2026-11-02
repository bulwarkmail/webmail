import { create } from "zustand";
import type { ImportProgress } from "@/lib/mail-import/engine";
import type { ExportProgress } from "@/lib/mail-export/engine";
import { downloadAllowed } from "@/lib/download-guard";

/**
 * The mail import and export dialog: what it was opened for, whether it is
 * on screen, and the job it runs. A job keeps running while the dialog is
 * hidden ("Run in background"); a small chip then shows its progress and
 * brings the dialog back. One job at a time.
 */

export interface ImportRequest {
  kind: "import";
  /** The folder it was opened from (its id in the mail store), if any. */
  mailboxId?: string;
}

export interface ExportRequest {
  kind: "export";
  /** A folder (its id in the mail store), or the whole account when absent. */
  mailboxId?: string;
}

export type TransferRequest = ImportRequest | ExportRequest;

interface JobBase {
  controller: AbortController;
  /** The Bulwark account that runs it: its sign-out stops it. */
  scope?: string;
  /** Settles when the job has ended. */
  finished?: Promise<unknown>;
}

export type TransferJob =
  | (JobBase & { kind: "import"; progress: ImportProgress })
  | (JobBase & { kind: "export"; progress: ExportProgress });

interface MailTransferState {
  request: TransferRequest | null;
  visible: boolean;
  job: TransferJob | null;
  /** Opens the dialog; false when a job is running already (it is shown instead). */
  open: (request: TransferRequest) => boolean;
  /** Hides the dialog; a running job goes on. */
  hide: () => void;
  show: () => void;
  /**
   * Closes the dialog and forgets a finished job. An export's private file
   * is deleted once its download had time to finish, or at once with `now`.
   */
  close: (options?: { now?: boolean }) => void;
  startJob: (job: TransferJob) => void;
  updateProgress: (progress: ImportProgress | ExportProgress) => void;
  /** `reason` "signout": the account signs out, so nothing more is written for it. */
  cancelJob: (reason?: string) => void;
}

export function isJobActive(job: TransferJob | null): boolean {
  return !!job && (job.progress.phase === "running" || job.progress.phase === "paused");
}

function discardExport(job: TransferJob | null, now = false): void {
  if (job?.kind === "export") void job.progress.file?.discard(now).catch(() => {});
}

export const useMailTransferStore = create<MailTransferState>()((set, get) => ({
  request: null,
  visible: false,
  job: null,
  open: (request) => {
    // The device policy "No export" of the active account (Organisation >
    // Devices): the dialog doesn't open and the app says why. Import stays.
    if (request.kind === "export" && !downloadAllowed("export", null)) return false;
    if (isJobActive(get().job)) {
      set({ visible: true });
      return false;
    }
    discardExport(get().job);
    set({ request, visible: true, job: null });
    return true;
  },
  hide: () => set({ visible: false }),
  show: () => set({ visible: true }),
  close: (options) => {
    if (isJobActive(get().job)) {
      set({ visible: false });
      return;
    }
    discardExport(get().job, options?.now);
    set({ request: null, visible: false, job: null });
  },
  startJob: (job) => set({ job }),
  updateProgress: (progress) => {
    const job = get().job;
    if (job) set({ job: { ...job, progress } as TransferJob });
  },
  cancelJob: (reason) => get().job?.controller.abort(reason),
}));

/** Opens the import dialog, for a folder or (from Settings) for none. */
export function openMailImport(request: Omit<ImportRequest, "kind"> = {}): void {
  useMailTransferStore.getState().open({ kind: "import", ...request });
}

/** Opens the export dialog for a folder, or for the whole account. */
export function openMailExport(request: Omit<ExportRequest, "kind"> = {}): void {
  useMailTransferStore.getState().open({ kind: "export", ...request });
}
