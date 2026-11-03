import type { Migration } from '../storage';

const FTS_COLUMNS = 'subject, from_addr, to_addr, cc_addr, bcc_addr, body';

/**
 * Gives To, Cc and Bcc their own index columns. `to` used to find Cc and Bcc
 * too, and `cc` (the client's recipient search asks for it) had no answer.
 *
 * FTS5 can't add a column and contentless tables have nothing to copy, so the
 * indexes are made again and the mail syncs again to fill them. No released
 * version has data here: this only touches a development database.
 */
export const SEARCH_MIGRATIONS: readonly Migration[] = [
  {
    id: 300,
    name: 'search-address-columns',
    sql: `
      DROP TABLE email_fts_word;
      DROP TABLE email_fts_tri;
      CREATE VIRTUAL TABLE email_fts_word USING fts5(
        ${FTS_COLUMNS},
        content = '', contentless_delete = 1,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE email_fts_tri USING fts5(
        ${FTS_COLUMNS},
        content = '', contentless_delete = 1,
        tokenize = 'trigram remove_diacritics 1'
      );
      DELETE FROM email_keyword;
      DELETE FROM email_mailbox;
      DELETE FROM email_body;
      DELETE FROM thread;
      DELETE FROM email;
      DELETE FROM sync_state WHERE type IN ('Email', 'Thread');
    `,
  },
];
