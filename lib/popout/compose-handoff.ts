/**
 * Moves a composer into a pop-out. The window has to open inside the click,
 * but the draft is only ready once it is saved, so the opening window keeps
 * a pending handoff that the pop-out asks for by id and waits on. The opening
 * window lets go of its copy only once the pop-out says the composer is on
 * screen, with the text in it.
 */

import { openPopoutChannel, newPopoutId, type PopoutChannel } from './channel';
import type { ComposePopoutPayload } from './compose-payload';

/** A handoff nobody asked for after this long is dropped. Above the time a save can take. */
const PENDING_TTL_MS = 120_000;
/** How long a pop-out waits for its draft. */
export const HANDOFF_WAIT_MS = 60_000;
/** How often a pop-out asks again: the request may cross a reload of the window that opened it. */
const HANDOFF_RETRY_MS = 1000;
/** How long the opening window waits for the composer to be on screen before it keeps the draft. */
export const HANDOFF_RENDER_WAIT_MS = 30_000;

const STORAGE_PREFIX = 'bulwark-popout-compose:';

interface Pending {
  requested: boolean;
  /** Undefined until the opening window decided; null means it won't come. */
  payload?: ComposePopoutPayload | null;
  rendered?: (shown: boolean) => void;
  renderTimer?: ReturnType<typeof setTimeout>;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
let channel: PopoutChannel | null = null;

function deliver(handoffId: string, entry: Pending): void {
  if (!entry.requested || entry.payload === undefined) return;
  channel?.post({ type: 'handoff-answer', handoffId, payload: entry.payload });
  // Called off: nothing more to hear. Otherwise stay for "it is on screen".
  if (entry.payload === null) forget(handoffId);
}

function forget(handoffId: string): void {
  const entry = pending.get(handoffId);
  if (entry) {
    clearTimeout(entry.timer);
    if (entry.renderTimer) clearTimeout(entry.renderTimer);
    entry.rendered?.(false);
  }
  pending.delete(handoffId);
  if (pending.size === 0) {
    channel?.close();
    channel = null;
  }
}

export interface ComposeHandoff {
  id: string;
  /** Hands the draft over. True once the composer is on screen in the other window; false if that doesn't happen in time. */
  complete(payload: ComposePopoutPayload, waitMs?: number): Promise<boolean>;
  cancel(): void;
}

/** Null without BroadcastChannel. */
export function createComposeHandoff(): ComposeHandoff | null {
  channel ??= openPopoutChannel((message) => {
    if (message.type === 'handoff-request') {
      const entry = pending.get(message.handoffId);
      if (!entry) return;
      entry.requested = true;
      deliver(message.handoffId, entry);
    } else if (message.type === 'handoff-rendered') {
      const entry = pending.get(message.handoffId);
      if (!entry) return;
      entry.rendered?.(true);
      entry.rendered = undefined;
      forget(message.handoffId);
    }
  });
  if (!channel) return null;

  const id = newPopoutId();
  pending.set(id, { requested: false, timer: setTimeout(() => forget(id), PENDING_TTL_MS) });
  return {
    id,
    complete(payload, waitMs = HANDOFF_RENDER_WAIT_MS) {
      const entry = pending.get(id);
      if (!entry) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        entry.rendered = resolve;
        entry.renderTimer = setTimeout(() => {
          entry.rendered = undefined;
          resolve(false);
        }, waitMs);
        entry.payload = payload;
        deliver(id, entry);
      });
    },
    cancel() {
      const entry = pending.get(id);
      // Also when the draft was delivered already: the pop-out is still listening.
      if (!entry) return;
      entry.payload = null;
      entry.requested = true;
      deliver(id, entry);
    },
  };
}

/** Keeps the draft with this window, so a reload starts from it. */
export function rememberComposePayload(handoffId: string, payload: ComposePopoutPayload): void {
  try {
    // A File doesn't go into JSON: once attached, the draft holds it.
    const { initialFiles: _files, ...kept } = payload;
    sessionStorage.setItem(STORAGE_PREFIX + handoffId, JSON.stringify(kept));
  } catch {
    // Full or unavailable: a reload then starts from the saved draft's first state.
  }
}

/**
 * A newer version is on the server. What's remembered was written as the page last unloaded,
 * and a page that crashes writes nothing, so it would bring back older text than the draft.
 */
export function forgetComposePayload(handoffId: string): void {
  try {
    sessionStorage.removeItem(STORAGE_PREFIX + handoffId);
  } catch {
    // Unavailable: there's nothing remembered either.
  }
}

/** The draft this window holds from before a reload. */
export function rememberedComposePayload(handoffId: string): ComposePopoutPayload | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + handoffId);
    return raw ? (JSON.parse(raw) as ComposePopoutPayload) : null;
  } catch {
    return null;
  }
}

/**
 * The pop-out's side. Null when the opening window called it off, or nothing
 * came in time.
 */
export function receiveComposeHandoff(handoffId: string, timeoutMs: number = HANDOFF_WAIT_MS): Promise<ComposePopoutPayload | null> {
  const remembered = rememberedComposePayload(handoffId);
  if (remembered) return Promise.resolve(remembered);

  return new Promise((resolve) => {
    let retry: ReturnType<typeof setInterval> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (payload: ComposePopoutPayload | null) => {
      if (retry) clearInterval(retry);
      if (timer) clearTimeout(timer);
      listener?.close();
      resolve(payload);
    };
    const listener = openPopoutChannel((message) => {
      if (message.type !== 'handoff-answer' || message.handoffId !== handoffId) return;
      if (message.payload) rememberComposePayload(handoffId, message.payload);
      finish(message.payload);
    });
    if (!listener) {
      resolve(null);
      return;
    }
    const ask = () => listener.post({ type: 'handoff-request', handoffId });
    timer = setTimeout(() => finish(null), timeoutMs);
    retry = setInterval(ask, HANDOFF_RETRY_MS);
    ask();
  });
}

/** The composer with the text is on screen here: the opening window can let go. */
export function acknowledgeComposeHandoff(handoffId: string): void {
  const sender = openPopoutChannel(() => {});
  sender?.post({ type: 'handoff-rendered', handoffId });
  sender?.close();
}

/** Calls `onCancel` if the opening window takes the draft back. Returns the stop. */
export function watchHandoffCancel(handoffId: string, onCancel: () => void): () => void {
  const listener = openPopoutChannel((message) => {
    if (message.type === 'handoff-answer' && message.handoffId === handoffId && message.payload === null) onCancel();
  });
  return () => listener?.close();
}
