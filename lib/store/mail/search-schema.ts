import type { Migration } from '../storage';

const INDEX_OPTIONS = "content = '', contentless_delete = 1";
const WORD = "tokenize = 'unicode61 remove_diacritics 2'";
const TRIGRAM = "tokenize = 'trigram remove_diacritics 1'";
const HEAD_COLUMNS = 'subject, from_addr, to_addr, cc_addr, bcc_addr';

/** Bytes of pending terms a body index holds before it writes a segment. */
const BODY_WORD_HASH = 8 * 1024 * 1024;
const BODY_TRIGRAM_HASH = 16 * 1024 * 1024;
const AUTOMERGE = 8;

function setOption(table: string, option: string, value: number): string {
  return `INSERT INTO ${table} (${table}, rank) VALUES ('${option}', ${value});`;
}

/**
 * The final search tables. Migration 100's two indexes held everything, so a
 * message went in twice: its head at list time, then a delete and a second
 * insert when its body arrived. Now the head tables are written once at list
 * time and the body tables once at body time. Only a message with Bcc touches
 * its head row again, since Bcc isn't known before the body. To, Cc and Bcc
 * have their own columns: `to` used to find Cc and Bcc too, and `cc` (the
 * client's recipient search asks for it) had no answer.
 *
 * Options for the bulk writes of a first sync, which trade memory and some
 * reading speed for less writing:
 * - `hashsize` on the body tables: FTS5 writes a new segment when this much is
 *   pending (1 MiB by default), and at every commit. A larger value turns a
 *   batch of bodies into one segment, not many that have to be merged later.
 *   The memory is only held during a batch. Trigrams produce the most terms.
 * - `automerge` 8 (4 by default): merge when eight segments of a size exist, so
 *   each term is rewritten less often on its way up. Queries read a few more
 *   segments until then, and `crisismerge` (16) still bounds how many.
 *
 * FTS5 can't add a column and contentless tables have nothing to copy, so the
 * mail syncs again to fill them. No released version has data here: this only
 * touches a development database.
 */
export const SEARCH_MIGRATIONS: readonly Migration[] = [
  {
    id: 300,
    name: 'search-indexes',
    sql: `
      DROP TABLE email_fts_word;
      DROP TABLE email_fts_tri;
      CREATE VIRTUAL TABLE email_fts_word USING fts5(${HEAD_COLUMNS}, ${INDEX_OPTIONS}, ${WORD});
      CREATE VIRTUAL TABLE email_fts_tri USING fts5(${HEAD_COLUMNS}, ${INDEX_OPTIONS}, ${TRIGRAM});
      CREATE VIRTUAL TABLE email_fts_body_word USING fts5(body, ${INDEX_OPTIONS}, ${WORD});
      CREATE VIRTUAL TABLE email_fts_body_tri USING fts5(body, ${INDEX_OPTIONS}, ${TRIGRAM});
      ${setOption('email_fts_body_word', 'hashsize', BODY_WORD_HASH)}
      ${setOption('email_fts_body_tri', 'hashsize', BODY_TRIGRAM_HASH)}
      ${setOption('email_fts_word', 'automerge', AUTOMERGE)}
      ${setOption('email_fts_tri', 'automerge', AUTOMERGE)}
      ${setOption('email_fts_body_word', 'automerge', AUTOMERGE)}
      ${setOption('email_fts_body_tri', 'automerge', AUTOMERGE)}
      DELETE FROM email_keyword;
      DELETE FROM email_mailbox;
      DELETE FROM email_body;
      DELETE FROM thread;
      DELETE FROM email;
      DELETE FROM sync_state WHERE type IN ('Email', 'Thread');
    `,
  },
];
