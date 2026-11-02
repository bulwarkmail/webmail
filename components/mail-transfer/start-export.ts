import { runExport, folderTree, type ExportFolder, type ExportFormat } from "@/lib/mail-export/engine";
import type { ExportSink } from "@/lib/mail-export/sinks";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import { useAuthStore } from "@/stores/auth-store";
import { useMailTransferStore } from "@/stores/mail-transfer-store";
import { downloadAllowed } from "@/lib/download-guard";

export interface StartExportInput {
  format: ExportFormat;
  /** JMAP account of the folder (or of the whole export). */
  accountId: string;
  /** One folder (its id in its account); the whole account when absent. */
  mailboxId?: string;
  sink: ExportSink;
}

/** Runs an export as the dialog's job. */
export function startExport(input: StartExportInput): void {
  const auth = useAuthStore.getState();
  if (!auth.client) return;
  // Backstop for the device policy "No export" (the dialog is not offered then).
  if (!downloadAllowed("export", auth.activeAccountId ?? null)) {
    void input.sink.abort().catch(() => {});
    return;
  }
  const client: IJMAPClient = auth.client;
  const controller = new AbortController();
  let ended: () => void = () => {};
  const finished = new Promise<void>((resolve) => { ended = resolve; });
  useMailTransferStore.getState().startJob({
    kind: "export",
    controller,
    scope: auth.activeAccountId ?? "default",
    finished,
    progress: { phase: "running", exported: 0, failed: 0, failures: [], total: 0, fraction: 0 },
  });
  void (async () => {
    try {
      await run();
    } finally {
      ended();
    }
  })();
  async function run() {
    let folders: ExportFolder[];
    try {
      folders = input.mailboxId
        ? [{ mailboxId: input.mailboxId, path: [] }]
        : folderTree(await client.getMailboxes(input.accountId));
    } catch (error) {
      await input.sink.abort().catch(() => {});
      useMailTransferStore.getState().updateProgress({
        phase: "failed", exported: 0, failed: 0, failures: [], total: 0, fraction: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const result = await runExport({
      client,
      accountId: input.accountId,
      folders,
      format: input.format,
      sink: input.sink,
      signal: controller.signal,
      onProgress: (progress) => useMailTransferStore.getState().updateProgress(progress),
    });
    useMailTransferStore.getState().updateProgress(result);
  }
}
