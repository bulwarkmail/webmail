import type { Email, Mailbox } from '@/lib/jmap/types';

/**
 * A message in its Undo send window: sent to the server with a short hold, so
 * the server already files it in Sent and lists its submission. Until the
 * window is over it isn't sent as far as the user can tell (mail-p2-8):
 * Sent and Scheduled don't count it, and the message it answers isn't marked
 * as answered yet.
 */
export const UNDO_WINDOW_MS = 120_000;

export interface HeldSendCounts {
  /** Sent's total before the send, when the send went through the open login. */
  sent?: number;
  /** The Scheduled count before the send. */
  scheduled: number;
}

export function isUndoWindow(sendAt: string | undefined, now = Date.now()): boolean {
  const at = sendAt ? Date.parse(sendAt) : NaN;
  return Number.isFinite(at) && at - now <= UNDO_WINDOW_MS;
}

/**
 * The folder list and Scheduled count to show while a send waits in its
 * Undo window: neither goes above what it was before the send. A count that
 * fell meanwhile (a mail deleted) shows as it is.
 */
export function withoutHeldSend(
  mailboxes: Mailbox[],
  scheduledTotal: number,
  held: { sendAt: string; countsBefore?: HeldSendCounts } | null | undefined,
  now = Date.now(),
): { mailboxes: Mailbox[]; scheduledTotal: number } {
  if (!held?.countsBefore || !isUndoWindow(held.sendAt, now)) return { mailboxes, scheduledTotal };
  const before = held.countsBefore;
  const sentBefore = before.sent;
  const adjusted = sentBefore === undefined ? mailboxes : mailboxes.map((mb) =>
    mb.role === 'sent' && !mb.isShared && mb.totalEmails > sentBefore ? { ...mb, totalEmails: sentBefore } : mb);
  return { mailboxes: adjusted, scheduledTotal: Math.min(scheduledTotal, before.scheduled) };
}

/**
 * The reply just sent, as the conversation shows it until the server's copy
 * is read back (mail-p2-1). With the server's id when it gave one, so the
 * real message replaces it in place.
 */
export function sentEcho(input: {
  emailId?: string;
  threadId: string;
  fromEmail?: string;
  fromName?: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  now?: Date;
}): Email {
  const at = (input.now ?? new Date()).toISOString();
  const preview = input.text.replace(/\s+/g, ' ').trim().slice(0, 256);
  return {
    id: input.emailId ?? `sent-echo-${at}`,
    blobId: '',
    threadId: input.threadId,
    mailboxIds: {},
    keywords: { $seen: true },
    size: 0,
    receivedAt: at,
    sentAt: at,
    from: input.fromEmail ? [{ name: input.fromName ?? '', email: input.fromEmail }] : [],
    to: input.to.map((email) => ({ name: '', email })),
    cc: (input.cc ?? []).map((email) => ({ name: '', email })),
    subject: input.subject,
    preview,
    hasAttachment: false,
    textBody: [{ partId: 'sent-echo', blobId: '', size: 0, type: 'text/plain' }],
    htmlBody: [],
    attachments: [],
    bodyValues: { 'sent-echo': { value: input.text, isEncodingProblem: false, isTruncated: false } },
    sentEcho: true,
  } as unknown as Email;
}

/**
 * The conversation with a just-sent reply added at its end (once).
 */
export function addEcho(conversation: Email[], echo: Email): Email[] {
  if (conversation.some((e) => e.id === echo.id)) return conversation;
  return [...conversation, echo];
}

/**
 * The server's reading of the conversation, with the replies shown before it
 * had them kept at the end: a server that threads a new message a moment
 * later (or an offline send that waits in the outbox) doesn't make the reply
 * vanish again.
 */
export function mergeEchoes(server: Email[], shown: Email[], now = Date.now()): Email[] {
  const ids = new Set(server.map((e) => e.id));
  const byId = new Map(shown.map((e) => [e.id, e]));
  // The thread read carries list properties only: a message already unfolded
  // keeps the body it loaded, with the server's flags and folders.
  const merged = server.map((e) => {
    const had = byId.get(e.id);
    // The server's copy of a reply just sent waits out its Undo window as a
    // submission with a send time; it was sent as far as the user can tell,
    // so it carries no scheduled clock (mail-p3, p2-1).
    const held = !!had && (had.sentEcho || !had.isScheduled) && isHeldSend(e, now);
    const base = held ? withoutScheduledMark(e) : e;
    return had?.bodyValues && !e.bodyValues && !had.sentEcho
      ? { ...had, keywords: e.keywords, mailboxIds: e.mailboxIds }
      : base;
  });
  const echoes = shown.filter((e) => e.sentEcho && !ids.has(e.id));
  return echoes.length ? [...merged, ...echoes] : merged;
}

/**
 * Messages whose send time has passed are sent: a thread read during the
 * Undo window still marks them as waiting.
 */
export function settleSent(emails: Email[], now = Date.now()): Email[] {
  return emails.map((e) => (e.isScheduled && e.scheduledSendAt && Date.parse(e.scheduledSendAt) <= now
    ? withoutScheduledMark(e)
    : e));
}

function withoutScheduledMark(e: Email): Email {
  return { ...e, isScheduled: false, scheduledSendAt: undefined, scheduledUndoStatus: undefined };
}

/** A message the server holds only for an Undo window: its send time is at most that far away. */
function isHeldSend(e: Email, now: number): boolean {
  return !!e.isScheduled && isUndoWindow(e.scheduledSendAt, now);
}

/**
 * Scheduled's count without the sends whose time has come: the server lists
 * a held reply's submission for a few seconds more while it goes out, and
 * Scheduled counted it after the "Sent" toast (mail-p3, p2-1).
 */
export function scheduledShownTotal(
  scheduledTotal: number,
  sendTimes: Iterable<{ sendAt?: string; undoStatus?: string }>,
  now = Date.now(),
): number {
  let due = 0;
  for (const s of sendTimes) {
    const at = s.sendAt ? Date.parse(s.sendAt) : NaN;
    if (s.undoStatus !== 'canceled' && Number.isFinite(at) && at <= now) due += 1;
  }
  return Math.max(0, scheduledTotal - due);
}

/** The next send time after `now` among `sendTimes`, so the count can follow it. */
export function nextSendTime(sendTimes: Iterable<{ sendAt?: string }>, now = Date.now()): number | null {
  let next: number | null = null;
  for (const s of sendTimes) {
    const at = s.sendAt ? Date.parse(s.sendAt) : NaN;
    if (Number.isFinite(at) && at > now && (next === null || at < next)) next = at;
  }
  return next;
}

/**
 * The thread counts with a conversation's message count read from the
 * server, when it holds more than the list knew: the list row said 4 while
 * the open conversation showed the reply as its 5th (mail-p3, p2-1).
 * Null when nothing changes.
 */
export function raiseThreadCount(counts: Map<string, number>, key: string, count: number): Map<string, number> | null {
  if ((counts.get(key) ?? 0) >= count) return null;
  const next = new Map(counts);
  next.set(key, count);
  return next;
}
