import type { Attachment, Email, EmailAddress } from '@/lib/jmap/types';
import { getDraftComposerBody } from '@/lib/email-body-selection';
import { parseHtmlSafely, sanitizeEmailHtml } from '@/lib/email-sanitization';
import { normalizeCid } from '@/lib/attachment-visibility';
import { formatRecipient } from '@/lib/email-composer-utils';
import { stripPlainTextQuotes, stripQuotedHtml } from '@/lib/quote-collapse';
import { stripSubjectPrefixes } from '@/lib/subject-prefix';

/** What "Save as template" on a message keeps of it. */
export interface TemplateDraftFromEmail {
  subject: string;
  body: string;
  isHTML: boolean;
  /** Only for the user's own mail: who received someone else's mail says nothing about who the next one goes to. */
  to?: string[];
  cc?: string[];
  bcc?: string[];
  /** Images of the body that couldn't be loaded and were left out. */
  droppedImages: number;
}

/** An inline image part as a data: URL, or null when it can't be had or is no image. */
export type InlineImageLoader = (part: Attachment) => Promise<string | null>;

/**
 * Whether a message is the user's own: in Sent or Drafts, or from one of
 * their addresses. The folder alone misses a sent copy filed elsewhere.
 */
export function isOwnMail(
  email: Pick<Email, 'from'>,
  folderRoles: ReadonlyArray<string>,
  ownAddresses: ReadonlyArray<string>,
): boolean {
  if (folderRoles.includes('sent') || folderRoles.includes('drafts')) return true;
  const from = email.from?.[0]?.email?.toLowerCase();
  return !!from && ownAddresses.some((address) => address.toLowerCase() === from);
}

function cidOf(src: string): string {
  const raw = src.slice(4);
  try {
    return normalizeCid(decodeURIComponent(raw));
  } catch {
    return normalizeCid(raw);
  }
}

/**
 * The body's cid: images as data: URLs, as a template keeps its images
 * (embedTemplateImages turns them back into parts when the template is
 * used). A template outlives the message, so it can't point at its parts
 * the way "Edit as new" does: deleting the message would take them along.
 * An image that can't be loaded is left out rather than left broken.
 */
export async function embedCidImages(
  html: string,
  parts: ReadonlyArray<Attachment>,
  loadImage: InlineImageLoader,
): Promise<{ html: string; dropped: number }> {
  if (!/\bcid:/i.test(html)) return { html, dropped: 0 };
  const doc = parseHtmlSafely(`<body>${html}</body>`);
  const images = Array.from(doc.body.querySelectorAll('img')).filter((img) => /^\s*cid:/i.test(img.getAttribute('src') ?? ''));
  if (images.length === 0) return { html, dropped: 0 };
  const byCid = new Map<string, Attachment>();
  for (const part of parts) {
    if (part.cid && part.blobId) byCid.set(normalizeCid(part.cid), part);
  }
  // One download per part, however often the body shows it.
  const loads = new Map<string, Promise<string | null>>();
  const load = (cid: string): Promise<string | null> => {
    let pending = loads.get(cid);
    if (!pending) {
      const part = byCid.get(cid);
      pending = part ? loadImage(part).catch(() => null) : Promise.resolve(null);
      loads.set(cid, pending);
    }
    return pending;
  };
  let dropped = 0;
  await Promise.all(images.map(async (img) => {
    const dataUrl = await load(cidOf(img.getAttribute('src')!.trim()));
    if (dataUrl) {
      img.setAttribute('src', dataUrl);
    } else {
      img.remove();
      dropped += 1;
    }
  }));
  return { html: doc.body.innerHTML, dropped };
}

function addresses(list: EmailAddress[] | null | undefined): string[] | undefined {
  const out = (list ?? []).filter((a) => !!a.email).map((a) => formatRecipient(a.name, a.email));
  return out.length > 0 ? out : undefined;
}

/**
 * A template made from `email`, a message read in full (bodyValues and
 * attachments): its subject without Re:/Fwd: prefixes, its body without the quoted
 * original a reply or forward carries (no template needs it), HTML
 * sanitized as for the reader, and its recipients when it is the user's own mail.
 */
export async function templateDraftFromEmail(
  email: Email,
  options: { ownMail: boolean; loadImage: InlineImageLoader },
): Promise<TemplateDraftFromEmail> {
  const { body, plainTextMode } = getDraftComposerBody(email);
  const recipients = options.ownMail
    ? { to: addresses(email.to), cc: addresses(email.cc), bcc: addresses(email.bcc) }
    : {};
  const subject = stripSubjectPrefixes(email.subject).trim();
  if (plainTextMode !== false) {
    return { subject, body: stripPlainTextQuotes(body), isHTML: false, ...recipients, droppedImages: 0 };
  }
  // Before sanitizing: the clients' quote markers (classes, ids) are found as they wrote them.
  const embedded = await embedCidImages(sanitizeEmailHtml(stripQuotedHtml(body)), email.attachments ?? [], options.loadImage);
  return { subject, body: embedded.html, isHTML: true, ...recipients, droppedImages: embedded.dropped };
}
