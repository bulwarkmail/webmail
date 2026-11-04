/**
 * Undo for a draft thrown away in a composer window of its own, in the desktop app
 * (desktop-p3-1). Quick compose is used with the main window in the tray, so its toast
 * would sit in a window nobody sees, and a draft not saved yet had no Undo at all.
 *
 * The main window keeps what the composer held, deletes the draft at once, and asks
 * the OS for a "Draft discarded" notification with Undo. Undo opens quick compose
 * again with the text, the attachments and the send options as they were; it saves
 * itself again as a new draft. Kept in this page's memory only, for an hour.
 */

import { getDesktopBridge } from '@/lib/desktop/bridge';
import type { ComposePopoutPayload } from './compose-payload';
import { openComposerWindow } from './open';

/** An Undo from the Action Center after this long finds nothing to bring back. */
export const DISCARDED_KEEP_MS = 60 * 60 * 1000;
const MAX_KEPT = 20;

interface Kept {
  payload: ComposePopoutPayload;
  login: string | null;
  at: number;
}

const kept = new Map<string, Kept>();

function newToken(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function dropOld(now: number): void {
  for (const [token, entry] of kept) if (now - entry.at > DISCARDED_KEEP_MS) kept.delete(token);
  while (kept.size >= MAX_KEPT) {
    const oldest = kept.keys().next().value;
    if (oldest === undefined) break;
    kept.delete(oldest);
  }
}

/**
 * What comes back: the composer as it was, without the draft that is gone from the
 * server by then. It counts as unsaved, so it saves itself again.
 */
export function restoredPayload(payload: ComposePopoutPayload): ComposePopoutPayload {
  const data = payload.initialData;
  return {
    ...payload,
    initialDraftText: undefined,
    prefill: null,
    initialFiles: undefined,
    initialData: data
      ? { ...data, draftId: null, draftAccountId: undefined, draftLocalAccountId: undefined, unedited: undefined, unsaved: true }
      : data,
  };
}

/** Keeps a discarded composer for Undo. Returns the token the notification hands back. */
export function keepDiscarded(payload: ComposePopoutPayload, login: string | null, now = Date.now()): string {
  dropOld(now);
  const token = newToken();
  kept.set(token, { payload: restoredPayload(payload), login, at: now });
  return token;
}

export function hasDiscarded(token: string): boolean {
  const entry = kept.get(token);
  return !!entry && Date.now() - entry.at <= DISCARDED_KEEP_MS;
}

/**
 * Undo: quick compose opens again with what was thrown away. False when there's
 * nothing (any more) to bring back, or no window opened.
 */
export function reopenDiscarded(token: string): boolean {
  const entry = kept.get(token);
  if (!entry || Date.now() - entry.at > DISCARDED_KEEP_MS) {
    kept.delete(token);
    return false;
  }
  const window = openComposerWindow(entry.login, { quick: true });
  if (!window) return false;
  kept.delete(token);
  void window.handOver(entry.payload).then((shown) => {
    // Not on screen in time: keep it, so Undo can be tried again.
    if (!shown) kept.set(token, entry);
  });
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
  kept.clear();
}
