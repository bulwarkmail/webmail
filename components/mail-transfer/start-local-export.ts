import { downloadAllowed, downloadAllowedQuietly } from "@/lib/download-guard";
import { localExportClient } from "@/lib/mail-export/local-store-client";
import { runExport, type ExportFolder, type ExportFormat } from "@/lib/mail-export/engine";
import { guardedSink, type ExportSink } from "@/lib/mail-export/sinks";
import { scopeDecided } from "@/lib/offline/offline-mode";
import { isOfflineNow, useOfflineStore } from "@/lib/offline/state";
import { getStore } from "@/lib/store/client/api";
import type { StoreSession } from "@/lib/store/engine/transport";
import { useAuthStore } from "@/stores/auth-store";
import { useMailTransferStore } from "@/stores/mail-transfer-store";
import { usePolicyStore } from "@/stores/policy-store";
import { useAccountSubjects } from "@/lib/org/account-subjects";

const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";

/**
 * Whether the organisation has said what applies to this account, down to its
 * groups. A start offline may not have heard it, and a group or domain scope may
 * forbid what Everyone may do: not known means no.
 */
export function localExportDecided(account: string): boolean {
  return scopeDecided(account);
}

/** Whether the organisation lets this account export. */
export function localExportAllowed(account: string): boolean {
  return localExportDecided(account) && downloadAllowedQuietly("export", account);
}

function clientOf(account: string) {
  const auth = useAuthStore.getState();
  return auth.getClientForAccount?.(account) ?? (account === auth.activeAccountId ? auth.client : undefined) ?? null;
}

/** The real client while its server can be reached. */
function reachableClient(account: string) {
  const client = clientOf(account);
  if (!client || isOfflineNow(client.getServerUrl())) return null;
  return client;
}

/** Whether a message with no original here could be fetched right now. */
export function localExportReachable(account: string): boolean {
  return reachableClient(account) !== null;
}

/** The account's own mail account in the store. Shared accounts aren't offered yet. */
export async function primaryJmapAccount(account: string): Promise<string | null> {
  const session = await getStore().area<StoreSession | null>(account, "mail.session");
  return session?.primaryAccounts?.[MAIL_CAPABILITY] ?? clientOf(account)?.getAccountId() ?? null;
}

export function localExportReader(account: string, jmap: string) {
  return localExportClient({ account, jmap, store: getStore(), online: () => reachableClient(account) });
}

export interface StartLocalExportInput {
  account: string;
  jmap: string;
  format: ExportFormat;
  folders: ExportFolder[];
  sink: ExportSink;
}

/** Runs an export from the local store as the dialog's job. False, and nothing read, when the policy says no. */
export function startLocalExport(input: StartLocalExportInput): boolean {
  const { account, jmap, format, folders } = input;
  if (!localExportAllowed(account) || !downloadAllowed("export", account)) {
    void input.sink.abort().catch(() => {});
    return false;
  }
  const controller = new AbortController();
  // Stops at once, also for an account that isn't the active one, and when no write is due.
  const unwatchPolicy = usePolicyStore.subscribe(() => {
    if (!localExportAllowed(account)) controller.abort("policy");
  });
  // What another account's groups turn out to be can say no as well.
  const unwatchSubjects = useAccountSubjects.subscribe(() => {
    if (!localExportAllowed(account)) controller.abort("policy");
  });
  const unwatchOffline = useOfflineStore.subscribe((state) => {
    if (!state.enabled.includes(account)) controller.abort("offline-off");
  });
  let ended: () => void = () => {};
  const finished = new Promise<void>((resolve) => { ended = resolve; });
  useMailTransferStore.getState().startJob({
    kind: "export",
    controller,
    scope: account,
    finished,
    progress: { phase: "running", exported: 0, failed: 0, failures: [], total: 0, fraction: 0 },
  });
  void (async () => {
    try {
      const result = await runExport({
        client: localExportReader(account, jmap),
        accountId: jmap,
        folders,
        format,
        // The save picker passes the guard in saveBlobAs, so every write asks.
        sink: guardedSink(input.sink, () => localExportAllowed(account)),
        signal: controller.signal,
        requestsPerMinute: Infinity,
        noEmptyFile: true,
        onProgress: (progress) => useMailTransferStore.getState().updateProgress(progress),
      });
      useMailTransferStore.getState().updateProgress(result);
    } finally {
      unwatchPolicy();
      unwatchSubjects();
      unwatchOffline();
      ended();
    }
  })();
  return true;
}
