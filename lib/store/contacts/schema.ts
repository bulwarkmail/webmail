import type { Migration } from '../storage';

export const CONTACT_MIGRATIONS: readonly Migration[] = [
  {
    id: 600,
    name: 'contacts',
    sql: `
      CREATE TABLE contact_card (
        rowid INTEGER PRIMARY KEY,
        jmap TEXT NOT NULL,
        id TEXT NOT NULL,
        uid TEXT,
        sort_key TEXT NOT NULL DEFAULT '',
        -- What the UI sees: the server's card with queued edits on top.
        json TEXT NOT NULL,
        gen INTEGER NOT NULL DEFAULT 0,
        UNIQUE (jmap, id)
      );
      CREATE INDEX contact_card_sort ON contact_card (jmap, sort_key, id);
      CREATE TABLE contact_card_book (
        card_rowid INTEGER NOT NULL,
        book_id TEXT NOT NULL,
        PRIMARY KEY (card_rowid, book_id)
      ) WITHOUT ROWID;
      CREATE INDEX contact_card_book_lookup ON contact_card_book (book_id, card_rowid);
      -- Text goes in through foldText (records.ts), which also takes care of accents.
      CREATE VIRTUAL TABLE contact_fts_word USING fts5(
        name, email, org,
        content = '', contentless_delete = 1,
        tokenize = 'unicode61 remove_diacritics 0',
        prefix = '2 3'
      );
      CREATE VIRTUAL TABLE contact_fts_tri USING fts5(
        name, email, org,
        content = '', contentless_delete = 1,
        tokenize = 'trigram'
      );
      -- One row per card with something to send. Edits to a card merge here.
      CREATE TABLE contact_pending (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        jmap TEXT NOT NULL,
        id TEXT NOT NULL,
        op TEXT NOT NULL,
        uid TEXT,
        -- create: the whole card. update: the merged patch. destroy: nothing.
        payload TEXT,
        -- The server's card when the first edit was queued, to see what changed there since.
        base TEXT,
        -- A request may have reached the server, so a create looks for its uid first.
        attempted INTEGER NOT NULL DEFAULT 0,
        queued_at INTEGER NOT NULL,
        UNIQUE (jmap, id)
      );
      -- Stand-in ids the page may still hold after a create went through.
      CREATE TABLE contact_id_map (
        jmap TEXT NOT NULL,
        local_id TEXT NOT NULL,
        real_id TEXT NOT NULL,
        PRIMARY KEY (jmap, local_id)
      ) WITHOUT ROWID;
      CREATE TABLE contact_conflict (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jmap TEXT NOT NULL,
        record_id TEXT NOT NULL,
        -- refused: the server said no. changed: edited there too. gone: deleted there.
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        local TEXT NOT NULL,
        server TEXT,
        error TEXT,
        created_at INTEGER NOT NULL
      );
    `,
  },
];
