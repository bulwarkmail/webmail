/**
 * Full-text matching and SearchSnippet/get over the two FTS indexes.
 *
 * What a search value means here (the shapes buildJMAPFilter sends):
 * - `rechnung`: a word of three or more characters is found anywhere, also
 *   inside a longer word, through the trigram index ("Rechnung" in
 *   "Zahlungserinnerungsrechnung").
 * - `zu`: one or two characters can't use trigrams, so only the whole word
 *   matches, through the word index. "zu" doesn't find "zum".
 * - `rech*`: the start of a word, through the word index. It needs two
 *   characters: `a*` is the word "a", since reading every word that starts
 *   with one letter is the most expensive thing FTS5 can be asked.
 * - `"annual report"`: these exact words in this order, through the word index.
 * - Several words have to all match, each in any field `text` covers. That's a
 *   little wider than Stalwart, which wants them in one field.
 * - Case and diacritics don't count: Müller and muller find each other.
 *
 * Input never reaches FTS5 as syntax: every term goes in as a quoted string, so
 * `"`, `*`, `-`, `:` and parentheses are text. A term without a letter or digit
 * has nothing to search for and is left out; a value left with no terms matches
 * nothing, because leaving it out would widen the search to every message.
 *
 * Limits: MAX_TERMS per value, MAX_TERM_CHARS per term, MAX_TEXT_CONDITIONS per
 * filter. Past them the extra terms are ignored, which only widens the result,
 * so a pasted page of text still gets an answer and can't keep the worker busy.
 * A very common word costs one read of its list in each index, at most the size
 * of the account. Body text past 32 KB has no trigrams (see records.ts), so deep
 * in a long mail only whole words and word starts are found.
 */

import { MethodError, type MethodHandler } from '../area';
import type { SqlValue, StorageAdapter } from '../storage';
import { bodyText, INDEX_BODY_CHARS } from './records';

export const TEXT_FIELDS = ['text', 'subject', 'from', 'to', 'cc', 'bcc', 'body'] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

const HEAD_COLUMNS: Partial<Record<TextField, string>> = {
  subject: 'subject',
  from: 'from_addr',
  to: 'to_addr',
  cc: 'cc_addr',
  bcc: 'bcc_addr',
};

const HEAD_TABLES = { word: 'email_fts_word', tri: 'email_fts_tri' };
const BODY_TABLES = { word: 'email_fts_body_word', tri: 'email_fts_body_tri' };

const MAX_INPUT_CHARS = 8192;
const MAX_TERMS = 16;
const MAX_TERM_CHARS = 200;
const MAX_TEXT_CONDITIONS = 32;
const MIN_TRIGRAM_CHARS = 3;
const MIN_PREFIX_CHARS = 2;
const MIN_PLAIN_SPELLING_CHARS = 5;
const MAX_SNIPPET_IDS = 500;
const MAX_HIGHLIGHT_PATTERNS = 64;
const MAX_SNIPPET_SUBJECT_CHARS = 1024;
/** RFC 8621 §5: a preview is at most 255 octets. */
const PREVIEW_BYTES = 255;
const PREVIEW_CONTEXT_CHARS = 40;

const WORD_CHAR = '[\\p{L}\\p{N}\\p{M}]';
const NOT_WORD_CHAR = '[^\\p{L}\\p{N}\\p{M}]';
const EDGE_PUNCTUATION = new RegExp(`^${NOT_WORD_CHAR}+|${NOT_WORD_CHAR}+$`, 'gu');

interface Term {
  needle: string;
  kind: 'word' | 'prefix' | 'phrase';
}

/** One lookup in one index. A term matches when any of its lookups does. */
interface Probe {
  index: 'word' | 'tri';
  text: string;
  prefix: boolean;
}

function chars(text: string): number {
  return [...text].length;
}

function parseTerms(input: string): Term[] {
  const clean = input.slice(0, MAX_INPUT_CHARS).normalize('NFC').replace(/\p{Cc}/gu, ' ');
  const terms: Term[] = [];
  for (const match of clean.matchAll(/"([^"]*)"|(\S+)/g)) {
    const quoted = match[1] !== undefined;
    const raw = match[1] ?? match[2];
    const needle = [...raw.replace(EDGE_PUNCTUATION, '')].slice(0, MAX_TERM_CHARS).join('');
    if (!needle) continue;
    terms.push({ needle, kind: quoted ? 'phrase' : raw.endsWith('*') ? 'prefix' : 'word' });
    if (terms.length === MAX_TERMS) break;
  }
  return terms;
}

/**
 * The other German spellings of a term, worked out when searching so the
 * indexes stay as they are. The indexes store ü as u, so:
 * - Müller also looks for "mueller", the way the term itself is looked for;
 * - Mueller also looks for "muller", as a whole word only: Treue must not find
 *   "Betreuung" through "treu". Short words stay out for the same reason (Poet,
 *   blue, neue).
 * ß and ss work the same way.
 */
function spellings(needle: string): { written: string | null; plain: string | null } {
  const lower = needle.toLowerCase();
  const written = lower.replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' })[c] as string);
  const plain = chars(lower) >= MIN_PLAIN_SPELLING_CHARS
    ? lower.replace(/ae|oe|ue/g, (pair) => pair[0]).replace(/ss/g, 'ß')
    : lower;
  return { written: written === lower ? null : written, plain: plain === lower ? null : plain };
}

function probesFor(term: Term): Probe[] {
  const probes: Probe[] = [];
  const addWord = (text: string) => {
    probes.push({ index: 'word', text, prefix: term.kind === 'prefix' && chars(text) >= MIN_PREFIX_CHARS });
  };
  const addAll = (text: string) => {
    addWord(text);
    if (term.kind === 'word' && chars(text) >= MIN_TRIGRAM_CHARS) probes.push({ index: 'tri', text, prefix: false });
  };
  addAll(term.needle);
  const { written, plain } = spellings(term.needle);
  if (written) addAll(written);
  if (plain) addWord(plain);
  return probes;
}

function quote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** One FTS5 lookup of a term: the index table and its MATCH value. */
export interface TermLookup { table: string; match: string }

/**
 * Where a query keeps the messages each term matched, so a page and its total
 * read the index once between them, not once each. Returns the SQL that tests
 * `rowid` against the term's matches.
 */
export type TermSets = (lookups: readonly TermLookup[], rowid: string) => string;

/**
 * SQL for a text condition on `rowid` (the message's or its folder row's).
 * Every term has to match. Without `sets`, each term is a subquery of its own.
 */
export function textCondition(field: TextField, input: string, rowid = 'e.rowid', sets?: TermSets): { sql: string; params: SqlValue[] } {
  const terms = parseTerms(input);
  if (terms.length === 0) return { sql: '0', params: [] };
  const column = HEAD_COLUMNS[field];
  const scope = column ? `${column} : ` : '';
  const tables = field === 'text' ? [HEAD_TABLES, BODY_TABLES] : field === 'body' ? [BODY_TABLES] : [HEAD_TABLES];
  const conditions: string[] = [];
  const params: SqlValue[] = [];
  for (const term of terms) {
    const lookups: TermLookup[] = [];
    for (const probe of probesFor(term)) {
      for (const pair of tables) {
        lookups.push({ table: pair[probe.index], match: `${scope}${quote(probe.text)}${probe.prefix ? '*' : ''}` });
      }
    }
    if (sets) {
      conditions.push(sets(lookups, rowid));
      continue;
    }
    conditions.push(`${rowid} IN (${lookups.map(({ table }) => `SELECT rowid FROM ${table} WHERE ${table} MATCH ?`).join(' UNION ')})`);
    params.push(...lookups.map(({ match }) => match));
  }
  return { sql: conditions.join(' AND '), params };
}

/**
 * Term sets in an in-memory temp table (temp_store is MEMORY, so nothing of it
 * reaches the disk), filled once per query. A test is then a seek in that
 * table, for only the rows the query visits. `clear` empties it after the query.
 */
export function tempTermSets(db: StorageAdapter): { sets: TermSets; clear(): void } {
  let next = 0;
  let created = false;
  return {
    sets: (lookups, rowid) => {
      if (!created) {
        db.exec('CREATE TEMP TABLE IF NOT EXISTS search_hit (term INTEGER NOT NULL, email_rowid INTEGER NOT NULL, PRIMARY KEY (term, email_rowid)) WITHOUT ROWID');
        db.run('DELETE FROM temp.search_hit');
        created = true;
      }
      const term = next;
      next += 1;
      for (const { table, match } of lookups) {
        db.run(`INSERT OR IGNORE INTO temp.search_hit (term, email_rowid) SELECT ${term}, rowid FROM ${table} WHERE ${table} MATCH ?`, [match]);
      }
      return `EXISTS (SELECT 1 FROM temp.search_hit h WHERE h.term = ${term} AND h.email_rowid = ${rowid})`;
    },
    clear: () => {
      if (created) db.run('DELETE FROM temp.search_hit');
    },
  };
}

// ---- Limiting a whole filter ----

type Filter = Record<string, unknown>;

function isOperator(filter: Filter): boolean {
  return typeof filter.operator === 'string';
}

function conditionsOf(filter: Filter): Filter[] {
  return Array.isArray(filter.conditions) ? filter.conditions as Filter[] : [];
}

function textKeysOf(filter: Filter): TextField[] {
  return TEXT_FIELDS.filter((field) => field in filter);
}

function countTextConditions(filter: Filter): number {
  if (isOperator(filter)) return conditionsOf(filter).reduce((sum, condition) => sum + countTextConditions(condition), 0);
  return textKeysOf(filter).length;
}

/**
 * Keeps a filter within MAX_TEXT_CONDITIONS. Under AND a text condition past
 * the limit is dropped, which only widens the result. Under OR or NOT that
 * would narrow it or turn it around, so such a branch has to fit or the call
 * gets an error.
 */
export function limitTextConditions(filter: Filter | undefined): Filter | undefined {
  if (!filter) return filter;
  let left = MAX_TEXT_CONDITIONS;
  const walk = (node: Filter): Filter | null => {
    if (isOperator(node)) {
      if (node.operator === 'AND') {
        const kept = conditionsOf(node).map(walk).filter((condition): condition is Filter => condition !== null);
        return kept.length > 0 || conditionsOf(node).length === 0 ? { ...node, conditions: kept } : null;
      }
      const count = countTextConditions(node);
      if (count > left) throw new MethodError('unsupportedFilter', 'This search has too many terms');
      left -= count;
      return node;
    }
    const keys = textKeysOf(node);
    if (keys.length <= left) {
      left -= keys.length;
      return node;
    }
    const kept = { ...node };
    for (const key of keys.slice(left)) delete kept[key];
    left = 0;
    return Object.keys(kept).length > 0 ? kept : null;
  };
  return walk(filter) ?? {};
}

// ---- SearchSnippet/get ----

const FOLD_CACHE = new Map<string, string>();

function foldChar(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code < 128) return code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : ch;
  let folded = FOLD_CACHE.get(ch);
  if (folded === undefined) {
    folded = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    if (FOLD_CACHE.size < 4096) FOLD_CACHE.set(ch, folded);
  }
  return folded;
}

function fold(text: string): string {
  let out = '';
  for (const ch of text) out += foldChar(ch);
  return out;
}

/** Text without case and diacritics, and where each of its positions came from. */
function foldWithMap(text: string): { folded: string; map: number[] } {
  const map: number[] = [];
  let folded = '';
  let at = 0;
  for (const ch of text) {
    const piece = foldChar(ch);
    for (let i = 0; i < piece.length; i += 1) map.push(at);
    folded += piece;
    at += ch.length;
  }
  map.push(text.length);
  return { folded, map };
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/** What a probe finds, as a pattern over folded text, so a mark lands where the index matched. */
function probePattern(probe: Probe): string | null {
  const text = fold(probe.text);
  if (probe.index === 'tri') return escapeRegExp(text);
  const words = text.split(new RegExp(`${NOT_WORD_CHAR}+`, 'u')).filter(Boolean).map(escapeRegExp);
  if (words.length === 0) return null;
  return `(?<!${WORD_CHAR})${words.join(`${NOT_WORD_CHAR}+`)}${probe.prefix ? '' : `(?!${WORD_CHAR})`}`;
}

function highlighter(terms: readonly Term[]): RegExp | null {
  const patterns = new Set<string>();
  for (const term of terms) {
    for (const probe of probesFor(term)) {
      const pattern = probePattern(probe);
      if (pattern) patterns.add(pattern);
    }
  }
  if (patterns.size === 0) return null;
  // Longest first, so a match isn't cut short by a shorter spelling of it.
  return new RegExp([...patterns].sort((a, b) => b.length - a.length).slice(0, MAX_HIGHLIGHT_PATTERNS).join('|'), 'gu');
}

/** The terms a snippet marks. Anything under NOT was searched to be absent, so it isn't marked. */
function snippetTerms(filter: Filter | null | undefined): { subject: Term[]; body: Term[] } {
  const subject: Term[] = [];
  const body: Term[] = [];
  let left = MAX_TEXT_CONDITIONS;
  const walk = (node: Filter) => {
    if (isOperator(node)) {
      if (node.operator !== 'NOT') conditionsOf(node).forEach(walk);
      return;
    }
    for (const key of ['text', 'subject', 'body'] as const) {
      const value = node[key];
      if (typeof value !== 'string' || left === 0) continue;
      left -= 1;
      const terms = parseTerms(value);
      if (key !== 'body') subject.push(...terms);
      if (key !== 'subject') body.push(...terms);
    }
  };
  if (filter) walk(filter);
  return { subject, body };
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** The whole text, escaped, with its matches marked; null when nothing matches. */
function markAll(text: string, pattern: RegExp): string | null {
  const { folded, map } = foldWithMap(text);
  let out = '';
  let at = 0;
  for (const match of folded.matchAll(pattern)) {
    const start = map[match.index];
    const end = map[match.index + match[0].length];
    out += `${escapeHtml(text.slice(at, start))}<mark>${escapeHtml(text.slice(start, end))}</mark>`;
    at = end;
  }
  return out === '' ? null : out + escapeHtml(text.slice(at));
}

/** A section around the first match, escaped and marked, never past PREVIEW_BYTES; null when nothing matches. */
function excerpt(raw: string, pattern: RegExp): string | null {
  const text = raw.replace(/\s+/g, ' ').trim();
  const { folded, map } = foldWithMap(text);
  let out = '';
  let used = 0;
  // Stops before the character that wouldn't fit, keeping room for what must still follow.
  const put = (segment: string, reserve: number): boolean => {
    for (const ch of segment) {
      const piece = escapeHtml(ch);
      const size = utf8Bytes(piece);
      if (used + size + reserve > PREVIEW_BYTES) return false;
      out += piece;
      used += size;
    }
    return true;
  };
  let at = -1;
  for (const match of folded.matchAll(pattern)) {
    const start = map[match.index];
    const end = map[match.index + match[0].length];
    if (at < 0) {
      const earliest = Math.max(0, start - PREVIEW_CONTEXT_CHARS);
      const space = earliest === 0 ? -1 : text.indexOf(' ', earliest);
      at = earliest === 0 ? 0 : space >= 0 && space < start ? space + 1 : start;
    }
    if (!put(text.slice(at, start), 0)) return out;
    const before = out;
    const usedBefore = used;
    out += '<mark>';
    used += '<mark>'.length;
    const opened = out.length;
    const whole = put(text.slice(start, end), '</mark>'.length);
    if (out.length === opened) {
      // Not even one character fit: no empty mark.
      out = before;
      used = usedBefore;
      return out;
    }
    out += '</mark>';
    used += '</mark>'.length;
    if (!whole) return out;
    at = end;
  }
  if (at < 0) return null;
  put(text.slice(at), 0);
  return out;
}

/** The indexes are contentless, so snippets come from the stored message itself. */
export const searchSnippetGet: MethodHandler = (ctx, args) => {
  const jmap = (args.accountId as string | undefined) ?? ctx.defaultJmap;
  const ids = args.emailIds;
  if (!Array.isArray(ids)) throw new MethodError('invalidArguments', 'emailIds is required');
  if (ids.length > MAX_SNIPPET_IDS) throw new MethodError('requestTooLarge', `At most ${MAX_SNIPPET_IDS} messages at a time`);
  const terms = snippetTerms(args.filter as Filter | null | undefined);
  const subjectPattern = highlighter(terms.subject);
  const bodyPattern = highlighter(terms.body);
  const list: Array<{ emailId: string; subject: string | null; preview: string | null }> = [];
  const notFound: string[] = [];
  for (const id of ids as string[]) {
    const row = ctx.db.get<{ rowid: number; json: string }>('SELECT rowid, json FROM email WHERE jmap = ? AND id = ?', [jmap, id]);
    if (!row) {
      notFound.push(id);
      continue;
    }
    const email = JSON.parse(row.json) as { subject?: unknown; preview?: unknown };
    const subject = subjectPattern && typeof email.subject === 'string'
      ? markAll(email.subject.slice(0, MAX_SNIPPET_SUBJECT_CHARS), subjectPattern)
      : null;
    let preview: string | null = null;
    if (bodyPattern) {
      const body = ctx.db.get<{ json: string }>('SELECT json FROM email_body WHERE email_rowid = ?', [row.rowid]);
      // Before its body has arrived, a message only has its preview to show.
      const text = body ? bodyText(JSON.parse(body.json) as Record<string, unknown>) : '';
      const source = text.trim() ? text.slice(0, INDEX_BODY_CHARS) : typeof email.preview === 'string' ? email.preview : '';
      preview = excerpt(source, bodyPattern);
    }
    list.push({ emailId: id, subject, preview });
  }
  return { accountId: jmap, list, notFound };
};
