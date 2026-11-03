/**
 * The page's way to the local store: one StoreClient per tab, accounts opened
 * while this tab is the owner, sessions and auth handed over. Knows nothing of
 * the app's stores: lib/offline/offline-mode.ts wires those in with
 * configureStore, so the worker bundle stays free of them.
 */

import type { StoreEvent, StoreScope } from '../area';
import type { JmapResponse, MethodCall, StoreSession } from '../engine/transport';
import { forgetAccountKey, getAccountRecord, listAccountRecords, openAccountKey, type WrapLayer } from './keys';
import { StoreClient } from './store-client';

export interface StoreAccountInputs {
  session: StoreSession | null;
  auth: string | null;
  /** Left out while the organisation's policy isn't known: the store keeps the last one. */
  scope?: StoreScope;
  invertedKeywordSort: boolean | null;
}

export interface StorePageHooks {
  /** What this tab knows about an account right now. */
  inputs(account: string): StoreAccountInputs;
  /** Runs the client's refresh path; the fresh Authorization header, or null. */
  refreshAuth(account: string): Promise<string | null>;
  onEvent(event: StoreEvent): void;
  /** What opening an account found: its key from before, and its file. Owner tab only. */
  onOpened?(account: string, found: { hadKey: boolean; fileExisted: boolean }): void;
  /** Wrap layers on top of the WebCrypto one (desktop keychain, app lock). */
  keyLayers?(): readonly WrapLayer[];
}

/** What lib/offline uses. A seam, so its tests run the real engine on node:sqlite. */
export interface StoreBackend {
  supported(): boolean;
  /** Asks for the account to be open. `session` is for a first open with no client yet. */
  ensureOpen(account: string, session?: StoreSession | null): Promise<void>;
  /** Hands the owner what this tab now knows: session, auth, sort polarity. */
  refresh(account: string): void;
  answer(account: string, calls: MethodCall[]): Promise<JmapResponse | null>;
  area<T = unknown>(account: string, name: string, params?: unknown): Promise<T>;
  /** What the store may keep. A tightened scope prunes at once, also without a network. */
  setScope(account: string, scope: StoreScope): Promise<void>;
  sync(account: string): Promise<void>;
  noteStateChange(account: string, changed: Record<string, Record<string, string>>): Promise<void>;
  setOnline(online: boolean): Promise<void>;
  /** Closes the account, forgets its key and deletes its file. */
  remove(account: string): Promise<void>;
  /** Stops this tab's worker at once (a sign-out; the files go separately). */
  stop(): void;
}

/** How long a call waits for the owner to have opened an account. */
const OPEN_RETRIES = 25;
const OPEN_RETRY_MS = 200;

class PageStore implements StoreBackend {
  private client: StoreClient | null = null;
  private readonly wanted = new Map<string, StoreSession | null>();
  private readonly opening = new Map<string, Promise<void>>();
  /** The engine can't start in this browser: don't keep every caller waiting for an owner. */
  private broken = false;

  constructor(private readonly hooks: () => StorePageHooks | null) {}

  supported(): boolean {
    return StoreClient.supported();
  }

  private started(): StoreClient {
    if (this.client) return this.client;
    this.broken = false;
    const client = new StoreClient({
      basePath: (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, ''),
      buildId: process.env.NEXT_PUBLIC_BUILD_ID,
      onEvent: (event) => {
        if (event.type === 'error' && event.area === 'store' && !event.account) this.broken = true;
        this.hooks()?.onEvent(event);
      },
      onOwner: () => {
        this.opening.clear();
        for (const account of this.wanted.keys()) void this.openHere(account).catch(() => {});
        void this.sweepOrphans();
      },
      onNeedAuth: (account) => {
        void (this.hooks()?.refreshAuth(account) ?? Promise.resolve(null))
          .catch(() => null)
          .then((auth) => this.client?.setAuth(account, auth));
      },
      onHalted: () => this.reset(),
    });
    client.start();
    this.client = client;
    return client;
  }

  private reset(): void {
    this.client = null;
    this.wanted.clear();
    this.opening.clear();
    this.broken = false;
  }

  /** Files whose key is gone can't be read by anyone: they only take room. */
  private async sweepOrphans(): Promise<void> {
    try {
      const records = await listAccountRecords();
      await this.client?.sweepFiles(records.map((record) => record.file));
    } catch {
      // Tried again the next time this tab or another becomes the owner.
    }
  }

  /** Only the owner may open: the key goes to this tab's own worker, never over the channel. */
  private openHere(account: string): Promise<void> {
    const running = this.opening.get(account);
    if (running) return running;
    const run = (async () => {
      const client = this.started();
      const hadKey = Boolean(await getAccountRecord(account));
      const { keyHex, record } = await openAccountKey(account, this.hooks()?.keyLayers?.() ?? []);
      const inputs = this.hooks()?.inputs(account) ?? { session: null, auth: null, invertedKeywordSort: null };
      const { fileExisted } = await client.openAccount({
        account,
        file: record.file,
        keyHex,
        session: inputs.session ?? this.wanted.get(account) ?? null,
        scope: inputs.scope,
        invertedKeywordSort: inputs.invertedKeywordSort,
        auth: inputs.auth,
      });
      this.hooks()?.onOpened?.(account, { hadKey, fileExisted });
    })();
    this.opening.set(account, run);
    run.catch(() => this.opening.delete(account));
    return run;
  }

  async ensureOpen(account: string, session?: StoreSession | null): Promise<void> {
    this.wanted.set(account, session ?? this.wanted.get(account) ?? null);
    const client = this.started();
    if (client.ownsStore) await this.openHere(account);
    // Otherwise the owner opens it: calls below wait for that.
  }

  refresh(account: string): void {
    const client = this.client;
    if (!client?.ownsStore) return;
    const inputs = this.hooks()?.inputs(account);
    if (!inputs) return;
    if (inputs.session) client.setSession(account, inputs.session);
    client.setAuth(account, inputs.auth);
    if (inputs.scope) void client.setScope(account, inputs.scope).catch(() => {});
    if (inputs.invertedKeywordSort !== null) client.setInvertedKeywordSort(account, inputs.invertedKeywordSort);
  }

  /** A call for an account: the owner may still be opening it, in this tab or another. */
  private async whenOpen<T>(account: string, call: (client: StoreClient) => Promise<T>): Promise<T> {
    if (this.broken) throw new Error('The local store could not start');
    await this.ensureOpen(account);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await call(this.started());
      } catch (error) {
        if ((error as Error)?.name !== 'StoreAccountClosedError' || attempt >= OPEN_RETRIES) throw error;
        await new Promise((resolve) => setTimeout(resolve, OPEN_RETRY_MS));
      }
    }
  }

  answer(account: string, calls: MethodCall[]): Promise<JmapResponse | null> {
    return this.whenOpen(account, (client) => client.answer(account, calls));
  }

  area<T = unknown>(account: string, name: string, params?: unknown): Promise<T> {
    return this.whenOpen(account, (client) => client.area<T>(account, name, params));
  }

  setScope(account: string, scope: StoreScope): Promise<void> {
    return this.whenOpen(account, (client) => client.setScope(account, scope));
  }

  sync(account: string): Promise<void> {
    return this.whenOpen(account, (client) => client.sync(account));
  }

  noteStateChange(account: string, changed: Record<string, Record<string, string>>): Promise<void> {
    return this.whenOpen(account, (client) => client.noteStateChange(account, changed));
  }

  async setOnline(online: boolean): Promise<void> {
    if (!this.client || this.broken) return;
    await this.client.setOnline(online);
  }

  async remove(account: string): Promise<void> {
    const record = await getAccountRecord(account);
    await forgetAccountKey(account);
    this.wanted.delete(account);
    this.opening.delete(account);
    if (record && !this.broken) await this.started().removeAccount(account, record.file);
  }

  stop(): void {
    this.client?.halt();
    this.reset();
  }
}

let hooks: StorePageHooks | null = null;
let backend: StoreBackend | null = null;

/** Registers what the store needs from the app. */
export function configureStore(next: StorePageHooks | null): void {
  hooks = next;
}

export function getStore(): StoreBackend {
  backend ??= new PageStore(() => hooks);
  return backend;
}

/** Tests run the real engine in-process. */
export function setStoreBackend(next: StoreBackend | null): void {
  backend = next;
}
