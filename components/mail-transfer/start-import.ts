import { localDedupe } from "@/lib/mail-import/dedupe";
import { runImport, type ImportFile, type ImportProgress } from "@/lib/mail-import/engine";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useMailTransferStore } from "@/stores/mail-transfer-store";

export interface StartImportInput {
  files: ImportFile[];
  /** JMAP account of the target. */
  accountId: string;
  /** null = the top level (with keepFolders). */
  targetMailboxId: string | null;
  keepFolders: boolean;
  resume: boolean;
  /** Skip what an earlier import put in the same folder (lib/mail-import/dedupe.ts). */
  dedupe?: boolean;
  /** Called with how the job ended. */
  onEnd?: (result: ImportProgress) => void;
}

/** Runs an import as the dialog's job and refreshes the mail lists when it ends. */
export function startImport(input: StartImportInput): void {
  const auth = useAuthStore.getState();
  if (!auth.client) return;
  const client: IJMAPClient = auth.client;
  const store = useMailTransferStore.getState();
  const controller = new AbortController();
  const scope = auth.activeAccountId ?? "default";
  let ended: () => void = () => {};
  const finished = new Promise<void>((resolve) => { ended = resolve; });
  store.startJob({
    kind: "import",
    controller,
    scope,
    finished,
    progress: { phase: "running", imported: 0, failed: 0, skipped: {}, failures: [], fraction: 0, foldersCreated: 0 },
  });
  const hasPst = input.files.some((f) => f.format === "pst");
  void (async () => {
    try {
      await run();
    } finally {
      ended();
    }
  })();
  async function run() {
    // The PST reader (and its worker) load only for an Outlook file.
    const openPst = hasPst ? (await import("@/lib/mail-import/pst-source")).openPstSource : undefined;
    const result = await runImport({
      client,
      accountId: input.accountId,
      targetMailboxId: input.targetMailboxId,
      keepFolders: input.keepFolders,
      files: input.files,
      scope,
      resume: input.resume,
      signal: controller.signal,
      onProgress: (progress) => useMailTransferStore.getState().updateProgress(progress),
      openPst,
      dedupe: input.dedupe ? localDedupe(scope, input.accountId) : undefined,
    });
    useMailTransferStore.getState().updateProgress(result);
    input.onEnd?.(result);
    // Show what arrived, if the same account is still the one on screen.
    if (useAuthStore.getState().client !== client || result.imported === 0) return;
    const email = useEmailStore.getState();
    try {
      await email.fetchMailboxes(client);
      await email.fetchEmails(client, email.selectedMailbox || undefined, { background: true });
    } catch {
      /* the next refresh shows them */
    }
  }
}
