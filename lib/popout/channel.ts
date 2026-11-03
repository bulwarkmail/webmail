/**
 * What the windows of this browser say to each other about pop-outs. A
 * BroadcastChannel, because a window opened by the desktop bridge has no
 * opener, and a pop-out outlives a reload of the window that opened it.
 *
 * Session answers carry the auth header. A channel reaches same-origin pages
 * only, and those can already ask PUT /api/auth/session for the credentials;
 * plugin frames of the untrusted tier have an opaque origin and aren't on it.
 */

import type { ComposePopoutPayload } from './compose-payload';

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
  options?: { priority?: import('@/lib/message-priority').MessagePriority; previousDraftAccountId?: string; classification?: string | null };
}

export type PopoutMessage =
  | { type: 'session-request'; requestId: string; accountId?: string; rejectedAuthHeader?: string }
  | { type: 'session-answer'; requestId: string; answer: SharedSessionAnswer }
  | { type: 'handoff-request'; handoffId: string }
  | { type: 'handoff-answer'; handoffId: string; payload: ComposePopoutPayload | null }
  | { type: 'sent'; requestId: string; notice: PopoutSentNotice }
  | { type: 'sent-ack'; requestId: string }
  | { type: 'mail-changed'; accountId: string | null }
  | { type: 'state-change' }
  | { type: 'draft-rescue'; draft: RescuedDraft }
  | { type: 'main-ping' }
  | { type: 'main-pong' }
  | { type: 'main-gone' }
  | { type: 'account-removed'; accountId: string };

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
 * The session of a window that is signed in, from any main window. With
 * `rejectedAuthHeader` the server just refused that credential: the main
 * window renews it first when it still holds the same one. Null when no main
 * window answers in time.
 */
export function requestWindowSession(
  options: { accountId?: string; rejectedAuthHeader?: string } = {},
  timeoutMs: number = SESSION_ANSWER_MS,
): Promise<SharedSessionAnswer | null> {
  return new Promise((resolve) => {
    const requestId = newId();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const channel = openPopoutChannel((message) => {
      if (message.type !== 'session-answer' || message.requestId !== requestId) return;
      finish(message.answer);
    });
    const finish = (answer: SharedSessionAnswer | null) => {
      if (timer) clearTimeout(timer);
      channel?.close();
      resolve(answer);
    };
    if (!channel) {
      resolve(null);
      return;
    }
    timer = setTimeout(() => finish(null), timeoutMs);
    channel.post({ type: 'session-request', requestId, ...options });
  });
}

/** Tells a main window what was sent. True when one took it over. */
export function announceSentToMainWindow(notice: PopoutSentNotice, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const requestId = newId();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const channel = openPopoutChannel((message) => {
      if (message.type === 'sent-ack' && message.requestId === requestId) finish(true);
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
    channel.post({ type: 'sent', requestId, notice });
  });
}

/** Tells the main windows that this pop-out changed mail they may be showing. */
export function announceMailChanged(accountId: string | null): void {
  const channel = openPopoutChannel(() => {});
  channel?.post({ type: 'mail-changed', accountId });
  channel?.close();
}

/** How often a pop-out checks that a main window is there, and how long an answer counts. */
const MAIN_PING_MS = 4000;
const MAIN_ALIVE_MS = 10_000;

/**
 * Keeps track, synchronously, of whether a main window is open: a window
 * closing has no time to ask. Also hands a closing draft to it.
 */
export function watchMainWindow(): { alive(): boolean; rescue(draft: RescuedDraft): boolean; stop(): void } {
  let lastSeen = 0;
  const channel = openPopoutChannel((message) => {
    if (message.type === 'main-pong') lastSeen = Date.now();
    if (message.type === 'main-gone') {
      lastSeen = 0;
      // Another main window takes over, and answers this.
      channel?.post({ type: 'main-ping' });
    }
  });
  channel?.post({ type: 'main-ping' });
  const timer = setInterval(() => channel?.post({ type: 'main-ping' }), MAIN_PING_MS);
  const alive = () => Date.now() - lastSeen < MAIN_ALIVE_MS;
  return {
    alive,
    rescue(draft) {
      if (!channel || !alive()) return false;
      channel.post({ type: 'draft-rescue', draft });
      return true;
    },
    stop() {
      clearInterval(timer);
      channel?.close();
    },
  };
}
