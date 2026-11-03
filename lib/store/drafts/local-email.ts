/**
 * What a draft saved on this device looks like to everyone who reads it: the
 * Email/set create the client wrote, turned into the list properties and the
 * body a server would answer with. The composer reads it back straight after a
 * save and matches attachments by name and size.
 */

import { isLocalBlobId } from '../outbox/items';
import type { StorageAdapter } from '../storage';

export type DraftCreate = Record<string, unknown>;

interface CreatePart {
  partId?: string;
  blobId?: string;
  type?: string;
  name?: string | null;
  disposition?: string | null;
  cid?: string | null;
  subParts?: CreatePart[];
}

interface BodyPart extends CreatePart {
  size: number;
}

/** A held file's size is known. A part of a kept message's is too. Else the server knows, and the list shows nothing. */
function blobSize(db: StorageAdapter, jmap: string, blobId: string): number {
  const row = isLocalBlobId(blobId)
    ? db.get<{ size: number }>('SELECT size FROM upload WHERE local_id = ?', [blobId])
    : db.get<{ size: number }>('SELECT size FROM email_part WHERE jmap = ? AND blob_id = ? ORDER BY size DESC LIMIT 1', [jmap, blobId]);
  return Number(row?.size ?? 0);
}

function leaves(part: CreatePart): CreatePart[] {
  return part.subParts ? part.subParts.flatMap(leaves) : [part];
}

/** Every blob part a create names, wherever it put them. */
export function blobPartsOf(create: DraftCreate): CreatePart[] {
  const listed = (create.attachments ?? []) as CreatePart[];
  const tree = create.bodyStructure ? leaves(create.bodyStructure as CreatePart) : [];
  return [...listed, ...tree].filter((part) => typeof part.blobId === 'string');
}

export function heldBlobsOf(create: DraftCreate): string[] {
  return blobPartsOf(create).map((part) => part.blobId as string).filter(isLocalBlobId);
}

/** The create with the blob ids a flush got for its held files. */
export function withUploadedBlobs(create: DraftCreate, uploaded: ReadonlyMap<string, string>): DraftCreate {
  const swap = (part: CreatePart): CreatePart => ({
    ...part,
    ...(part.blobId && uploaded.has(part.blobId) ? { blobId: uploaded.get(part.blobId) } : {}),
    ...(part.subParts ? { subParts: part.subParts.map(swap) } : {}),
  });
  const out: DraftCreate = { ...create };
  if (Array.isArray(create.attachments)) out.attachments = (create.attachments as CreatePart[]).map(swap);
  if (create.bodyStructure) out.bodyStructure = swap(create.bodyStructure as CreatePart);
  return out;
}

function previewOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 256);
}

function plainFromHtml(html: string): string {
  return html.replace(/<(style|script)\b[^<]*(?:<(?!\/\1>)[^<]*)*<\/\1>/gi, ' ').replace(/<[^<>]*>/g, ' ');
}

function headersOf(create: DraftCreate): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const [key, value] of Object.entries(create)) {
    const match = /^header:([^:]+):asText$/.exec(key);
    if (match && typeof value === 'string') out.push({ name: match[1], value: ` ${value}` });
  }
  return out;
}

/**
 * The message as it's answered from the store. `id` also serves as thread id and
 * blob id: nothing else has one yet. The raw message doesn't exist until the
 * server made it, so an export finds no raw copy to read.
 */
export function localEmailFrom(db: StorageAdapter, jmap: string, id: string, create: DraftCreate, messageId: string, now: number): { list: Record<string, unknown> & { id: string }; body: Record<string, unknown> } {
  const values = (create.bodyValues ?? {}) as Record<string, { value?: string }>;
  const valueOf = (part: CreatePart) => values[part.partId ?? '']?.value ?? '';
  const asBodyPart = (part: CreatePart, type: string): BodyPart => ({ partId: part.partId, type: part.type ?? type, size: valueOf(part).length });
  const tree = create.bodyStructure ? leaves(create.bodyStructure as CreatePart) : [];
  const textParts = (tree.length ? tree.filter((part) => part.partId && part.type === 'text/plain') : (create.textBody ?? []) as CreatePart[]).map((part) => asBodyPart(part, 'text/plain'));
  const htmlParts = (tree.length ? tree.filter((part) => part.partId && part.type === 'text/html') : (create.htmlBody ?? []) as CreatePart[]).map((part) => asBodyPart(part, 'text/html'));
  const attachments: BodyPart[] = blobPartsOf(create).map((part) => ({
    partId: part.blobId,
    blobId: part.blobId,
    type: part.type ?? 'application/octet-stream',
    name: part.name ?? null,
    size: blobSize(db, jmap, part.blobId as string),
    disposition: part.disposition ?? 'attachment',
    cid: part.cid ?? null,
  }));
  const text = textParts.map(valueOf).join('\n') || plainFromHtml(htmlParts.map(valueOf).join('\n'));
  const size = [...textParts, ...htmlParts, ...attachments].reduce((sum, part) => sum + part.size, 0);
  const at = new Date(now).toISOString();
  const list = {
    id,
    threadId: id,
    blobId: id,
    mailboxIds: create.mailboxIds,
    keywords: create.keywords,
    size,
    receivedAt: at,
    sentAt: at,
    from: create.from ?? [],
    to: create.to ?? [],
    cc: create.cc ?? [],
    subject: typeof create.subject === 'string' ? create.subject : '',
    preview: previewOf(text),
    hasAttachment: attachments.some((part) => part.disposition !== 'inline'),
  } as Record<string, unknown> & { id: string };
  const body: Record<string, unknown> = {
    bcc: create.bcc ?? [],
    replyTo: create.replyTo ?? null,
    messageId: [messageId],
    inReplyTo: create.inReplyTo ?? null,
    references: create.references ?? null,
    headers: headersOf(create),
    textBody: textParts.length ? textParts : htmlParts,
    // A plain text draft lists its text part as the HTML body too, as a server does (RFC 8621 4.1.4).
    htmlBody: htmlParts.length ? htmlParts : textParts,
    attachments,
    bodyStructure: create.bodyStructure ?? { type: 'multipart/mixed', subParts: [...textParts, ...htmlParts, ...attachments] },
    bodyValues: Object.fromEntries(Object.entries(values).map(([partId, value]) => [partId, { value: value.value ?? '', isEncodingProblem: false, isTruncated: false }])),
  };
  return { list, body };
}
