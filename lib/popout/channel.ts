/**
 * What the windows of this browser say to each other about pop-outs. A
 * BroadcastChannel, because a window opened by the desktop bridge has no
 * opener, and a pop-out outlives a reload of the window that opened it.
 *
 * Every same-origin page hears this channel, and that includes privileged
 * plugin frames (untrusted ones have an opaque origin and don't). So no
 * credential goes on it in the clear: session answers are sealed for the
 * window that asked (lib/popout/sealed.ts), and a refused credential is named
 * by its fingerprint. Draft text does go on it, as it does for the plugins that
 * see drafts anyway.
 */

import type { ComposerDraftData } from '@/components/email/email-composer';
import { isAppLockedNow } from '@/lib/app-lock/state';
import type { MessagePriority } from '@/lib/message-priority';
import type { EmailRestorePoint } from '@/stores/email-store';
import type { ComposePopoutPayload } from './compose-payload';
import { canSealSessions, createSessionOpener, credentialFingerprint, type SealedAnswer } from './sealed';

export const POPOUT_CHANNEL = 'bulwark:popout-windows';

/** One connected login, as the window that holds it sees it. */
export interface SharedAccountSession {
  accountId: string;
  serverUrl: string;
  username: string;
  authMode: 'basic' | 'token' | 'oauth';
  authHeader: string;
  /** The window started offline: it has no credential to share (#523). */
  offlineOnly?: boolean;
}

export interface SharedSessionAnswer {
  activeAccountId: string | null;
  sessions: SharedAccountSession[];
}

/** The send's outcome, for the main window to say and to offer Undo. The pop-out has closed by then. */
export interface PopoutSentNotice {
  accountId: string | null;
  scheduled?: boolean;
  queued?: boolean;
  filingError?: boolean;
  rejectedRecipients?: string;
  /** stores/email-store.ts PendingUndoSend. */
  pendingUndoSend?: {
    submissionId: string;
    emailId?: string;
    identityId?: string;
    sendAt: string;
    isSmime: boolean;
    localAccountId?: string;
    submissionAccountId?: string;
  } | null;
  /** A send held for undo in the pop-out itself: when the server lets it go. */
  releasesAt?: string;
  /** That send's submission, which the main window's Scheduled leaves out until then. */
  heldSubmissionId?: string;
}

/**
 * A message a message window archived, deleted or moved, for the main window
 * to offer Undo for (a toast and Ctrl+Z). The message window has closed by then.
 */
export interface PopoutMovedNotice {
  kind: 'archive' | 'delete' | 'move';
  /** Where the messages were (stores/email-store.ts EmailRestoreBatch), by login instead of client. */
  batches: Array<{ login: string | null; accountId?: string; points: EmailRestorePoint[] }>;
}

/**
 * A draft whose window is closing, ready to save. A request started while a
 * window closes doesn't survive, and saving takes several, so another window
 * does it. The arguments of JMAPClient.createDraft, as plain data.
 */
export interface RescuedDraft {
  /** The login to save through; absent, the window's active one. */
  localAccountId?: string;
  to: string[];
  subject: string;
  body: string;
  cc: string[];
  bcc: string[];
  identityId?: string;
  fromEmail?: string;
  /** The version this one replaces. */
  draftId?: string;
  attachments: Array<{ blobId: string; name: string; type: string; size: number; disposition?: 'attachment' | 'inline'; cid?: string }>;
  fromName?: string;
  htmlBody?: string;
  inReplyTo?: string[];
  references?: string[];
  options?: { priority?: MessagePriority; previousDraftAccountId?: string; classification?: string | null };
  /** The composer's state: where the text goes when the save fails. */
  state: ComposerDraftData;
  /** For a reload of that window to ask which draft id came of it. */
  rescueKey?: string;
}

export type PopoutMessage =
  | { type: 'session-request'; requestId: string; publicKey: JsonWebKey; accountId?: string; rejectedFingerprint?: string }
  | { type: 'session-answer'; requestId: string; sealed: SealedAnswer }
  | { type: 'handoff-request'; handoffId: string }
  | { type: 'handoff-answer'; handoffId: string; payload: ComposePopoutPayload | null }
  | { type: 'handoff-rendered'; handoffId: string }
  | { type: 'sent'; requestId: string; notice: PopoutSentNotice }
  | { type: 'sent-ack'; requestId: string }
  | { type: 'moved'; requestId: string; notice: PopoutMovedNotice }
  | { type: 'moved-ack'; requestId: string }
  | { type: 'mail-changed'; accountId: string | null }
  | { type: 'draft-kept'; requestId: string; notice: DraftKeptNotice }
  | { type: 'state-change' }
  | { type: 'draft-rescue'; draft: RescuedDraft }
  | { type: 'rescue-query'; rescueKey: string }
  | { type: 'rescue-answer'; rescueKey: string; draftId: string | null }
  | { type: 'composer-return'; returnId: string; accountId?: string; payload: ComposePopoutPayload }
  | { type: 'composer-return-ready'; returnId: string }
  | { type: 'composer-return-commit'; returnId: string }
  | { type: 'composer-return-answer'; returnId: string; status: 'shown' | 'busy' }
  | { type: 'composer-return-cancel'; returnId: string }
  | { type: 'main-ping' }
  | { type: 'main-pong'; windowId: string; accountIds: string[] }
  | { type: 'main-gone'; windowId: string }
  | { type: 'account-removed'; accountId: string };

/** A pop-out closed and kept its draft: the main window says so, with Discard. */
export interface DraftKeptNotice {
  draftId: string;
  /** The account it lives in, when not the login's own. */
  accountId?: string;
  /** The login it was saved through. */
  localAccountId?: string;
  /** Thrown away with the bin: "Draft discarded" with Undo, deleted after. */
  discarded?: boolean;
}

export interface PopoutChannel {
  post(message: PopoutMessage): void;
  close(): void;
}

/** Null without BroadcastChannel: pop-outs aren't offered then (lib/popout/support.ts). */
export function openPopoutChannel(onMessage: (message: PopoutMessage) => void): PopoutChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(POPOUT_CHANNEL);
  } catch {
    return null;
  }
  channel.onmessage = (event: MessageEvent) => {
    const message = event.data as PopoutMessage | null;
    if (message && typeof message.type === 'string') onMessage(message);
  };
  return {
    post(message) {
      try {
        channel.postMessage(message);
      } catch {
        // The channel is closed, or the page is going away.
      }
    },
    close() {
      channel.close();
    },
  };
}

function newId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export { newId as newPopoutId };

/** How long a pop-out waits for a main window before it goes on without one. */
export const SESSION_ANSWER_MS = 3000;

/**
 * The session of a window that is signed in. With `accountId`, only a window
 * holding that login answers, so the first answer is one that can be used.
 * With `rejectedAuthHeader` the server just refused that credential: the main
 * window renews it first when it still holds the same one. Null when no main
 * window answers in time.
 */
export async function requestWindowSession(
  options: { accountId?: string; rejectedAuthHeader?: string } = {},
  timeoutMs: number = SESSION_ANSWER_MS,
): Promise<SharedSessionAnswer | null> {
  if (!canSealSessions() || isAppLockedNow()) return null;
  const opener = await createSessionOpener();
  const rejectedFingerprint = options.rejectedAuthHeader ? await credentialFingerprint(options.rejectedAuthHeader) : undefined;
  return new Promise((resolve) => {
    const requestId = newId();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (answer: SharedSessionAnswer | null) => {
      if (timer) clearTimeout(timer);
      channel?.close();
      resolve(answer);
    };
    const channel = openPopoutChannel((message) => {
      if (message.type !== 'session-answer' || message.requestId !== requestId) return;
      // Locked while the answer was on its way: it is not opened.
      if (isAppLockedNow()) {
        finish(null);
        return;
      }
      void opener.open<SharedSessionAnswer>(message.sealed).then(finish, () => finish(null));
    });
    if (!channel) {
      resolve(null);
      return;
    }
    timer = setTimeout(() => finish(null), timeoutMs);
    channel.post({
      type: 'session-request',
      requestId,
      publicKey: opener.publicKey,
      ...(options.accountId ? { accountId: options.accountId } : {}),
      ...(rejectedFingerprint ? { rejectedFingerprint } : {}),
    });
  });
}

/** Tells a main window what was sent. True when one took it over. */
export function announceSentToMainWindow(notice: PopoutSentNotice, timeoutMs = 500): Promise<boolean> {
  return announceToMainWindow((requestId) => ({ type: 'sent', requestId, notice }), 'sent-ack', timeoutMs);
}

/** Hands a move's Undo to a main window. True when one took it over. */
export function announceMovedToMainWindow(notice: PopoutMovedNotice, timeoutMs = 500): Promise<boolean> {
  return announceToMainWindow((requestId) => ({ type: 'moved', requestId, notice }), 'moved-ack', timeoutMs);
}

function announceToMainWindow(message: (requestId: string) => PopoutMessage, ack: 'sent-ack' | 'moved-ack', timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const requestId = newId();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const channel = openPopoutChannel((answer) => {
      if (answer.type === ack && answer.requestId === requestId) finish(true);
    });
    const finish = (taken: boolean) => {
      if (timer) clearTimeout(timer);
      channel?.close();
      resolve(taken);
    };
    if (!channel) {
      resolve(false);
      return;
    }
    timer = setTimeout(() => finish(false), timeoutMs);
    channel.post(message(requestId));
  });
}

/** Tells the main windows that this pop-out changed mail they may be showing. */
export function announceMailChanged(accountId: string | null): void {
  const channel = openPopoutChannel(() => {});
  channel?.post({ type: 'mail-changed', accountId });
  channel?.close();
}

/** Tells the main window that a closing pop-out kept its draft. */
export function announceDraftKept(notice: DraftKeptNotice): void {
  const channel = openPopoutChannel(() => {});
  channel?.post({ type: 'draft-kept', requestId: newId(), notice });
  channel?.close();
}

/**
 * The draft id a closing window's text was saved under, for the same window
 * after a reload, whose own copy still names the version that replaced. Null
 * when no window saved anything for it.
 */
export function askRescuedDraftId(rescueKey: string, timeoutMs = 1500): Promise<string | null> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const channel = openPopoutChannel((message) => {
      if (message.type === 'rescue-answer' && message.rescueKey === rescueKey) finish(message.draftId);
    });
    const finish = (draftId: string | null) => {
      if (timer) clearTimeout(timer);
      channel?.close();
      resolve(draftId);
    };
    if (!channel) {
      resolve(null);
      return;
    }
    timer = setTimeout(() => finish(null), timeoutMs);
    channel.post({ type: 'rescue-query', rescueKey });
  });
}

/** How often a pop-out checks that a main window is there, and how long an answer counts. */
const MAIN_PING_MS = 4000;
const MAIN_ALIVE_MS = 10_000;

/**
 * Keeps track, synchronously, of which main windows are open and which logins
 * they hold: a window closing has no time to ask. Also hands a closing draft to
 * one that can save it.
 */
export function watchMainWindow(): { alive(accountId?: string): boolean; rescue(draft: RescuedDraft): boolean; stop(): void } {
  const windows = new Map<string, { at: number; accountIds: string[] }>();
  const channel = openPopoutChannel((message) => {
    if (message.type === 'main-pong') windows.set(message.windowId, { at: Date.now(), accountIds: message.accountIds });
    if (message.type === 'main-gone') windows.delete(message.windowId);
  });
  channel?.post({ type: 'main-ping' });
  const timer = setInterval(() => channel?.post({ type: 'main-ping' }), MAIN_PING_MS);
  const alive = (accountId?: string) => [...windows.values()].some((entry) =>
    Date.now() - entry.at < MAIN_ALIVE_MS && (!accountId || entry.accountIds.includes(accountId)));
  return {
    alive,
    rescue(draft) {
      if (!channel || !alive(draft.localAccountId)) return false;
      channel.post({ type: 'draft-rescue', draft });
      return true;
    },
    stop() {
      clearInterval(timer);
      channel?.close();
    },
  };
}
