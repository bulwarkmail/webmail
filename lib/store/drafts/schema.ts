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
        last_attempt_at INTEGER,
        -- What this version should look like on the server.
        size INTEGER NOT NULL DEFAULT 0,
        -- Earlier versions that may have reached the server. Only removed once
        -- this one is there, and only if they still look like those versions.
        ghosts TEXT NOT NULL DEFAULT '[]',
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
      -- A version that may have reached the server, of a draft discarded here
      -- since. Looked up and removed when the server is back.
      CREATE TABLE draft_ghost (
        jmap TEXT NOT NULL,
        message_id TEXT NOT NULL,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        subject TEXT NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (jmap, message_id)
      ) WITHOUT ROWID;
      -- An old version in another login: this store can't queue it. Removed
      -- through that login once local_id is NULL: the new version is up, or the
      -- draft was discarded or sent.
      CREATE TABLE draft_elsewhere (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        local_id TEXT,
        login TEXT NOT NULL,
        jmap TEXT,
        record_id TEXT NOT NULL
      );
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
