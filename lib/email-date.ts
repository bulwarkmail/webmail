/**
 * Which timestamp to show for a message.
 *
 * JMAP `receivedAt` is the server's internal date - the moment the message
 * landed in the store. That is fine for freshly delivered mail, but it is not
 * the mail's own date: an import, migration or backup restore that does not
 * preserve internal dates stamps every message with the import time, so a whole
 * mailbox suddenly "arrived" today (#891). `sentAt` is the RFC 5322 `Date`
 * header, which survives such moves and is what Thunderbird, Outlook and Apple
 * Mail display.
 *
 * Prefer `sentAt`; fall back to `receivedAt` when the header is missing,
 * unparsable, or implausibly far in the future relative to the receive time
 * (spam forges future dates to float to the top of date-sorted lists; genuine
 * clock skew is minutes, not days).
 *
 * List *ordering* is unaffected - queries still sort by `receivedAt`, which is
 * monotonic and cannot be forged by the sender.
 */

/** How far ahead of `receivedAt` a `Date` header may be before it is ignored. */
export const MAX_FUTURE_SENT_AT_MS = 24 * 60 * 60 * 1000;

interface DatedEmail {
  sentAt?: string | null;
  receivedAt?: string | null;
}

/** `string` when the input is guaranteed a `receivedAt` (a full `Email`), else possibly undefined. */
type DisplayDate<T extends DatedEmail> = T extends { receivedAt: string } ? string : string | undefined;

export function emailDisplayDate<T extends DatedEmail>(email: T): DisplayDate<T> {
  const { sentAt, receivedAt } = email;
  const fallback = (receivedAt ?? undefined) as DisplayDate<T>;
  if (!sentAt) return fallback;
  const sent = Date.parse(sentAt);
  if (Number.isNaN(sent)) return fallback;
  if (receivedAt) {
    const received = Date.parse(receivedAt);
    if (!Number.isNaN(received) && sent - received > MAX_FUTURE_SENT_AT_MS) return fallback;
  }
  return sentAt as DisplayDate<T>;
}

/**
 * How long after its `Date` header a message may arrive before the list takes
 * it for imported or restored mail and shows the header instead.
 */
export const MAX_DELIVERY_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Which timestamp the message list shows: when the mail arrived, as Gmail and
 * Outlook do. The list sorts by `receivedAt`, so a mail held up on the way
 * would otherwise show an older time between newer ones and the list would
 * look out of order. The reader and the details keep the sent time
 * (`emailDisplayDate`).
 *
 * Mail that arrived much later than it was sent was imported or restored
 * (#891): its `receivedAt` is the import time, so it shows its own date.
 */
export function emailListDate<T extends DatedEmail>(email: T): DisplayDate<T> {
  const { sentAt, receivedAt } = email;
  const received = receivedAt ? Date.parse(receivedAt) : NaN;
  if (Number.isNaN(received)) return emailDisplayDate(email);
  const sent = sentAt ? Date.parse(sentAt) : NaN;
  if (!Number.isNaN(sent) && received - sent > MAX_DELIVERY_DELAY_MS) return emailDisplayDate(email);
  return receivedAt as DisplayDate<T>;
}
