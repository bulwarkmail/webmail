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
        pinned_at INTEGER,
        -- When the page last opened it. Cleared when its content is pushed out.
        opened_at INTEGER,
        -- Why the content isn't kept: tooLarge, overLimit, notAllowed or download.
        keep_error TEXT,
        -- Failed downloads in a row, and when the last one was.
        keep_failures INTEGER NOT NULL DEFAULT 0,
        keep_failed_at INTEGER,
        -- The kept content of the version before blob_id, until blob_id is kept.
        stale_blob_id TEXT,
        PRIMARY KEY (jmap, id)
      ) WITHOUT ROWID;
      CREATE INDEX file_node_parent ON file_node (jmap, parent_id);
      CREATE INDEX file_node_blob ON file_node (jmap, blob_id);
      CREATE INDEX file_node_stale ON file_node (jmap, stale_blob_id);
      CREATE TABLE file_blob (
        jmap TEXT NOT NULL,
        blob_id TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        kept_at INTEGER NOT NULL,
        -- 0 while its chunks are still coming in. Nothing reads it until it's 1.
        complete INTEGER NOT NULL DEFAULT 0,
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
