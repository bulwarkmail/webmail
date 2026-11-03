import { htmlToPlainText } from '@/lib/html-to-text';
import { escapeHtml } from '@/lib/email-sanitization';

interface DescribedEvent {
  description?: string | null;
  descriptionContentType?: string | null;
}

/** Whether the description is HTML: other JMAP clients, and ICS files with STYLED-DESCRIPTION, can store it that way. */
export function isHtmlDescription(event: DescribedEvent): boolean {
  return /^\s*text\/html\b/i.test(event.descriptionContentType ?? '');
}

/**
 * The event's description as plain text, for showing, editing and exporting.
 * An HTML description is turned into readable text rather than rendered, so
 * its markup never shows up as source and never reaches the page as HTML.
 */
export function descriptionAsText(event: DescribedEvent): string {
  const description = event.description ?? '';
  if (!description || !isHtmlDescription(event)) return description;
  return htmlToPlainText(description, { paragraphSpacing: true });
}

/**
 * The fields that write `text` as the description of `event`. An event whose
 * description had another type (text/html) is relabelled text/plain, or other
 * clients would read the text as HTML and run its lines together. Events
 * without a type keep none: Stalwart writes a set type to ICS as
 * STYLED-DESCRIPTION, which many CalDAV clients do not read.
 */
export function plainDescriptionFields(
  event: DescribedEvent | null | undefined,
  text: string,
): { description: string; descriptionContentType?: string } {
  const type = event?.descriptionContentType?.trim();
  if (type && !/^text\/plain\b/i.test(type)) return { description: text, descriptionContentType: 'text/plain' };
  return { description: text };
}

/**
 * The description of `event` with a note added under `heading`. An HTML
 * description gets the note as an HTML paragraph, so it keeps its own
 * formatting and stays text/html.
 */
export function descriptionWithNote(
  event: DescribedEvent,
  heading: string,
  note: string,
): { description: string; descriptionContentType?: string } {
  const description = event.description ?? '';
  if (description && isHtmlDescription(event)) {
    const lines = [heading, ...note.split(/\r?\n/)].map(escapeHtml).join('<br>');
    return { description: `${description}<p>${lines}</p>` };
  }
  const text = description ? `${description}\n\n${heading}\n${note}` : `${heading}\n${note}`;
  return plainDescriptionFields(event, text);
}
