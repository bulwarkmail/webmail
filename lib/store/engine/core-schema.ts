import type { Migration, StorageAdapter } from '../storage';

export const CORE_MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'core',
    sql: `
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;
      CREATE TABLE sync_state (
        jmap TEXT NOT NULL,
        type TEXT NOT NULL,
        state TEXT,
        target TEXT,
        phase TEXT,
        cursor TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (jmap, type)
      ) WITHOUT ROWID;
      CREATE TABLE object (
        jmap TEXT NOT NULL,
        type TEXT NOT NULL,
        id TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (jmap, type, id)
      ) WITHOUT ROWID;
    `,
  },
];

export function metaGet(db: StorageAdapter, key: string): string | null {
  return db.get<{ v: string | null }>('SELECT v FROM meta WHERE k = ?', [key])?.v ?? null;
}

export function metaSet(db: StorageAdapter, key: string, value: string | null): void {
  db.run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', [key, value]);
}

export function putObject(db: StorageAdapter, jmap: string, type: string, id: string, value: unknown): void {
  db.run(
    'INSERT INTO object (jmap, type, id, json) VALUES (?, ?, ?, ?) ON CONFLICT (jmap, type, id) DO UPDATE SET json = excluded.json',
    [jmap, type, id, JSON.stringify(value)],
  );
}

export function deleteObject(db: StorageAdapter, jmap: string, type: string, id: string): void {
  db.run('DELETE FROM object WHERE jmap = ? AND type = ? AND id = ?', [jmap, type, id]);
}

export function getObject<T = Record<string, unknown>>(db: StorageAdapter, jmap: string, type: string, id: string): T | null {
  const row = db.get<{ json: string }>('SELECT json FROM object WHERE jmap = ? AND type = ? AND id = ?', [jmap, type, id]);
  return row ? JSON.parse(row.json) as T : null;
}

export function listObjects<T = Record<string, unknown>>(db: StorageAdapter, jmap: string, type: string): T[] {
  return db.all<{ json: string }>('SELECT json FROM object WHERE jmap = ? AND type = ?', [jmap, type])
    .map((row) => JSON.parse(row.json) as T);
}
