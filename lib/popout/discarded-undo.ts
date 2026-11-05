/**
 * Undo for a draft thrown away in a composer window of its own, in the desktop app
 * (desktop-p3-1). Quick compose is used with the main window in the tray, so its toast
 * would sit in a window nobody sees, and a draft not saved yet had no Undo at all.
 *
 * The main window keeps what the composer held and asks the OS for a "Draft discarded"
 * notification with Undo. A saved draft goes to Trash at once, as Outlook's Discard
 * does, so Drafts no longer lists it and its attachments stay on the server: a draft's
 * attachments are parts of that message, and destroying it takes them along. Undo moves
 * it back to Drafts and opens quick compose with the text, the attachments and the send
 * options as they were. Kept in this page's memory only, for an hour; then, or when the
 * page goes, the draft is destroyed in Trash, as Discard did before.
 */

import { getDesktopBridge } from '@/lib/desktop/bridge';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useAuthStore } from '@/stores/auth-store';
import type { ComposePopoutPayload } from './compose-payload';
import { openComposerWindow } from './open';

/** An Undo from the Action Center after this long finds nothing to bring back. */
export const DISCARDED_KEEP_MS = 60 * 60 * 1000;
const MAX_KEPT = 20;

/** A saved draft, moved to Trash for as long as Undo can bring it back. */
export interface TrashedDraft {
  draftId: string;
  /** The JMAP account it lives in, when not the login's own. */
  accountId?: string;
}

interface Kept {
  payload: ComposePopoutPayload;
  login: string | null;
  trashed?: TrashedDraft;
  at: number;
  timer: ReturnType<typeof setTimeout>;
}

const kept = new Map<string, Kept>();
let leaving = false;

function newToken(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function clientFor(login: string | null): IJMAPClient | null {
  const auth = useAuthStore.getState();
  return (login ? auth.getClientForAccount(login) : auth.client) ?? null;
}

async function mailboxWithRole(client: IJMAPClient, role: 'trash' | 'drafts', accountId?: string): Promise<string | null> {
  const own = client.getAccountId();
  const mailboxes = await client.getAllMailboxes();
  const found = mailboxes.find((mailbox) => mailbox.role === role && (mailbox.accountId ?? own) === (accountId ?? own));
  return found ? found.originalId || found.id : null;
}

/** Gone for good: the Undo ran out, or the page is going. */
function destroy(entry: Kept): void {
  if (!entry.trashed) return;
  const client = clientFor(entry.login);
  void client?.deleteEmail(entry.trashed.draftId, entry.trashed.accountId).catch((error: unknown) => console.error('Failed to discard draft:', error));
}

function forget(token: string, destroyDraft: boolean): Kept | null {
  const entry = kept.get(token);
  if (!entry) return null;
  clearTimeout(entry.timer);
  kept.delete(token);
  if (destroyDraft) destroy(entry);
  return entry;
}

function watchLeaving(): void {
  if (leaving || typeof window === 'undefined') return;
  leaving = true;
  // As the in-app Undo did: nothing is left behind in Trash when the page goes.
  window.addEventListener('pagehide', () => {
    for (const token of [...kept.keys()]) forget(token, true);
  });
}

/**
 * A saved draft to Trash, for Undo to bring back. False when that didn't work: the draft
 * is then deleted as before, and Undo brings the text back as a new draft.
 */
export async function trashDiscardedDraft(login: string | null, draft: TrashedDraft): Promise<boolean> {
  const client = clientFor(login);
  if (!client) return false;
  try {
    const trash = await mailboxWithRole(client, 'trash', draft.accountId);
    if (!trash) throw new Error('No Trash');
    await client.moveEmail(draft.draftId, trash, draft.accountId);
    return true;
  } catch (error) {
    console.warn('Could not move a discarded draft to Trash:', error);
    await client.deleteEmail(draft.draftId, draft.accountId).catch((failed: unknown) => console.error('Failed to discard draft:', failed));
    return false;
  }
}

/**
 * What comes back: the composer as it was. On the draft moved back from Trash when there
 * is one, else as a new one. Either way it counts as unsaved, so it saves itself.
 */
export function restoredPayload(payload: ComposePopoutPayload, trashed?: TrashedDraft): ComposePopoutPayload {
  const data = payload.initialData;
  return {
    ...payload,
    initialDraftText: undefined,
    prefill: null,
    initialFiles: undefined,
    initialData: data
      ? trashed
        ? { ...data, draftId: trashed.draftId, draftAccountId: trashed.accountId, unedited: undefined, unsaved: true }
        : { ...data, draftId: null, draftAccountId: undefined, draftLocalAccountId: undefined, unedited: undefined, unsaved: true }
      : data,
  };
}

/** Keeps a discarded composer for Undo. Returns the token the notification hands back. */
export function keepDiscarded(payload: ComposePopoutPayload, login: string | null, trashed?: TrashedDraft): string {
  watchLeaving();
  while (kept.size >= MAX_KEPT) {
    const oldest = kept.keys().next().value;
    if (oldest === undefined) break;
    forget(oldest, true);
  }
  const token = newToken();
  const timer = setTimeout(() => forget(token, true), DISCARDED_KEEP_MS);
  kept.set(token, { payload, login, trashed, at: Date.now(), timer });
  return token;
}

export function hasDiscarded(token: string): boolean {
  return kept.has(token);
}

/**
 * Undo: the draft back in Drafts, and quick compose open again with what was thrown
 * away. False when there's nothing (any more) to bring back, or no window opened.
 */
export async function reopenDiscarded(token: string): Promise<boolean> {
  const entry = forget(token, false);
  if (!entry) return false;
  let trashed = entry.trashed;
  if (trashed) {
    const client = clientFor(entry.login);
    try {
      const drafts = client ? await mailboxWithRole(client, 'drafts', trashed.accountId) : null;
      if (!client || !drafts) throw new Error('No Drafts');
      await client.moveEmail(trashed.draftId, drafts, trashed.accountId);
    } catch (error) {
      console.warn('Could not move a discarded draft back to Drafts:', error);
      trashed = undefined;
    }
  }
  const window = openComposerWindow(entry.login, { quick: true });
  if (!window) {
    // Nothing on screen to bring it back to: it stays thrown away, as asked.
    if (trashed) destroy({ ...entry, trashed });
    return false;
  }
  void window.handOver(restoredPayload(entry.payload, trashed));
  return true;
}

export interface DiscardedNoticeLabels {
  discarded: string;
  undo: string;
}

/**
 * "Draft discarded" with Undo, from the OS. True when it showed; false where there's
 * no OS notification or it didn't show, so the caller can offer Undo itself.
 */
export async function notifyDiscarded(token: string, subject: string, labels: DiscardedNoticeLabels): Promise<boolean> {
  const os = getDesktopBridge()?.os;
  if (!os?.notify) return false;
  try {
    const result = await os.notify({
      id: `discarded:${token}`,
      title: labels.discarded,
      body: subject.trim(),
      context: JSON.stringify({ discardedDraft: token }),
      actions: [{ id: 'undo', label: labels.undo }],
      kind: 'undo',
    });
    return !!result?.shown;
  } catch {
    return false;
  }
}

/** For tests. */
export function forgetAllDiscarded(): void {
  for (const token of [...kept.keys()]) forget(token, false);
}
