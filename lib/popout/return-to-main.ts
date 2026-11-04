/**
 * Moves a composer from its own window back into the main window: the way back of
 * compose-handoff.ts. The pop-out has saved by now and keeps its copy until the main
 * window says the composer is on screen there. A main window already busy with a message
 * says so and takes nothing, because a composer that is open holds someone's text.
 *
 * Only one window may end up with the text, so the move has two steps. The main window says
 * it's ready before it opens anything. The pop-out commits only if it hasn't given up, and
 * from then on it waits for as long as a main window is there: giving up after that would
 * leave the same draft open twice.
 */

import { onComposerOpened } from '@/lib/compose-flush-registry';
import { newPopoutId, openPopoutChannel } from './channel';
import type { ComposePopoutPayload } from './compose-payload';

/** Longer than a route change to the mail page takes; then the pop-out keeps the draft. */
export const RETURN_WAIT_MS = 20_000;
/** How long a main window that said it's ready waits to hear go ahead. */
const COMMIT_WAIT_MS = 5000;
/** How often a pop-out that committed looks whether a main window is still there. */
const ALIVE_CHECK_MS = 1000;

export type ReturnAnswer = 'shown' | 'busy';
export type ReturnResult = ReturnAnswer | 'no-answer';

/** From a pop-out: `shown` once the composer is on screen in the main window. */
export function returnComposerToMain(
  payload: ComposePopoutPayload,
  accountId: string | null | undefined,
  mainStillThere: () => boolean,
  waitMs = RETURN_WAIT_MS,
): Promise<ReturnResult> {
  return new Promise((resolve) => {
    const returnId = newPopoutId();
    let aliveTimer: ReturnType<typeof setInterval> | null = null;
    const finish = (result: ReturnResult) => {
      clearTimeout(timer);
      if (aliveTimer) clearInterval(aliveTimer);
      channel?.close();
      resolve(result);
    };
    const channel = openPopoutChannel((message) => {
      if (!('returnId' in message) || message.returnId !== returnId) return;
      if (message.type === 'composer-return-answer') finish(message.status);
      if (message.type === 'composer-return-ready') {
        clearTimeout(timer);
        channel?.post({ type: 'composer-return-commit', returnId });
        aliveTimer = setInterval(() => {
          if (!mainStillThere()) finish('no-answer');
        }, ALIVE_CHECK_MS);
      }
    });
    const timer = setTimeout(() => {
      channel?.post({ type: 'composer-return-cancel', returnId });
      finish('no-answer');
    }, waitMs);
    channel?.post({ type: 'composer-return', returnId, accountId: accountId ?? undefined, payload });
  });
}

export interface ReturnedComposer {
  returnId: string;
  payload: ComposePopoutPayload;
  answer: (status: ReturnAnswer) => void;
  /** Asks the pop-out to go ahead. False: it has given up, and keeps the text. */
  claim: () => Promise<boolean>;
}

let waiting: ReturnedComposer | null = null;
const mailListeners = new Set<() => void>();
const elsewhereListeners = new Set<() => void>();
const commits = new Map<string, (go: boolean) => void>();

/**
 * In the main window. The mail page picks it up, or, with no mail page on screen, whoever
 * can go there does and the page picks it up as it mounts.
 */
export function offerReturnedComposer(incoming: Omit<ReturnedComposer, 'claim'> & { sendReady: () => void }): void {
  const { sendReady, ...returned } = incoming;
  if (waiting) {
    returned.answer('busy');
    return;
  }
  waiting = {
    ...returned,
    claim: () => new Promise((resolve) => {
      const settle = (go: boolean) => {
        clearTimeout(timer);
        commits.delete(returned.returnId);
        resolve(go);
      };
      const timer = setTimeout(() => settle(false), COMMIT_WAIT_MS);
      commits.set(returned.returnId, settle);
      sendReady();
    }),
  };
  for (const listener of [...(mailListeners.size > 0 ? mailListeners : elsewhereListeners)]) listener();
}

export function takeReturnedComposer(): ReturnedComposer | null {
  const returned = waiting;
  waiting = null;
  return returned;
}

/** The pop-out goes ahead. */
export function commitReturnedComposer(returnId: string): void {
  commits.get(returnId)?.(true);
}

/** The pop-out gave up waiting and keeps the draft. */
export function dropReturnedComposer(returnId: string): void {
  if (waiting?.returnId === returnId) waiting = null;
  commits.get(returnId)?.(false);
}

/** The mail page, for as long as it's there. */
export function onReturnedComposer(listener: () => void): () => void {
  mailListeners.add(listener);
  return () => {
    mailListeners.delete(listener);
  };
}

/** Whoever can bring up the mail page. */
export function onReturnedComposerElsewhere(listener: () => void): () => void {
  elsewhereListeners.add(listener);
  return () => {
    elsewhereListeners.delete(listener);
  };
}

/**
 * Lets the pop-out go once a composer has really opened here. Call before opening it. There's
 * no time limit: the pop-out holds the text until then, and goes on holding it if this window goes.
 */
export function answerWhenComposerOpens(returned: ReturnedComposer): void {
  const stop = onComposerOpened(() => {
    stop();
    returned.answer('shown');
  });
}
