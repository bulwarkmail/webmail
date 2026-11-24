import type { CalendarEvent, CalendarLink } from '@/lib/jmap/types';
import { generateUUID } from '@/lib/utils';

/**
 * A file attached to a calendar event: a JSCalendar link the server stores
 * as a blob (Stalwart 1.0, from ATTACH;VALUE=BINARY or an upload) or one
 * that points to a URL (ATTACH;VALUE=URI).
 */
export interface EventAttachment {
  /** The key of the link in the event's links. */
  key: string;
  /** The link's title, else the last part of its URL; null when neither gives a name. */
  name: string | null;
  contentType: string | null;
  size: number | null;
  blobId: string | null;
  /** The link's URL when it is http or https, the only ones opened from the app. */
  url: string | null;
}

// The last part of a path with an extension: /files/plan.pdf, /a/b/notes.txt.
const FILE_NAME = /\/([^/]+\.[a-z0-9]{1,8})$/i;

function httpUrl(href: string | undefined): URL | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function fileNameOf(url: URL | null): string | null {
  const match = url?.pathname.match(FILE_NAME);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * Whether a link is a file attached to the event. A link with rel
 * "enclosure" is (RFC 8984 §1.4.11), and so is one without a rel that
 * carries a blob or points to a file. Other rels (an icon, a describedby
 * page) are links for other things.
 */
export function isAttachmentLink(link: CalendarLink | null | undefined): boolean {
  if (!link || typeof link !== 'object') return false;
  if (link.rel === 'enclosure') return !!(link.blobId || link.href);
  if (link.rel) return false;
  if (link.blobId) return true;
  return !!fileNameOf(httpUrl(link.href));
}

/** The files attached to an event, in the order of its links. */
export function eventAttachments(event: Pick<CalendarEvent, 'links'> | null | undefined): EventAttachment[] {
  const links = event?.links;
  if (!links || typeof links !== 'object') return [];
  return Object.entries(links)
    .filter(([, link]) => isAttachmentLink(link))
    .map(([key, link]) => {
      const url = httpUrl(link.href);
      return {
        key,
        name: link.title?.trim() || fileNameOf(url),
        contentType: link.contentType ?? null,
        size: typeof link.size === 'number' && link.size >= 0 ? link.size : null,
        blobId: link.blobId || null,
        url: url ? url.href : null,
      };
    });
}

/**
 * The link for a file uploaded to the event's account. Only members with a
 * value: Stalwart writes null members out as empty iCalendar parameters.
 */
export function attachmentLink(upload: { blobId: string; size: number; type: string }, name: string): CalendarLink {
  return {
    '@type': 'Link',
    blobId: upload.blobId,
    rel: 'enclosure',
    contentType: upload.type || 'application/octet-stream',
    size: upload.size,
    title: name,
  } as CalendarLink;
}

/**
 * The event's links once the user removed some attachments and added
 * others, or undefined when nothing changed, so the save leaves the links
 * out. Every other link, from this app or another client, goes back as the
 * server sent it.
 */
export function linksWithAttachmentChanges(
  links: CalendarEvent['links'] | undefined,
  removed: readonly string[],
  added: readonly CalendarLink[],
): CalendarEvent['links'] | undefined {
  const before = links ?? {};
  const removing = removed.filter((key) => key in before);
  if (removing.length === 0 && added.length === 0) return undefined;
  const next: Record<string, CalendarLink> = {};
  for (const [key, link] of Object.entries(before)) {
    if (!removing.includes(key)) next[key] = link;
  }
  for (const link of added) {
    let key = generateUUID();
    while (key in next) key = generateUUID();
    next[key] = link;
  }
  return Object.keys(next).length > 0 ? next : null;
}
