/**
 * One local account in the store: its database, its sync runs, its answers.
 * It acts as a JMAP client toward the real server and as a JMAP server toward
 * the UI. Nothing here touches the DOM, so tests run it on node:sqlite.
 */

import { MethodError, STORAGE_ERROR_AREA, type AreaCall, type MethodHandler, type RecordOverlay, type StoreArea, type StoreContext, type StoreEvent, type StoreScope, type SyncContext, type SyncStateRow, type Syncer } from '../area';
import { isStorageFailure, migrate, type StorageAdapter } from '../storage';
import { answerRequest, buildMethodTable } from './responder';
import { TransportError, type JmapResponse, type JmapTransport, type MethodCall, type StoreSession } from './transport';
import { CORE_MIGRATIONS, metaGet, metaSet } from './core-schema';

export interface AccountEngineOptions {
  account: string;
  db: StorageAdapter;
  session: StoreSession;
  transport: JmapTransport;
  areas: readonly StoreArea[];
  scope: StoreScope;
  invertedKeywordSort?: boolean;
  emit?: (event: StoreEvent) => void;
  now?: () => number;
  /** Waits before a retry after the server said it's busy. Tests pass a stub. */
  sleep?: (ms: number) => Promise<void>;
}

const RATE_RETRIES = 5;
const RATE_BACKOFF_MS = 2_000;
/** After a failed write: the first wait, and the longest. */
const STORAGE_BACKOFF_MS = 60_000;
const STORAGE_BACKOFF_MAX_MS = 60 * 60_000;

export class AccountEngine {
  readonly account: string;
  private readonly db: StorageAdapter;
  private session: StoreSession;
  private scope: StoreScope;
  private readonly transport: JmapTransport;
  private readonly syncers: readonly Syncer[];
  private readonly areas: readonly StoreArea[];
  private readonly methods: ReadonlyMap<string, MethodHandler>;
  private readonly calls = new Map<string, AreaCall>();
  private readonly overlays: readonly RecordOverlay[];
  private readonly emitter: (event: StoreEvent) => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private invertedKeywordSort: boolean;
  private closed = false;
  private online = true;
  private running: Promise<void> | null = null;
  private again = false;
  /** A write failed (full disk, quota): no sync before this time, however much the server pushes. */
  private storageBlockedUntil = 0;
  private storageFailures = 0;

  constructor(options: AccountEngineOptions) {
    this.account = options.account;
    this.db = options.db;
    this.session = options.session;
    this.scope = options.scope;
    this.transport = options.transport;
    this.areas = options.areas;
    const syncers = options.areas.flatMap((area) => area.syncers);
    this.syncers = [...syncers.filter((syncer) => !syncer.low), ...syncers.filter((syncer) => syncer.low)];
    this.methods = buildMethodTable(options.areas);
    this.overlays = options.areas.flatMap((area) => (area.overlay ? [area.overlay] : []));
    for (const area of options.areas) {
      for (const [name, call] of Object.entries(area.calls ?? {})) {
        if (this.calls.has(name)) throw new Error(`Two store areas define ${name}`);
        this.calls.set(name, call);
      }
    }
    this.emitter = options.emit ?? (() => {});
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    migrate(this.db, [...CORE_MIGRATIONS, ...options.areas.flatMap((area) => area.migrations)]);
    metaSet(this.db, 'session', JSON.stringify(options.session));
    // An offline start has no way to probe the server, so the last answer stays.
    this.invertedKeywordSort = options.invertedKeywordSort ?? metaGet(this.db, 'inverted_keyword_sort') === '1';
    if (options.invertedKeywordSort !== undefined) metaSet(this.db, 'inverted_keyword_sort', options.invertedKeywordSort ? '1' : '0');
    this.applyScope();
  }

  private applyScope(): void {
    const ctx = this.storeContext();
    for (const area of this.areas) area.scopeChanged?.(ctx);
  }

  /** The session kept from the last time, for a start without a network. */
  static storedSession(db: StorageAdapter): StoreSession | null {
    migrate(db, CORE_MIGRATIONS);
    const raw = metaGet(db, 'session');
    return raw ? JSON.parse(raw) as StoreSession : null;
  }

  setSession(session: StoreSession): void {
    this.session = session;
    metaSet(this.db, 'session', JSON.stringify(session));
  }

  setScope(scope: StoreScope): void {
    this.scope = scope;
    // The user may just have made room by keeping less.
    this.storageBlockedUntil = 0;
    metaSet(this.db, 'scope', JSON.stringify(scope));
    this.applyScope();
  }

  setInvertedKeywordSort(inverted: boolean): void {
    this.invertedKeywordSort = inverted;
    metaSet(this.db, 'inverted_keyword_sort', inverted ? '1' : '0');
  }

  private overlay<T extends { id: string }>(jmap: string, type: string, records: T[]): T[] {
    let out: Array<{ id: string }> = records;
    for (const overlay of this.overlays) out = overlay({ db: this.db, now: this.now }, jmap, type, out);
    return out as T[];
  }

  setOnline(online: boolean): void {
    this.online = online;
    if (online) this.requestSync();
  }

  private syncState(jmap: string, type: string): SyncStateRow {
    const row = this.db.get<{ state: string | null; target: string | null; phase: string | null; cursor: string | null }>(
      'SELECT state, target, phase, cursor FROM sync_state WHERE jmap = ? AND type = ?',
      [jmap, type],
    );
    return {
      state: row?.state ?? null,
      target: row?.target ?? null,
      phase: row?.phase ?? null,
      cursor: row?.cursor ? JSON.parse(row.cursor) as Record<string, unknown> : null,
    };
  }

  private setSyncState(jmap: string, type: string, patch: Partial<SyncStateRow>): void {
    const row = { ...this.syncState(jmap, type), ...patch };
    this.db.run(
      `INSERT INTO sync_state (jmap, type, state, target, phase, cursor, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (jmap, type) DO UPDATE SET state = excluded.state, target = excluded.target, phase = excluded.phase,
         cursor = excluded.cursor, updated_at = excluded.updated_at`,
      [jmap, type, row.state, row.target, row.phase, row.cursor ? JSON.stringify(row.cursor) : null, this.now()],
    );
  }

  /** What the server pushed: jmap account id to { type: state }. */
  noteStateChange(changed: Record<string, Record<string, string>>): void {
    this.db.transaction(() => {
      for (const [jmap, types] of Object.entries(changed)) {
        for (const [type, state] of Object.entries(types)) this.setSyncState(jmap, type, { target: state });
      }
    });
    this.requestSync();
  }

  /** Starts a run, or asks the running one to go again when it's done. */
  requestSync(): Promise<void> {
    if (this.closed || this.now() < this.storageBlockedUntil) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.runLoop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runLoop(): Promise<void> {
    do {
      this.again = false;
      await this.runOnce();
    } while (this.again && !this.closed && this.online && this.now() >= this.storageBlockedUntil);
  }

  private async runOnce(): Promise<void> {
    if (!this.online) return;
    const ctx = this.syncContext();
    const jmapAccounts = Object.keys(this.session.accounts);
    for (const syncer of this.syncers) {
      for (const jmap of jmapAccounts) {
        const capabilities = this.session.accounts[jmap].accountCapabilities ?? this.session.capabilities;
        if (!(syncer.capability in capabilities)) continue;
        if (this.closed || !this.online) return;
        if (!(await this.runSyncer(ctx, syncer, jmap))) return;
      }
    }
    this.storageFailures = 0;
    if (!this.closed && this.online) this.emitter({ type: 'synced', account: this.account, at: this.now() });
  }

  /** False when the run should end: no network, no credentials. */
  private async runSyncer(ctx: SyncContext, syncer: Syncer, jmap: string): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await syncer.run(ctx, jmap);
        return true;
      } catch (error) {
        if (error instanceof TransportError) {
          if (error.kind === 'network' || error.kind === 'auth') return false;
          if (error.kind === 'rate' && attempt < RATE_RETRIES) {
            await this.sleep(error.retryAfterMs ?? RATE_BACKOFF_MS * 2 ** attempt);
            continue;
          }
        }
        // The others would fail on the same disk: the run ends, and sync waits.
        if (isStorageFailure(error)) {
          this.noteStorageFailure(error);
          return false;
        }
        // One part failing doesn't hold up the others. It runs again next time.
        this.emitter({
          type: 'error',
          account: this.account,
          area: syncer.name,
          message: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    }
  }

  private noteStorageFailure(error: unknown): void {
    this.storageFailures += 1;
    const wait = Math.min(STORAGE_BACKOFF_MS * 2 ** (this.storageFailures - 1), STORAGE_BACKOFF_MAX_MS);
    this.storageBlockedUntil = this.now() + wait;
    this.emitter({
      type: 'error',
      account: this.account,
      area: STORAGE_ERROR_AREA,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private syncContext(): SyncContext {
    const scope = () => this.scope;
    return {
      account: this.account,
      db: this.db,
      session: this.session,
      // A pass can take long, and a tighter policy applies to the rest of it.
      get scope() {
        return scope();
      },
      transport: this.transport,
      now: this.now,
      emit: this.emitter,
      stopped: () => this.closed || !this.online,
      syncWanted: () => this.again,
      pause: this.sleep,
      syncState: (jmap, type) => this.syncState(jmap, type),
      setSyncState: (jmap, type, row) => this.setSyncState(jmap, type, row),
      overlay: (jmap, type, records) => this.overlay(jmap, type, records),
    };
  }

  private storeContext(): StoreContext {
    return {
      account: this.account,
      db: this.db,
      session: this.session,
      scope: this.scope,
      now: this.now,
      emit: this.emitter,
      overlay: (jmap, type, records) => this.overlay(jmap, type, records),
    };
  }

  /** A non-JMAP call into one of the areas. */
  async areaCall(name: string, params: unknown): Promise<unknown> {
    const call = this.calls.get(name);
    if (!call) throw new Error(`Unknown store call ${name}`);
    try {
      return await call(this.syncContext(), params as never);
    } catch (error) {
      if (isStorageFailure(error)) this.noteStorageFailure(error);
      throw error;
    }
  }

  /** An answer from the device. Null when nothing in the request could be answered. */
  async answer(calls: MethodCall[]): Promise<JmapResponse | null> {
    if (this.closed) throw new MethodError('serverUnavailable', 'The local store is closed');
    const primary = this.session.primaryAccounts['urn:ietf:params:jmap:mail'] ?? Object.keys(this.session.accounts)[0];
    try {
      return await answerRequest(
        {
          ...this.storeContext(),
          defaultJmap: primary,
          invertedKeywordSort: this.invertedKeywordSort,
        },
        this.methods,
        calls,
      );
    } catch (error) {
      if (isStorageFailure(error)) this.noteStorageFailure(error);
      throw error;
    }
  }

  /** Stops syncing and waits for the current batch. The database stays open for the caller to close. */
  async close(): Promise<void> {
    this.closed = true;
    // A large download could otherwise hold up removing the account.
    this.transport.abort?.();
    await this.running?.catch(() => {});
  }
}
