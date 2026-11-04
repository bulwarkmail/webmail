/**
 * The toast of a send from the moment the composer closes: "Sending…" while
 * the server takes the message, then "Sent" with View. The composer used to
 * stay on screen, greyed and without a word, until the server answered.
 */

import { toast } from '@/stores/toast-store';
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
