import { toastWithUndo, undoLabels, undoMoveAction } from '@/lib/email-action-toast';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useAuthStore } from '@/stores/auth-store';
import type { EmailRestoreBatch } from '@/stores/email-store';
import { announceMovedToMainWindow, type PopoutMovedNotice } from './channel';

type MoveKind = PopoutMovedNotice['kind'];
type Translate = (key: string, values?: Record<string, string>) => string;

/** The toast's title for each kind, in the `notifications` namespace. */
const TITLE_KEY: Record<MoveKind, string> = {
  archive: 'email_archived',
  delete: 'email_deleted',
  move: 'email_moved',
};

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
  toastWithUndo(t(TITLE_KEY[kind]), undoMoveAction(client, restore, undoLabels(t)));
}

/** The main window's side of offerMoveUndo. `t` is of the `notifications` namespace. */
export function takeOverMoved(notice: PopoutMovedNotice, t: Translate): void {
  const batches = restoreBatchesFromNotice(notice);
  toastWithUndo(t(TITLE_KEY[notice.kind]), undoMoveAction(useAuthStore.getState().client, batches, undoLabels(t)));
}
