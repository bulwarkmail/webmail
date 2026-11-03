import type { Migration } from '../storage';

export const MAIL_MIGRATIONS: readonly Migration[] = [
  {
    id: 100,
    name: 'mail',
    sql: `
      CREATE TABLE email (
        rowid INTEGER PRIMARY KEY,
        jmap TEXT NOT NULL,
        id TEXT NOT NULL,
        thread_id TEXT,
        received_at INTEGER NOT NULL,
        sent_at INTEGER,
        size INTEGER NOT NULL DEFAULT 0,
        has_attachment INTEGER NOT NULL DEFAULT 0,
        subject_sort TEXT,
        from_sort TEXT,
        to_sort TEXT,
        json TEXT NOT NULL,
        -- 0 no body yet, 1 kept, 2 the server had none to give
        body_state INTEGER NOT NULL DEFAULT 0,
        gen INTEGER NOT NULL DEFAULT 0,
        UNIQUE (jmap, id)
      );
      CREATE INDEX email_received ON email (jmap, received_at DESC);
      CREATE INDEX email_thread ON email (jmap, thread_id);
      CREATE INDEX email_backfill ON email (jmap, body_state, received_at DESC);
      CREATE TABLE email_mailbox (
        email_rowid INTEGER NOT NULL REFERENCES email (rowid) ON DELETE CASCADE,
        jmap TEXT NOT NULL,
        mailbox_id TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (email_rowid, mailbox_id)
      ) WITHOUT ROWID;
      CREATE INDEX email_mailbox_list ON email_mailbox (jmap, mailbox_id, received_at DESC);
      CREATE TABLE email_keyword (
        email_rowid INTEGER NOT NULL REFERENCES email (rowid) ON DELETE CASCADE,
        keyword TEXT NOT NULL,
        PRIMARY KEY (email_rowid, keyword)
      ) WITHOUT ROWID;
      CREATE INDEX email_keyword_lookup ON email_keyword (keyword, email_rowid);
      CREATE TABLE email_body (
        email_rowid INTEGER PRIMARY KEY REFERENCES email (rowid) ON DELETE CASCADE,
        json TEXT NOT NULL
      );
      CREATE TABLE thread (
        jmap TEXT NOT NULL,
        id TEXT NOT NULL,
        email_ids TEXT NOT NULL,
        PRIMARY KEY (jmap, id)
      ) WITHOUT ROWID;
      CREATE VIRTUAL TABLE email_fts_word USING fts5(
        subject, from_addr, to_addr, body,
        content = '', contentless_delete = 1,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE email_fts_tri USING fts5(
        subject, from_addr, to_addr, body,
        content = '', contentless_delete = 1,
        tokenize = 'trigram remove_diacritics 1'
      );
    `,
  },
];
