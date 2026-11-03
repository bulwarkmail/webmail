/**
 * The local store for tests of lib/offline: the real engine on node:sqlite in
 * the same process, behind the seam the page uses. Fetches nothing unless a
 * test hands it a transport.
 */

import { DEFAULT_SCOPE, type StoreScope } from '../../area';
import { STORE_AREAS } from '../../areas';
import type { StoreBackend } from '../../client/api';
import { AccountEngine } from '../../engine/account-engine';
import type { JmapTransport, MethodCall, StoreSession } from '../../engine/transport';
import type { StorageAdapter } from '../../storage';
import { FAKE_SESSION } from './fake-jmap';
import { openMemoryStore } from './node-adapter';

const NO_SERVER: JmapTransport = {
  request: async () => { throw new Error('This test has no server for the store'); },
  download: async () => new Uint8Array(),
  upload: async () => ({ blobId: 'x', type: '', size: 0 }),
};

export class InProcessStore implements StoreBackend {
  readonly engines = new Map<string, AccountEngine>();
  readonly dbs = new Map<string, StorageAdapter>();
  /** What a test wants a failing store to do. */
  failArea: ((name: string) => boolean) | null = null;
  removed: string[] = [];
  stopped = 0;
  isSupported = true;

  constructor(private readonly transport: JmapTransport = NO_SERVER, private readonly session: StoreSession = FAKE_SESSION) {}

  supported(): boolean {
    return this.isSupported;
  }

  engine(account: string, session?: StoreSession | null): AccountEngine {
    let engine = this.engines.get(account);
    if (!engine) {
      const db = openMemoryStore();
      this.dbs.set(account, db);
      engine = new AccountEngine({
        account,
        db,
        session: session ?? this.session,
        transport: this.transport,
        areas: STORE_AREAS,
        scope: { ...DEFAULT_SCOPE, days: null },
        sleep: async () => {},
      });
      this.engines.set(account, engine);
    }
    return engine;
  }

  has(account: string): boolean {
    return this.engines.has(account);
  }

  async ensureOpen(account: string, session?: StoreSession | null): Promise<void> {
    this.engine(account, session);
  }

  refresh(): void {}

  async answer(account: string, calls: MethodCall[]) {
    const answer = await this.engine(account).answer(calls);
    // Across the worker boundary answers are copies.
    return answer ? structuredClone(answer) : null;
  }

  async area<T = unknown>(account: string, name: string, params?: unknown): Promise<T> {
    if (this.failArea?.(name)) throw new Error(`${name} failed`);
    const result = await this.engine(account).areaCall(name, structuredClone(params));
    return (result === undefined ? undefined : structuredClone(result)) as T;
  }

  async setScope(account: string, scope: StoreScope): Promise<void> {
    const engine = this.engine(account);
    if (engine.setScope(scope)) await engine.requestSync();
  }

  async sync(account: string): Promise<void> {
    await this.engine(account).requestSync();
  }

  async noteStateChange(account: string, changed: Record<string, Record<string, string>>): Promise<void> {
    this.engine(account).noteStateChange(changed);
  }

  async setOnline(online: boolean): Promise<void> {
    for (const engine of this.engines.values()) engine.setOnline(online);
  }

  async remove(account: string): Promise<void> {
    this.removed.push(account);
    await this.engines.get(account)?.close();
    this.dbs.get(account)?.close();
    this.engines.delete(account);
    this.dbs.delete(account);
  }

  stop(): void {
    this.stopped += 1;
    for (const engine of this.engines.values()) void engine.close();
    this.engines.clear();
    this.dbs.clear();
  }
}
