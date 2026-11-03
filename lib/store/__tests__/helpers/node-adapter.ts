/** The storage adapter for tests: real SQLite with FTS5 through node:sqlite. */

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { runTransaction, type SqlRow, type SqlValue, type StorageAdapter } from '../../storage';

export function openMemoryStore(): StorageAdapter {
  return adapterFor(new DatabaseSync(':memory:'));
}

export function openFileStore(file: string): StorageAdapter {
  return adapterFor(new DatabaseSync(file));
}

function adapterFor(db: DatabaseSync): StorageAdapter {
  const tx = { depth: 0 };
  const prepared = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  const statement = (sql: string) => {
    let stmt = prepared.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      prepared.set(sql, stmt);
    }
    return stmt;
  };
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => {
      const result = statement(sql).run(...(params as SQLInputValue[]));
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    },
    all: <T extends object = SqlRow>(sql: string, params: readonly SqlValue[] = []) => statement(sql).all(...(params as SQLInputValue[])) as T[],
    get: <T extends object = SqlRow>(sql: string, params: readonly SqlValue[] = []) => statement(sql).get(...(params as SQLInputValue[])) as T | undefined,
    transaction: (fn) => runTransaction(tx, (sql) => db.exec(sql), fn),
    close: () => db.close(),
  };
}
