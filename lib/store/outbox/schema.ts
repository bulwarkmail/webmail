import type { Migration } from '../storage';

export const OUTBOX_MIGRATIONS: readonly Migration[] = [
  {
    id: 200,
    name: 'outbox',
    sql: `
      -- Finished messages waiting for the server. seq is shared with
      -- outbox_patch, so changes and sends go out in the order they were made.
      CREATE TABLE outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        sending_since INTEGER,
        -- When it was first handed to the server: where a retry's lookup starts.
        first_attempt_at INTEGER,
        payload TEXT NOT NULL,
        summary TEXT NOT NULL,
        message_id TEXT,
        -- The copy already on the server that only needs submitting.
        copy_id TEXT,
        error TEXT
      );
      -- One row per record, later changes merged in. base is the record's state
      -- when first queued, to tell whether the server changed it since; server
      -- is the newest state the server sent, for the folder counts.
      CREATE TABLE outbox_patch (
        jmap TEXT NOT NULL,
        type TEXT NOT NULL,
        record_id TEXT NOT NULL,
        op TEXT NOT NULL,
        patch TEXT NOT NULL,
        base TEXT,
        server TEXT,
        subject TEXT,
        seq INTEGER NOT NULL,
        queued_at INTEGER NOT NULL,
        PRIMARY KEY (jmap, type, record_id)
      ) WITHOUT ROWID;
      CREATE INDEX outbox_patch_seq ON outbox_patch (seq);
      CREATE TABLE conflict (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jmap TEXT NOT NULL,
        type TEXT NOT NULL,
        record_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        local TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      -- Files attached offline, under a stand-in blob id.
      CREATE TABLE upload (
        local_id TEXT PRIMARY KEY,
        jmap TEXT,
        type TEXT,
        name TEXT,
        size INTEGER NOT NULL,
        data BLOB NOT NULL,
        created_at INTEGER NOT NULL
      ) WITHOUT ROWID;
    `,
  },
];
