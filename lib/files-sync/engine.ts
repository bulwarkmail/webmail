/**
 * Files on this computer: the engine for every root of the signed-in accounts. It keeps each
 * account's FileNode tree current (a listing once, then FileNode/changes on push and on a slow
 * poll), runs a RootSync per root when either side changed, and answers the drive's fetches.
 *
 * Main only does the disk (lib/desktop/types.ts FilesControls); everything that decides is here,
 * in the page, with the app's own JMAP session. The host (host.ts) starts it in the main window
 * and tells it which accounts are signed in.
 *
 * When a pass runs:
 * - main's `onChange` for a root: soon after, so a burst of writes is one pass. `paths: null` is
 *   what a new, resumed or re-armed watch says first. A root id nobody knows: ask for the roots.
 * - FileNode changes that touch a root: at once.
 * - offline: again after 5 s, then longer, up to 5 minutes, and at once when the host hears the
 *   network is back.
 * - every 10 minutes regardless, in case a change went unheard.
 */

import type { FilesControls, FilesFetchRequest, FilesRoot } from '@/lib/desktop/types';
import { isOffline, type FilesSyncErrorName } from './errors';
import type { DiskNaming } from './names';
import { RemoteTree, type FilesRemote } from './remote';
import { RootSync, type AccountLink, type ActivityInput } from './root-sync';
import type { FilesFlushOptions, FilesFlushOutcome, FilesSyncActivity, FilesSyncCoverage, FilesSyncItemStatus, FilesSyncRootStatus } from './types';

export const ACTIVITY_LIMIT = 200;
/** How long uploading what waits before a root stops may take at most. */
const FLUSH_LIMIT_MS = 10 * 60_000;
const PIECE = 1024 * 1024;
const MOST_SOON = 5;

export interface EngineTiming {
  /** After main says something changed on disk. */
  localDelayMs: number;
  /** After a push says Files changed. */
  remoteDelayMs: number;
  /** /changes without a push, per account. */
  pollMs: number;
  /** A full pass of every root regardless. */
  rescanMs: number;
  /** Waits while offline, one after another; the last repeats. */
  retryMs: number[];
  /** Again after a pass where something changed while it was read. */
  soonMs: number;
  /** How long a drive fetch waits for the first listing. */
  fetchWaitMs: number;
}

export const DEFAULT_TIMING: EngineTiming = {
  localDelayMs: 1500,
  remoteDelayMs: 300,
  pollMs: 60_000,
  rescanMs: 10 * 60_000,
  retryMs: [5_000, 15_000, 30_000, 60_000, 120_000, 300_000],
  soonMs: 3_000,
  fetchWaitMs: 20_000,
};

export interface EngineOptions {
  controls: FilesControls;
  naming: DiskNaming;
  device: string;
  readUrl?: (url: string) => Promise<Uint8Array>;
  now?: () => number;
  timing?: Partial<EngineTiming>;
  /** The organisation's word on a root: null when it may sync. */
  blocked?: (root: FilesRoot) => FilesSyncErrorName | null;
  /** May this account's files be downloaded to this computer? */
  downloadsAllowed?: (account: string) => boolean;
  /** Something the UI shows changed. */
  onUpdate?: () => void;
  /** A new line in the activity list. */
  onActivity?: (entry: FilesSyncActivity) => void;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`read failed: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

class Account implements AccountLink {
  readonly tree = new RemoteTree();
  private loaded = false;
  private running: Promise<void> | null = null;
  private again = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  private readyWaiters: (() => void)[] = [];

  constructor(
    readonly account: string,
    public remote: FilesRemote,
    private readonly changed: (account: Account, ids: Set<string>, origin: string | null) => void,
  ) {}

  get isLoaded(): boolean {
    return this.loaded;
  }

  startPolling(ms: number, run: () => void): void {
    this.stopPolling();
    this.poll = setInterval(run, ms);
    (this.poll as { unref?: () => void }).unref?.();
  }

  stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  /** Waits for the first listing, up to `ms`. */
  ready(ms: number): Promise<boolean> {
    if (this.loaded) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  refresh(origin: string | null = null): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.catchUp(origin);
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async catchUp(origin: string | null): Promise<void> {
    const ids = new Set<string>();
    if (!this.loaded || !this.tree.state) {
      await this.listAll(ids);
    } else {
      const written = [...this.tree.written];
      const heard = new Set<string>();
      const outcome = await this.remote.changes(this.tree.state, (batch, state) => {
        for (const node of batch.changed) {
          ids.add(node.id);
          heard.add(node.id);
        }
        for (const id of batch.destroyed) {
          ids.add(id);
          heard.add(id);
        }
        this.tree.apply(batch);
        this.tree.state = state;
      });
      // The server can't say what changed since then: read it all again. Only here.
      if (outcome.outcome === 'resync') {
        await this.listAll(ids);
      } else {
        for (const id of written) this.tree.written.delete(id);
        // Made here and deleted elsewhere since: /changes says neither.
        const unheard = written.filter((id) => !heard.has(id) && this.tree.get(id));
        if (unheard.length > 0) {
          const still = new Set((await this.remote.get(unheard)).map((node) => node.id));
          for (const id of unheard) {
            if (still.has(id)) continue;
            this.tree.remove(id);
            ids.add(id);
          }
        }
      }
    }
    if (ids.size > 0) this.changed(this, ids, origin);
  }

  private async listAll(ids: Set<string>): Promise<void> {
    const before = new Map(this.tree.nodes);
    const { nodes, state } = await this.remote.listAll();
    this.tree.reset(nodes, state);
    // Whatever changed while it was read.
    await this.remote.changes(state, (batch, next) => {
      this.tree.apply(batch);
      this.tree.state = next;
    }).then((outcome) => {
      if (outcome.outcome === 'resync') throw new Error('The FileNode state was refused right after a listing');
    });
    for (const [id, node] of this.tree.nodes) {
      const old = before.get(id);
      if (!old || old.parentId !== node.parentId || old.name !== node.name || old.blobId !== node.blobId) ids.add(id);
    }
    for (const id of before.keys()) if (!this.tree.nodes.has(id)) ids.add(id);
    const first = !this.loaded;
    this.loaded = true;
    if (first) for (const waiter of this.readyWaiters.splice(0)) waiter();
  }
}

class Runner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private due = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private retryAt = 0;
  private soon = 0;
  private stopped = false;

  constructor(readonly sync: RootSync, private readonly timing: EngineTiming) {}

  get busy(): boolean {
    return this.running !== null || (this.timer !== null && this.due - Date.now() <= Math.max(this.timing.localDelayMs, this.timing.soonMs));
  }

  get offline(): boolean {
    return this.sync.status.state === 'offline';
  }

  request(delay: number): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    const due = Date.now() + delay;
    if (this.timer) {
      if (this.due <= due) return;
      clearTimeout(this.timer);
    }
    this.due = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
  }

  private async run(): Promise<void> {
    if (this.stopped || this.running) return;
    const pass = this.sync.pass().catch((error: unknown) => {
      console.warn('[files-sync] A pass stopped:', error);
      return 'retry' as const;
    });
    this.running = pass.then(() => {});
    const outcome = await pass;
    this.running = null;
    if (this.stopped) return;
    if (this.again) {
      this.again = false;
      this.request(0);
      return;
    }
    if (outcome === 'retry') {
      const waits = this.timing.retryMs;
      this.request(waits[Math.min(this.retryAt, waits.length - 1)]);
      this.retryAt += 1;
      return;
    }
    this.retryAt = 0;
    if (outcome === 'soon' && this.soon < MOST_SOON) {
      this.soon += 1;
      this.request(this.timing.soonMs);
      return;
    }
    this.soon = 0;
  }

  /** Waits for what's running and whatever is due within the short delays. For tests and shutdown. */
  async settle(): Promise<void> {
    for (let i = 0; i < 1000; i += 1) {
      if (this.running) {
        await this.running;
        continue;
      }
      if (this.timer && this.due - Date.now() <= Math.max(this.timing.localDelayMs, this.timing.soonMs, this.timing.remoteDelayMs)) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, this.due - Date.now()) + 1));
        continue;
      }
      return;
    }
  }

  stop(): void {
    this.stopped = true;
    this.sync.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export class FilesSyncEngine {
  roots: FilesRoot[] = [];
  activity: FilesSyncActivity[] = [];
  private readonly accounts = new Map<string, Account>();
  private readonly runners = new Map<string, Runner>();
  private readonly timing: EngineTiming;
  private readonly fetches = new Map<string, { cancelled: boolean }>();
  private unsubscribe: (() => void)[] = [];
  private rescan: ReturnType<typeof setInterval> | null = null;
  private rootsRun: Promise<void> | null = null;
  private rootsAgain = false;
  private activitySeq = 0;
  private stopped = false;
  private readonly readUrl: (url: string) => Promise<Uint8Array>;
  private readonly now: () => number;

  constructor(private readonly options: EngineOptions) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.readUrl = options.readUrl ?? fetchBytes;
    this.now = options.now ?? Date.now;
  }

  get controls(): FilesControls {
    return this.options.controls;
  }

  start(): void {
    const { controls } = this.options;
    this.unsubscribe.push(controls.onChange((event) => {
      const runner = this.runners.get(event.rootId);
      if (!runner) {
        void this.refreshRoots();
        return;
      }
      runner.request(event.paths === null ? 0 : this.timing.localDelayMs);
    }));
    const drive = controls.drive;
    if (drive) {
      this.unsubscribe.push(drive.onFetch((request) => void this.fetch(request)));
      this.unsubscribe.push(drive.onFetchCancel((fetchId) => {
        const fetch = this.fetches.get(fetchId);
        if (fetch) fetch.cancelled = true;
      }));
    }
    this.rescan = setInterval(() => {
      for (const runner of this.runners.values()) runner.request(0);
    }, this.timing.rescanMs);
    (this.rescan as { unref?: () => void }).unref?.();
    void this.refreshRoots();
  }

  stop(): void {
    this.stopped = true;
    for (const stop of this.unsubscribe.splice(0)) stop();
    if (this.rescan) clearInterval(this.rescan);
    for (const runner of this.runners.values()) runner.stop();
    this.runners.clear();
    for (const account of this.accounts.values()) account.stopPolling();
    this.accounts.clear();
    for (const fetch of this.fetches.values()) fetch.cancelled = true;
  }

  // ─── Accounts ───────────────────────────────────────────────

  /** A signed-in account and its way to Files. Its roots start. */
  setAccount(account: string, remote: FilesRemote): void {
    if (this.stopped) return;
    const known = this.accounts.get(account);
    if (known) {
      known.remote = remote;
      return;
    }
    const entry = new Account(account, remote, (from, ids, origin) => this.remoteTouched(from, ids, origin));
    this.accounts.set(account, entry);
    entry.startPolling(this.timing.pollMs, () => void this.pollAccount(account));
    this.applyRoots();
  }

  /** Signed out, or gone: its roots stop. Nothing on disk changes. */
  dropAccount(account: string): void {
    const entry = this.accounts.get(account);
    if (!entry) return;
    entry.stopPolling();
    this.accounts.delete(account);
    for (const [id, runner] of this.runners) {
      if (runner.sync.root.account !== account) continue;
      runner.stop();
      this.runners.delete(id);
    }
    this.update();
  }

  /** What the account's files take, from its FileNode tree. Null before the first listing. */
  filesBytes(account: string): number | null {
    const entry = this.accounts.get(account);
    if (!entry?.isLoaded) return null;
    let total = 0;
    for (const node of entry.tree.nodes.values()) if (node.kind === 'file') total += node.size;
    return total;
  }

  hasAccount(account: string): boolean {
    return this.accounts.has(account);
  }

  /** A push said FileNode changed in this account. */
  remoteChanged(account: string): void {
    void this.pollAccount(account);
  }

  private async pollAccount(account: string): Promise<void> {
    const entry = this.accounts.get(account);
    if (!entry?.isLoaded) {
      // Nothing listed yet: a root's pass lists it.
      for (const runner of this.runnersOf(account)) runner.request(this.timing.remoteDelayMs);
      return;
    }
    try {
      await entry.refresh();
    } catch (error) {
      if (!isOffline(error)) console.warn('[files-sync] Reading changes failed:', error);
    }
  }

  /** The network is back: whatever waits goes now. */
  retryNow(): void {
    for (const runner of this.runners.values()) if (runner.offline) runner.request(0);
  }

  private runnersOf(account: string): Runner[] {
    return [...this.runners.values()].filter((runner) => runner.sync.root.account === account);
  }

  private remoteTouched(account: Account, ids: Set<string>, origin: string | null): void {
    for (const runner of this.runnersOf(account.account)) {
      if (runner.sync.root.id === origin) continue;
      const remoteId = runner.sync.root.remoteId;
      const touched = [...ids].some((id) => !!runner.sync.item(id) || account.tree.isUnder(id, remoteId) || id === remoteId);
      if (touched) runner.request(this.timing.remoteDelayMs);
    }
  }

  // ─── Roots ──────────────────────────────────────────────────

  /** Asks main for the roots again and starts, changes or stops runners to match. */
  refreshRoots(): Promise<void> {
    if (this.rootsRun) {
      this.rootsAgain = true;
      return this.rootsRun;
    }
    this.rootsRun = (async () => {
      try {
        do {
          this.rootsAgain = false;
          try {
            this.roots = await this.options.controls.roots();
          } catch {
            this.roots = [];
          }
          this.applyRoots();
        } while (this.rootsAgain && !this.stopped);
      } finally {
        this.rootsRun = null;
      }
    })();
    return this.rootsRun;
  }

  private applyRoots(): void {
    if (this.stopped) return;
    const live = new Map(this.roots.map((root) => [root.id, root]));
    for (const [id, runner] of this.runners) {
      const root = live.get(id);
      if (!root || !this.accounts.has(root.account)) {
        runner.stop();
        this.runners.delete(id);
        continue;
      }
      const wasPaused = runner.sync.root.paused;
      runner.sync.setRoot(root);
      if (wasPaused && !root.paused) runner.request(0);
    }
    for (const root of this.roots) {
      if (this.runners.has(root.id)) continue;
      const account = this.accounts.get(root.account);
      if (!account) continue;
      const sync = new RootSync(root, {
        account: account.account,
        tree: account.tree,
        get remote() {
          return account.remote;
        },
        refresh: () => account.refresh(root.id),
      }, {
        controls: this.options.controls,
        naming: this.options.naming,
        device: this.options.device,
        now: this.now,
        readUrl: this.readUrl,
        activity: (entry) => this.addActivity(entry),
        changed: () => this.update(),
        blocked: (current) => this.options.blocked?.(current) ?? null,
      });
      const runner = new Runner(sync, this.timing);
      this.runners.set(root.id, runner);
      runner.request(0);
    }
    this.update();
  }

  root(rootId: string): RootSync | null {
    return this.runners.get(rootId)?.sync ?? null;
  }

  /** Runs a pass of a root (all of them without an id) now. */
  syncNow(rootId?: string): void {
    for (const [id, runner] of this.runners) if (!rootId || id === rootId) runner.request(0);
  }

  /** Waits until nothing runs or is due shortly. For tests and the sign-out. */
  async settled(): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      if (this.rootsRun) await this.rootsRun;
      await Promise.all([...this.runners.values()].map((runner) => runner.settle()));
      if (!this.rootsRun && [...this.runners.values()].every((runner) => !runner.busy)) return;
    }
  }

  async setPaused(rootId: string, paused: boolean): Promise<void> {
    await this.options.controls.setPaused(rootId, paused);
    await this.refreshRoots();
  }

  async removeRoot(rootId: string): Promise<void> {
    await this.options.controls.removeRoot(rootId);
    await this.refreshRoots();
  }

  confirmMassDelete(rootId: string, allow: boolean): void {
    const runner = this.runners.get(rootId);
    if (!runner) return;
    runner.sync.answerMassDelete(allow);
    runner.request(0);
  }

  /** What a root would leave behind if it stopped now. Null: the root isn't running (locked, gone). */
  async pendingHere(rootId: string): Promise<string[] | null> {
    const runner = this.runners.get(rootId);
    if (!runner) return null;
    return runner.sync.pendingHere().catch(() => null);
  }

  /**
   * Before a drive goes or a folder stops: passes until nothing waits here, or a pass gets no
   * further (offline, too large, refused, paused, a question open), or the user stops waiting.
   */
  async flushRoot(rootId: string, options: FilesFlushOptions = {}): Promise<FilesFlushOutcome> {
    const runner = this.runners.get(rootId);
    if (!runner) return 'gone';
    let waiting = await this.pendingHere(rootId);
    if (waiting === null) return 'gone';
    const total = waiting.length;
    options.onProgress?.(waiting, total);
    if (total === 0) return 'done';
    const until = this.now() + (options.timeoutMs ?? FLUSH_LIMIT_MS);
    for (;;) {
      if (options.signal?.aborted || this.stopped) return 'cancelled';
      runner.request(0);
      await runner.settle();
      if (options.signal?.aborted) return 'cancelled';
      if (this.runners.get(rootId) !== runner) return 'gone';
      const next = await this.pendingHere(rootId);
      if (next === null) return 'gone';
      options.onProgress?.(next, total);
      if (next.length === 0) return 'done';
      const state = runner.sync.status.state;
      if (state === 'offline') return 'offline';
      if (state !== 'idle' && state !== 'syncing' && state !== 'starting') return 'stuck';
      // A whole pass and nothing went: it won't.
      if (next.length >= waiting.length || this.now() > until) return 'stuck';
      waiting = next;
    }
  }

  /** The drive's record goes before its folder does (sign-out): the next sign-in starts from an empty folder. */
  async forgetRoot(rootId: string): Promise<void> {
    const runner = this.runners.get(rootId);
    if (!runner) return;
    runner.stop();
    await runner.sync.forget();
    this.runners.delete(rootId);
  }

  // ─── What the UI reads ──────────────────────────────────────

  status(): Record<string, FilesSyncRootStatus> {
    const out: Record<string, FilesSyncRootStatus> = {};
    for (const [id, runner] of this.runners) out[id] = runner.sync.status;
    return out;
  }

  items(account: string): Record<string, FilesSyncItemStatus> {
    const out: Record<string, FilesSyncItemStatus> = {};
    for (const runner of this.runnersOf(account)) Object.assign(out, runner.sync.items);
    return out;
  }

  coverage(account: string, nodeId: string): FilesSyncCoverage | null {
    for (const runner of this.runnersOf(account)) {
      const { root } = runner.sync;
      if (root.remoteId === nodeId) return { rootId: root.id, kind: root.kind, path: '' };
      const item = runner.sync.item(nodeId);
      if (item) return { rootId: root.id, kind: root.kind, path: item.path };
    }
    return null;
  }

  clearActivity(): void {
    this.activity = [];
    this.update();
  }

  private addActivity(entry: ActivityInput): void {
    this.activitySeq += 1;
    const line: FilesSyncActivity = { id: `${this.now()}-${this.activitySeq}`, at: this.now(), ...entry };
    this.activity = [line, ...this.activity].slice(0, ACTIVITY_LIMIT);
    this.update();
    try {
      this.options.onActivity?.(line);
    } catch {
      // Telling about it is extra.
    }
  }

  private update(): void {
    this.options.onUpdate?.();
  }

  // ─── The drive's fetches ────────────────────────────────────

  /**
   * Someone opened a file on the drive that isn't on the disk: stream its content to main, from
   * where Windows asked (rounded down to 4 KB) to the end, in order. Main fails a fetch it hears
   * nothing of for 30 s, and Windows cancels after 60 s.
   */
  async fetch(request: FilesFetchRequest): Promise<void> {
    const drive = this.options.controls.drive;
    if (!drive) return;
    const handle = { cancelled: false };
    this.fetches.set(request.fetchId, handle);
    try {
      let runner = this.runners.get(request.rootId);
      if (!runner) {
        await this.refreshRoots();
        runner = this.runners.get(request.rootId);
      }
      if (!runner || runner.sync.root.kind !== 'drive') {
        drive.fail(request.fetchId, this.accountsKnown(request.rootId) ? 'failed' : 'offline');
        return;
      }
      const { root } = runner.sync;
      if (this.options.downloadsAllowed && !this.options.downloadsAllowed(root.account)) {
        drive.fail(request.fetchId, 'failed');
        return;
      }
      const account = this.accounts.get(root.account);
      if (!account || !(await account.ready(this.timing.fetchWaitMs))) {
        drive.fail(request.fetchId, 'offline');
        return;
      }
      // The newest version, not one deleted or replaced since the last push. Offline: what's known.
      await account.refresh().catch(() => {});
      const node = account.tree.get(request.identity);
      if (!node || node.kind !== 'file' || account.tree.inTrash(node.id)) {
        drive.fail(request.fetchId, 'missing');
        runner.request(this.timing.remoteDelayMs);
        return;
      }
      if (node.size !== request.total) {
        // The placeholder is older than the file: the pass puts the new one there.
        drive.fail(request.fetchId, 'failed');
        runner.request(0);
        return;
      }
      await this.stream(request, node, account, handle);
    } catch (error) {
      if (!handle.cancelled) drive.fail(request.fetchId, isOffline(error) ? 'offline' : 'failed');
    } finally {
      this.fetches.delete(request.fetchId);
    }
  }

  private accountsKnown(rootId: string): boolean {
    const root = this.roots.find((entry) => entry.id === rootId);
    return !!root && this.accounts.has(root.account);
  }

  private async stream(request: FilesFetchRequest, node: { blobId: string | null; type: string; name: string; size: number }, account: Account, handle: { cancelled: boolean }): Promise<void> {
    const drive = this.options.controls.drive;
    if (!drive) return;
    const start = Math.max(0, request.offset);
    let at = 0;
    let sent = start;
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let chain: Promise<boolean> = Promise.resolve(true);
    let refused = false;
    const STOP = 'files-sync:fetch-stopped';
    const flush = (all: boolean) => {
      if (pendingBytes === 0 || (!all && pendingBytes < PIECE)) return;
      const piece = joinParts(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      const offset = sent;
      sent += piece.length;
      chain = chain.then(async (good) => {
        if (!good || handle.cancelled) return false;
        const taken = await drive.supply(request.fetchId, offset, piece);
        if (!taken) refused = true;
        return taken;
      });
    };
    try {
      await account.remote.download(node, (part) => {
        if (handle.cancelled || refused) throw new Error(STOP);
        let slice = part;
        if (at + part.length <= start) {
          at += part.length;
          return;
        }
        if (at < start) slice = part.subarray(start - at);
        at += part.length;
        pending.push(slice);
        pendingBytes += slice.length;
        flush(false);
      });
    } catch (error) {
      if ((error as Error)?.message === STOP) return;
      throw error;
    }
    flush(true);
    await chain;
  }
}

function joinParts(parts: Uint8Array[], size: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
