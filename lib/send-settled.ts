// When a send the server accepted has really gone out.
//
// - A plain send has gone at once.
// - A send the user scheduled for later counts as gone at once too: the
//   server has it, and nothing on this side waits for the time to come.
// - A send held back for undo ("Sending in 10 s") goes when the hold runs out
//   or the user picks "Send now", and never when the user undoes it.
// - A send waiting in the offline outbox (#523) has not gone, and nothing
//   here follows it.
//
// The one place that tracks held sends: the plugin announcement
// (plugin-after-send.ts) and the app's own follow-ups both wait through
// `whenSent`, and the undo toast settles a hold with `releaseHeldSend` or
// `cancelHeldSend`.

import type { SendEmailResult } from './jmap/types';

type SendResult = Pick<SendEmailResult, 'queued' | 'scheduled' | 'emailSubmissionId' | 'sendAt'>;

interface Hold {
  timer: ReturnType<typeof setTimeout>;
  followUps: Array<() => void>;
}

const holds = new Map<string, Hold>();

function run(followUps: Array<() => void>): void {
  for (const followUp of followUps) {
    try {
      followUp();
    } catch {
      // One follow-up failing does not stop the others.
    }
  }
}

function settle(submissionId: string): Hold | undefined {
  const hold = holds.get(submissionId);
  if (!hold) return undefined;
  clearTimeout(hold.timer);
  holds.delete(submissionId);
  return hold;
}

/**
 * Run `followUp` once the send has gone (see the rules above). Pass
 * `scheduledByUser` for a send the user scheduled: its `scheduled` result
 * looks like an undo hold's, but there is nothing to wait for.
 */
export function whenSent(
  result: SendResult,
  followUp: () => void,
  { scheduledByUser = false }: { scheduledByUser?: boolean } = {},
): void {
  if (result.queued) return;
  const submissionId = result.emailSubmissionId;
  if (scheduledByUser || !result.scheduled || !submissionId || !result.sendAt) {
    run([followUp]);
    return;
  }
  const existing = holds.get(submissionId);
  if (existing) {
    existing.followUps.push(followUp);
    return;
  }
  const wait = Math.max(0, Date.parse(result.sendAt) - Date.now());
  const hold: Hold = {
    followUps: [followUp],
    timer: setTimeout(() => {
      holds.delete(submissionId);
      run(hold.followUps);
    }, Number.isFinite(wait) ? wait : 0),
  };
  holds.set(submissionId, hold);
}

/** The user chose "Send now" for a held send: it has gone. */
export function releaseHeldSend(submissionId: string): void {
  const hold = settle(submissionId);
  if (hold) run(hold.followUps);
}

/** The user undid a held send: it never goes, and nothing waiting on it runs. */
export function cancelHeldSend(submissionId: string): void {
  settle(submissionId);
}

/** Drop every held send (tests). */
export function resetHeldSends(): void {
  for (const { timer } of holds.values()) clearTimeout(timer);
  holds.clear();
}
