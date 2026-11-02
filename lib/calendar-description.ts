import { htmlToPlainText } from '@/lib/html-to-text';

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
