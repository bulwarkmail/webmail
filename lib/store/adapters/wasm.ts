/**
 * SQLite3MultipleCiphers on OPFS, for the owner tab's worker.
 *
 * Rules that come from bugs reproduced in 2.6.1, see
 * local-data/desktop-offline-facts-parts/sqlite-wasm.md section 5:
 * - PRAGMA key is the very first thing on a connection. Reading first deletes
 *   a hot journal (#292).
 * - The page size must be 8192. On 4096, rollback doesn't work (#293).
 * - No PRAGMA rekey (#291, #294). The key is random and only ever re-wrapped.
 * - Always the multipleciphers VFS. On plain opfs-sahpool, PRAGMA key throws
 *   and the connection still writes in the clear if that's ignored.
 */

import { runTransaction, type SqlRow, type SqlValue, type StorageAdapter } from '../storage';
import { POOL_DIRECTORY } from '../worker/protocol';

const VFS = 'multipleciphers-opfs-sahpool';
const INIT_TIMEOUT_MS = 30_000;
const REQUIRED_PAGE_SIZE = 8192;
const INITIAL_CAPACITY = 16;
/** A database and its journal, plus room for one more. */
const SLOTS_PER_DATABASE = 3;

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Pool {
  getFileNames(): string[];
  getCapacity(): number;
  getFileCount(): number;
  addCapacity(n: number): Promise<number>;
  unlink(name: string): boolean;
  wipeFiles(): Promise<void>;
  pauseVfs(): void;
  unpauseVfs(): Promise<void>;
  isPaused(): boolean;
}

export class StoreKeyError extends Error {
  constructor() {
    super('The local store could not be opened with this key');
    this.name = 'StoreKeyError';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

class WasmAdapter implements StorageAdapter {
  private readonly tx = { depth: 0 };
  private readonly statements = new Map<string, any>();

  constructor(private readonly sqlite3: any, private readonly db: any) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  private statement(sql: string): any {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  private bindAndRun<T>(sql: string, params: readonly SqlValue[] | undefined, read: (stmt: any) => T): T {
    const stmt = this.statement(sql);
    try {
      if (params && params.length > 0) stmt.bind(params as SqlValue[]);
      return read(stmt);
    } finally {
      stmt.reset(true);
    }
  }

  run(sql: string, params?: readonly SqlValue[]): { changes: number; lastInsertRowid: number } {
    this.bindAndRun(sql, params, (stmt) => {
      while (stmt.step()) { /* no rows wanted */ }
    });
    return {
      changes: Number(this.db.changes()),
      lastInsertRowid: Number(this.sqlite3.capi.sqlite3_last_insert_rowid(this.db.pointer)),
    };
  }

  all<T extends object = SqlRow>(sql: string, params?: readonly SqlValue[]): T[] {
    return this.bindAndRun(sql, params, (stmt) => {
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.get({}) as T);
      return rows;
    });
  }

  get<T extends object = SqlRow>(sql: string, params?: readonly SqlValue[]): T | undefined {
    return this.bindAndRun(sql, params, (stmt) => (stmt.step() ? stmt.get({}) as T : undefined));
  }

  transaction<T>(fn: () => T): T {
    return runTransaction(this.tx, (sql) => this.db.exec(sql), fn);
  }

  close(): void {
    for (const stmt of this.statements.values()) stmt.finalize();
    this.statements.clear();
    this.db.close();
  }
}

/** The module and the pool, once. Only the owner gets here. */
export class WasmStorage {
  private constructor(private readonly sqlite3: any, private readonly pool: Pool) {}

  /**
   * Call only while holding the owner lock. The holder before may still be
   * letting go, so a refusal is retried for a while.
   */
  static async install(moduleUrl: string): Promise<WasmStorage> {
    const { default: init } = await import(/* webpackIgnore: true */ moduleUrl) as { default: (o: unknown) => Promise<any> };
    // A failed wasm load never settles the promise from the module's init.
    const sqlite3 = await withTimeout(init({ print() {}, printErr() {} }), INIT_TIMEOUT_MS, 'Loading the store engine');
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const pool = await sqlite3.installOpfsSAHPoolVfs({
          name: 'opfs-sahpool',
          directory: POOL_DIRECTORY,
          initialCapacity: INITIAL_CAPACITY,
          preserveOnInitFailure: true,
          forceReinitIfPreviouslyFailed: true,
        }) as Pool;
        return new WasmStorage(sqlite3, pool);
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100 + attempt * 50));
      }
    }
    throw lastError;
  }

  /** Opens one account's database. `keyHex` is 32 random bytes in hex. */
  async open(file: string, keyHex: string): Promise<StorageAdapter> {
    if (!/^\/a[0-9a-f]+\.db$/.test(file)) throw new Error('Store file names carry no account data');
    if (!/^[0-9a-f]{64}$/.test(keyHex)) throw new Error('A store key is 32 bytes of hex');
    const needed = this.pool.getFileCount() + SLOTS_PER_DATABASE;
    if (this.pool.getCapacity() < needed) await this.pool.addCapacity(needed - this.pool.getCapacity());
    const db = new this.sqlite3.oo1.DB({ filename: file, vfs: VFS, flags: 'c' });
    try {
      db.exec(`PRAGMA key = "raw:${keyHex}"`);
      try {
        db.selectValue('SELECT count(*) FROM sqlite_master');
      } catch (error) {
        // Only "this isn't a database": a passing read error must not read as a lost file.
        if (error instanceof Error && /NOTADB|not a database/i.test(error.message)) throw new StoreKeyError();
        throw error;
      }
      const pageSize = Number(db.selectValue('PRAGMA page_size'));
      if (pageSize !== REQUIRED_PAGE_SIZE) throw new Error(`Refusing an unsafe page size: ${pageSize}`);
      db.exec('PRAGMA temp_store = MEMORY');
      // Every page read is a decryption, so a miss costs more than usual.
      db.exec('PRAGMA cache_size = -65536');
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec('PRAGMA synchronous = NORMAL');
    } catch (error) {
      db.close();
      throw error;
    }
    return new WasmAdapter(this.sqlite3, db);
  }

  remove(file: string): boolean {
    let removed = false;
    for (const name of this.pool.getFileNames()) {
      if (name === file || name === `${file}-journal`) removed = this.pool.unlink(name) || removed;
    }
    return removed;
  }

  /** Lets go of the OPFS handles. Every database must be closed first. */
  pause(): void {
    this.pool.pauseVfs();
  }

  async unpause(): Promise<void> {
    await this.pool.unpauseVfs();
  }

  files(): string[] {
    return this.pool.getFileNames();
  }
}
