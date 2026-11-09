/**
 * The toast of a send from the moment the composer closes: "Sending…" while
 * the server takes the message, then "Sent" with View. The composer used to
 * stay on screen, greyed and without a word, until the server answered.
 */

import { toast, useToastStore } from '@/stores/toast-store';
import { announce } from '@/lib/announce';
import { effectiveToastDuration } from '@/lib/toast-duration';

export interface SendProgressLabels {
  sending: string;
  sent: string;
  view: string;
}

export interface SendProgress {
  /** The message is out. `view` opens it; without it there is no View. */
  sent(view?: () => void): void;
  /** Another toast says what happened (undo, scheduled, failed, kept offline). */
  dismiss(): void;
}

export function startSendProgress(labels: SendProgressLabels): SendProgress {
  const id = toast.progress(labels.sending, { progress: null });
  let settled = false;
  return {
    sent(view) {
      if (settled) return;
      settled = true;
      const action = view ? { label: labels.view, onClick: view } : undefined;
      toast.update(id, {
        type: 'success',
        title: labels.sent,
        progress: undefined,
        action,
        duration: effectiveToastDuration({ type: 'success', action }),
      });
      // An update isn't read out as a new toast is.
      announce(labels.sent);
    },
    dismiss() {
      if (settled) return;
      settled = true;
      toast.dismiss(id);
    },
  };
}

/** How long past the end of Undo the undo toast is given, so the change to "Sent" comes first. */
export const UNDO_TOAST_SLACK_MS = 1000;

export interface UndoCountdownOptions {
  /** When the server lets the message go (ms since epoch). */
  sendAt: number;
  /** When Undo stops being offered (ms since epoch); the toast turns into "Sent" then. */
  undoEndsAt: number;
  /** The delay the user picked, in seconds: the count never shows more. */
  maxSeconds?: number;
  sendingIn: (seconds: number) => string;
  sent: string;
  /** View on "Sent": opens the message. Without it there is no View. */
  view?: { label: string; onClick: () => void };
  now?: () => number;
}

/**
 * The undo-send toast `id`, counting down to the send ("Sending in 5
 * seconds", 4, 3…), then "Sent" with View for the usual time, as Gmail does
 * (compose-p2-12). It used to show the same number until it went, with no
 * word that the message went. Stops by itself once the toast is gone (Undo,
 * Send now, closed). Returns a stop for the caller.
 */
/**
 * Whole seconds until a held send goes, at least 1 and never more than the
 * delay the user picked: the server's time runs a moment past it, which
 * showed "Sending in 6 seconds" for a 5 s delay.
 */
export function secondsUntilSend(sendAt: number, now: number, maxSeconds?: number): number {
  const left = Math.max(1, Math.ceil((sendAt - now) / 1000));
  return maxSeconds && maxSeconds > 0 ? Math.min(left, maxSeconds) : left;
}

/** Undo is never offered closer than this to the server letting the message go. */
export const UNDO_SAFETY_MS = 500;

/**
 * When Undo ends for a held send shown from `shownAt`: the whole delay the user
 * picked, counted from then, as the server holds the message a moment longer
 * (lib/outgoing/undo-delay.ts). Never later than UNDO_SAFETY_MS before it goes.
 * Before, Undo ended a second before the server's time, which the save and
 * the submission had already eaten into: 5, 4, 3, 2, then "Sent" (compose-p3-8).
 */
export function undoEndsAt(sendAt: number, shownAt: number, delaySeconds: number): number {
  const latest = sendAt - UNDO_SAFETY_MS;
  if (!(delaySeconds > 0)) return Math.max(shownAt, sendAt - 1000);
  return Math.max(shownAt, Math.min(shownAt + delaySeconds * 1000, latest));
}

export function runUndoSendCountdown(id: string, options: UndoCountdownOptions): () => void {
  const now = options.now ?? Date.now;
  const present = () => useToastStore.getState().toasts.some((t) => t.id === id);
  // Down to the end of Undo, where the toast says "Sent": 5, 4, 3, 2, 1.
  const secondsLeft = () => secondsUntilSend(options.undoEndsAt, now(), options.maxSeconds);
  let shown = -1;
  const tick = () => {
    if (!present()) return stop();
    const seconds = secondsLeft();
    if (seconds === shown) return;
    shown = seconds;
    toast.update(id, { title: options.sendingIn(seconds) });
  };
  const finish = () => {
    stop();
    const current = useToastStore.getState().toasts.find((t) => t.id === id);
    if (!current) return;
    const action = options.view;
    let duration = effectiveToastDuration({ type: 'success', action });
    // A new duration starts the toast's countdown afresh; the same one wouldn't.
    if (duration === current.duration) duration += 1;
    toast.update(id, {
      type: 'success',
      title: options.sent,
      message: undefined,
      action,
      secondaryAction: undefined,
      pauseOnHover: undefined,
      duration,
    });
    announce(options.sent);
  };
  const interval = setInterval(tick, 250);
  const timer = setTimeout(finish, Math.max(0, options.undoEndsAt - now()));
  function stop() {
    clearInterval(interval);
    clearTimeout(timer);
  }
  tick();
  return stop;
}
