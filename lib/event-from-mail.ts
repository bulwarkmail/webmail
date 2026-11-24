// Create an event from a message (#1579): the calendar's editor opens on a
// new event filled in from the message, and nothing is saved until the
// user saves it. The mail page parks the draft here and goes to the
// calendar, which opens it once it is there.

import type { CalendarEvent, CalendarParticipant, Email } from '@/lib/jmap/types';
import { stripSubjectPrefixes } from '@/lib/subject-prefix';
import { htmlToPlainText } from '@/lib/html-to-text';

const DRAFT_KEY = 'bulwark:pending-event-draft';
const DRAFT_TTL_MS = 5 * 60 * 1000;
/** The message's text in the description is cut here. */
export const MAX_DESCRIPTION_CHARS = 4000;
/** Most people the event starts with. */
export const MAX_PARTICIPANTS = 50;

/** The message's text: its plain-text body, else its HTML as text, else the preview. */
export function mailText(email: Pick<Email, 'textBody' | 'htmlBody' | 'bodyValues' | 'preview'>): string {
  const values = email.bodyValues ?? {};
  const text = (email.textBody ?? [])
    .filter((part) => part.type === 'text/plain')
    .map((part) => (part.partId ? values[part.partId]?.value ?? '' : ''))
    .join('\n')
    .trim();
  if (text) return text;
  const html = (email.htmlBody ?? [])
    .map((part) => (part.partId ? values[part.partId]?.value ?? '' : ''))
    .join('\n');
  const fromHtml = html ? htmlToPlainText(html).trim() : '';
  return fromHtml || (email.preview ?? '').trim();
}

export interface EventDraftOptions {
  /** The user's own addresses: they organise the event, so they aren't among its guests. */
  ownEmails: readonly string[];
  /** The message's address in the app, written under its text. */
  link: string;
  /** What goes before the link ("Email: <link>"). */
  linkLine: (link: string) => string;
}

/**
 * The new event: the subject (without Re:, Fwd: and the like) as its title,
 * the message's text and a link back to it as its description, and the
 * sender and the other recipients as guests. The editor picks the date
 * (the next full hour) and the calendar.
 */
export function eventDraftFromEmail(
  email: Pick<Email, 'subject' | 'from' | 'to' | 'cc' | 'textBody' | 'htmlBody' | 'bodyValues' | 'preview'>,
  options: EventDraftOptions,
): Partial<CalendarEvent> {
  const own = new Set(options.ownEmails.map((address) => address.toLowerCase()));
  const seen = new Set<string>();
  const participants: Record<string, CalendarParticipant> = {};
  for (const person of [...(email.from ?? []), ...(email.to ?? []), ...(email.cc ?? [])]) {
    const address = person.email?.trim();
    const key = address?.toLowerCase();
    if (!address || !key || own.has(key) || seen.has(key)) continue;
    if (seen.size >= MAX_PARTICIPANTS) break;
    seen.add(key);
    participants[`p${seen.size}`] = {
      '@type': 'Participant',
      ...(person.name && person.name !== address ? { name: person.name } : {}),
      email: address,
      calendarAddress: `mailto:${address}`,
      roles: { attendee: true },
      participationStatus: 'needs-action',
      expectReply: true,
    } as unknown as CalendarParticipant;
  }

  const text = mailText(email);
  const excerpt = text.length > MAX_DESCRIPTION_CHARS ? `${text.slice(0, MAX_DESCRIPTION_CHARS).trimEnd()}…` : text;
  const description = [excerpt, options.linkLine(options.link)].filter(Boolean).join('\n\n');

  return {
    title: stripSubjectPrefixes(email.subject).trim(),
    description,
    descriptionContentType: 'text/plain',
    ...(seen.size > 0 ? { participants } : {}),
    useDefaultAlerts: true,
  };
}

/** Park the draft for the calendar page. */
export function savePendingEventDraft(draft: Partial<CalendarEvent>): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ draft, createdAt: Date.now() }));
  } catch {
    // Storage can be unavailable in hardened or private browser modes.
  }
}

/** The parked draft, once: null when there is none or it is old. */
export function consumePendingEventDraft(): Partial<CalendarEvent> | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    sessionStorage.removeItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { draft?: unknown; createdAt?: unknown };
    if (typeof parsed.createdAt !== 'number' || Date.now() - parsed.createdAt > DRAFT_TTL_MS) return null;
    const draft = parsed.draft;
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return null;
    return draft as Partial<CalendarEvent>;
  } catch {
    return null;
  }
}
