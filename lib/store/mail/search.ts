/** Full-text matching over the two FTS indexes. */

import type { SqlValue } from '../storage';

export type TextField = 'text' | 'subject' | 'from' | 'to' | 'body';

const COLUMNS: Record<TextField, string | null> = {
  text: null,
  subject: 'subject',
  from: 'from_addr',
  to: 'to_addr',
  body: 'body',
};

function quote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** The terms of a search box value: quoted phrases stay whole, `word*` keeps its star. */
export function splitTerms(input: string): string[] {
  const out: string[] = [];
  for (const match of input.matchAll(/"([^"]+)"|(\S+)/g)) out.push(match[1] ?? match[2]);
  return out;
}

/**
 * One term as SQL over rowids. The word index finds words and word starts,
 * the trigram index finds a term inside a longer word, which is how German
 * compounds are found ("Rechnung" in "Zahlungserinnerungsrechnung").
 */
function termRowids(field: TextField, term: string): { sql: string; params: SqlValue[] } {
  const column = COLUMNS[field];
  const star = term.endsWith('*');
  const clean = star ? term.slice(0, -1) : term;
  const scope = column ? `${column} : ` : '';
  const word = `${scope}${quote(clean)}${' *'.slice(1)}`;
  const parts = ['SELECT rowid FROM email_fts_word WHERE email_fts_word MATCH ?'];
  const params: SqlValue[] = [word];
  // Trigrams need three characters. Shorter terms use the word index alone.
  if ([...clean].length >= 3) {
    parts.push('SELECT rowid FROM email_fts_tri WHERE email_fts_tri MATCH ?');
    params.push(`${scope}${quote(clean)}`);
  }
  return { sql: parts.join(' UNION '), params };
}

/** SQL for a text condition, as a condition on `e.rowid`. Every term has to match. */
export function textCondition(field: TextField, input: string): { sql: string; params: SqlValue[] } {
  const terms = splitTerms(input);
  if (terms.length === 0) return { sql: '1', params: [] };
  const conditions: string[] = [];
  const params: SqlValue[] = [];
  for (const term of terms) {
    const part = termRowids(field, term);
    conditions.push(`e.rowid IN (${part.sql})`);
    params.push(...part.params);
  }
  return { sql: conditions.join(' AND '), params };
}
