/**
 * The Undo send delay travels as a time (`delayedUntil`) through the
 * composer, its hosts, the stores, a crypto plugin's raw send and the JMAP
 * client. The delay is meant from the moment the server takes the message,
 * not from the click: a question answered in between (a plugin's send check,
 * a passphrase) or the save before the send used to eat it, and an answer
 * slower than the delay put the time in the past, so the server refused the
 * send with "Scheduled send time must be in the future" (compose-p3-1).
 *
 * The times made here are remembered for this tab, and the client turns
 * such a time back into the whole delay when it builds the submission. A
 * time the user picked in the schedule dialog isn't one of them and stays
 * as it is.
 */

/** At most this many Undo times are remembered; older ones are long submitted. */
const REMEMBERED = 50;

const issued = new Map<string, number>();

/** The time to send at for an Undo delay of `seconds`, counted from `now`. */
export function undoDelayUntil(seconds: number, now = Date.now()): string {
  let at = now + seconds * 1000;
  // Two sends in the same millisecond still get times of their own.
  while (issued.has(new Date(at).toISOString())) at += 1;
  const iso = new Date(at).toISOString();
  issued.set(iso, seconds);
  if (issued.size > REMEMBERED) issued.delete(issued.keys().next().value!);
  return iso;
}

/**
 * The Undo delay `delayedUntil` stands for, in whole seconds, when it came
 * from undoDelayUntil in this tab; undefined for any other time.
 */
export function undoDelaySeconds(delayedUntil: string | undefined): number | undefined {
  return delayedUntil === undefined ? undefined : issued.get(delayedUntil);
}
