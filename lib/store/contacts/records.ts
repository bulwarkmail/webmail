/** How a ContactCard becomes rows, and how the search index reads it. */

import type { SqlValue, StorageAdapter } from '../storage';

export const CONTACTS_CAPABILITY = 'urn:ietf:params:jmap:contacts';
export const CONTACTS_USING = ['urn:ietf:params:jmap:core', CONTACTS_CAPABILITY];

/** As the client asks for them. Without them Stalwart may leave out shareWith and myRights. */
export const ADDRESS_BOOK_PROPERTIES = ['id', 'name', 'description', 'sortOrder', 'isDefault', 'isSubscribed', 'shareWith', 'myRights'];

export type Card = Record<string, unknown> & { id: string };

function values(map: unknown): Array<Record<string, unknown>> {
  if (typeof map !== 'object' || map === null) return [];
  return Object.values(map).filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null);
}

function strings(items: unknown[]): string[] {
  return items.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/** Lower case, no accents: what both the index and the search terms go through. */
export function foldText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/[øđł]/g, (c) => ({ ø: 'o', đ: 'd', ł: 'l' })[c] as string);
}

/**
 * The text to index. A German name is indexed both ways, since people type
 * "Mueller" for "Müller" as often as "Muller".
 */
function indexText(text: string): string {
  const folded = foldText(text);
  const german = foldText(
    text.normalize('NFC').replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue'),
  );
  return german === folded ? folded : `${folded} ${german}`;
}

export function cardDisplayName(card: Record<string, unknown>): string {
  const name = card.name as { full?: unknown; components?: unknown } | undefined;
  if (typeof name?.full === 'string' && name.full) return name.full;
  const parts = Array.isArray(name?.components) ? strings((name.components as Array<{ value?: unknown }>).map((c) => c?.value)) : [];
  if (parts.length > 0) return parts.join(' ');
  return strings(values(card.emails).map((e) => e.address))[0] ?? '';
}

function cardIndex(card: Record<string, unknown>): { name: string; email: string; org: string } {
  const name = card.name as { full?: unknown; components?: unknown } | undefined;
  const components = Array.isArray(name?.components) ? (name.components as Array<{ value?: unknown }>).map((c) => c?.value) : [];
  const nicknames = values(card.nicknames).map((n) => n.name);
  const emails = values(card.emails).map((e) => e.address);
  const organizations = values(card.organizations).flatMap((o) => [
    o.name,
    ...(Array.isArray(o.units) ? (o.units as Array<{ name?: unknown }>).map((u) => u?.name) : []),
  ]);
  return {
    name: indexText(strings([name?.full, ...components, ...nicknames]).join(' ')),
    email: indexText(strings(emails).join(' ')),
    org: indexText(strings(organizations).join(' ')),
  };
}

function books(card: Record<string, unknown>): string[] {
  const ids = card.addressBookIds;
  if (typeof ids !== 'object' || ids === null) return [];
  return Object.entries(ids).filter(([, on]) => on).map(([id]) => id);
}

/** Writes one card and its index rows. Without a gen, the row keeps its own. */
export function writeCard(db: StorageAdapter, jmap: string, card: Card, gen?: number): void {
  const existing = db.get<{ rowid: number; gen: number }>('SELECT rowid, gen FROM contact_card WHERE jmap = ? AND id = ?', [jmap, card.id]);
  const row: SqlValue[] = [
    typeof card.uid === 'string' ? card.uid : null,
    foldText(cardDisplayName(card)),
    JSON.stringify(card),
    gen ?? Number(existing?.gen ?? 0),
  ];
  let rowid: number;
  if (existing) {
    rowid = Number(existing.rowid);
    db.run('UPDATE contact_card SET uid = ?, sort_key = ?, json = ?, gen = ? WHERE rowid = ?', [...row, rowid]);
    dropIndex(db, rowid);
  } else {
    rowid = db.run('INSERT INTO contact_card (uid, sort_key, json, gen, jmap, id) VALUES (?, ?, ?, ?, ?, ?)', [...row, jmap, card.id]).lastInsertRowid;
  }
  const text = cardIndex(card);
  for (const table of ['contact_fts_word', 'contact_fts_tri']) {
    db.run(`INSERT INTO ${table} (rowid, name, email, org) VALUES (?, ?, ?, ?)`, [rowid, text.name, text.email, text.org]);
  }
  for (const book of books(card)) db.run('INSERT OR IGNORE INTO contact_card_book (card_rowid, book_id) VALUES (?, ?)', [rowid, book]);
}

function dropIndex(db: StorageAdapter, rowid: number): void {
  db.run('DELETE FROM contact_fts_word WHERE rowid = ?', [rowid]);
  db.run('DELETE FROM contact_fts_tri WHERE rowid = ?', [rowid]);
  db.run('DELETE FROM contact_card_book WHERE card_rowid = ?', [rowid]);
}

export function removeCard(db: StorageAdapter, jmap: string, id: string): void {
  const existing = db.get<{ rowid: number }>('SELECT rowid FROM contact_card WHERE jmap = ? AND id = ?', [jmap, id]);
  if (!existing) return;
  dropIndex(db, Number(existing.rowid));
  db.run('DELETE FROM contact_card WHERE rowid = ?', [existing.rowid]);
}

export function readCard(db: StorageAdapter, jmap: string, id: string): Card | null {
  const row = db.get<{ json: string }>('SELECT json FROM contact_card WHERE jmap = ? AND id = ?', [jmap, id]);
  return row ? JSON.parse(row.json) as Card : null;
}
