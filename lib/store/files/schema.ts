import type { Migration } from '../storage';

export const FILE_MIGRATIONS: readonly Migration[] = [
  {
    id: 700,
    name: 'files',
    sql: `
      CREATE TABLE file_node (
        jmap TEXT NOT NULL,
        id TEXT NOT NULL,
        parent_id TEXT,
        name TEXT NOT NULL DEFAULT '',
        -- file, directory or symlink, whichever way the server says so.
        kind TEXT NOT NULL,
        blob_id TEXT,
        size INTEGER,
        json TEXT NOT NULL,
        gen INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        -- When the page last opened it. Cleared when its content is pushed out.
        opened_at INTEGER,
        -- Why the content isn't kept: tooLarge, overLimit, notAllowed or download.
        keep_error TEXT,
        PRIMARY KEY (jmap, id)
      ) WITHOUT ROWID;
      CREATE INDEX file_node_parent ON file_node (jmap, parent_id);
      CREATE INDEX file_node_blob ON file_node (jmap, blob_id);
      CREATE TABLE file_blob (
        jmap TEXT NOT NULL,
        blob_id TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        kept_at INTEGER NOT NULL,
        PRIMARY KEY (jmap, blob_id)
      ) WITHOUT ROWID;
      -- In pieces: a whole file bound at once would grow the WASM heap by its
      -- size, and that memory never comes back.
      CREATE TABLE file_blob_chunk (
        jmap TEXT NOT NULL,
        blob_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (jmap, blob_id, seq)
      );
    `,
  },
];
