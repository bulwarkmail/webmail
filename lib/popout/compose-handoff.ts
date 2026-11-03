/**
 * Moves a composer into a pop-out. The window has to open inside the click,
 * but the draft is only ready once it is saved, so the opening window keeps
 * a pending handoff that the pop-out asks for by id and waits on.
 */

import { openPopoutChannel, newPopoutId, type PopoutChannel } from './channel';
import type { ComposePopoutPayload } from './compose-payload';

/** A handoff nobody asked for after this long is dropped. Above the time a save can take. */
const PENDING_TTL_MS = 120_000;
/** How long a pop-out waits for its draft. */
export const HANDOFF_WAIT_MS = 60_000;
/** How often a pop-out asks again: the request may cross a reload of the window that opened it. */
const HANDOFF_RETRY_MS = 1000;

const STORAGE_PREFIX = 'bulwark-popout-compose:';

interface Pending {
  requested: boolean;
  /** Undefined until the opening window decided; null means it won't come. */
  payload?: ComposePopoutPayload | null;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
let channel: PopoutChannel | null = null;

function deliver(handoffId: string, entry: Pending): void {
  if (!entry.requested || entry.payload === undefined) return;
  channel?.post({ type: 'handoff-answer', handoffId, payload: entry.payload });
  forget(handoffId);
}

function forget(handoffId: string): void {
  const entry = pending.get(handoffId);
  if (entry) clearTimeout(entry.timer);
  pending.delete(handoffId);
  if (pending.size === 0) {
    channel?.close();
    channel = null;
  }
}

export interface ComposeHandoff {
  id: string;
  complete(payload: ComposePopoutPayload): void;
  cancel(): void;
}

/** Null without BroadcastChannel. */
export function createComposeHandoff(): ComposeHandoff | null {
  channel ??= openPopoutChannel((message) => {
    if (message.type !== 'handoff-request') return;
    const entry = pending.get(message.handoffId);
    if (!entry) return;
    entry.requested = true;
    deliver(message.handoffId, entry);
  });
  if (!channel) return null;

  const id = newPopoutId();
  pending.set(id, { requested: false, timer: setTimeout(() => forget(id), PENDING_TTL_MS) });
  const settle = (payload: ComposePopoutPayload | null) => {
    const entry = pending.get(id);
    if (!entry) return;
    entry.payload = payload;
    deliver(id, entry);
  };
  return { id, complete: (payload) => settle(payload), cancel: () => settle(null) };
}

/** Keeps the draft with this window, so a reload starts from it. */
export function rememberComposePayload(handoffId: string, payload: ComposePopoutPayload): void {
  try {
    sessionStorage.setItem(STORAGE_PREFIX + handoffId, JSON.stringify(payload));
  } catch {
    // Full or unavailable: a reload then starts from the saved draft's first state.
  }
}

function rememberedComposePayload(handoffId: string): ComposePopoutPayload | null {
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
    const listener = openPopoutChannel((message) => {
      if (message.type !== 'handoff-answer' || message.handoffId !== handoffId) return;
      if (message.payload) rememberComposePayload(handoffId, message.payload);
      finish(message.payload);
    });
    const finish = (payload: ComposePopoutPayload | null) => {
      if (retry) clearInterval(retry);
      if (timer) clearTimeout(timer);
      listener?.close();
      resolve(payload);
    };
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
