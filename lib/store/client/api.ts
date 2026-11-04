/**
 * The page's way to the local store: one StoreClient per tab, accounts opened
 * while this tab is the owner, sessions and auth handed over. Knows nothing of
 * the app's stores: lib/offline/offline-mode.ts wires those in with
 * configureStore, so the worker bundle stays free of them.
 */

import type { StoreEvent, StoreScope } from '../area';
import type { JmapResponse, MethodCall, StoreSession } from '../engine/transport';
import { clearLeftover, forgetAccountKey, getAccountRecord, knownStoreFiles, listAccountRecords, newStoreKey, openAccountKey, replaceAccountKey, STORE_OPENED_KEY, type StoreKeyLayerMissingError, type WrapLayer } from './keys';
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
  /** Wrap layers on top of the WebCrypto one (desktop keychain, app lock). */
  keyLayers?(): readonly WrapLayer[] | Promise<readonly WrapLayer[]>;
  /** The OS's key store is there and wouldn't take this key: it isn't protected as it should be. */
  onKeyWrapFailed?(account: string): void;
  /** A re-encryption didn't finish. The old key and file stay. It's tried again at the next start. */
  onRekeyFailed?(account: string): void;
  /**
   * This tab just took over the store. Resolves when it has heard the
   * organisation's policy since: until then it sends no scope, which may be old.
   */
  ownerTaken?(): Promise<void>;
  /** An account this device kept mail for has an empty store now: its key or its file went. */
  onStoreLost?(account: string): void;
  /** This tab became the owner and has no lock key: the app lock has to ask again. */
  onKeyLocked?(): void;
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
  /**
   * App lock: closes the databases and stops this tab's worker, with every key it had.
   * Waits for a clean close at most `closeMs`. Until `unlock`, every call is refused.
   */
  lock?(closeMs: number): Promise<void>;
  /** This tab has the key again: its worker starts first, and takes the store. */
  unlock?(ownerWaitMs: number): Promise<void>;
  ownsStoreHere?(): boolean;
  /** Starts the re-encryption of what's open here and asks for it. */
  rekeyPending?(): Promise<void>;
}

/** The app is locked: the store is closed, and its key isn't in memory anywhere. */
export class StoreLockedError extends Error {
  constructor() {
    super('The local store is closed while the app is locked');
    this.name = 'StoreLockedError';
  }
}

/** How long a call waits for the owner to have opened an account. */
const OPEN_RETRIES = 25;
const OPEN_RETRY_MS = 200;

export { STORE_OPENED_KEY };

function readOpenedAccounts(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_OPENED_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed as string[] : [];
  } catch {
    return [];
  }
}

function rememberOpened(account: string, opened: boolean): void {
  try {
    const others = readOpenedAccounts().filter((id) => id !== account);
    localStorage.setItem(STORE_OPENED_KEY, JSON.stringify(opened ? [...others, account] : others));
  } catch {
    // Without it a lost store goes unnoticed, and the store still works.
  }
}

class PageStore implements StoreBackend {
  private client: StoreClient | null = null;
  private readonly wanted = new Map<string, StoreSession | null>();
  private readonly opening = new Map<string, Promise<void>>();
  /** The engine can't start in this browser: don't keep every caller waiting for an owner. */
  private broken = false;
  /**
   * Accounts whose key was just made, until their store has opened. A new owner
   * can start the open again, and the second try finds the key the first one made.
   */
  private readonly keyJustMade = new Set<string>();
  private locked = false;
  private ownerReady: (() => void) | null = null;
  /** False from taking over the store until this tab has heard the policy again. */
  private scopeCurrent = true;
  /** One at a time: each may double what's on disk for a while. */
  private rekeyTurn: Promise<unknown> = Promise.resolve();
  private readonly rekeyDone = new Set<string>();
  /** Tried again at the next start, not in a loop. */
  private readonly rekeyFailed = new Set<string>();

  constructor(private readonly hooks: () => StorePageHooks | null) {}

  supported(): boolean {
    return StoreClient.supported();
  }

  private started(): StoreClient {
    if (this.locked) throw new StoreLockedError();
    if (this.client) return this.client;
    this.broken = false;
    const client = new StoreClient({
      basePath: (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, ''),
      buildId: process.env.NEXT_PUBLIC_BUILD_ID,
      onEvent: (event) => {
        if (event.type === 'error' && event.area === 'store' && !event.account) this.broken = true;
        // Another tab cleared it: what this tab remembers opening is gone.
        if (event.type === 'removed') this.opening.delete(event.account);
        this.hooks()?.onEvent(event);
      },
      onOwner: () => {
        this.ownerReady?.();
        this.opening.clear();
        const hooks = this.hooks();
        if (hooks?.ownerTaken) {
          this.scopeCurrent = false;
          const heard = () => {
            this.scopeCurrent = true;
            for (const account of this.wanted.keys()) this.refresh(account);
          };
          void hooks.ownerTaken().then(heard, heard);
        }
        for (const account of this.wanted.keys()) void this.openHere(account).catch(() => {});
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
    this.scopeCurrent = true;
    this.wanted.clear();
    this.opening.clear();
    this.broken = false;
  }

  private async readKey(account: string): ReturnType<typeof openAccountKey> {
    try {
      const opened = await openAccountKey(account, await this.hooks()?.keyLayers?.() ?? []);
      if (opened.wrapFailed) this.hooks()?.onKeyWrapFailed?.(account);
      return opened;
    } catch (error) {
      if ((error as Error)?.name === 'StoreKeyLayerMissingError' && (error as StoreKeyLayerMissingError).layer === 'applock') this.hooks()?.onKeyLocked?.();
      else if ((error as Error)?.name === 'StoreKeyLayerMissingError') this.hooks()?.onKeyWrapFailed?.(account);
      throw error;
    }
  }

  /** Only the owner may open: the key goes to this tab's own worker, never over the channel. */
  private openHere(account: string): Promise<void> {
    const running = this.opening.get(account);
    if (running) return running;
    const run = (async () => {
      const client = this.started();
      const { keyHex, record, fresh } = await this.readKey(account);
      if (fresh) this.keyJustMade.add(account);
      // The old file, if the key alone went, can never be read again.
      if (this.keyJustMade.has(account)) await client.pruneFiles(await knownStoreFiles()).catch(() => {});
      // A re-encryption stopped right before it deleted the old file.
      if (record.leftover) await this.deleteLeftover(client, account);
      const inputs = this.hooks()?.inputs(account) ?? { session: null, auth: null, invertedKeywordSort: null };
      const opened = await client.openAccount({
        account,
        file: record.file,
        keyHex,
        session: inputs.session ?? this.wanted.get(account) ?? null,
        scope: this.scopeCurrent ? inputs.scope : undefined,
        invertedKeywordSort: inputs.invertedKeywordSort,
        auth: inputs.auth,
      });
      // Whichever try of them gets here first says so.
      if (this.keyJustMade.delete(account) || opened?.created) {
        if (readOpenedAccounts().includes(account)) this.hooks()?.onStoreLost?.(account);
      }
      rememberOpened(account, true);
      if (record.rekey) void this.rekey(account);
    })();
    this.opening.set(account, run);
    run.catch(() => this.opening.delete(account));
    return run;
  }

  private async deleteLeftover(client: StoreClient, account: string): Promise<void> {
    await client.pruneFiles(await knownStoreFiles());
    await clearLeftover(account);
  }

  /**
   * A new key and a new file for an account whose record asks for it: an older copy of that record,
   * with fewer layers, may still be in the browser's files, and only a new key makes it worthless.
   * The worker copies while the store goes on working, the record changes in one write, then the old
   * file goes. Wherever this stops, one whole file has a record, and the other goes at the next open.
   */
  private rekey(account: string): Promise<void> {
    if (this.rekeyDone.has(account) || this.rekeyFailed.has(account)) return Promise.resolve();
    this.rekeyDone.add(account);
    const turn = this.rekeyTurn.then(() => this.rekeyNow(account)).finally(() => this.rekeyDone.delete(account));
    this.rekeyTurn = turn.catch(() => {});
    return turn;
  }

  private async rekeyNow(account: string): Promise<void> {
    const client = this.client;
    const before = await getAccountRecord(account);
    if (!client?.ownsStore || this.locked || !before?.rekey) return;
    const { keyHex, file } = newStoreKey();
    let copied = false;
    try {
      await client.pruneFiles(await knownStoreFiles());
      await client.rekeyAccount(account, file, keyHex);
      copied = true;
      await replaceAccountKey(account, keyHex, file, await this.hooks()?.keyLayers?.() ?? []);
      await this.deleteLeftover(client, account);
    } catch (error) {
      // A lock stopped it: the next unlock goes on from the start.
      if (!this.locked && this.client === client && (error as Error)?.name !== 'StoreRekeyStoppedError') {
        this.rekeyFailed.add(account);
        this.hooks()?.onRekeyFailed?.(account);
        if (copied) void client.pruneFiles(await knownStoreFiles()).catch(() => {});
      }
    }
    if (this.locked || this.client !== client) return;
    this.opening.delete(account);
    if (this.wanted.has(account)) await this.openHere(account).catch(() => {});
  }

  async rekeyPending(): Promise<void> {
    if (!this.client?.ownsStore || this.locked) return;
    const records = await listAccountRecords().catch(() => []);
    await Promise.all(records.filter((record) => record.rekey && this.wanted.has(record.account)).map((record) => this.rekey(record.account)));
  }

  async lock(closeMs: number): Promise<void> {
    this.locked = true;
    const client = this.client;
    this.client = null;
    this.opening.clear();
    this.keyJustMade.clear();
    if (!client) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      client.release().catch(() => {}),
      new Promise((resolve) => { timer = setTimeout(resolve, closeMs); }),
    ]);
    clearTimeout(timer);
    // Past the wait a sync may still be running. Stopping the worker ends it, as a crash would.
    client.halt();
  }

  async unlock(ownerWaitMs: number): Promise<void> {
    this.locked = false;
    if (this.client?.ownsStore || !StoreClient.supported()) return;
    if ((await listAccountRecords().catch(() => [])).length === 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ownerWaitMs);
      this.ownerReady = () => {
        clearTimeout(timer);
        this.ownerReady = null;
        resolve();
      };
      this.started();
    });
  }

  ownsStoreHere(): boolean {
    return this.client?.ownsStore ?? false;
  }

  async ensureOpen(account: string, session?: StoreSession | null): Promise<void> {
    if (this.locked) throw new StoreLockedError();
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
    // The engine drops one that's no change.
    if (inputs.scope && this.scopeCurrent) void client.setScope(account, inputs.scope).catch(() => {});
    if (inputs.invertedKeywordSort !== null) client.setInvertedKeywordSort(account, inputs.invertedKeywordSort);
  }

  /** A call for an account: the owner may still be opening it, in this tab or another. */
  private async whenOpen<T>(account: string, call: (client: StoreClient) => Promise<T>): Promise<T> {
    if (this.locked) throw new StoreLockedError();
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
    if (this.locked || !this.client || this.broken) return;
    await this.client.setOnline(online);
  }

  async remove(account: string): Promise<void> {
    const record = await getAccountRecord(account);
    await forgetAccountKey(account);
    rememberOpened(account, false);
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
