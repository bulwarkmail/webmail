// Area b of the assistant's host APIs, host side (see README.md): more
// context for the assistant. The text of an attachment.

import type { InstalledPlugin, Permission } from '../../plugin-types';
import { NOT_MINE } from './not-mine';
import type { AreaHostFeaturesB, AttachmentTextView } from './b.types';
import { readNamedEmail } from '../host-api-mail';
import { readId, readInteger, readObject, sessionClient, withinRate } from '../host-api-input';
import { DEFAULT_TEXT_CHARS, MAX_TEXT_CHARS, MAX_TEXT_SOURCE_BYTES, extractText, textFormatOf } from '@/lib/attachment-text';

/** Method → permission, joined into PERM_PER_METHOD. */
export const PERMS: Readonly<Record<string, Permission | null>> = {
  'email.getAttachmentText': 'email:blob-read',
};

/** Attachment reads (text) a plugin may make per minute. */
export const MAX_ATTACHMENT_TEXT_PER_MINUTE = 30;

/**
 * The text of one attachment of one message. The blob has to be an
 * attachment of that message, as for api.email.getAttachment; the message
 * is found the way api.email.get finds it (the account the plugin names,
 * the list's row, the signed-in account).
 */
export async function doEmailGetAttachmentText(
  plugin: InstalledPlugin,
  emailIdArg: unknown,
  blobIdArg: unknown,
  optionsArg?: unknown,
): Promise<AttachmentTextView> {
  const method = 'email.getAttachmentText';
  const emailId = readId(emailIdArg, method, 'emailId');
  const blobId = readId(blobIdArg, method, 'blobId');
  const opts = readObject(optionsArg, method, 'options', ['maxChars', 'accountId'], true);
  const maxChars = opts.maxChars === undefined ? DEFAULT_TEXT_CHARS : readInteger(opts.maxChars, method, 'maxChars', 1, MAX_TEXT_CHARS);
  if (!withinRate(method, plugin.id, MAX_ATTACHMENT_TEXT_PER_MINUTE)) throw new Error(`${method}: too many reads, try again in a minute`);
  const client = sessionClient(method);
  const found = await readNamedEmail(client, emailId, method, opts.accountId);
  if (!found) throw new Error(`${method}: no message with id "${emailId}"`);
  const part = (found.email.attachments ?? []).find((a) => a.blobId === blobId);
  if (!part) throw new Error(`${method}: that blob is not an attachment of this message`);
  const name = part.name || 'attachment';
  const type = part.type || 'application/octet-stream';
  const base = { name, type, size: part.size || 0 };
  if ((part.size || 0) > MAX_TEXT_SOURCE_BYTES) {
    return { ...base, format: textFormatOf(name, type), status: 'too_big', text: '', truncated: false };
  }
  const data = await client.fetchBlobArrayBuffer(blobId, part.name || undefined, part.type || undefined, ...(found.accountId ? [found.accountId] : []));
  const result = await extractText(data, { name, type, maxChars });
  return { ...base, size: data.byteLength, ...result };
}

/** Runs a method of this area; NOT_MINE for any other. */
export async function dispatch(plugin: InstalledPlugin, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'email.getAttachmentText': return doEmailGetAttachmentText(plugin, args[0], args[1], args[2]);
    default: return NOT_MINE;
  }
}

/** This area's flags in api.host.features, right now. */
export function features(): AreaHostFeaturesB {
  return { attachmentText: true };
}
