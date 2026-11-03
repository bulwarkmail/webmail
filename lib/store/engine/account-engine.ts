/**
 * One local account in the store: its database, its sync runs, its answers.
 * It acts as a JMAP client toward the real server and as a JMAP server toward
 * the UI. Nothing here touches the DOM, so tests run it on node:sqlite.
 */

import { MethodError, type AreaCall, type MethodHandler, type StoreArea, type StoreContext, type StoreEvent, type StoreScope, type SyncContext, type SyncStateRow, type Syncer } from '../area';
import { migrate, type StorageAdapter } from '../storage';
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

export class AccountEngine {
  readonly account: string;
  private readonly db: StorageAdapter;
  private session: StoreSession;
  private scope: StoreScope;
  private readonly transport: JmapTransport;
  private readonly syncers: readonly Syncer[];
  private readonly methods: ReadonlyMap<string, MethodHandler>;
  private readonly calls = new Map<string, AreaCall>();
  private readonly emitter: (event: StoreEvent) => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private invertedKeywordSort: boolean;
  private closed = false;
  private online = true;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(options: AccountEngineOptions) {
    this.account = options.account;
    this.db = options.db;
    this.session = options.session;
    this.scope = options.scope;
    this.transport = options.transport;
    this.syncers = options.areas.flatMap((area) => area.syncers);
    this.methods = buildMethodTable(options.areas);
    for (const area of options.areas) {
      for (const [name, call] of Object.entries(area.calls ?? {})) {
        if (this.calls.has(name)) throw new Error(`Two store areas define ${name}`);
        this.calls.set(name, call);
      }
    }
    this.emitter = options.emit ?? (() => {});
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.invertedKeywordSort = options.invertedKeywordSort ?? false;
    migrate(this.db, [...CORE_MIGRATIONS, ...options.areas.flatMap((area) => area.migrations)]);
    metaSet(this.db, 'session', JSON.stringify(options.session));
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
    metaSet(this.db, 'scope', JSON.stringify(scope));
  }

  setInvertedKeywordSort(inverted: boolean): void {
    this.invertedKeywordSort = inverted;
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
    if (this.closed) return Promise.resolve();
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
    } while (this.again && !this.closed && this.online);
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

  private syncContext(): SyncContext {
    return {
      account: this.account,
      db: this.db,
      session: this.session,
      scope: this.scope,
      transport: this.transport,
      now: this.now,
      emit: this.emitter,
      stopped: () => this.closed || !this.online,
      syncState: (jmap, type) => this.syncState(jmap, type),
      setSyncState: (jmap, type, row) => this.setSyncState(jmap, type, row),
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
    };
  }

  /** A non-JMAP call into one of the areas. */
  async areaCall(name: string, params: unknown): Promise<unknown> {
    const call = this.calls.get(name);
    if (!call) throw new Error(`Unknown store call ${name}`);
    return call(this.syncContext(), params as never);
  }

  /** An answer from the device. Null when nothing in the request could be answered. */
  async answer(calls: MethodCall[]): Promise<JmapResponse | null> {
    if (this.closed) throw new MethodError('serverUnavailable', 'The local store is closed');
    const primary = this.session.primaryAccounts['urn:ietf:params:jmap:mail'] ?? Object.keys(this.session.accounts)[0];
    return answerRequest(
      {
        ...this.storeContext(),
        defaultJmap: primary,
        invertedKeywordSort: this.invertedKeywordSort,
      },
      this.methods,
      calls,
    );
  }

  /** Stops syncing and waits for the current batch. The database stays open for the caller to close. */
  async close(): Promise<void> {
    this.closed = true;
    await this.running?.catch(() => {});
  }
}
