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
  | { type: 'error'; account: string; area: string; message: string };

export interface StoreContext {
  account: string;
  db: StorageAdapter;
  session: StoreSession;
  scope: StoreScope;
  now(): number;
  emit(event: StoreEvent): void;
}

export interface SyncContext extends StoreContext {
  transport: JmapTransport;
  /** True once the engine is closing or lost the network: stop at the next batch. */
  stopped(): boolean;
  syncState(jmap: string, type: string): SyncStateRow;
  /** Call inside the transaction that writes the data, so the two can't disagree. */
  setSyncState(jmap: string, type: string, row: Partial<SyncStateRow>): void;
}

export interface Syncer {
  /** A short name for progress and errors. */
  name: string;
  /** The JMAP capability an account must advertise for this to run for it. */
  capability: string;
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
}

export type MethodHandler = (ctx: MethodContext, args: Record<string, unknown>, call: MethodCall) => MethodResult | Promise<MethodResult>;

/**
 * A call from the page that isn't JMAP: outbox rows, usage, clearing. Reached
 * from any tab with `store.area(account, 'outbox.list', params)`. Names are
 * unique across areas and start with the area's name.
 */
export type AreaCall = (ctx: StoreContext, params: never) => unknown | Promise<unknown>;

export interface StoreArea {
  name: string;
  migrations: readonly Migration[];
  methods: Readonly<Record<string, MethodHandler>>;
  syncers: readonly Syncer[];
  calls?: Readonly<Record<string, AreaCall>>;
}
