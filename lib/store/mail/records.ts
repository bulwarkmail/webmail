/** How an Email object becomes rows, and back. */

import type { StorageAdapter } from '../storage';

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
    if (on) db.run('INSERT INTO email_keyword (email_rowid, keyword) VALUES (?, ?)', [rowid, keyword.toLowerCase()]);
  }
  return rowid;
}

export function deleteEmail(db: StorageAdapter, jmap: string, id: string): void {
  const row = db.get<{ rowid: number }>('SELECT rowid FROM email WHERE jmap = ? AND id = ?', [jmap, id]);
  if (!row) return;
  deleteEmailRow(db, Number(row.rowid));
}

export function deleteEmailRow(db: StorageAdapter, rowid: number): void {
  deleteHeadIndex(db, rowid);
  deleteBodyIndex(db, rowid);
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

export function storeBody(db: StorageAdapter, rowid: number, listJson: string, full: Record<string, unknown>): void {
  const list = JSON.parse(listJson) as Record<string, unknown>;
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(full)) if (!(key in list)) body[key] = value;
  const hadBody = Number(db.get<{ body_state: number }>('SELECT body_state FROM email WHERE rowid = ?', [rowid])?.body_state) === 1;
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
}
