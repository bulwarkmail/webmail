import type { Migration } from '../storage';

export const CALENDAR_MIGRATIONS: readonly Migration[] = [
  {
    id: 500,
    name: 'calendar',
    sql: `
      CREATE TABLE calendar_event (
        jmap TEXT NOT NULL,
        id TEXT NOT NULL,
        uid TEXT,
        is_task INTEGER NOT NULL DEFAULT 0,
        -- 1 for a series master. Occurrences are never stored: /changes only
        -- lists masters, and the client expands them.
        is_series INTEGER NOT NULL DEFAULT 0,
        -- Instants to narrow a query with. A floating event is read in UTC here.
        start_ms INTEGER,
        end_ms INTEGER,
        -- What answers show: the server's copy with any pending write applied.
        json TEXT NOT NULL,
        -- The server's copy while a write is pending on it, otherwise NULL.
        server_json TEXT,
        -- 1 while a delete is pending.
        hidden INTEGER NOT NULL DEFAULT 0,
        gen INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (jmap, id)
      ) WITHOUT ROWID;
      CREATE INDEX calendar_event_uid ON calendar_event (jmap, uid);
      CREATE INDEX calendar_event_start ON calendar_event (jmap, start_ms);
      CREATE INDEX calendar_event_end ON calendar_event (jmap, end_ms);

      -- An event's writes in order. A later one merges when the flags match (see writes.ts).
      CREATE TABLE calendar_pending (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        jmap TEXT NOT NULL,
        record_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('create', 'update', 'destroy')),
        -- create: the whole event. update: a PatchObject. destroy: empty.
        patch TEXT NOT NULL,
        -- The server's value at each patched path when it was queued.
        base TEXT NOT NULL DEFAULT '{}',
        -- For a create: how to find it again after a lost response.
        uid TEXT,
        -- sendSchedulingMessages: NULL when no write named it.
        send_scheduling INTEGER,
        -- 1 once it went out, or when the server may hold it for another reason.
        attempted INTEGER NOT NULL DEFAULT 0,
        -- What went out last, or for a later row what its earlier rows wrote:
        -- values of ours the server may hold.
        sent TEXT,
        -- Moves on every merge, to see a write that came in during a send.
        rev INTEGER NOT NULL DEFAULT 0,
        queued_at INTEGER NOT NULL
      );
      CREATE INDEX calendar_pending_record ON calendar_pending (jmap, record_id, seq);
      CREATE INDEX calendar_pending_uid ON calendar_pending (jmap, uid);

      -- What a stand-in id became, for a page still holding the stand-in.
      CREATE TABLE calendar_id_map (
        jmap TEXT NOT NULL,
        local_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        PRIMARY KEY (jmap, local_id)
      ) WITHOUT ROWID;

      CREATE TABLE calendar_conflict (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jmap TEXT NOT NULL,
        record_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        reason TEXT NOT NULL,
        error_type TEXT,
        description TEXT,
        title TEXT,
        local TEXT NOT NULL,
        server TEXT,
        created_at INTEGER NOT NULL
      );
    `,
  },
];
