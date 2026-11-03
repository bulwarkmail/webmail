import { getDesktopBridge } from "@/lib/desktop/bridge";
import { toImportFile } from "@/lib/desktop/local-import";
import { readStoredJob, writeStoredJob } from "@/lib/mail-import/checkpoints";
import { holdLock, waitForLock } from "@/lib/mail-import/locks";
import type { ImportFile, ImportProgress } from "@/lib/mail-import/engine";
import { useAuthStore } from "@/stores/auth-store";
import { useContactStore } from "@/stores/contact-store";
import { isJobActive, useMailTransferStore } from "@/stores/mail-transfer-store";
import { detectDuplicates, parseVCard } from "@/lib/vcard";
import { startImport } from "./start-import";

/**
 * A desktop import of local data, which can take days under a server's upload limit: what
 * it needs to go on after a restart stays with the checkpoints, and the shell holds the
 * paths. The shell asks the user again before it reads anything after a restart.
 */

/** Across the windows of the app: the one that has this runs the job. */
const JOB_LOCK = "bulwark-local-import-job";

export interface LocalImportJobRecord {
  id: string;
  scope: string;
  accountId: string;
  targetMailboxId: string | null;
  keepFolders: boolean;
  dedupe: boolean;
}

export function readLocalImportJob(): Promise<LocalImportJobRecord | null> {
  return readStoredJob<LocalImportJobRecord>();
}

export function saveLocalImportJob(job: LocalImportJobRecord): Promise<void> {
  return writeStoredJob(job);
}

export function forgetLocalImportJob(): Promise<void> {
  return writeStoredJob(null);
}

let releaseLock: (() => void) | null = null;

function ended(job: LocalImportJobRecord, result: ImportProgress): void {
  releaseLock?.();
  releaseLock = null;
  // A failed import comes back at the next start: the network or the server is usually why.
  if (result.phase === "failed") return;
  void forgetLocalImportJob();
  void getDesktopBridge()?.localImport?.release(job.id).catch(() => {});
}

async function run(job: LocalImportJobRecord, files: ImportFile[], resume: boolean): Promise<void> {
  // Before the first message: what's imported from here on can come back.
  await saveLocalImportJob(job);
  startImport({
    files,
    accountId: job.accountId,
    targetMailboxId: job.targetMailboxId,
    keepFolders: job.keepFolders,
    resume,
    dedupe: job.dedupe,
    onEnd: (result) => ended(job, result),
  });
}

export interface StartLocalImport {
  jobId: string;
  /** Files of this job, and any files chosen the ordinary way in the same dialog. */
  files: ImportFile[];
  accountId: string;
  targetMailboxId: string | null;
  keepFolders: boolean;
  resume: boolean;
  dedupe: boolean;
}

export async function startLocalImport(input: StartLocalImport): Promise<void> {
  const scope = useAuthStore.getState().activeAccountId ?? "default";
  releaseLock?.();
  releaseLock = await holdLock(JOB_LOCK);
  await run(
    { id: input.jobId, scope, accountId: input.accountId, targetMailboxId: input.targetMailboxId, keepFolders: input.keepFolders, dedupe: input.dedupe },
    input.files,
    input.resume,
  );
}

/** Started from the device's copy of the session: it answers from here, and the real one comes later. */
export function isDeviceOnlyClient(client: unknown): boolean {
  return !!(client as { isOfflineOnly?: () => boolean } | null)?.isOfflineOnly?.();
}

export type ResumeOutcome = "none" | "resumed" | "resumed-thunderbird-running" | "later" | "gone";

/**
 * Goes on with an import an earlier run of the app left, once the same account is signed
 * in again. The shell's dialog decides: continue, not now, or stop. Not in pop-out
 * windows, which come and go.
 *
 * It waits for the job's lock rather than giving up on it. The window that has the job
 * can go at any moment: the shell rebuilds a window once while it starts, and a settings
 * window can be closed. Whoever waits then takes over. When the job ended instead, there
 * is no record left and this does nothing.
 */
export async function resumeLocalImport(): Promise<ResumeOutcome> {
  const bridge = getDesktopBridge()?.localImport;
  const auth = useAuthStore.getState();
  const store = useMailTransferStore.getState();
  if (!bridge || !auth.client || isDeviceOnlyClient(auth.client) || isJobActive(store.job)) return "none";
  const scope = auth.activeAccountId ?? "default";
  const waiting = await readLocalImportJob();
  if (!waiting || waiting.scope !== scope) return "none";
  if (/^(\/[a-zA-Z-]{2,10})?\/popout(\/|$)/.test(window.location.pathname)) return "none";
  const lock = await waitForLock(JOB_LOCK);
  let keepLock = false;
  try {
    // A long wait: look again at what's true now.
    const job = await readLocalImportJob();
    const now = useAuthStore.getState();
    if (!job || job.scope !== scope || !now.client || isDeviceOnlyClient(now.client) || (now.activeAccountId ?? "default") !== scope || isJobActive(useMailTransferStore.getState().job)) return "none";
    const result = await bridge.resume(job.id);
    if (!result.ok) {
      if (result.reason === "later" || result.reason === "busy") return "later";
      await forgetLocalImportJob();
      return result.reason === "stopped" ? "none" : "gone";
    }
    keepLock = true;
    releaseLock = lock;
    // A dialog to come back to from the corner chip, closed for now.
    store.open({ kind: "import" });
    store.hide();
    await run(job, result.files.map(toImportFile), true);
    return result.thunderbirdRunning ? "resumed-thunderbird-running" : "resumed";
  } finally {
    if (!keepLock) lock();
  }
}

/** A sign-out takes the job along: the checkpoints and what's remembered are gone too. */
export async function forgetLocalImportFor(accountId: string): Promise<void> {
  const bridge = getDesktopBridge()?.localImport;
  if (accountId === "all") {
    await forgetLocalImportJob();
    await bridge?.releaseAll().catch(() => {});
    return;
  }
  const job = await readLocalImportJob();
  if (job?.scope !== accountId) return;
  await forgetLocalImportJob();
  await bridge?.release(job.id).catch(() => {});
}

/** Contacts of the confirmed address books, the ones not there yet. How many went in. */
export async function importLocalContacts(vcards: string[]): Promise<number> {
  const client = useAuthStore.getState().client;
  const store = useContactStore.getState();
  if (!client || !client.supportsContacts() || !store.supportsSync || vcards.length === 0) return 0;
  const parsed = parseVCard(vcards.join("\r\n"));
  const duplicates = detectDuplicates(store.contacts, parsed);
  return store.importContacts(client, parsed.filter((_, index) => !duplicates.has(index)));
}

/** The taskbar's bar, where the shell has one (feat/os-integration's os.setProgress). */
export function setImportTaskbarProgress(progress: ImportProgress | null): void {
  const os = (getDesktopBridge() as { os?: { setProgress?: (value: number | null, mode?: "normal" | "paused") => void } } | null)?.os;
  if (!os?.setProgress) return;
  if (!progress || (progress.phase !== "running" && progress.phase !== "paused")) os.setProgress(null);
  else os.setProgress(progress.fraction, progress.phase === "paused" ? "paused" : "normal");
}
