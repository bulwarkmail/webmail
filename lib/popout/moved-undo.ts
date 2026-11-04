import { toastWithUndo, undoLabels, undoMoveAction } from '@/lib/email-action-toast';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useAuthStore } from '@/stores/auth-store';
import type { EmailRestoreBatch } from '@/stores/email-store';
import { announceMovedToMainWindow, type PopoutMovedNotice } from './channel';

type MoveKind = PopoutMovedNotice['kind'];
type Translate = (key: string, values?: Record<string, string>) => string;

/**
 * The toast's title for each kind, the main window's words (mail-18):
 * "Archived", "Moved to Trash", and "Email deleted" only for a delete for
 * good, which has nothing to restore.
 */
function titleKey(kind: MoveKind, hasRestore: boolean): string {
  if (kind === 'archive') return 'mail_list_extra.archived';
  if (kind === 'delete') return hasRestore ? 'mail_list_extra.moved_to_trash' : 'notifications.email_deleted';
  return 'notifications.email_moved';
}

/** `t` of the `notifications` namespace, for the Undo labels. */
const notificationsOf = (t: Translate): Translate => (key, values) => t(`notifications.${key}`, values);

/** A move this window made, with logins in place of clients, so another window can undo it. */
export function movedNotice(kind: MoveKind, batches: EmailRestoreBatch[] | null): PopoutMovedNotice {
  const clients = [...useAuthStore.getState().getAllConnectedClients()];
  return {
    kind,
    batches: (batches ?? []).map((batch) => ({
      login: clients.find(([, client]) => client === batch.client)?.[0] ?? null,
      accountId: batch.accountId,
      points: batch.points,
    })),
  };
}

/** A notice's restore batches, through this window's own connections. */
export function restoreBatchesFromNotice(notice: PopoutMovedNotice): EmailRestoreBatch[] {
  const auth = useAuthStore.getState();
  return notice.batches.flatMap((batch) => {
    const client = (batch.login ? auth.getClientForAccount(batch.login) : undefined) ?? auth.client;
    return client && batch.points.length > 0 ? [{ client, accountId: batch.accountId, points: batch.points }] : [];
  });
}

/**
 * The toast with Undo after a message view archived, deleted or moved its
 * message. A message window closes right after, and its toast would go with
 * it: there the main window shows the toast and keeps the Undo, so Ctrl+Z in
 * the main window reaches it. With no main window to take it, this one does.
 */
export async function offerMoveUndo(
  kind: MoveKind,
  client: IJMAPClient | null | undefined,
  restore: EmailRestoreBatch[] | null,
  t: Translate,
  inOwnWindow: boolean,
): Promise<void> {
  if (inOwnWindow && (await announceMovedToMainWindow(movedNotice(kind, restore)))) return;
  toastWithUndo(t(titleKey(kind, !!restore?.length)), undoMoveAction(client, restore, undoLabels(notificationsOf(t))));
}

/** The main window's side of offerMoveUndo. `t` is the root translator, as there. */
export function takeOverMoved(notice: PopoutMovedNotice, t: Translate): void {
  const batches = restoreBatchesFromNotice(notice);
  toastWithUndo(t(titleKey(notice.kind, notice.batches.length > 0)), undoMoveAction(useAuthStore.getState().client, batches, undoLabels(notificationsOf(t))));
}
