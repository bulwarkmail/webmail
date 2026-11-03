import { getDesktopBridge } from "@/lib/desktop/bridge";
import {
  forgetLocalImportJob,
  forgetLocalImportOf,
  readLocalImportJob,
  saveLocalImportJob,
  toImportFile,
  type LocalImportJobRecord,
} from "@/lib/desktop/local-import";
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

/** Across the windows of the app: the one that has this runs the account's job. */
const jobLock = (scope: string) => `bulwark-local-import-job:${scope}`;

let releaseLock: (() => void) | null = null;

async function ended(job: LocalImportJobRecord, result: ImportProgress): Promise<void> {
  releaseLock?.();
  releaseLock = null;
  // A failed import comes back at the next start: the network or the server is usually why.
  if (result.phase === "failed") return;
  // Folders a resume couldn't read stay to be tried, unless the user said to stop trying.
  const latest = await readLocalImportJob(job.scope);
  if (result.phase === "done" && latest?.retryOnly?.length) return;
  await forgetLocalImportJob(job.scope);
  await getDesktopBridge()?.localImport?.release(job.id).catch(() => {});
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
    onEnd: (result) => void ended(job, result),
  });
}

export interface StartLocalImport {
  jobId: string;
  /** Files of this job, and any files chosen the ordinary way in the same dialog. */
  files: ImportFile[];
  /** Those chosen by hand. There's no way back to them after a restart. */
  handPicked: string[];
  accountId: string;
  targetMailboxId: string | null;
  keepFolders: boolean;
  resume: boolean;
  dedupe: boolean;
}

/** False when another window of the app is importing for this account already: nothing started. */
export async function startLocalImport(input: StartLocalImport): Promise<boolean> {
  const scope = useAuthStore.getState().activeAccountId ?? "default";
  const lock = await holdLock(jobLock(scope));
  if (!lock) return false;
  releaseLock?.();
  releaseLock = lock;
  await run(
    {
      id: input.jobId,
      scope,
      accountId: input.accountId,
      targetMailboxId: input.targetMailboxId,
      keepFolders: input.keepFolders,
      dedupe: input.dedupe,
      handPicked: input.handPicked,
    },
    input.files,
    input.resume,
  );
  return true;
}

/** Started from the device's copy of the session: it answers from here, and the real one comes later. */
export function isDeviceOnlyClient(client: unknown): boolean {
  return !!(client as { isOfflineOnly?: () => boolean } | null)?.isOfflineOnly?.();
}

export interface ResumeResult {
  outcome: "none" | "resumed" | "later" | "gone";
  thunderbirdRunning?: boolean;
  /** Folders that can't be read now. Said out loud: the job stays open for them. */
  refused?: string[];
  /** Files chosen by hand in the dialog, which can't come back by themselves. */
  handPicked?: string[];
}

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
export async function resumeLocalImport(): Promise<ResumeResult> {
  const none: ResumeResult = { outcome: "none" };
  const bridge = getDesktopBridge()?.localImport;
  const auth = useAuthStore.getState();
  const store = useMailTransferStore.getState();
  if (!bridge || !auth.client || isDeviceOnlyClient(auth.client) || isJobActive(store.job)) return none;
  const scope = auth.activeAccountId ?? "default";
  const waiting = await readLocalImportJob(scope);
  if (!waiting) return none;
  if (/^(\/[a-zA-Z-]{2,10})?\/popout(\/|$)/.test(window.location.pathname)) return none;
  const lock = await waitForLock(jobLock(scope));
  let keepLock = false;
  try {
    // A long wait: look again at what's true now.
    const job = await readLocalImportJob(scope);
    const now = useAuthStore.getState();
    if (!job || !now.client || isDeviceOnlyClient(now.client) || (now.activeAccountId ?? "default") !== scope || isJobActive(useMailTransferStore.getState().job)) return none;
    const result = await bridge.resume(job.id);
    if (!result.ok) {
      // In use: they're there and may be readable next time, so the job stays.
      if (result.reason === "in-use") return { outcome: "later", refused: result.refused };
      if (result.reason === "later" || result.reason === "busy") return { outcome: "later" };
      await forgetLocalImportJob(scope);
      return result.reason === "stopped" ? none : { outcome: "gone", refused: result.refused };
    }
    const wanted = job.retryOnly?.length ? new Set(job.retryOnly) : null;
    const files = wanted ? result.files.filter((file) => wanted.has(file.name)) : result.files;
    const refused = wanted ? result.refused.filter((name) => wanted.has(name)) : result.refused;
    const handPicked = job.handPicked ?? [];
    const next: LocalImportJobRecord = { ...job, handPicked: [], retryOnly: refused };
    if (files.length === 0) {
      // Nothing to do now, and the record still says what's left.
      await saveLocalImportJob(next);
      return { outcome: "later", refused, handPicked };
    }
    keepLock = true;
    releaseLock = lock;
    // A dialog to come back to from the corner chip, closed for now.
    store.open({ kind: "import" });
    store.hide();
    await run(next, files.map((file) => toImportFile(file)), true);
    return { outcome: "resumed", thunderbirdRunning: result.thunderbirdRunning, refused, handPicked };
  } finally {
    if (!keepLock) lock();
  }
}

/** "Stop trying": the folders a resume couldn't read are let go. What's running goes on. */
export async function stopTryingRefused(scope: string): Promise<void> {
  const job = await readLocalImportJob(scope);
  if (!job) return;
  const store = useMailTransferStore.getState();
  if (isJobActive(store.job)) {
    await saveLocalImportJob({ ...job, retryOnly: [] });
    return;
  }
  await forgetLocalImportOf(scope);
}

/** A sign-out takes the job along: the checkpoints and what's remembered are gone too. */
export const forgetLocalImportFor = forgetLocalImportOf;

/** Contacts of the confirmed address books, the ones not there yet. How many went in. */
export async function importLocalContacts(vcards: string[]): Promise<number> {
  const client = useAuthStore.getState().client;
  const store = useContactStore.getState();
  if (!client || !client.supportsContacts() || !store.supportsSync || vcards.length === 0) return 0;
  const parsed = parseVCard(vcards.join("\r\n"));
  const duplicates = detectDuplicates(store.contacts, parsed);
  return store.importContacts(client, parsed.filter((_, index) => !duplicates.has(index)));
}
