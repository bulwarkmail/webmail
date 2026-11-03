import type { Migration } from '../storage';

export const REMINDER_MIGRATIONS: readonly Migration[] = [
  {
    id: 850,
    name: 'reminders',
    sql: `
      CREATE TABLE reminder (
        key TEXT PRIMARY KEY,
        uid TEXT NOT NULL,
        status TEXT NOT NULL,
        fire_time INTEGER NOT NULL,
        snooze_until INTEGER,
        batch INTEGER,
        -- A summary someone took: unless they say it's shown by then, it comes back.
        lease_until INTEGER,
        alert TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX reminder_status ON reminder (status, snooze_until);
      CREATE INDEX reminder_fire ON reminder (fire_time);
    `,
  },
];
