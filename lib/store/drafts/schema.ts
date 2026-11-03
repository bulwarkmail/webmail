import type { Migration } from '../storage';

export const DRAFT_MIGRATIONS: readonly Migration[] = [
  {
    id: 400,
    name: 'drafts',
    sql: `
      -- A draft saved on this device and not on the server yet. One row per
      -- draft: a later save takes over from the row before it.
      CREATE TABLE draft_pending (
        local_id TEXT PRIMARY KEY,
        jmap TEXT NOT NULL,
        seq INTEGER NOT NULL,
        subject TEXT,
        -- The create as the client wrote it, with its fixed Message-ID.
        create_json TEXT NOT NULL,
        message_id TEXT NOT NULL,
        -- Versions on the server this one replaces: destroyed after it's there.
        replaces TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'waiting',
        sending_since INTEGER,
        -- Set once it may have reached the server: then it's looked up first.
        first_attempt_at INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      -- What a stand-in id became. The page may hold one for a long time.
      CREATE TABLE draft_id_map (
        local_id TEXT PRIMARY KEY,
        jmap TEXT NOT NULL,
        server_id TEXT NOT NULL,
        at INTEGER NOT NULL
      ) WITHOUT ROWID;
      -- A version that may have reached the server and has been replaced or
      -- discarded here since. Looked up and removed when the server is back.
      CREATE TABLE draft_ghost (
        jmap TEXT NOT NULL,
        message_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (jmap, message_id)
      ) WITHOUT ROWID;
    `,
  },
  {
    id: 401,
    name: 'held files in chunks',
    sql: `
      ALTER TABLE upload ADD COLUMN complete INTEGER NOT NULL DEFAULT 1;
      -- Binding a whole file grows the WASM heap by its size, and that never shrinks.
      CREATE TABLE upload_chunk (
        local_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (local_id, seq)
      );
    `,
  },
];
