import { toast } from "@/stores/toast-store";
import { useEmailStore, resolveEmailActionContext, resolveSelectedEmails, type EmailRestoreBatch, type CrossAccountMoveReceipt } from "@/stores/email-store";
import type { ToastAction } from "@/components/ui/toast";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { Email } from "@/lib/jmap/types";
import { recordUndo } from "@/lib/undo-history";
import { confirmUndone, showUndoCard, UNDO_TOAST_DURATION, UNDO_TOAST_GROUP } from "@/lib/undo-deck";
import { formatShortcutCombo } from "@/lib/shortcut-keys";
import { emailKeyFor, KEYWORD_PREFIX, KEYWORD_PREFIX_LEGACY } from "@/lib/thread-utils";
import { announce } from "@/lib/announce";
import { stripSubjectPrefixes } from "@/lib/subject-prefix";
import { currentStoreEpoch } from "@/lib/store-epoch";

export { UNDO_TOAST_DURATION, UNDO_TOAST_GROUP };

/** The words the Undo action needs, from the `notifications` namespace. */
export interface UndoLabels {
  undo: string;
  done: string;
  failed: string;
  /** "Press Ctrl+Z to undo.", read out after the toast. */
  hint?: string;
  /** "Undone", after a read, flag or tag change was put back. */
  undone?: string;
}

/** An Undo for a toast, with the words a screen reader hears about it. */
export interface UndoToastAction extends ToastAction {
  hint?: string;
  subject?: string;
  keys?: string[];
}

function subjectOf(batches: EmailRestoreBatch[]): string | undefined {
  const subjects = new Set<string>();
  for (const batch of batches) for (const point of batch.points) {
    const subject = stripSubjectPrefixes(batch.messages?.[point.id]?.subject).trim();
    if (subject) subjects.add(subject);
  }
  return subjects.size === 1 ? subjects.values().next().value : undefined;
}

/** The undo shortcut as this platform writes it (Ctrl+Z, ⌘Z). */
export function undoShortcutLabel(): string {
  return formatShortcutCombo("Mod+Z");
}

/** `t` of the `notifications` namespace → UndoLabels. */
export function undoLabels(t: (key: string, values?: Record<string, string>) => string): UndoLabels {
  return {
    undo: t("undo"),
    done: t("undo_done"),
    failed: t("undo_failed"),
    hint: t("undo_hint", { keys: undoShortcutLabel() }),
    undone: t("undone"),
  };
}

/**
 * The keywords a read, flag or tag change is about to touch on one message,
 * with the values they have now, so Undo can put exactly those back.
 */
export interface KeywordRestorePoint {
  id: string;
  /** emailKeyFor of the row: the id alone can name another account's message. */
  key: string;
  changes: Record<string, boolean>;
}

/**
 * Restore points for `names` on `emails`, taken before the change. Messages
 * the change leaves as they are (`target` given: already in that state) are
 * left out.
 */
export function keywordRestorePoints(
  emails: Email[],
  names: string[],
  target?: Record<string, boolean>,
): KeywordRestorePoint[] {
  const points: KeywordRestorePoint[] = [];
  for (const email of emails) {
    const changes = Object.fromEntries(names.map((name) => [name, email.keywords?.[name] === true]));
    if (target && Object.entries(target).every(([name, value]) => changes[name] === value)) continue;
    points.push({ id: email.id, key: emailKeyFor(email), changes });
  }
  return points;
}

/** The two spellings of a tag's keyword. */
export function tagKeywords(tagId: string): string[] {
  return [KEYWORD_PREFIX + tagId, KEYWORD_PREFIX_LEGACY + tagId];
}

/**
 * Undo for a read, flag or tag change: writes back the keywords the restore
 * points hold, and nothing else (patchEmailKeywords, routed to each message's
 * own account by its row key). None when nothing changed.
 */
export function undoKeywordAction(
  client: IJMAPClient | null | undefined,
  points: KeywordRestorePoint[],
  labels: UndoLabels,
): UndoToastAction | undefined {
  if (!client || points.length === 0) return undefined;
  return {
    label: labels.undo,
    hint: labels.hint,
    keys: points.map((p) => p.key),
    onClick: () => {
      void (async () => {
        const { patchEmailKeywords } = useEmailStore.getState();
        const results = await Promise.allSettled(
          points.map((p) => patchEmailKeywords(client, p.id, p.changes, p.key)),
        );
        const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
        if (failed) {
          console.error("Failed to undo:", failed.reason);
          toast.error(labels.failed);
        } else {
          confirmUndone(labels.undone ?? labels.done);
        }
      })();
    },
  };
}

/**
 * Keeps an Undo for a small change that shows no toast of its own (a star,
 * a message marked read, a tag): Ctrl+Z reaches it, and a screen reader
 * hears what happened.
 */
export function recordQuietUndo(title: string, undo: UndoToastAction | undefined): void {
  announce(title);
  if (undo) recordUndo(title, undo.onClick, undo.keys);
}

/**
 * Marks the selection read or unread, with a toast that offers Undo. The
 * messages the change leaves alone are not put back.
 */
export async function markSelectionReadWithUndo(
  client: IJMAPClient,
  read: boolean,
  words: { success: string; error: string; labels: UndoLabels },
): Promise<void> {
  const epoch = currentStoreEpoch();
  const points = keywordRestorePoints(resolveSelectedEmails(useEmailStore.getState()), ["$seen"], { $seen: read });
  await runBatchEmailAction(() => useEmailStore.getState().batchMarkAsRead(client, read), {
    success: words.success,
    error: words.error,
    undo: undoKeywordAction(client, points, words.labels),
    // Switched to another account meanwhile: its error is not this action's
    // outcome, and Undo would act on the other account's list.
    isCurrent: () => currentStoreEpoch() === epoch,
  });
}

/**
 * Puts a tag on the selection or takes it off (batchSetTag; rejects when a
 * write fails) and keeps an Undo for Ctrl+Z. The selection stays, so several
 * tags can be changed in a row; a toast for each would pile up, so the
 * change is only read out.
 */
export async function setSelectionTagWithUndo(
  client: IJMAPClient,
  tagId: string,
  add: boolean,
  words: { describe: (count: number) => string; labels: UndoLabels },
): Promise<boolean> {
  const names = tagKeywords(tagId);
  const points = keywordRestorePoints(resolveSelectedEmails(useEmailStore.getState()), names)
    .filter((p) => names.some((name) => p.changes[name]) !== add);
  const done = await useEmailStore.getState().batchSetTag(client, tagId, add);
  if (done && points.length > 0) {
    recordQuietUndo(words.describe(points.length), undoKeywordAction(client, points, words.labels));
  }
  return done;
}

/**
 * Puts tags on every message of a conversation row or takes them off
 * (batchSetTag with these messages as its target; rejects when a write
 * fails), and keeps one Undo for Ctrl+Z. Each tag is one Email/set per
 * account the messages live in, routed as a single message's tag change.
 * The messages the change leaves alone are not put back.
 */
export async function setConversationTagsWithUndo(
  client: IJMAPClient,
  emails: Email[],
  tagIds: string[],
  add: boolean,
  words: { describe: (count: number) => string; labels: UndoLabels },
): Promise<boolean> {
  if (emails.length === 0 || tagIds.length === 0) return true;
  const names = tagIds.flatMap(tagKeywords);
  const has = (changes: Record<string, boolean>, tagId: string) => tagKeywords(tagId).some((name) => changes[name]);
  const points = keywordRestorePoints(emails, names)
    .filter((p) => tagIds.some((tagId) => has(p.changes, tagId) !== add));

  const groups = new Map<IJMAPClient, Map<string | undefined, Email[]>>();
  for (const email of emails) {
    const { client: actionClient, accountId } = resolveEmailActionContext(email, client);
    const byAccount = groups.get(actionClient) ?? new Map<string | undefined, Email[]>();
    groups.set(actionClient, byAccount);
    byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), email]);
  }

  let done = true;
  for (const tagId of tagIds) {
    for (const [actionClient, byAccount] of groups) {
      for (const [accountId, group] of byAccount) {
        const target = { emailIds: group.map((e) => e.id), client: actionClient, accountId, emails: group };
        if (!(await useEmailStore.getState().batchSetTag(client, tagId, add, target))) done = false;
      }
    }
  }
  if (done && points.length > 0) {
    recordQuietUndo(words.describe(points.length), undoKeywordAction(client, points, words.labels));
  }
  return done;
}

/**
 * Stars the selection or takes the star off (batchSetStarred; rejects when a write
 * fails), with a toast that offers Undo. The messages already as asked are not put back.
 */
export async function setSelectionStarredWithUndo(
  client: IJMAPClient,
  starred: boolean,
  words: { success: string; error: string; labels: UndoLabels },
): Promise<void> {
  const points = keywordRestorePoints(resolveSelectedEmails(useEmailStore.getState()), ["$flagged"], { $flagged: starred });
  await runBatchEmailAction(() => useEmailStore.getState().batchSetStarred(client, starred), {
    success: words.success,
    error: words.error,
    undo: undoKeywordAction(client, points, words.labels),
  });
}

/**
 * The toast's Undo for a reversible move (delete to Trash, archive, move,
 * report spam, remove from folder): puts the messages back where `batches`
 * says they were. None when there is nothing to put back.
 *
 * `receipts` (filled while the move runs) name the messages it took to
 * another account: Undo moves those back, the same way, into the folders
 * their restore points name (undoMove). `onUndone` runs once they are back.
 */
export function undoMoveAction(
  client: IJMAPClient | null | undefined,
  batches: EmailRestoreBatch[] | null | undefined,
  labels: UndoLabels,
  receipts?: CrossAccountMoveReceipt[],
  onUndone?: () => void,
): UndoToastAction | undefined {
  if (!client || !batches || !batches.some(b => b.points.length > 0)) return undefined;
  return {
    label: labels.undo,
    hint: labels.hint,
    subject: subjectOf(batches),
    keys: batches.flatMap((b) => b.points.map((p) => b.messages?.[p.id]?.key ?? p.id)),
    onClick: () => {
      void (async () => {
        try {
          await useEmailStore.getState().undoMove(client, batches, receipts ?? []);
          confirmUndone(labels.done);
          onUndone?.();
        } catch (error) {
          console.error("Failed to undo:", error);
          toast.error(labels.failed);
        }
      })();
    },
  };
}

/**
 * A success toast, with Undo when the action can be undone. The Undo also
 * goes into the undo history (lib/undo-history), so Ctrl+Z reaches it after
 * the toast is gone or another one took its place.
 */
export function toastWithUndo(title: string, undo: UndoToastAction | undefined, message?: string): void {
  if (!undo) {
    toast.success(title, message);
    return;
  }
  showUndoCard(title, undo, message ?? undo.subject);
}

/**
 * Runs a bulk email-store action and toasts the outcome: a failure always, a
 * success when there is a message for it. Most batch actions report failure
 * through `state.error` instead of throwing (batchArchive does both), so a
 * resolved promise alone does not mean the mail moved. An action that
 * resolves `false` did nothing: a plugin vetoed it (and told the user why) or
 * there was nothing to act on, so there is no success to report. `undo` goes
 * on the success toast only: after a partial failure the list is reloaded and
 * the error says what stayed.
 */
export async function runBatchEmailAction(
  run: () => Promise<boolean | void>,
  messages: { success?: string; error: string; describeError?: (error: unknown) => string | undefined; undo?: ToastAction; isCurrent?: () => boolean },
): Promise<void> {
  // An error left over from an earlier action is not this action's outcome.
  useEmailStore.setState({ error: null });
  let ran: boolean | void;
  try {
    ran = await run();
  } catch (error) {
    if (messages.isCurrent?.() === false) return;
    console.error(messages.error, error);
    const detail = messages.describeError?.(error) ?? (error instanceof Error ? error.message : undefined);
    toast.error(messages.error, detail);
    return;
  }
  // `isCurrent` false: the view this action ran in is gone, so is its feedback.
  if (messages.isCurrent?.() === false) return;
  const storeError = useEmailStore.getState().error;
  if (storeError) {
    toast.error(messages.error, storeError);
  } else if (ran !== false && messages.success) {
    toastWithUndo(messages.success, messages.undo);
  }
}
