/** How an Email object becomes rows, and back. */

import type { StorageAdapter } from '../storage';

/**
 * How keywords compare, measured on both Stalwart versions: the IMAP system
 * flags fold to lower case, every other keyword is case-sensitive, so `Tag` and
 * `tag` are two keywords and one message can carry both.
 */
const SYSTEM_KEYWORDS = new Set(['$seen', '$flagged', '$answered', '$draft', '$forwarded', '$mdnsent', '$junk', '$notjunk', '$phishing', '$recent', '$deleted']);

export function keywordKey(keyword: string): string {
  const lower = keyword.toLowerCase();
  return SYSTEM_KEYWORDS.has(lower) ? lower : keyword;
}

export const MAIL_USING = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'];

export const EMAIL_LIST_PROPERTIES = [
  'id', 'threadId', 'mailboxIds', 'keywords', 'size', 'receivedAt', 'sentAt', 'from', 'to', 'cc',
  'subject', 'preview', 'hasAttachment', 'blobId', 'header:Authentication-Results:all',
];

/** What opening a message asks for, past the list properties. */
export const EMAIL_BODY_PROPERTIES = [
  'bcc', 'replyTo', 'textBody', 'htmlBody', 'bodyValues', 'attachments', 'messageId', 'inReplyTo',
  'references', 'headers', 'bodyStructure',
];

export type EmailObject = Record<string, unknown> & { id: string };

interface Address { name?: string | null; email?: string | null }

function firstAddress(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] as Address | undefined : undefined;
  const text = first?.name || first?.email;
  return text ? text.toLowerCase() : null;
}

function addressText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return (value as Address[]).map((a) => [a.name, a.email].filter(Boolean).join(' ')).join(' ');
}

function time(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** The subject without Re:, Fwd: and the like, as the client sorts it. */
export function baseSubject(subject: string): string {
  return subject.replace(/^(\s*(re|aw|fw|fwd|wg)\s*(\[\d+\])?\s*:\s*)+/i, '').trim().toLowerCase();
}

/** Inserts or updates one message from its list properties. Keeps a body already stored. */
export function upsertEmail(db: StorageAdapter, jmap: string, email: EmailObject, gen: number): number {
  const receivedAt = time(email.receivedAt) ?? 0;
  const subject = typeof email.subject === 'string' ? email.subject : '';
  const existing = db.get<{ rowid: number }>('SELECT rowid FROM email WHERE jmap = ? AND id = ?', [jmap, email.id]);
  const values = [
    typeof email.threadId === 'string' ? email.threadId : null,
    receivedAt,
    time(email.sentAt),
    typeof email.size === 'number' ? email.size : 0,
    email.hasAttachment ? 1 : 0,
    baseSubject(subject),
    firstAddress(email.from),
    firstAddress(email.to),
    JSON.stringify(email),
    gen,
  ];
  let rowid: number;
  if (existing) {
    rowid = Number(existing.rowid);
    db.run(
      `UPDATE email SET thread_id = ?, received_at = ?, sent_at = ?, size = ?, has_attachment = ?, subject_sort = ?,
         from_sort = ?, to_sort = ?, json = ?, gen = ? WHERE rowid = ?`,
      [...values, rowid],
    );
    db.run('DELETE FROM email_mailbox WHERE email_rowid = ?', [rowid]);
    db.run('DELETE FROM email_keyword WHERE email_rowid = ?', [rowid]);
  } else {
    rowid = db.run(
      `INSERT INTO email (thread_id, received_at, sent_at, size, has_attachment, subject_sort, from_sort, to_sort, json, gen, jmap, id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...values, jmap, email.id],
    ).lastInsertRowid;
    indexEmail(db, rowid, email, '');
  }
  for (const [box, on] of Object.entries((email.mailboxIds ?? {}) as Record<string, boolean>)) {
    if (on) db.run('INSERT INTO email_mailbox (email_rowid, jmap, mailbox_id, received_at) VALUES (?, ?, ?, ?)', [rowid, jmap, box, receivedAt]);
  }
  for (const [keyword, on] of Object.entries((email.keywords ?? {}) as Record<string, boolean>)) {
    if (on) db.run('INSERT OR IGNORE INTO email_keyword (email_rowid, keyword) VALUES (?, ?)', [rowid, keywordKey(keyword)]);
  }
  return rowid;
}

/** Kept files are stored in pieces of this size. */
export const BLOB_CHUNK_BYTES = 1024 * 1024;

export function dropBlob(db: StorageAdapter, jmap: string, blobId: string): void {
  db.run('DELETE FROM blob_chunk WHERE jmap = ? AND blob_id = ?', [jmap, blobId]);
  db.run('DELETE FROM blob WHERE jmap = ? AND blob_id = ?', [jmap, blobId]);
}

/** A file that's here as a whole already. */
export function putBlob(db: StorageAdapter, jmap: string, blobId: string, type: string | null, data: Uint8Array, at: number): void {
  dropBlob(db, jmap, blobId);
  for (let from = 0, seq = 0; from < data.byteLength; from += BLOB_CHUNK_BYTES, seq += 1) {
    db.run('INSERT INTO blob_chunk (jmap, blob_id, seq, data) VALUES (?, ?, ?, ?)', [jmap, blobId, seq, data.subarray(from, from + BLOB_CHUNK_BYTES)]);
  }
  db.run("INSERT INTO blob (jmap, blob_id, type, size, at, data) VALUES (?, ?, ?, ?, ?, x'')", [jmap, blobId, type, data.byteLength, at]);
}

export function deleteEmail(db: StorageAdapter, jmap: string, id: string): void {
  const row = db.get<{ rowid: number }>('SELECT rowid FROM email WHERE jmap = ? AND id = ?', [jmap, id]);
  if (!row) return;
  deleteEmailRow(db, Number(row.rowid));
}

export function deleteEmailRow(db: StorageAdapter, rowid: number): void {
  deleteHeadIndex(db, rowid);
  deleteBodyIndex(db, rowid);
  forgetParts(db, rowid);
  // Explicit rather than ON DELETE CASCADE: foreign keys stay off for bulk speed.
  db.run('DELETE FROM email_mailbox WHERE email_rowid = ?', [rowid]);
  db.run('DELETE FROM email_keyword WHERE email_rowid = ?', [rowid]);
  db.run('DELETE FROM email_body WHERE email_rowid = ?', [rowid]);
  db.run('DELETE FROM email WHERE rowid = ?', [rowid]);
}

/** German HTML mail often writes its umlauts as entities: unread, "M&uuml;ller" would never be found. */
const NAMED_ENTITIES = new Map(Object.entries({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ndash: '-', mdash: '-', hellip: '...', euro: '€',
  bdquo: '"', ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'",
}));

function decodeEntity(whole: string, name: string): string {
  if (name[0] !== '#') return NAMED_ENTITIES.get(name) ?? whole;
  const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
}

/** More than a server sends for one part. Everything below is only linear up to a point of patience. */
const RAW_BODY_CHARS = 1_000_000;

/**
 * Takes out comments and style, script and head blocks. A single scan: each
 * search for a closer starts past the last one, and a kind of block with no
 * closer left isn't looked for again, so hostile HTML that only ever opens them
 * can't make this quadratic. An unclosed block stays as text.
 */
function stripBlocks(html: string): string {
  const opener = /<!--|<(style|script|head)\b/gi;
  const unclosed = new Set<string>();
  const kept: string[] = [];
  let at = 0;
  for (let match = opener.exec(html); match; match = opener.exec(html)) {
    const name = match[1]?.toLowerCase() ?? '!--';
    if (unclosed.has(name)) continue;
    let end: number;
    if (name === '!--') {
      const closer = html.indexOf('-->', opener.lastIndex);
      end = closer < 0 ? -1 : closer + '-->'.length;
    } else {
      const closer = new RegExp(`</${name}>`, 'gi');
      closer.lastIndex = opener.lastIndex;
      end = closer.exec(html) ? closer.lastIndex : -1;
    }
    if (end < 0) {
      unclosed.add(name);
      continue;
    }
    kept.push(html.slice(at, match.index));
    at = end;
    opener.lastIndex = end;
  }
  kept.push(html.slice(at));
  return kept.join(' ');
}

/** Plain text of a message for the search index: the text part, or the HTML part without its tags. */
export function bodyText(email: Record<string, unknown>): string {
  const values = (email.bodyValues ?? {}) as Record<string, { value?: string }>;
  const parts = (key: string) => ((email[key] ?? []) as Array<{ partId?: string; type?: string }>);
  const text = parts('textBody')
    .filter((part) => part.type !== 'text/html')
    .map((part) => values[part.partId ?? '']?.value ?? '')
    .join('\n')
    .slice(0, RAW_BODY_CHARS);
  if (text.trim()) return text;
  const html = parts('htmlBody')
    .map((part) => values[part.partId ?? '']?.value ?? '')
    .join('\n')
    .slice(0, RAW_BODY_CHARS);
  return stripBlocks(html)
    .replace(/<[^<>]*>/g, ' ')
    .replace(/&(#\d{1,7}|#x[\da-f]{1,6}|[a-z]{1,31}\d{0,2});/gi, decodeEntity)
    .replace(/\s+/g, ' ');
}

/** A long message past this is rare and only bloats the index. */
export const INDEX_BODY_CHARS = 200_000;
/**
 * Trigrams cost several times what words do, and a term deep in a long mail is
 * rarely part of a compound someone remembers. Past this, a mail is found by its
 * whole words and word starts only.
 */
export const TRIGRAM_BODY_CHARS = 32 * 1024;

function deleteHeadIndex(db: StorageAdapter, rowid: number): void {
  db.run('DELETE FROM email_fts_word WHERE rowid = ?', [rowid]);
  db.run('DELETE FROM email_fts_tri WHERE rowid = ?', [rowid]);
}

function deleteBodyIndex(db: StorageAdapter, rowid: number): void {
  db.run('DELETE FROM email_fts_body_word WHERE rowid = ?', [rowid]);
  db.run('DELETE FROM email_fts_body_tri WHERE rowid = ?', [rowid]);
}

function indexHead(db: StorageAdapter, rowid: number, email: Record<string, unknown>): void {
  const subject = typeof email.subject === 'string' ? email.subject : '';
  const values = [rowid, subject, addressText(email.from), addressText(email.to), addressText(email.cc), addressText(email.bcc)];
  for (const table of ['email_fts_word', 'email_fts_tri']) {
    db.run(`INSERT INTO ${table} (rowid, subject, from_addr, to_addr, cc_addr, bcc_addr) VALUES (?, ?, ?, ?, ?, ?)`, values);
  }
}

function indexBody(db: StorageAdapter, rowid: number, body: string): void {
  if (!body) return;
  db.run('INSERT INTO email_fts_body_word (rowid, body) VALUES (?, ?)', [rowid, body.slice(0, INDEX_BODY_CHARS)]);
  db.run('INSERT INTO email_fts_body_tri (rowid, body) VALUES (?, ?)', [rowid, body.slice(0, TRIGRAM_BODY_CHARS)]);
}

export function indexEmail(db: StorageAdapter, rowid: number, email: Record<string, unknown>, body: string): void {
  indexHead(db, rowid, email);
  indexBody(db, rowid, body);
}

/** A message's files go with it, unless another kept message has the same one. */
function forgetParts(db: StorageAdapter, rowid: number): void {
  const parts = db.all<{ jmap: string; blob_id: string }>('SELECT jmap, blob_id FROM email_part WHERE email_rowid = ?', [rowid]);
  db.run('DELETE FROM email_part WHERE email_rowid = ?', [rowid]);
  for (const part of parts) {
    if (db.get('SELECT 1 AS x FROM email_part WHERE jmap = ? AND blob_id = ?', [part.jmap, part.blob_id])) continue;
    dropBlob(db, part.jmap, part.blob_id);
  }
}

interface MimePart {
  blobId?: unknown;
  size?: unknown;
  type?: unknown;
  name?: unknown;
  disposition?: unknown;
  subParts?: MimePart[];
}

function leafParts(part: MimePart): MimePart[] {
  return part.subParts ? part.subParts.flatMap(leafParts) : [part];
}

/**
 * The parts a message needs as files: its attachments, and whatever else the
 * body shows. Stalwart 1.0 doesn't list inline images under `attachments`, so
 * those come from the body lists and the MIME tree. Text parts are in bodyValues.
 */
function fileParts(body: Record<string, unknown>): MimePart[] {
  const listed = (key: string) => (Array.isArray(body[key]) ? body[key] as MimePart[] : []);
  const shown = [...listed('textBody'), ...listed('htmlBody'), ...(body.bodyStructure ? leafParts(body.bodyStructure as MimePart) : [])]
    .filter((part) => !(typeof part.type === 'string' && part.type.startsWith('text/')) || part.disposition === 'attachment');
  return [...listed('attachments'), ...shown];
}

function rememberParts(db: StorageAdapter, rowid: number, row: { jmap: string; received_at: number }, list: Record<string, unknown>, body: Record<string, unknown>): void {
  const remember = (blobId: string, size: unknown, type: unknown, name: unknown, raw: number) => db.run(
    `INSERT INTO email_part (jmap, blob_id, email_rowid, received_at, size, type, name, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (jmap, blob_id, email_rowid) DO NOTHING`,
    [row.jmap, blobId, rowid, row.received_at, typeof size === 'number' ? size : 0, typeof type === 'string' ? type : null, typeof name === 'string' ? name : null, raw],
  );
  for (const part of fileParts(body)) {
    if (typeof part.blobId === 'string') remember(part.blobId, part.size, part.type, part.name, 0);
  }
  if (typeof list.blobId === 'string') remember(list.blobId, list.size, 'message/rfc822', 'message.eml', 1);
}

/** False when the message is gone, for instance deleted while its body was on the way. */
export function storeBody(db: StorageAdapter, rowid: number, listJson: string, full: Record<string, unknown>): boolean {
  const row = db.get<{ jmap: string; received_at: number; body_state: number }>('SELECT jmap, received_at, body_state FROM email WHERE rowid = ?', [rowid]);
  if (!row) return false;
  const list = JSON.parse(listJson) as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(full)) if (!(key in list)) body[key] = value;
  const hadBody = Number(row.body_state) === 1;
  rememberParts(db, rowid, row, list, body);
  db.run('INSERT INTO email_body (email_rowid, json) VALUES (?, ?) ON CONFLICT (email_rowid) DO UPDATE SET json = excluded.json', [rowid, JSON.stringify(body)]);
  db.run('UPDATE email SET body_state = 1 WHERE rowid = ?', [rowid]);
  // A first body is one insert. Only a body stored again has an old row to replace.
  if (hadBody) deleteBodyIndex(db, rowid);
  indexBody(db, rowid, bodyText(full));
  // Bcc isn't a list property, so a message that has one gets its head row again.
  if (addressText(full.bcc)) {
    deleteHeadIndex(db, rowid);
    indexHead(db, rowid, { ...list, ...body });
  }
  return true;
}
