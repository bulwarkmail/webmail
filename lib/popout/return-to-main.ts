/**
 * Moves a composer from its own window back into the main window: the way back of
 * compose-handoff.ts. The pop-out has saved by now and keeps its copy until the main
 * window says the composer is on screen there. A main window already busy with a message
 * says so and takes nothing, because a composer that is open holds someone's text.
 */

import { onComposerOpened } from '@/lib/compose-flush-registry';
import { newPopoutId, openPopoutChannel } from './channel';
import type { ComposePopoutPayload } from './compose-payload';

/** Longer than a route change to the mail page takes; then the pop-out keeps the draft. */
export const RETURN_WAIT_MS = 20_000;
const OPEN_WAIT_MS = RETURN_WAIT_MS - 2000;

export type ReturnAnswer = 'shown' | 'busy';
export type ReturnResult = ReturnAnswer | 'no-answer';

/** From a pop-out: true once the composer is on screen in the main window. */
export function returnComposerToMain(payload: ComposePopoutPayload, accountId?: string | null, waitMs = RETURN_WAIT_MS): Promise<ReturnResult> {
  return new Promise((resolve) => {
    const returnId = newPopoutId();
    const finish = (result: ReturnResult) => {
      clearTimeout(timer);
      channel?.close();
      resolve(result);
    };
    const channel = openPopoutChannel((message) => {
      if (message.type === 'composer-return-answer' && message.returnId === returnId) finish(message.status);
    });
    const timer = setTimeout(() => {
      // It might still turn up there, next to the copy that stays here.
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
}

let waiting: ReturnedComposer | null = null;
const mailListeners = new Set<() => void>();
const elsewhereListeners = new Set<() => void>();

/**
 * In the main window. The mail page picks it up, or, with no mail page on screen, whoever
 * can go there does and the page picks it up as it mounts.
 */
export function offerReturnedComposer(returned: ReturnedComposer): void {
  if (waiting) {
    returned.answer('busy');
    return;
  }
  waiting = returned;
  for (const listener of [...(mailListeners.size > 0 ? mailListeners : elsewhereListeners)]) listener();
}

export function takeReturnedComposer(): ReturnedComposer | null {
  const returned = waiting;
  waiting = null;
  return returned;
}

/** The pop-out gave up waiting and keeps the draft. */
export function dropReturnedComposer(returnId: string): void {
  if (waiting?.returnId === returnId) waiting = null;
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

/** Lets the pop-out go once a composer has really opened here. Call before opening it. */
export function answerWhenComposerOpens(returned: ReturnedComposer, waitMs = OPEN_WAIT_MS): void {
  const finish = () => {
    clearTimeout(timer);
    stop();
    returned.answer('shown');
  };
  const stop = onComposerOpened(finish);
  // No answer means the pop-out stays with the text: nothing is lost by saying nothing.
  const timer = setTimeout(stop, waitMs);
}
