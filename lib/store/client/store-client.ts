/**
 * The page's side of the local store. Each tab starts its own worker, which
 * waits for the owner lock. Calls go over a BroadcastChannel to whichever
 * worker owns the store, including this tab's own, so a tab doesn't need to
 * know whether it's the owner. A key never goes over the channel.
 */

import type { StoreEvent, StoreScope } from '../area';
import type { JmapResponse, MethodCall, StoreSession } from '../engine/transport';
import { SQLITE3MC_PUBLIC_DIR } from '../sqlite-version';
import {
  RPC_CHANNEL,
  type ChannelMessage,
  type OpenAccountParams,
  type PageToWorker,
  type RpcReply,
  type StoreRpc,
  type StoreStatus,
  type WorkerToPage,
} from '../worker/protocol';

const CALL_TIMEOUT_MS = 60_000;
const OWNER_WAIT_MS = 15_000;
/** A first sync of a large account runs a long time, and its promise is what ends "syncing". */
const SYNC_TIMEOUT_MS = 30 * 60_000;

export class StoreOwnerGoneError extends Error {
  constructor() {
    super('The local store is not available in this browser window');
    this.name = 'StoreOwnerGoneError';
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface StoreClientOptions {
  /** NEXT_PUBLIC_BASE_PATH plus the build id, passed in so this works in tests. */
  basePath?: string;
  buildId?: string;
  onEvent?(event: StoreEvent): void;
  /** The tab became the owner: open its accounts. */
  onOwner?(): void;
  /** The worker asks for a fresh Authorization header. */
  onNeedAuth?(account: string): void;
  /** Another tab signed everyone out: this tab's worker is gone. */
  onHalted?(): void;
}

export class StoreClient {
  readonly clientId = crypto.randomUUID();
  private worker: Worker | null = null;
  private channel: BroadcastChannel | null = null;
  private owner: string | null = null;
  private isOwner = false;
  private readonly pending = new Map<string, Pending>();
  private readonly ownerWaiters: Array<() => void> = [];
  private lifecycleBound = false;

  constructor(private readonly options: StoreClientOptions = {}) {}

  static supported(): boolean {
    return typeof Worker === 'function'
      && typeof BroadcastChannel === 'function'
      && typeof navigator !== 'undefined'
      && Boolean(navigator.locks)
      && typeof navigator.storage?.getDirectory === 'function'
      // createSyncAccessHandle itself only exists inside a dedicated worker,
      // so the page can't check for it. A browser without it fails at the
      // worker's start, which the page hears as an error event.
      && typeof FileSystemFileHandle !== 'undefined';
  }

  start(): void {
    if (this.worker) return;
    const base = this.options.basePath ?? '';
    const query = this.options.buildId ? `?v=${encodeURIComponent(this.options.buildId)}` : '';
    this.channel = new BroadcastChannel(RPC_CHANNEL);
    this.channel.onmessage = (event: MessageEvent<ChannelMessage>) => this.onChannel(event.data);
    this.worker = new Worker(`${base}/store-worker.js${query}`, { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerToPage>) => this.onWorker(event.data);
    this.post({
      kind: 'init',
      clientId: this.clientId,
      moduleUrl: new URL(`${base}/${SQLITE3MC_PUBLIC_DIR}/sqlite3.mjs`, location.origin).href,
    });
    // An owner from before this tab won't announce itself again.
    this.channel.postMessage({ kind: 'who-owns' } satisfies ChannelMessage);
    this.bindLifecycle();
  }

  private bindLifecycle(): void {
    if (this.lifecycleBound) return;
    this.lifecycleBound = true;
    // A clean handover when the tab goes. If this doesn't get to run, the lock
    // and the handles die with the worker and the next owner retries.
    addEventListener('pagehide', (event) => {
      if (!event.persisted) void this.release().catch(() => {});
    });
  }

  private post(message: PageToWorker): void {
    this.worker?.postMessage(message);
  }

  private onWorker(message: WorkerToPage): void {
    switch (message.kind) {
      case 'owner':
        this.isOwner = true;
        // Not an owner to call yet. This message can overtake the worker's
        // channel getting registered, and a call posted then never reaches it,
        // so calls wait for the worker's answer on the channel itself.
        this.channel?.postMessage({ kind: 'who-owns' } satisfies ChannelMessage);
        this.options.onOwner?.();
        break;
      case 'result': {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          const error = new Error(message.error);
          if (message.errorName) error.name = message.errorName;
          pending.reject(error);
        } else {
          pending.resolve(message.result);
        }
        break;
      }
      case 'need-auth':
        this.options.onNeedAuth?.(message.account);
        break;
      case 'event':
        // The owner's events also reach every other tab over the channel.
        this.options.onEvent?.(message.event);
        break;
    }
  }

  private onChannel(message: ChannelMessage): void {
    switch (message.kind) {
      case 'reply':
        if ((message as RpcReply).to === this.clientId) this.settle(message);
        break;
      case 'event':
        if (!this.isOwner) this.options.onEvent?.(message.event);
        break;
      case 'owner-changed':
        this.owner = message.owner;
        if (message.owner) this.flushOwnerWaiters();
        break;
      case 'shutdown':
        this.halt();
        this.options.onHalted?.();
        break;
      default:
        break;
    }
  }

  private settle(message: RpcReply): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const error = new Error(message.error);
      if (message.errorName) error.name = message.errorName;
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  private flushOwnerWaiters(): void {
    for (const waiter of this.ownerWaiters.splice(0)) waiter();
  }

  private track<T>(id: string, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new StoreOwnerGoneError());
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    });
  }

  private async waitForOwner(): Promise<void> {
    if (this.owner) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new StoreOwnerGoneError()), OWNER_WAIT_MS);
      this.ownerWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async rpc<K extends keyof StoreRpc>(method: K, params: Parameters<StoreRpc[K]>[0], timeoutMs = CALL_TIMEOUT_MS): Promise<ReturnType<StoreRpc[K]>> {
    await this.waitForOwner();
    const id = crypto.randomUUID();
    const result = this.track<ReturnType<StoreRpc[K]>>(id, timeoutMs);
    this.channel?.postMessage({ kind: 'rpc', id, from: this.clientId, method, params } as ChannelMessage);
    return result;
  }

  private direct<T>(message: PageToWorker & { id: string }): Promise<T> {
    const result = this.track<T>(message.id, CALL_TIMEOUT_MS);
    this.post(message);
    return result;
  }

  // ---- Owner only: these carry keys or manage files ----

  get ownsStore(): boolean {
    return this.isOwner;
  }

  openAccount(params: OpenAccountParams): Promise<void> {
    return this.direct({ kind: 'open', id: crypto.randomUUID(), params });
  }

  closeAccount(account: string): Promise<void> {
    return this.direct({ kind: 'close-account', id: crypto.randomUUID(), account });
  }

  setAuth(account: string, auth: string | null): void {
    this.post({ kind: 'set-auth', account, auth });
  }

  setSession(account: string, session: StoreSession): void {
    this.post({ kind: 'set-session', account, session });
  }

  setScope(account: string, scope: StoreScope): void {
    this.post({ kind: 'set-scope', account, scope });
  }

  setInvertedKeywordSort(account: string, inverted: boolean): void {
    this.post({ kind: 'set-inverted', account, inverted });
  }

  /** Hands the store over: the worker closes everything, then lets go of the lock. */
  async release(): Promise<void> {
    if (!this.worker) return;
    if (this.isOwner) {
      await this.direct({ kind: 'release', id: crypto.randomUUID() });
      this.isOwner = false;
      this.owner = null;
    }
    this.halt();
  }

  /**
   * Stops at once, with no handover. For a sign-out: the data goes anyway, and
   * the worker's end frees the lock and the OPFS handles.
   */
  halt(): void {
    this.worker?.terminate();
    this.worker = null;
    this.channel?.close();
    this.channel = null;
    this.isOwner = false;
    this.owner = null;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new StoreOwnerGoneError());
    }
  }

  // ---- Any tab ----

  answer(account: string, calls: MethodCall[]): Promise<JmapResponse | null> {
    return this.rpc('answer', { account, calls });
  }

  sync(account: string): Promise<void> {
    return this.rpc('sync', { account }, SYNC_TIMEOUT_MS);
  }

  removeAccount(account: string, file: string): Promise<boolean> {
    return this.rpc('removeAccount', { account, file });
  }

  noteStateChange(account: string, changed: Record<string, Record<string, string>>): Promise<void> {
    return this.rpc('noteStateChange', { account, changed });
  }

  setOnline(online: boolean): Promise<void> {
    return this.rpc('setOnline', { online });
  }

  status(account: string): Promise<StoreStatus | null> {
    return this.rpc('status', { account });
  }

  area<T = unknown>(account: string, name: string, params?: unknown): Promise<T> {
    return this.rpc('area', { account, name, params }) as Promise<T>;
  }
}
