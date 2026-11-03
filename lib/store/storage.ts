/**
 * The small storage interface the local store is written against.
 *
 * Synchronous on purpose: SQLite3MC in a worker and node:sqlite in the tests
 * both are, and a transaction then can't hold an await by accident. A native
 * or mobile adapter runs the engine next to its database, not across a
 * message boundary.
 */

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface StorageAdapter {
  /** Runs one or more statements without parameters. */
  exec(sql: string): void;
  /** Runs one statement. */
  run(sql: string, params?: readonly SqlValue[]): { changes: number; lastInsertRowid: number };
  all<T extends object = SqlRow>(sql: string, params?: readonly SqlValue[]): T[];
  get<T extends object = SqlRow>(sql: string, params?: readonly SqlValue[]): T | undefined;
  /** Commits when fn returns, rolls back when it throws. Nested calls join the outer one. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** Shared by the adapters: BEGIN/COMMIT around fn, and a guard against async bodies. */
export function runTransaction<T>(
  state: { depth: number },
  exec: (sql: string) => void,
  fn: () => T,
): T {
  if (state.depth > 0) return fn();
  exec('BEGIN IMMEDIATE');
  state.depth += 1;
  try {
    const result = fn();
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      throw new Error('A store transaction must be synchronous');
    }
    exec('COMMIT');
    return result;
  } catch (error) {
    exec('ROLLBACK');
    throw error;
  } finally {
    state.depth -= 1;
  }
}

export interface Migration {
  /** Unique, ascending. Ranges per area are listed in lib/store/area.ts. */
  id: number;
  name: string;
  sql: string;
}

/** Applies what's missing, in id order, each in its own transaction. */
export function migrate(db: StorageAdapter, migrations: readonly Migration[]): number[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migration (id INTEGER PRIMARY KEY, name TEXT NOT NULL, at INTEGER NOT NULL)');
  const done = new Set(db.all<{ id: number }>('SELECT id FROM schema_migration').map((row) => Number(row.id)));
  const ids = new Set<number>();
  const applied: number[] = [];
  for (const migration of [...migrations].sort((a, b) => a.id - b.id)) {
    if (ids.has(migration.id)) throw new Error(`Duplicate store migration id ${migration.id}`);
    ids.add(migration.id);
    if (done.has(migration.id)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.run('INSERT INTO schema_migration (id, name, at) VALUES (?, ?, ?)', [migration.id, migration.name, Date.now()]);
    });
    applied.push(migration.id);
  }
  return applied;
}
