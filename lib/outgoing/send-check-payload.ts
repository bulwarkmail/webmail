/**
 * What plugins' send checks (onBeforeEmailSend) get beyond the message
 * itself, so a rule such as "warn about an IBAN, only when the mail leaves
 * the organisation" works without exposing the policy:
 *
 * - `externalRecipients`: the recipients outside the organisation of the
 *   account the mail goes out from (its identity domains plus the admin's
 *   organisation domains), filled whether or not the admin's recipient
 *   warning is on;
 * - per attachment the blobId, whether it is inline, the type its first
 *   bytes say (sniffedType) and, for text files, the first megabyte as text
 *   (textExcerpt; only plugins with `email:blob-read` see it, see
 *   lib/plugin-sandbox/hook-payload.ts).
 *
 * Attachments are read only while a plugin listens, and a file that can't
 * be read is passed on without the two fields.
 */

import type { OutgoingAttachment } from '@/lib/plugin-types';
import { addressDomain, addressKey, contextInternalDomains, externalMailContextFor, externalRecipients } from '@/lib/external-mail';
import { debug } from '@/lib/debug';
import { isTextAttachment, sniffType, SNIFF_BYTES } from './attachment-sniff';
import type { OutgoingContext } from './send-pipeline';

/** Most of a text attachment a plugin gets as text. */
export const TEXT_EXCERPT_BYTES = 1024 * 1024;

/** The recipients outside the sending account's organisation, as bare lowercase addresses. */
export async function externalRecipientsFor(context: OutgoingContext): Promise<string[]> {
  const account = await externalMailContextFor(context.sender?.accountId);
  const internal = contextInternalDomains(account);
  // As the recipient warning: the identity's own domain is internal, a From
  // typed over it in the composer is not.
  const identityEmail = context.sender?.email ?? (context.surface === 'composer' ? undefined : context.fromEmail);
  const identityDomain = addressDomain(identityEmail);
  if (identityDomain && !internal.includes(identityDomain)) internal.push(identityDomain);
  return externalRecipients(context, internal).map((r) => addressKey(r.address));
}

export interface SendCheckAttachmentSource {
  name: string;
  type: string;
  size: number;
  blobId?: string;
  inline?: boolean;
  /** The bytes, when the browser still has them (a file the user picked). */
  file?: Blob;
  /** Reads up to `bytes` bytes of the blob from the server otherwise. */
  load?: (bytes: number) => Promise<ArrayBuffer>;
}

/** The first `bytes` bytes, or null when they couldn't be read (or there is nothing to read them from). */
async function headOf(source: SendCheckAttachmentSource, bytes: number): Promise<Uint8Array | null> {
  try {
    if (source.file) return new Uint8Array(await source.file.slice(0, bytes).arrayBuffer());
    if (source.load) return new Uint8Array((await source.load(bytes)).slice(0, bytes));
  } catch (error) {
    debug.warn('email', `Could not read ${source.name} for the send checks:`, error);
  }
  return null;
}

function decodeExcerpt(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes).replace(/\uFFFD+$/, '');
}

/** The attachment list for onBeforeEmailSend, with sniffedType and text excerpts. */
export async function inspectAttachments(sources: readonly SendCheckAttachmentSource[]): Promise<OutgoingAttachment[]> {
  const out: OutgoingAttachment[] = [];
  // One at a time: a send rarely has many, and downloads share the
  // server's request slots with everything else.
  for (const source of sources) {
    const entry: OutgoingAttachment = {
      name: source.name,
      type: source.type || 'application/octet-stream',
      size: source.size,
      ...(source.blobId ? { blobId: source.blobId } : {}),
      ...(source.inline ? { inline: true } : {}),
    };
    const text = !source.inline && isTextAttachment(source.name, source.type);
    const head = await headOf(source, text ? TEXT_EXCERPT_BYTES : SNIFF_BYTES);
    if (head) {
      const sniffed = sniffType(head);
      if (sniffed) entry.sniffedType = sniffed;
      // A "text" file whose bytes say it is a program is not read as text.
      if (text && (!sniffed || sniffed.startsWith('text/'))) entry.textExcerpt = decodeExcerpt(head);
    } else {
      // Said out loud, so a check doesn't take it for a clean file.
      entry.unreadable = true;
    }
    out.push(entry);
  }
  return out;
}

/** sniffedType of a file about to be attached (onBeforeAttachmentUpload), or unreadable. */
export async function sniffFile(file: Blob): Promise<{ sniffedType?: string; unreadable?: true }> {
  try {
    const sniffedType = sniffType(new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer()));
    return sniffedType ? { sniffedType } : {};
  } catch {
    return { unreadable: true };
  }
}
