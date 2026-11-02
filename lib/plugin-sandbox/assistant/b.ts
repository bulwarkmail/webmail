// Area b of the assistant's host APIs, host side (see README.md): more
// context for the assistant. The text of an attachment, an image
// attachment shrunk to what a model needs, and a whole conversation.

import type { EmailReadView, InstalledPlugin, Permission } from '../../plugin-types';
import type { IJMAPClient } from '../../jmap/client-interface';
import type { Attachment, Email } from '../../jmap/types';
import { NOT_MINE } from './not-mine';
import type { AreaHostFeaturesB, AttachmentImageView, AttachmentTextView } from './b.types';
import { attachmentExtras, cidAltTexts } from './b.projection';
import { readNamedEmail } from '../host-api-mail';
import { readBoolean, readId, readInteger, readObject, sessionClient, withinRate } from '../host-api-input';
import { DEFAULT_TEXT_CHARS, MAX_TEXT_CHARS, MAX_TEXT_SOURCE_BYTES, extractText, textFormatOf } from '@/lib/attachment-text';
import { DEFAULT_IMAGE_SIDE, MAX_IMAGE_SIDE, MIN_IMAGE_SIDE, shrinkImage, toBase64 } from '@/lib/image-shrink';
import { readPhotoExif } from '@/lib/exif';
import { emailToReadView } from '@/lib/plugin-projection';

/** Method → permission, joined into PERM_PER_METHOD. */
export const PERMS: Readonly<Record<string, Permission | null>> = {
  'email.getAttachmentText': 'email:blob-read',
  'email.getAttachmentImage': 'email:blob-read',
  'email.getThread': 'email:read',
};

/** Attachment reads (text) a plugin may make per minute. */
export const MAX_ATTACHMENT_TEXT_PER_MINUTE = 30;
/** Attachment reads (images) a plugin may make per minute. */
export const MAX_ATTACHMENT_IMAGE_PER_MINUTE = 30;
/** Conversations a plugin may read per minute. */
export const MAX_THREADS_PER_MINUTE = 60;
/** Most messages api.email.getThread returns (the newest of a longer conversation). */
export const MAX_THREAD_MESSAGES = 50;

interface FoundAttachment {
  client: IJMAPClient;
  email: Email;
  accountId: string | undefined;
  part: Attachment;
}

/**
 * One attachment of one message. The blob has to be an attachment of that
 * message, as for api.email.getAttachment; the message is found the way
 * api.email.get finds it (the account the plugin names, the list's row,
 * the signed-in account).
 */
async function findAttachment(method: string, emailIdArg: unknown, blobIdArg: unknown, accountArg: unknown): Promise<FoundAttachment> {
  const emailId = readId(emailIdArg, method, 'emailId');
  const blobId = readId(blobIdArg, method, 'blobId');
  const client = sessionClient(method);
  const found = await readNamedEmail(client, emailId, method, accountArg);
  if (!found) throw new Error(`${method}: no message with id "${emailId}"`);
  const part = (found.email.attachments ?? []).find((a) => a.blobId === blobId);
  if (!part) throw new Error(`${method}: that blob is not an attachment of this message`);
  return { client, email: found.email, accountId: found.accountId, part };
}

function fetchPart({ client, accountId, part }: FoundAttachment): Promise<ArrayBuffer> {
  return client.fetchBlobArrayBuffer(part.blobId, part.name || undefined, part.type || undefined, ...(accountId ? [accountId] : []));
}

/** The text of one attachment of one message (see AttachmentTextView). */
export async function doEmailGetAttachmentText(
  plugin: InstalledPlugin,
  emailIdArg: unknown,
  blobIdArg: unknown,
  optionsArg?: unknown,
): Promise<AttachmentTextView> {
  const method = 'email.getAttachmentText';
  readId(emailIdArg, method, 'emailId');
  readId(blobIdArg, method, 'blobId');
  const opts = readObject(optionsArg, method, 'options', ['maxChars', 'accountId'], true);
  const maxChars = opts.maxChars === undefined ? DEFAULT_TEXT_CHARS : readInteger(opts.maxChars, method, 'maxChars', 1, MAX_TEXT_CHARS);
  if (!withinRate(method, plugin.id, MAX_ATTACHMENT_TEXT_PER_MINUTE)) throw new Error(`${method}: too many reads, try again in a minute`);
  const found = await findAttachment(method, emailIdArg, blobIdArg, opts.accountId);
  const { part } = found;
  const name = part.name || 'attachment';
  const type = part.type || 'application/octet-stream';
  const base = { name, type, size: part.size || 0 };
  if ((part.size || 0) > MAX_TEXT_SOURCE_BYTES) {
    return { ...base, format: textFormatOf(name, type), status: 'too_big', text: '', truncated: false };
  }
  const data = await fetchPart(found);
  const result = await extractText(data, { name, type, maxChars });
  return { ...base, size: data.byteLength, ...result };
}

const IMAGE_NAME = /\.(jpe?g|png|gif|webp|bmp|avif|heic|heif|tiff?)$/i;

/** Raster images by type or name. SVG is left out: it can load remote content. */
function isRasterImage(name: string, type: string): boolean {
  const mediaType = type.split(';')[0].trim().toLowerCase();
  if (mediaType === 'image/svg+xml' || /\.svgz?$/i.test(name)) return false;
  return mediaType.startsWith('image/') || IMAGE_NAME.test(name);
}

/**
 * An image attachment (or an inline image) of one message, shrunk in the
 * app to `maxSide` on its long edge and at most 1.5 MB, as base64. Only
 * the message's own parts: images the HTML loads from the web are never
 * fetched. The photo's date and place only with `exif: true`.
 */
export async function doEmailGetAttachmentImage(
  plugin: InstalledPlugin,
  emailIdArg: unknown,
  blobIdArg: unknown,
  optionsArg?: unknown,
): Promise<AttachmentImageView> {
  const method = 'email.getAttachmentImage';
  readId(emailIdArg, method, 'emailId');
  readId(blobIdArg, method, 'blobId');
  const opts = readObject(optionsArg, method, 'options', ['maxSide', 'exif', 'accountId'], true);
  const maxSide = opts.maxSide === undefined ? DEFAULT_IMAGE_SIDE : readInteger(opts.maxSide, method, 'maxSide', MIN_IMAGE_SIDE, MAX_IMAGE_SIDE);
  const wantExif = opts.exif === undefined ? false : readBoolean(opts.exif, method, 'exif');
  if (!withinRate(method, plugin.id, MAX_ATTACHMENT_IMAGE_PER_MINUTE)) throw new Error(`${method}: too many reads, try again in a minute`);
  const found = await findAttachment(method, emailIdArg, blobIdArg, opts.accountId);
  const { part, email } = found;
  const name = part.name || 'image';
  const sourceType = part.type || 'application/octet-stream';
  const { alt } = attachmentExtras(part, cidAltTexts(email));
  const answer = (status: AttachmentImageView['status'], width = 0, height = 0): AttachmentImageView => ({
    name, type: sourceType, width, height, data: '', status, ...(alt ? { alt } : {}),
  });
  if (!isRasterImage(name, sourceType)) return answer('unsupported');
  if ((part.size || 0) > MAX_TEXT_SOURCE_BYTES) return answer('too_big');
  const data = await fetchPart(found);
  const shrunk = await shrinkImage(new Blob([data], { type: sourceType }), { maxSide });
  if (shrunk.status !== 'ok' || !shrunk.bytes || !shrunk.type) return answer(shrunk.status === 'ok' ? 'failed' : shrunk.status, shrunk.width, shrunk.height);
  const exif = wantExif ? readPhotoExif(data) : null;
  return {
    name,
    type: shrunk.type,
    width: shrunk.width ?? 0,
    height: shrunk.height ?? 0,
    data: toBase64(shrunk.bytes),
    status: 'ok',
    ...(alt ? { alt } : {}),
    ...(exif && Object.keys(exif).length ? { exif } : {}),
  };
}

/**
 * Every message of the conversation `emailId` belongs to, oldest first, as
 * read views (at most the newest MAX_THREAD_MESSAGES). The message is found
 * the way api.email.get finds it, and the conversation is read from the
 * same account.
 */
export async function doEmailGetThread(plugin: InstalledPlugin, emailIdArg: unknown, optionsArg?: unknown): Promise<EmailReadView[]> {
  const method = 'email.getThread';
  const emailId = readId(emailIdArg, method, 'emailId');
  const opts = readObject(optionsArg, method, 'options', ['accountId'], true);
  if (!withinRate(method, plugin.id, MAX_THREADS_PER_MINUTE)) throw new Error(`${method}: too many reads, try again in a minute`);
  const client = sessionClient(method);
  const found = await readNamedEmail(client, emailId, method, opts.accountId);
  if (!found) throw new Error(`${method}: no message with id "${emailId}"`);
  const accountId = found.accountId ?? client.getAccountId();
  const emails = found.email.threadId ? await client.getThreadEmails(found.email.threadId, found.accountId) : [];
  // A server that knows no thread for it: the message on its own.
  const list = emails.length ? emails : [found.email];
  return list
    .slice()
    .sort((a, b) => String(a.receivedAt ?? '').localeCompare(String(b.receivedAt ?? '')))
    .slice(-MAX_THREAD_MESSAGES)
    .map((email) => emailToReadView(email, accountId));
}

/** Runs a method of this area; NOT_MINE for any other. */
export async function dispatch(plugin: InstalledPlugin, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'email.getAttachmentText': return doEmailGetAttachmentText(plugin, args[0], args[1], args[2]);
    case 'email.getAttachmentImage': return doEmailGetAttachmentImage(plugin, args[0], args[1], args[2]);
    case 'email.getThread': return doEmailGetThread(plugin, args[0], args[1]);
    default: return NOT_MINE;
  }
}

/** This area's flags in api.host.features, right now. */
export function features(): AreaHostFeaturesB {
  return { attachmentText: true, attachmentImages: true, threads: true, listSelection: true };
}
