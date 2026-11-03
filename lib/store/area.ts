/**
 * What one part of the local store (mail, calendar, contacts, files, ...)
 * plugs into the engine: its tables, the JMAP methods it answers while the
 * server can't be reached, and how it syncs.
 *
 * Migration id ranges: core 1-99, mail 100-199, outbox 200-299, search
 * 300-399, drafts 400-499, calendar 500-599, contacts 600-699, files 700-799,
 * settings and reminders 800-899, wipe and lock 900-999.
 */

import type { JmapTransport, MethodCall, StoreSession } from './engine/transport';
import type { Migration, StorageAdapter } from './storage';

export interface StoreScope {
  /** How far back mail is kept, in days. Null keeps everything. */
  days: number | null;
  /** Whether attachments are kept. */
  attachments: boolean;
  /** The largest attachment kept, and the total for all of them. */
  maxAttachmentBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_SCOPE: StoreScope = {
  days: 90,
  attachments: true,
  maxAttachmentBytes: 25 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

/** The `area` of an error event for a write that failed: a full disk, the browser's quota. */
export const STORAGE_ERROR_AREA = 'storage';

/** The scope changed, or a day passed and the window moved. `previous` is null on a store that never applied one. */
export interface ScopeChange {
  previous: StoreScope | null;
  next: StoreScope;
}

export type StoragePartName = 'mail' | 'attachments' | 'calendar' | 'contacts' | 'files';

/** One line of what an account's file holds. */
export interface StoreUsagePart {
  part: StoragePartName;
  bytes: number;
  items: number;
}

/** `store.usage`: what the file holds. `mail` gets what the other parts don't account for. */
export interface StoreUsage {
  bytes: number;
  parts: StoreUsagePart[];
}

export interface SyncStateRow {
  state: string | null;
  /** The newest state the server told us about, to know when a run is caught up. */
  target: string | null;
  /** The area's own phase name; null when in normal delta mode. */
  phase: string | null;
  /** The area's own resume point. */
  cursor: Record<string, unknown> | null;
}

export type StoreEvent =
  | { type: 'progress'; account: string; area: string; phase: string; done: number; total: number | null }
  | { type: 'synced'; account: string; at: number }
  | { type: 'changed'; account: string; collections: string[] }
  | { type: 'created'; account: string; jmap: string; collection: string; ids: string[] }
  | { type: 'error'; account: string; area: string; message: string }
  /** Its file and key are gone, whichever tab asked: opening it again makes a new one. */
  | { type: 'removed'; account: string };

export interface StoreContext {
  account: string;
  db: StorageAdapter;
  session: StoreSession;
  scope: StoreScope;
  now(): number;
  emit(event: StoreEvent): void;
  /** Records of one type as this device shows them: see RecordOverlay. */
  overlay<T extends { id: string }>(jmap: string, type: string, records: T[]): T[];
  /** Attachments and files the other areas keep: `scope.maxTotalBytes` is for all of them together. */
  keptByOthers(area: string): number;
  /** Records of one type another area needs to stay, whatever the window says. */
  sparedRecords(jmap: string, type: string): string[];
  /** Starts a sync pass, or one more after the running pass. Resolves when they're done. */
  requestSync(): Promise<void>;
}

/**
 * What an area changes about records another area stores: the outbox lays
 * changes that wait for the server over what the server sent. Runs inside the
 * caller's transaction. Returns the records to use; a record left out is one
 * this device already treats as gone.
 */
export type RecordOverlay = (ctx: Pick<StoreContext, 'db' | 'now'>, jmap: string, type: string, records: Array<{ id: string }>) => Array<{ id: string }>;

export interface SyncContext extends StoreContext {
  transport: JmapTransport;
  /** True once the engine is closing or lost the network: stop at the next batch. */
  stopped(): boolean;
  /** A newer pass was asked for. Work that can wait stops, and the next pass carries on with it. */
  syncWanted(): boolean;
  /** Waits, to stay polite to the server. */
  pause(ms: number): Promise<void>;
  syncState(jmap: string, type: string): SyncStateRow;
  /** Call inside the transaction that writes the data, so the two can't disagree. */
  setSyncState(jmap: string, type: string, row: Partial<SyncStateRow>): void;
}

export interface Syncer {
  /** A short name for progress and errors. */
  name: string;
  /** The JMAP capability an account must advertise for this to run for it. */
  capability: string;
  /** Runs after every other syncer of the pass, for work that can wait. */
  low?: boolean;
  /** Runs one pass for one JMAP account. Must be safe to stop between batches and start again. */
  run(ctx: SyncContext, jmap: string): Promise<void>;
}

export type MethodResult = Record<string, unknown>;

/** Thrown by a method handler: the client gets a per-call JMAP error. */
export class MethodError extends Error {
  constructor(readonly type: string, readonly description?: string) {
    super(description ?? type);
    this.name = 'MethodError';
  }
}

export interface MethodContext extends StoreContext {
  /** The account's own default JMAP account for calls that don't say. */
  defaultJmap: string;
  /** Whether keyword sort comparators arrive inverted from this client. */
  invertedKeywordSort: boolean;
  /** Earlier responses in this request, for creation-id references. */
  createdIds: Map<string, string>;
  /** The whole request this call came in. */
  calls: readonly MethodCall[];
}

export type MethodHandler = (ctx: MethodContext, args: Record<string, unknown>, call: MethodCall) => MethodResult | Promise<MethodResult>;

/**
 * A call from the page that isn't JMAP: outbox rows, usage, clearing. Reached
 * from any tab with `store.area(account, 'outbox.list', params)`. Names are
 * unique across areas and start with the area's name. It gets the sync context,
 * because some calls talk to the server (`calendar.flush`).
 */
export type AreaCall = (ctx: SyncContext, params: never) => unknown | Promise<unknown>;

export interface StoreArea {
  name: string;
  migrations: readonly Migration[];
  methods: Readonly<Record<string, MethodHandler>>;
  syncers: readonly Syncer[];
  calls?: Readonly<Record<string, AreaCall>>;
  overlay?: RecordOverlay;
  /**
   * Brings what's kept in line with the scope. Runs without the network and may
   * be interrupted: it runs again until it has finished, so it must be safe to
   * repeat. Whatever is fetched back goes through the next sync pass.
   */
  applyScope?: (ctx: SyncContext, change: ScopeChange) => void | Promise<void>;
  /** For the storage page. */
  usage?: (ctx: Pick<StoreContext, 'db'>) => StoreUsagePart[];
  /** Attachments and file contents it holds: what counts towards `scope.maxTotalBytes`. */
  keptBytes?: (ctx: Pick<StoreContext, 'db'>) => number;
  /** Records it needs, stored by another area, that no window may take away. */
  spares?: (ctx: Pick<StoreContext, 'db'>, jmap: string, type: string) => string[];
  /** At start and when the scope changes: a tighter policy applies at once, not at the next sync. */
  scopeChanged?(ctx: StoreContext): void;
}
