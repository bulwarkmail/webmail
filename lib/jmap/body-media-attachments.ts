import { collectReferencedCids, normalizeCid } from '@/lib/attachment-visibility';
import type { Attachment, EmailBodyPart } from './types';

const INLINE_MEDIA = /^(image|audio|video)\//i;

interface EmailParts {
  textBody?: EmailBodyPart[] | null;
  htmlBody?: EmailBodyPart[] | null;
  attachments?: Attachment[] | null;
  bodyValues?: Record<string, { value?: string }> | null;
}

/**
 * Lists inline images, audio and video from the body as attachments.
 *
 * Apple Mail sends a picture as an inline part between text parts of a
 * multipart/mixed. RFC 8621 (section 4.1.4) puts such a part into textBody
 * and htmlBody and leaves it out of `attachments` when both body lists can
 * show it. Stalwart 0.16 listed it as an attachment as well; 1.0 follows the
 * RFC. The viewers render only the first text part of a body, so the picture
 * showed nowhere (#1478). Each such part is added once, after the real
 * attachments, in body order.
 *
 * Its Content-ID is kept only when the HTML body links to it: the viewers
 * hide declared inline images that have one, and an unlinked part would be
 * hidden from the one place it shows.
 *
 * Changes `email` in place and returns it.
 */
export function addBodyMediaToAttachments<T extends EmailParts>(email: T): T {
  const known = new Set<string>();
  for (const att of email.attachments ?? []) known.add(att.partId || att.blobId);
  const htmlPartId = email.htmlBody?.[0]?.partId;
  const linked = collectReferencedCids(htmlPartId ? email.bodyValues?.[htmlPartId]?.value : null);
  const added: Attachment[] = [];
  for (const part of [...(email.textBody ?? []), ...(email.htmlBody ?? [])]) {
    if (!part || !INLINE_MEDIA.test(part.type || '')) continue;
    const key = part.partId || part.blobId;
    if (!key || known.has(key)) continue;
    known.add(key);
    added.push({
      partId: part.partId,
      blobId: part.blobId,
      size: part.size,
      type: part.type,
      ...(part.name ? { name: part.name } : {}),
      ...(part.charset ? { charset: part.charset } : {}),
      ...(part.cid && linked.has(normalizeCid(part.cid)) ? { cid: part.cid } : {}),
      ...(part.disposition ? { disposition: part.disposition } : {}),
    });
  }
  if (added.length) email.attachments = [...(email.attachments ?? []), ...added];
  return email;
}
