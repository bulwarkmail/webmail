/**
 * What runs in the owner tab's worker: one database and engine per account.
 * The list of areas is the only thing that decides what the store answers.
 */

import type { StoreArea, StoreEvent } from '../area';
import { AccountEngine } from '../engine/account-engine';
import { FetchTransport, type StoreSession } from '../engine/transport';
import type { StorageAdapter } from '../storage';
import type { OpenAccountParams, StoreRpc, StoreStatus } from './protocol';

export interface HostStorage {
  open(file: string, keyHex: string): Promise<StorageAdapter>;
  remove(file: string): boolean;
}

interface OpenAccount {
  engine: AccountEngine;
  db: StorageAdapter;
  file: string;
  auth: string | null;
  pendingAuth: Array<(header: string | null) => void>;
  session: StoreSession;
}

export interface StoreHostOptions {
  areas: readonly StoreArea[];
  storage: HostStorage;
  emit(event: StoreEvent): void;
  needAuth(account: string): void;
}

/** The owner hasn't opened this account yet. The caller may try again shortly. */
function accountClosed(): Error {
  const error = new Error('The local store is not open for this account');
  error.name = 'StoreAccountClosedError';
  return error;
}

export class StoreHost {
  private readonly accounts = new Map<string, OpenAccount>();
  private online = true;
  private readonly synced = new Map<string, number>();

  constructor(private readonly options: StoreHostOptions) {}

  async openAccount(params: OpenAccountParams): Promise<void> {
    const existing = this.accounts.get(params.account);
    if (existing) {
      if (params.session) this.setSession(params.account, params.session);
      this.setAuth(params.account, params.auth);
      existing.engine.setScope(params.scope);
      if (params.invertedKeywordSort !== null) existing.engine.setInvertedKeywordSort(params.invertedKeywordSort);
      void existing.engine.requestSync();
      return;
    }
    const db = await this.options.storage.open(params.file, params.keyHex);
    const session = params.session ?? AccountEngine.storedSession(db);
    if (!session) {
      db.close();
      throw new Error('No session for this account yet');
    }
    const account: OpenAccount = { db, file: params.file, auth: params.auth, pendingAuth: [], session, engine: undefined as unknown as AccountEngine };
    const transport = new FetchTransport({
      session: () => account.session,
      auth: () => account.auth,
      refreshAuth: () => new Promise((resolve) => {
        account.pendingAuth.push(resolve);
        this.options.needAuth(params.account);
      }),
    });
    account.engine = new AccountEngine({
      account: params.account,
      db,
      session,
      transport,
      areas: this.options.areas,
      scope: params.scope,
      invertedKeywordSort: params.invertedKeywordSort ?? undefined,
      emit: (event) => {
        if (event.type === 'synced') this.synced.set(event.account, event.at);
        this.options.emit(event);
      },
    });
    account.engine.setOnline(this.online);
    this.accounts.set(params.account, account);
    void account.engine.requestSync();
  }

  setAuth(account: string, auth: string | null): void {
    const open = this.accounts.get(account);
    if (!open) return;
    open.auth = auth;
    for (const resolve of open.pendingAuth.splice(0)) resolve(auth);
  }

  setSession(account: string, session: StoreSession): void {
    const open = this.accounts.get(account);
    if (!open) return;
    open.session = session;
    open.engine.setSession(session);
  }

  setScope(account: string, scope: Parameters<AccountEngine['setScope']>[0]): void {
    const open = this.accounts.get(account);
    if (!open) return;
    open.engine.setScope(scope);
    void open.engine.requestSync();
  }

  setInvertedKeywordSort(account: string, inverted: boolean): void {
    this.accounts.get(account)?.engine.setInvertedKeywordSort(inverted);
  }

  async closeAccount(account: string): Promise<void> {
    const open = this.accounts.get(account);
    if (!open) return;
    this.accounts.delete(account);
    await open.engine.close();
    for (const resolve of open.pendingAuth.splice(0)) resolve(null);
    open.db.close();
  }

  async removeAccount(account: string, file: string): Promise<boolean> {
    await this.closeAccount(account);
    this.synced.delete(account);
    return this.options.storage.remove(file);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.accounts.keys()].map((account) => this.closeAccount(account)));
  }

  /** The calls other tabs can make. */
  async call(method: keyof StoreRpc, params: unknown): Promise<unknown> {
    switch (method) {
      case 'answer': {
        const { account, calls } = params as Parameters<StoreRpc['answer']>[0];
        const open = this.accounts.get(account);
        if (!open) throw accountClosed();
        return open.engine.answer(calls);
      }
      case 'sync': {
        const { account } = params as Parameters<StoreRpc['sync']>[0];
        await this.accounts.get(account)?.engine.requestSync();
        return undefined;
      }
      case 'noteStateChange': {
        const { account, changed } = params as Parameters<StoreRpc['noteStateChange']>[0];
        this.accounts.get(account)?.engine.noteStateChange(changed);
        return undefined;
      }
      case 'setOnline': {
        const { online } = params as Parameters<StoreRpc['setOnline']>[0];
        this.online = online;
        for (const open of this.accounts.values()) open.engine.setOnline(online);
        return undefined;
      }
      case 'status': {
        const { account } = params as Parameters<StoreRpc['status']>[0];
        return this.status(account);
      }
      case 'area': {
        const { account, name, params: callParams } = params as Parameters<StoreRpc['area']>[0];
        const open = this.accounts.get(account);
        if (!open) throw accountClosed();
        return open.engine.areaCall(name, callParams);
      }
      case 'removeAccount': {
        const { account, file } = params as Parameters<StoreRpc['removeAccount']>[0];
        return this.removeAccount(account, file);
      }
      default:
        throw new Error(`Unknown store call ${String(method)}`);
    }
  }

  private status(account: string): StoreStatus | null {
    const open = this.accounts.get(account);
    if (!open) return null;
    return {
      account,
      open: true,
      emails: Number(open.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM email')?.n ?? 0),
      bodies: Number(open.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM email_body')?.n ?? 0),
      lastSyncedAt: this.synced.get(account) ?? null,
    };
  }
}
