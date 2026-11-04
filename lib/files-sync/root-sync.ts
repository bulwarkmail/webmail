/**
 * One root of Files on this computer: a folder the user paired with a Files folder, or the
 * Windows drive (the whole account). Each pass is a three-way comparison of what both sides
 * were at the last sync (state.ts) with the disk now (main's scan) and Files now (the account's
 * tree, remote.ts), and carries out what that calls for. Nothing is decided from one side alone:
 * an item missing on one side was deleted there only if the record says it was synced before.
 *
 * A pass goes in rounds. Each round scans the disk again and does what it can: moves, changed
 * content, new items, then deletes. What has to wait for something else of the same pass (a
 * file moved into a folder that's new on the other side) is done in the next round. A pass
 * ends when a round has nothing left to do.
 *
 * Rules (FILES-SYNC-BRIEF.md):
 * - Renames and moves are found by identity, never by name: the FileNode id in Files, the
 *   file id (or the placeholder's identity on the drive) on disk. A path that's still there
 *   counts first, so an editor that saves by writing a new file and renaming it over the old
 *   one is an edit, not a delete and a create.
 * - Both sides changed a file: neither is lost. The copy on this computer is kept as
 *   "name (conflict, <device>, <date>).ext" next to the other and uploaded, and Files' version
 *   takes the name. Both changed where it is: Files' place wins.
 * - Deleted on one side, changed on the other: the change wins and comes back. A folder is
 *   only deleted when nothing in it is new or changed on the other side.
 * - Deleted on this computer goes to Files' trash (lib/files-trash.ts); deleted in Files goes
 *   to the computer's trash where main has one.
 * - Many deletes at once (more than 50 items, or more than half of a root of 10 or more)
 *   stop the root and ask. No: what was deleted comes back from the other side.
 * - A file over the server's upload limit stays on this computer, said once, and isn't tried
 *   again until it changes.
 * - The server out of reach: nothing is lost, the record isn't moved on, and the pass runs
 *   again later. That is the offline queue.
 */

import type {
  FilesControls,
  FilesError,
  FilesExpect,
  FilesLocalEntry,
  FilesPlaceholder,
  FilesResult,
  FilesRoot,
} from '@/lib/desktop/types';
import { errorKey, isAuthRefused, isOffline, LocalError, localErrorName, remoteErrorName, type FilesSyncErrorName } from './errors';
import {
  baseName,
  conflictName,
  depthOf,
  diskName,
  freeLocalName,
  isSystemFileName,
  isUnderPath,
  joinPath,
  nameKey,
  parentPath,
  pathKey,
  type DiskNaming,
} from './names';
import type { FilesRemote, RemoteNode, RemoteTree } from './remote';
import { emptyRecord, parseRecord, serializeRecord, type BaseItem, type RootRecord } from './state';
import type { FilesSyncActivityKind, FilesSyncItemStatus, FilesSyncRootState, FilesSyncRootStatus, MassDeleteOrigin } from './types';

const MAX_ROUNDS = 12;
/** Both sides have a file of this size or less under one name: compare the bytes before calling it a conflict. */
const COMPARE_LIMIT = 64 * 1024 * 1024;
const PIECE = 1024 * 1024;
const PLACE_BATCH = 1000;
export const MASS_DELETE_COUNT = 50;
export const MASS_DELETE_MIN_ROOT = 10;

export interface ActivityInput {
  rootId: string;
  kind: FilesSyncActivityKind;
  direction: 'up' | 'down' | null;
  path: string;
  detail?: string;
  messageKey?: string;
}

/** The account a root belongs to, as the engine keeps it. */
export interface AccountLink {
  account: string;
  remote: FilesRemote;
  tree: RemoteTree;
  /** Brings the tree up to date with the server (FileNode/changes, or a full listing). */
  refresh(): Promise<void>;
}

export interface RootHost {
  controls: FilesControls;
  naming: DiskNaming;
  /** This computer's name, for conflict copies. */
  device: string;
  now(): number;
  readUrl(url: string): Promise<Uint8Array>;
  activity(entry: ActivityInput): void;
  /** Status or items changed. */
  changed(rootId: string): void;
  /** The organisation's word: null when it says nothing against syncing this root. */
  blocked(root: FilesRoot): FilesSyncErrorName | null;
}

interface PendingDelete {
  count: number;
  /** Where they were deleted. The question is whether to delete them on the other side. */
  deletedOn: MassDeleteOrigin;
  /** Base ids whose deletion waits for the answer. */
  ids: string[];
}

class Stop extends Error {
  constructor(readonly why: 'inactive' | 'offline' | 'auth' | 'not_found' | 'scan', readonly cause?: unknown) {
    super(why);
    this.name = 'RootStop';
  }
}

function expectOf(entry: FilesLocalEntry): FilesExpect {
  return { fileId: entry.fileId, size: entry.size, mtimeMs: entry.mtimeMs };
}

function unwrap<T>(result: FilesResult<T>): T {
  if (!result.ok) throw new LocalError(result.error);
  return result.value;
}

function errorOfLocal(error: unknown): FilesError | null {
  return (error as { name?: string })?.name === 'LocalError' ? (error as LocalError).error : null;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** What one round knows of the disk, kept up to date with what the round itself does there. */
class LocalIndex {
  readonly byKey = new Map<string, FilesLocalEntry>();
  /** Taken names per folder, as nameKey gives them. */
  private readonly names = new Map<string, Set<string>>();

  constructor(entries: FilesLocalEntry[], private readonly naming: DiskNaming) {
    for (const entry of entries) this.add(entry);
  }

  private folder(path: string): Set<string> {
    const key = pathKey(parentPath(path), this.naming);
    let set = this.names.get(key);
    if (!set) this.names.set(key, (set = new Set()));
    return set;
  }

  add(entry: FilesLocalEntry): void {
    this.byKey.set(pathKey(entry.path, this.naming), entry);
    this.folder(entry.path).add(nameKey(baseName(entry.path), this.naming));
  }

  get(path: string): FilesLocalEntry | undefined {
    return this.byKey.get(pathKey(path, this.naming));
  }

  delete(path: string): void {
    const key = pathKey(path, this.naming);
    for (const [other, entry] of [...this.byKey]) {
      if (other === key || other.startsWith(`${key}/`)) {
        this.byKey.delete(other);
        this.folder(entry.path).delete(nameKey(baseName(entry.path), this.naming));
      }
    }
  }

  /** Names taken in `folder`, without `except`. */
  taken(folder: string, except?: string): Set<string> {
    const set = new Set(this.names.get(pathKey(folder, this.naming)) ?? []);
    if (except !== undefined && parentPath(except) === folder) set.delete(nameKey(baseName(except), this.naming));
    return set;
  }

  /** A folder moved: everything in it moves with it. Answers the moved entries, old path to new. */
  move(from: string, to: string, moved: FilesLocalEntry): Map<string, FilesLocalEntry> {
    const changed = new Map<string, FilesLocalEntry>();
    const fromKey = pathKey(from, this.naming);
    const below = [...this.byKey].filter(([key]) => key.startsWith(`${fromKey}/`));
    this.delete(from);
    this.add(moved);
    changed.set(from, moved);
    for (const [, entry] of below) {
      const next = { ...entry, path: to + entry.path.slice(from.length) };
      this.add(next);
      changed.set(entry.path, next);
    }
    return changed;
  }
}

export class RootSync {
  root: FilesRoot;
  status: FilesSyncRootStatus;
  items: Record<string, FilesSyncItemStatus> = {};
  private record: RootRecord | null = null;
  private readonly base = new Map<string, BaseItem>();
  private massDelete: PendingDelete | null = null;
  private allowDeletes = false;
  private readonly failed = new Set<string>();
  /** Local paths skipped for the rest of a pass: changed while read, or failed. */
  private readonly skipPaths = new Set<string>();
  /** Something changed while it was looked at: another pass, soon. */
  private retrySoon = false;
  private lastSeen = new Map<string, FilesLocalEntry>();
  private dirty = false;
  private saveChain: Promise<void> = Promise.resolve();
  private waitingSaid = false;
  /** Nodes being placed by this pass, for items: `syncing`. */
  private busy = new Set<string>();
  /** Says the root was stopped for good: no pass runs again. */
  stopped = false;

  constructor(root: FilesRoot, private readonly account: AccountLink, private readonly host: RootHost) {
    this.root = root;
    this.status = { rootId: root.id, state: root.paused ? 'paused' : 'starting', pending: 0, done: 0, lastSyncedAt: null };
  }

  get isDrive(): boolean {
    return this.root.kind === 'drive';
  }

  get massDeletePending(): boolean {
    return this.massDelete !== null;
  }

  /** The record's items, for coverage. */
  item(id: string): BaseItem | undefined {
    return this.base.get(id);
  }

  setRoot(root: FilesRoot): void {
    this.root = root;
    if (root.paused) this.setStatus({ state: 'paused' });
  }

  private setStatus(patch: Partial<FilesSyncRootStatus>): void {
    this.status = { ...this.status, ...patch, rootId: this.root.id };
    // `blocked` says why too.
    if (this.status.state !== 'error' && this.status.state !== 'blocked') delete this.status.errorKey;
    if (this.status.state !== 'confirm-delete') delete this.status.massDelete;
    this.host.changed(this.root.id);
  }

  private log(kind: FilesSyncActivityKind, direction: 'up' | 'down' | null, path: string, extra: { detail?: string; messageKey?: string } = {}): void {
    this.host.activity({ rootId: this.root.id, kind, direction, path, ...extra });
  }

  private logError(path: string, name: FilesSyncErrorName, direction: 'up' | 'down' | null = null): void {
    this.log('error', direction, path, { messageKey: errorKey(name) });
  }

  // ─── The record ─────────────────────────────────────────────

  private async load(): Promise<void> {
    if (this.record) return;
    let raw: string | null;
    try {
      raw = await this.host.controls.loadState(this.root.id);
    } catch {
      // Locked, or the root went: not "never synced", which would put both sides together anew.
      throw new Stop('inactive');
    }
    this.record = parseRecord(raw, this.root.remoteId);
    this.base.clear();
    for (const item of this.record.items) this.base.set(item.id, item);
  }

  private snapshot(): string {
    const record = this.record ?? emptyRecord(this.root.remoteId);
    return serializeRecord({ ...record, items: [...this.base.values()] });
  }

  /** Writes the record; a failed write is tried again with the next. */
  private save(): Promise<void> {
    if (!this.record) return Promise.resolve();
    const text = this.snapshot();
    this.saveChain = this.saveChain.then(() => this.host.controls.saveState(this.root.id, text)).catch(() => {
      this.dirty = true;
    });
    return this.saveChain;
  }

  /** Forgets the record: the drive's folder went with a sign-out, and the next sign-in starts afresh. */
  async forget(): Promise<void> {
    this.base.clear();
    this.record = emptyRecord(this.root.remoteId);
    await this.host.controls.saveState(this.root.id, serializeRecord(this.record)).catch(() => {});
  }

  /**
   * Files changed or made on this computer that Files doesn't have yet, by local path: what a
   * drive going (or a folder that stops) now would leave behind. The drive: a placeholder in
   * sync, or with its content not here, is in Files. Anything else counts unless the record
   * has it with the same size and time (Windows drops "in sync" for an attribute too).
   */
  async pendingHere(): Promise<string[]> {
    await this.load();
    const entries = await this.scan();
    const naming = this.host.naming;
    const known = new Map<string, BaseItem>();
    for (const item of this.base.values()) if (item.kind === 'file') known.set(pathKey(item.path, naming), item);
    const out: string[] = [];
    for (const entry of entries) {
      if (entry.kind !== 'file' || isSystemFileName(baseName(entry.path))) continue;
      if (this.isDrive && entry.placeholder?.identity && (entry.placeholder.inSync || !entry.placeholder.hydrated)) continue;
      const item = known.get(pathKey(entry.path, naming));
      if (item && item.fileId && item.localSize === entry.size && item.mtimeMs === entry.mtimeMs) continue;
      out.push(entry.path);
    }
    return out;
  }

  // ─── Mass delete ────────────────────────────────────────────

  /** The user's answer. No: what was deleted on one side comes back from the other. */
  answerMassDelete(allow: boolean): void {
    const pending = this.massDelete;
    if (!pending) return;
    this.massDelete = null;
    if (allow) {
      this.allowDeletes = true;
    } else {
      for (const id of pending.ids) this.dropWithBelow(id);
      void this.save();
    }
    this.setStatus({ state: 'syncing' });
  }

  private dropWithBelow(id: string): void {
    const item = this.base.get(id);
    if (!item) return;
    for (const other of [...this.base.values()]) {
      if (other.id === id || isUnderPath(other.path, item.path)) this.base.delete(other.id);
    }
  }

  // ─── A pass ─────────────────────────────────────────────────

  /**
   * One pass. Answers what the runner should do next: `idle`, `retry` (offline: later, with a
   * longer wait each time), `soon` (something changed while it ran, or is being written now).
   */
  async pass(): Promise<'idle' | 'retry' | 'soon' | 'stopped'> {
    if (this.stopped) return 'stopped';
    if (this.root.paused) {
      this.setStatus({ state: 'paused' });
      return 'idle';
    }
    const blocked = this.host.blocked(this.root);
    if (blocked) {
      this.setStatus({ state: 'blocked', errorKey: errorKey(blocked) });
      return 'idle';
    }
    if (this.massDelete) {
      this.setStatus({ state: 'confirm-delete', massDelete: { count: this.massDelete.count, deletedOn: this.massDelete.deletedOn } });
      return 'idle';
    }
    this.failed.clear();
    this.skipPaths.clear();
    this.retrySoon = false;
    this.setStatus({ state: this.record ? 'syncing' : 'starting', done: 0 });
    let soon = false;
    try {
      await this.load();
      await this.account.refresh();
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const outcome = await this.round();
        if (outcome === 'confirm') break;
        if (outcome === 0) break;
        if (round === MAX_ROUNDS - 1) soon = true;
      }
      if (this.retrySoon) soon = true;
      await this.save();
    } catch (error) {
      await this.save();
      return this.stopWith(error);
    }
    this.allowDeletes = false;
    this.waitingSaid = false;
    // round() may have set it: TypeScript can't see that.
    const asking = this.massDelete as PendingDelete | null;
    if (asking) {
      this.setStatus({ state: 'confirm-delete', massDelete: { count: asking.count, deletedOn: asking.deletedOn }, pending: asking.count });
      return 'idle';
    }
    this.updateItems();
    const pending = this.failed.size;
    this.setStatus({ state: 'idle', pending, lastSyncedAt: this.host.now() });
    return soon ? 'soon' : 'idle';
  }

  private stopWith(error: unknown): 'idle' | 'retry' | 'stopped' {
    const why = (error as Stop)?.name === 'RootStop' ? (error as Stop).why : null;
    if (why === 'inactive') {
      // Paused, locked or gone meanwhile: the engine hears of it and asks for the roots again.
      this.setStatus({ state: this.root.paused ? 'paused' : 'idle' });
      return 'stopped';
    }
    if (why === 'not_found') {
      this.setStatus({ state: 'error', errorKey: errorKey('not_found') });
      return 'idle';
    }
    if (why === 'scan') {
      const local = errorOfLocal((error as Stop).cause);
      this.setStatus({ state: 'error', errorKey: errorKey(local ? localErrorName(local) : 'failed') });
      return 'retry';
    }
    if (isOffline(error) || why === 'offline') {
      if (!this.waitingSaid) {
        this.waitingSaid = true;
        this.log('waiting', null, '', { messageKey: errorKey('offline') });
      }
      this.updateItems();
      this.setStatus({ state: 'offline', pending: Math.max(this.status.pending, this.failed.size) });
      return 'retry';
    }
    if (isAuthRefused(error) || why === 'auth') {
      this.setStatus({ state: 'error', errorKey: errorKey('server_refused') });
      return 'retry';
    }
    console.warn('[files-sync] A pass failed:', error);
    this.setStatus({ state: 'error', errorKey: errorKey(remoteErrorName(error)) });
    return 'retry';
  }

  private async scan(): Promise<FilesLocalEntry[]> {
    const result = await this.host.controls.scan(this.root.id);
    if (!result.ok) {
      if (result.error === 'inactive') throw new Stop('inactive');
      throw new Stop('scan', new LocalError(result.error));
    }
    return result.value;
  }

  /** Answers how many things it did, or `confirm` when a mass delete stopped it. */
  private async round(): Promise<number | 'confirm'> {
    const entries = await this.scan();
    const tree = this.account.tree;
    const subtree = tree.subtree(this.root.remoteId);
    if (!subtree) throw new Stop('not_found');
    const view = new Map(subtree.map((node) => [node.id, node]));

    // The drive's folder goes with a sign-out and comes back empty: the record of the old one
    // would read as everything deleted here.
    if (this.isDrive && entries.length === 0 && this.base.size > 0) {
      this.base.clear();
      this.record = emptyRecord(this.root.remoteId);
    }

    const round = new Round(this, entries, view);
    round.match();
    let did = 0;
    did += await round.moves();
    did += await round.content();
    did += await round.remoteNew();
    did += await round.localNew();
    const deletes = round.planDeletes();
    if (deletes.local.count + deletes.remote.count > 0) {
      const total = this.base.size;
      const over = (count: number) => count > MASS_DELETE_COUNT || (total >= MASS_DELETE_MIN_ROOT && count * 2 > total);
      // `deletes.remote` are to be deleted in Files: they were deleted on this computer.
      const deletedOn: MassDeleteOrigin = deletes.remote.count >= deletes.local.count ? 'this-computer' : 'files';
      if (!this.allowDeletes && (over(deletes.local.count) || over(deletes.remote.count))) {
        const count = deletes.local.count + deletes.remote.count;
        this.massDelete = { count, deletedOn, ids: [...deletes.local.ids, ...deletes.remote.ids] };
        this.log('mass-delete', deletedOn === 'this-computer' ? 'up' : 'down', '', { detail: String(count) });
        await this.save();
        return 'confirm';
      }
      did += await round.deletes(deletes);
    }
    did += round.dropped;
    this.lastSeen = round.matched;
    if (did > 0) await this.save();
    return did;
  }

  private updateItems(): void {
    const items: Record<string, FilesSyncItemStatus> = {};
    for (const item of this.base.values()) {
      const seen = this.lastSeen.get(item.id);
      if (this.failed.has(item.id)) items[item.id] = 'error';
      else if (this.isDrive && item.kind === 'file' && seen?.placeholder && !seen.placeholder.hydrated) items[item.id] = 'online-only';
      else items[item.id] = 'synced';
    }
    const subtree = this.account.tree.subtree(this.root.remoteId) ?? [];
    for (const node of subtree) {
      if (!items[node.id]) items[node.id] = this.failed.has(node.id) ? 'error' : 'pending';
    }
    for (const id of this.busy) items[id] = 'syncing';
    this.items = items;
  }

  // ─── What a round uses ──────────────────────────────────────

  /** @internal */ get baseItems(): Map<string, BaseItem> {
    return this.base;
  }
  /** @internal */ get hostRef(): RootHost {
    return this.host;
  }
  /** @internal */ get link(): AccountLink {
    return this.account;
  }
  /** @internal */ get record_(): RootRecord {
    if (!this.record) this.record = emptyRecord(this.root.remoteId);
    return this.record;
  }
  /** @internal */ markFailed(id: string | null, path: string): void {
    if (id) this.failed.add(id);
    this.skipPaths.add(path);
  }
  /** @internal */ markRetry(path: string): void {
    this.skipPaths.add(path);
    this.retrySoon = true;
  }
  /** @internal */ noteError(id: string): void {
    this.failed.add(id);
  }
  /** @internal */ isSkipped(path: string): boolean {
    return this.skipPaths.has(path);
  }
  /** @internal */ noteDone(): void {
    this.setStatus({ done: this.status.done + 1 });
  }
  /** @internal */ logActivity(kind: FilesSyncActivityKind, direction: 'up' | 'down' | null, path: string, extra: { detail?: string; messageKey?: string } = {}): void {
    this.log(kind, direction, path, extra);
  }
  /** @internal */ logFailure(path: string, name: FilesSyncErrorName, direction: 'up' | 'down' | null = null): void {
    this.logError(path, name, direction);
  }
  /** @internal */ setBusy(id: string, on: boolean): void {
    if (on) this.busy.add(id);
    else this.busy.delete(id);
  }
  /** @internal */ get stateLabel(): FilesSyncRootState {
    return this.status.state;
  }
}

/** One round of a pass: the disk as scanned now, Files as the tree has it now, and the record. */
class Round {
  readonly local: LocalIndex;
  /** Base id to the entry it is on disk now. */
  readonly matched = new Map<string, FilesLocalEntry>();
  /** Entries taken by an item: matched, paired, or made by this round. */
  private readonly claimed = new Set<string>();
  /** Items the record dropped this round (both sides gone, or given back to one side). */
  dropped = 0;
  private readonly root: FilesRoot;
  private readonly base: Map<string, BaseItem>;
  private readonly host: RootHost;
  private readonly naming: DiskNaming;
  private readonly remote: FilesRemote;
  private readonly tree: RemoteTree;
  private readonly drive: boolean;

  constructor(private readonly sync: RootSync, entries: FilesLocalEntry[], private readonly view: Map<string, RemoteNode>) {
    this.root = sync.root;
    this.base = sync.baseItems;
    this.host = sync.hostRef;
    this.naming = this.host.naming;
    this.remote = sync.link.remote;
    this.tree = sync.link.tree;
    this.drive = sync.isDrive;
    this.local = new LocalIndex(entries, this.naming);
  }

  private key(path: string): string {
    return pathKey(path, this.naming);
  }

  private claim(entry: FilesLocalEntry): void {
    this.claimed.add(this.key(entry.path));
  }

  private isClaimed(entry: FilesLocalEntry): boolean {
    return this.claimed.has(this.key(entry.path));
  }

  private sortedBase(): BaseItem[] {
    return [...this.base.values()].sort((a, b) => depthOf(a.path) - depthOf(b.path));
  }

  // ─── Matching the record to the disk ────────────────────────

  private fits(entry: FilesLocalEntry, item: BaseItem): boolean {
    if (entry.kind !== item.kind) return false;
    if (!this.drive) return true;
    const identity = entry.placeholder?.identity;
    return identity === undefined || identity === null || identity === item.id;
  }

  match(): void {
    const items = this.sortedBase();
    for (const item of items) {
      const entry = this.local.get(item.path);
      if (entry && !this.isClaimed(entry) && this.fits(entry, item)) {
        this.matched.set(item.id, entry);
        this.claim(entry);
      }
    }
    const byFileId = new Map<string, FilesLocalEntry>();
    const byIdentity = new Map<string, FilesLocalEntry>();
    for (const entry of this.local.byKey.values()) {
      if (this.isClaimed(entry)) continue;
      if (entry.fileId) byFileId.set(entry.fileId, entry);
      const identity = entry.placeholder?.identity;
      if (identity) byIdentity.set(identity, entry);
    }
    for (const item of items) {
      if (this.matched.has(item.id)) continue;
      let entry = this.drive ? byIdentity.get(item.id) : undefined;
      if (!entry && item.fileId) entry = byFileId.get(item.fileId);
      if (entry && !this.isClaimed(entry) && entry.kind === item.kind) {
        this.matched.set(item.id, entry);
        this.claim(entry);
      }
    }
  }

  /** The id of the item that is the folder at `folder` on disk now; the root's for ''. Undefined: not synced yet. */
  private idAtLocal(folder: string): string | null | undefined {
    if (folder === '') return this.root.remoteId;
    const key = this.key(folder);
    for (const [id, entry] of this.matched) {
      if (entry.kind === 'directory' && this.key(entry.path) === key) return this.view.has(id) ? id : undefined;
    }
    return undefined;
  }

  /** Where a node's folder is on disk now: '' for the root's. Undefined: not there yet. */
  private localFolderOf(parentId: string | null): string | undefined {
    if (parentId === this.root.remoteId) return '';
    if (parentId === null) return undefined;
    const entry = this.matched.get(parentId);
    return entry && entry.kind === 'directory' ? entry.path : undefined;
  }

  private localChanged(item: BaseItem, entry: FilesLocalEntry): boolean {
    if (item.kind !== 'file') return false;
    if (this.drive) {
      if (entry.placeholder?.inSync) return false;
      // Content that isn't here can't have been changed here.
      if (entry.placeholder && !entry.placeholder.hydrated) return false;
      // Not in sync, and never seen in sync since it was placed: written over.
      if (!item.fileId) return true;
    } else if (!item.fileId) {
      return false;
    }
    return entry.size !== item.localSize || entry.mtimeMs !== item.mtimeMs;
  }

  private remoteChanged(item: BaseItem, node: RemoteNode): boolean {
    return item.kind === 'file' && node.blobId !== item.blobId;
  }

  private remember(item: BaseItem): void {
    this.base.set(item.id, item);
  }

  private adoptLocal(item: BaseItem, entry: FilesLocalEntry): BaseItem {
    return { ...item, path: entry.path, fileId: entry.fileId, localSize: entry.size, mtimeMs: entry.mtimeMs };
  }

  private adoptRemote(item: BaseItem, node: RemoteNode): BaseItem {
    return { ...item, name: node.name, parentId: node.parentId, blobId: node.blobId, size: node.size, modifiedMs: node.modifiedMs };
  }

  private itemOf(node: RemoteNode, entry: FilesLocalEntry | null, path: string): BaseItem {
    return {
      id: node.id,
      kind: node.kind,
      path,
      name: node.name,
      parentId: node.parentId,
      blobId: node.blobId,
      size: node.size,
      modifiedMs: node.modifiedMs,
      fileId: entry?.fileId ?? '',
      localSize: entry?.size ?? node.size,
      mtimeMs: entry?.mtimeMs ?? node.modifiedMs,
    };
  }

  /** Runs one step. An error on one item is said and the item waits; offline and the like stop the pass. */
  private async step(id: string | null, path: string, direction: 'up' | 'down' | null, work: () => Promise<boolean>): Promise<number> {
    if (this.sync.isSkipped(path)) return 0;
    try {
      if (id) this.sync.setBusy(id, true);
      const did = await work();
      if (did) this.sync.noteDone();
      return did ? 1 : 0;
    } catch (error) {
      if (isOffline(error) || isAuthRefused(error)) throw error;
      const local = errorOfLocal(error);
      if (local === 'inactive') throw new Stop('inactive');
      // Changed meanwhile: the next round looks again. Not an error anyone has to see.
      if (local === 'changed' || local === 'exists' || local === 'missing') {
        this.sync.markRetry(path);
        return 0;
      }
      const name = local ? localErrorName(local) : remoteErrorName(error);
      if (!local && name === 'not_found') {
        // Files changed under this pass: the next one reads it again.
        this.sync.markRetry(path);
        return 0;
      }
      if (!local) console.warn('[files-sync] An item failed:', error);
      this.sync.markFailed(id, path);
      this.sync.logFailure(path, name, direction);
      return 0;
    } finally {
      if (id) this.sync.setBusy(id, false);
    }
  }

  // ─── Moves and renames ──────────────────────────────────────

  async moves(): Promise<number> {
    let did = 0;
    for (const item of this.sortedBase()) {
      const entry = this.matched.get(item.id);
      const node = this.view.get(item.id);
      if (!entry || !node) continue;
      const localParent = this.idAtLocal(parentPath(entry.path));
      const localNameChanged = baseName(entry.path) !== baseName(item.path);
      const localMoved = localNameChanged || localParent !== item.parentId;
      const remoteMoved = node.name !== item.name || node.parentId !== item.parentId;
      if (!localMoved && !remoteMoved) {
        // A folder above moved: only the path is new.
        if (entry.path !== item.path) this.remember({ ...item, path: entry.path });
        continue;
      }
      if (localMoved && !remoteMoved) {
        if (localParent === undefined) continue;
        did += await this.step(item.id, entry.path, 'up', async () => {
          const name = localNameChanged ? this.remote.acceptedName(baseName(entry.path)) : item.name;
          const change: { name?: string; parentId?: string | null } = {};
          if (name !== node.name) change.name = name;
          if (localParent !== node.parentId) change.parentId = localParent;
          const moved = await this.remote.move(item.id, change);
          this.tree.put(moved);
          this.view.set(moved.id, moved);
          this.remember({ ...this.adoptRemote(item, moved), path: entry.path });
          this.sync.logActivity(change.parentId !== undefined ? 'moved' : 'renamed', 'up', entry.path, { detail: item.path });
          return true;
        });
        continue;
      }
      // Files moved it, or both did: Files' place wins.
      const folder = this.localFolderOf(node.parentId);
      if (folder === undefined) continue;
      const wanted = freeLocalName(node.name, this.local.taken(folder, entry.path), this.naming);
      const target = joinPath(folder, wanted);
      if (target === entry.path) {
        this.remember({ ...this.adoptRemote(item, node), path: entry.path });
        continue;
      }
      did += await this.step(item.id, entry.path, 'down', async () => {
        const moved = unwrap(await this.host.controls.move(this.root.id, entry.path, target, expectOf(entry)));
        const changed = this.local.move(entry.path, target, moved);
        for (const [id, seen] of [...this.matched]) {
          const next = changed.get(seen.path);
          if (next) this.matched.set(id, next);
        }
        this.claim(moved);
        this.remember({ ...this.adoptLocal(this.adoptRemote(item, node), moved) });
        this.sync.logActivity(folder !== parentPath(entry.path) ? 'moved' : 'renamed', 'down', target, { detail: entry.path });
        if (wanted !== node.name) this.sync.logActivity('renamed-for-disk', 'down', target, { detail: wanted });
        return true;
      });
    }
    return did;
  }

  // ─── Changed content ────────────────────────────────────────

  async content(): Promise<number> {
    let did = 0;
    for (const item of this.sortedBase()) {
      if (item.kind !== 'file') continue;
      const entry = this.matched.get(item.id);
      const node = this.view.get(item.id);
      if (!entry || !node) continue;
      const localChanged = this.localChanged(item, entry);
      const remoteChanged = this.remoteChanged(item, node);
      if (!localChanged && !remoteChanged) {
        if (this.drive && item.fileId && entry.placeholder && !entry.placeholder.inSync && entry.placeholder.hydrated) {
          // The same size and time as synced: Windows dropped "in sync" for an attribute.
          const marked = await this.host.controls.drive?.markInSync(this.root.id, entry.path, item.id, expectOf(entry));
          if (marked?.ok) this.remember(this.adoptLocal(item, marked.value));
        } else if (!item.fileId) {
          // Just placed: what it is on disk, now that it's in sync.
          this.remember(this.adoptLocal(item, entry));
        }
        continue;
      }
      if (localChanged && !remoteChanged) {
        did += await this.step(item.id, entry.path, 'up', () => this.uploadOver(item, entry, node));
      } else if (!localChanged && remoteChanged) {
        did += await this.step(item.id, entry.path, 'down', () => this.downloadOver(item, entry, node));
      } else {
        did += await this.step(item.id, entry.path, null, () => this.conflict(item, entry, node));
      }
    }
    return did;
  }

  /** Reads a local file whole, and makes sure it didn't change while it was read. Null: it did. */
  private async read(entry: FilesLocalEntry): Promise<{ data: Uint8Array; entry: FilesLocalEntry } | null> {
    if (this.drive && entry.placeholder && !entry.placeholder.hydrated) return null;
    const opened = unwrap(await this.host.controls.openRead(this.root.id, entry.path));
    let data: Uint8Array;
    try {
      data = await this.host.readUrl(opened.url);
    } catch {
      // Main answers 409 when it changed between openRead and the read.
      this.sync.markRetry(entry.path);
      return null;
    }
    const after = unwrap(await this.host.controls.stat(this.root.id, entry.path));
    const before = opened.entry;
    if (!after || after.fileId !== before.fileId || after.size !== before.size || after.mtimeMs !== before.mtimeMs || data.length !== before.size) {
      this.sync.markRetry(entry.path);
      return null;
    }
    return { data, entry: before };
  }

  /** Over the upload limit: said once, and not tried again until the file changes. */
  private tooLarge(entry: FilesLocalEntry): boolean {
    const limit = this.remote.maxUpload();
    const record = this.sync.record_;
    if (!limit || entry.size <= limit) {
      if (record.tooLarge[entry.path]) delete record.tooLarge[entry.path];
      return false;
    }
    const known = record.tooLarge[entry.path];
    if (!known || known.size !== entry.size || known.mtimeMs !== entry.mtimeMs) {
      record.tooLarge[entry.path] = { size: entry.size, mtimeMs: entry.mtimeMs };
      this.sync.logActivity('too-large', 'up', entry.path, { detail: String(limit), messageKey: errorKey('too_large') });
    }
    return true;
  }

  private async uploadBytes(entry: FilesLocalEntry, node: { type?: string } | null): Promise<{ blobId: string; type: string; read: FilesLocalEntry } | null> {
    if (this.tooLarge(entry)) return null;
    const read = await this.read(entry);
    if (!read) return null;
    const blob = await this.remote.upload(read.data, node?.type ?? typeFor(entry.path));
    return { blobId: blob.blobId, type: blob.type || node?.type || typeFor(entry.path), read: read.entry };
  }

  private async markDrive(path: string, id: string, read: FilesLocalEntry): Promise<FilesLocalEntry> {
    const drive = this.host.controls.drive;
    if (!this.drive || !drive) return read;
    const marked = await drive.markInSync(this.root.id, path, id, expectOf(read));
    // Renamed or changed since it was read: the next round finds it by its file id.
    return marked.ok ? marked.value : read;
  }

  private async uploadOver(item: BaseItem, entry: FilesLocalEntry, node: RemoteNode): Promise<boolean> {
    const bytes = await this.uploadBytes(entry, node);
    if (!bytes) {
      if (this.sync.record_.tooLarge[entry.path]) this.sync.noteError(item.id);
      return false;
    }
    const updated = await this.remote.replaceBlob(item.id, bytes.blobId);
    this.tree.put(updated);
    this.view.set(updated.id, updated);
    const local = await this.markDrive(entry.path, item.id, bytes.read);
    this.remember(this.adoptLocal(this.adoptRemote(item, updated), local));
    this.sync.logActivity('uploaded', 'up', entry.path);
    return true;
  }

  /** Streams a node's content into a new file at `path`. `expect`: what's there now, null for nothing. */
  private async write(path: string, node: RemoteNode, expect: FilesExpect | null): Promise<FilesLocalEntry> {
    const controls = this.host.controls;
    const writeId = unwrap(await controls.beginWrite(this.root.id, path, { expect, mtimeMs: node.modifiedMs || this.host.now(), size: node.size }));
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let written = 0;
    let chain: Promise<void> = Promise.resolve();
    let failure: unknown = null;
    const flush = (all: boolean) => {
      if (pendingBytes === 0 || (!all && pendingBytes < PIECE)) return;
      const piece = concat(pending, pendingBytes);
      pending = [];
      pendingBytes = 0;
      written += piece.length;
      chain = chain.then(async () => {
        if (failure) return;
        const result = await controls.writeChunk(writeId, piece);
        if (!result.ok) failure = new LocalError(result.error);
      });
    };
    try {
      await this.remote.download(node, (part) => {
        if (failure) throw failure;
        pending.push(part);
        pendingBytes += part.length;
        flush(false);
      });
      flush(true);
      await chain;
      if (failure) throw failure;
      if (written !== node.size) throw new LocalError('failed');
      return unwrap(await controls.commitWrite(writeId));
    } catch (error) {
      await chain.catch(() => {});
      await controls.abortWrite(writeId);
      throw error;
    }
  }

  private async downloadOver(item: BaseItem, entry: FilesLocalEntry, node: RemoteNode): Promise<boolean> {
    if (this.drive) {
      const drive = this.host.controls.drive;
      if (!drive) return false;
      const result = await drive.update(this.root.id, entry.path, { size: node.size, mtimeMs: node.modifiedMs || this.host.now(), identity: node.id, dehydrate: true }, expectOf(entry));
      if (!result.ok && result.error === 'changed') {
        // Saved over meanwhile with a plain write: a change here, which the next round sees.
        this.sync.markRetry(entry.path);
        return false;
      }
      const updated = unwrap(result);
      this.remember(this.adoptLocal(this.adoptRemote(item, node), updated));
      return true;
    }
    const written = await this.write(entry.path, node, expectOf(entry));
    this.local.add(written);
    this.matched.set(item.id, written);
    this.remember(this.adoptLocal(this.adoptRemote(item, node), written));
    this.sync.logActivity('downloaded', 'down', entry.path);
    return true;
  }

  /** Whether the file on disk and the node hold the same bytes. Only for files small enough to look. */
  private async sameContent(entry: FilesLocalEntry, node: RemoteNode): Promise<boolean> {
    if (entry.kind !== 'file' || node.kind !== 'file' || entry.size !== node.size || node.size > COMPARE_LIMIT) return false;
    if (this.drive) return false;
    const local = await this.read(entry);
    if (!local) return false;
    const parts: Uint8Array[] = [];
    let size = 0;
    await this.remote.download(node, (part) => {
      parts.push(part);
      size += part.length;
    });
    return sameBytes(local.data, concat(parts, size));
  }

  /** A free name for the copy that lost, next to `path`. */
  private conflictPath(path: string): string {
    const folder = parentPath(path);
    const name = conflictName(baseName(path), this.host.device, new Date(this.host.now()));
    return joinPath(folder, freeLocalName(name, this.local.taken(folder), this.naming));
  }

  /**
   * Both sides changed the file. The disk's copy moves aside under a conflict name and goes up
   * as a new file (the next round), and Files' version takes the name here.
   */
  private async conflict(item: BaseItem, entry: FilesLocalEntry, node: RemoteNode): Promise<boolean> {
    if (await this.sameContent(entry, node)) {
      this.remember(this.adoptLocal(this.adoptRemote(item, node), entry));
      return true;
    }
    if (this.drive && entry.placeholder && !entry.placeholder.hydrated) return false;
    const aside = this.conflictPath(entry.path);
    const moved = unwrap(await this.host.controls.move(this.root.id, entry.path, aside, expectOf(entry)));
    this.local.delete(entry.path);
    this.local.add(moved);
    this.matched.delete(item.id);
    this.sync.logActivity('conflict', null, entry.path, { detail: baseName(aside) });
    await this.bringDown(item.id, node, entry.path);
    return true;
  }

  /** Files' version of a node at `path`, where nothing is now: a file written, or a placeholder. */
  private async bringDown(id: string, node: RemoteNode, path: string): Promise<void> {
    if (this.drive) {
      const drive = this.host.controls.drive;
      if (!drive) return;
      const answers = unwrap(await drive.place(this.root.id, [placeholderOf(node, path)]));
      const problem = answers[0]?.error;
      if (problem) throw new LocalError(problem);
      const placed = reservedEntry(node, path);
      this.local.add(placed);
      this.claim(placed);
      this.matched.set(id, placed);
      this.remember(this.itemOf(node, null, path));
      return;
    }
    const written = node.kind === 'directory'
      ? unwrap(await this.host.controls.mkdir(this.root.id, path))
      : await this.write(path, node, null);
    this.local.add(written);
    this.claim(written);
    this.matched.set(id, written);
    this.remember(this.itemOf(node, written, path));
  }

  // ─── New in Files ───────────────────────────────────────────

  async remoteNew(): Promise<number> {
    let did = 0;
    const places: { node: RemoteNode; path: string }[] = [];
    for (const node of this.view.values()) {
      if (this.base.has(node.id)) continue;
      const folder = this.drive ? this.placedFolder(node.parentId) : this.localFolderOf(node.parentId);
      if (folder === undefined) continue;
      const wantedPath = joinPath(folder, diskName(node.name, this.naming));
      const there = this.local.get(wantedPath);
      if (there && !this.isClaimed(there)) {
        // Both sides have something new under this name: the first sync, mostly.
        did += await this.step(node.id, there.path, 'down', () => this.pair(node, there));
        continue;
      }
      const name = freeLocalName(node.name, this.local.taken(folder), this.naming);
      const path = joinPath(folder, name);
      if (this.sync.isSkipped(path)) continue;
      if (this.drive) {
        // Reserved here so siblings placed in the same call don't take the name.
        const reserved = reservedEntry(node, path);
        this.local.add(reserved);
        this.claim(reserved);
        this.matched.set(node.id, reserved);
        this.remember(this.itemOf(node, null, path));
        places.push({ node, path });
        if (name !== node.name) this.sync.logActivity('renamed-for-disk', 'down', path, { detail: name });
        continue;
      }
      did += await this.step(node.id, path, 'down', async () => {
        await this.bringDown(node.id, node, path);
        if (node.kind === 'directory') this.sync.logActivity('folder-created', 'down', path);
        else this.sync.logActivity('downloaded', 'down', path);
        if (name !== node.name) this.sync.logActivity('renamed-for-disk', 'down', path, { detail: name });
        return true;
      });
    }
    if (places.length > 0) did += await this.placeAll(places);
    return did;
  }

  /** The drive: where a node's folder is, counting folders placed by this round. */
  private placedFolder(parentId: string | null): string | undefined {
    if (parentId === this.root.remoteId) return '';
    if (parentId === null) return undefined;
    const matched = this.matched.get(parentId);
    if (matched) return matched.kind === 'directory' ? matched.path : undefined;
    const item = this.base.get(parentId);
    return item && item.kind === 'directory' && this.local.get(item.path) ? item.path : undefined;
  }

  private async placeAll(places: { node: RemoteNode; path: string }[]): Promise<number> {
    const drive = this.host.controls.drive;
    if (!drive) return 0;
    let did = 0;
    for (let at = 0; at < places.length; at += PLACE_BATCH) {
      const batch = places.slice(at, at + PLACE_BATCH);
      const result = await drive.place(this.root.id, batch.map(({ node, path }) => placeholderOf(node, path)));
      if (!result.ok) {
        if (result.error === 'inactive') throw new Stop('inactive');
        for (const { node, path } of batch) {
          this.base.delete(node.id);
          this.matched.delete(node.id);
          this.sync.markFailed(node.id, path);
        }
        this.sync.logFailure('', localErrorName(result.error), 'down');
        continue;
      }
      batch.forEach(({ node, path }, index) => {
        const error = result.value[index]?.error;
        if (!error) {
          did += 1;
          return;
        }
        this.base.delete(node.id);
        this.matched.delete(node.id);
        this.local.delete(path);
        if (error === 'exists' || error === 'missing') {
          this.sync.markRetry(path);
          return;
        }
        this.sync.markFailed(node.id, path);
        this.sync.logFailure(path, localErrorName(error), 'down');
      });
    }
    return did;
  }

  /**
   * Something new on both sides under one name. Two folders are one. Two files with the same
   * bytes are one. Anything else: the disk's moves aside as a conflict copy and goes up later,
   * and Files' comes down under the name.
   */
  private async pair(node: RemoteNode, entry: FilesLocalEntry): Promise<boolean> {
    if (node.kind === 'directory' && entry.kind === 'directory') {
      this.claim(entry);
      this.matched.set(node.id, entry);
      this.remember(this.itemOf(node, entry, entry.path));
      if (this.drive) await this.host.controls.drive?.markInSync(this.root.id, entry.path, node.id, expectOf(entry)).catch(() => null);
      return true;
    }
    if (this.drive && entry.placeholder?.identity === node.id) {
      this.claim(entry);
      this.matched.set(node.id, entry);
      this.remember(this.itemOf(node, entry, entry.path));
      return true;
    }
    if (await this.sameContent(entry, node)) {
      this.claim(entry);
      this.matched.set(node.id, entry);
      this.remember(this.itemOf(node, entry, entry.path));
      return true;
    }
    if (this.drive && entry.placeholder && !entry.placeholder.hydrated) return false;
    const aside = this.conflictPath(entry.path);
    const moved = unwrap(await this.host.controls.move(this.root.id, entry.path, aside, expectOf(entry)));
    this.local.delete(entry.path);
    this.local.add(moved);
    this.sync.logActivity('conflict', null, entry.path, { detail: baseName(aside) });
    await this.bringDown(node.id, node, entry.path);
    return true;
  }

  // ─── New on this computer ───────────────────────────────────

  async localNew(): Promise<number> {
    let did = 0;
    const fresh = [...this.local.byKey.values()]
      .filter((entry) => !this.isClaimed(entry) && !isSystemFileName(baseName(entry.path)))
      .sort((a, b) => depthOf(a.path) - depthOf(b.path));
    for (const entry of fresh) {
      if (this.isClaimed(entry) || this.sync.isSkipped(entry.path)) continue;
      const parentId = this.idAtLocal(parentPath(entry.path));
      if (parentId === undefined) continue;
      did += await this.step(null, entry.path, 'up', async () => {
        const name = this.remote.acceptedName(baseName(entry.path));
        if (entry.kind === 'directory') {
          const node = await this.remote.createFolder(name, parentId);
          this.tree.put(node);
          this.view.set(node.id, node);
          const local = this.drive ? await this.markDrive(entry.path, node.id, entry).catch(() => entry) : entry;
          this.claim(entry);
          this.matched.set(node.id, local);
          this.remember(this.itemOf(node, local, entry.path));
          this.sync.logActivity('folder-created', 'up', entry.path);
          return true;
        }
        const bytes = await this.uploadBytes(entry, null);
        if (!bytes) return false;
        const node = await this.remote.createFile(name, parentId, bytes);
        this.tree.put(node);
        this.view.set(node.id, node);
        const local = await this.markDrive(entry.path, node.id, bytes.read);
        this.claim(entry);
        this.matched.set(node.id, local);
        this.remember(this.itemOf(node, local, entry.path));
        this.sync.logActivity('uploaded', 'up', entry.path);
        return true;
      });
    }
    return did;
  }

  // ─── Deletes ────────────────────────────────────────────────

  /** Base items below `item` (by path), itself not counted. */
  private below(item: BaseItem): BaseItem[] {
    return [...this.base.values()].filter((other) => other.id !== item.id && isUnderPath(other.path, item.path));
  }

  planDeletes(): { local: { count: number; ids: string[] }; remote: { count: number; ids: string[] } } {
    const local = { count: 0, ids: [] as string[] };
    const remote = { count: 0, ids: [] as string[] };
    const covered = new Set<string>();
    for (const item of this.sortedBase()) {
      if (covered.has(item.id) || !this.base.has(item.id)) continue;
      const entry = this.matched.get(item.id);
      const node = this.view.get(item.id);
      if (!entry && !node) {
        this.base.delete(item.id);
        this.dropped += 1;
        continue;
      }
      if (entry && node) continue;
      if (node) {
        // Gone from this computer. Changed or moved in Files meanwhile: it comes back.
        if (this.remoteChanged(item, node) || node.name !== item.name || node.parentId !== item.parentId) {
          this.giveBack(item);
          continue;
        }
        if (item.kind === 'directory') {
          const inside = this.tree.subtree(item.id) ?? [];
          const touched = inside.some((child) => {
            const known = this.base.get(child.id);
            return !known || known.parentId !== child.parentId || known.name !== child.name || this.remoteChanged(known, child);
          });
          if (touched) {
            this.giveBack(item);
            continue;
          }
          // Something in it was moved out here, and Files hasn't heard yet: the next round.
          if (inside.some((child) => this.matched.has(child.id))) continue;
        }
        const under = this.below(item);
        for (const other of under) covered.add(other.id);
        remote.ids.push(item.id);
        remote.count += 1 + under.length;
        continue;
      }
      // Gone from Files. Changed here meanwhile: it goes up again.
      const here = entry as FilesLocalEntry;
      if (this.localChanged(item, here)) {
        this.giveBack(item);
        continue;
      }
      if (item.kind === 'directory') {
        const owners = new Map<FilesLocalEntry, string>();
        for (const [id, seen] of this.matched) owners.set(seen, id);
        let keep = false;
        let wait = false;
        for (const other of this.local.byKey.values()) {
          if (other.path === here.path || !isUnderPath(other.path, here.path, this.naming)) continue;
          if (isSystemFileName(baseName(other.path)) && !owners.has(other)) continue;
          const id = owners.get(other);
          const known = id ? this.base.get(id) : undefined;
          if (!known || this.localChanged(known, other)) keep = true;
          // Moved out in Files, and not yet here: the next round.
          else if (this.view.has(known.id)) wait = true;
        }
        if (keep) {
          this.giveBack(item);
          continue;
        }
        if (wait) continue;
      }
      const under = this.below(item);
      for (const other of under) covered.add(other.id);
      local.ids.push(item.id);
      local.count += 1 + under.length;
    }
    return { local, remote };
  }

  /** The record forgets an item and what's below it. */
  private forgetTree(item: BaseItem): void {
    for (const other of this.below(item)) this.base.delete(other.id);
    this.base.delete(item.id);
  }

  /** The record forgets an item and what's below it, so the side that still has them gives them back. */
  private giveBack(item: BaseItem): void {
    this.forgetTree(item);
    this.dropped += 1;
  }

  async deletes(plan: ReturnType<Round['planDeletes']>): Promise<number> {
    let did = 0;
    // In Files: one trash folder per parent, as the Files screen makes them.
    const byParent = new Map<string, BaseItem[]>();
    for (const id of plan.remote.ids) {
      const item = this.base.get(id);
      if (!item) continue;
      const key = item.parentId ?? '';
      byParent.set(key, [...(byParent.get(key) ?? []), item]);
    }
    for (const [parent, items] of byParent) {
      did += await this.step(null, items[0].path, 'up', async () => {
        const ids = items.map((item) => item.id);
        const trashBefore = this.tree.trashId();
        const { trashId, batchId } = await this.remote.trash(ids, parent || null, trashBefore, this.host.now());
        const now = this.host.now();
        if (!trashBefore) this.tree.put({ id: trashId, parentId: null, name: '.Trash', kind: 'directory', blobId: null, size: 0, modifiedMs: now, type: '' });
        this.tree.put({ id: batchId, parentId: trashId, name: `${now}~${parent}`, kind: 'directory', blobId: null, size: 0, modifiedMs: now, type: '' });
        for (const item of items) {
          const node = this.tree.get(item.id);
          if (node) this.tree.put({ ...node, parentId: batchId });
          this.view.delete(item.id);
          this.forgetTree(item);
          this.sync.logActivity('trashed', 'up', item.path);
        }
        return true;
      });
    }
    for (const id of plan.local.ids) {
      const item = this.base.get(id);
      const entry = this.matched.get(id);
      if (!item || !entry) continue;
      did += await this.step(null, entry.path, 'down', async () => {
        const how = unwrap(await this.host.controls.remove(this.root.id, entry.path, expectOf(entry)));
        this.local.delete(entry.path);
        this.forgetTree(item);
        this.sync.logActivity(how === 'trash' ? 'trashed' : 'deleted', 'down', entry.path);
        return true;
      });
    }
    return did;
  }
}

/** A placeholder this round placed, as a scan will show it. */
function reservedEntry(node: RemoteNode, path: string): FilesLocalEntry {
  return {
    path,
    kind: node.kind,
    size: node.kind === 'file' ? node.size : 0,
    mtimeMs: node.modifiedMs,
    fileId: '',
    placeholder: { identity: node.id, inSync: true, hydrated: node.kind === 'directory', pin: 'unspecified' },
  };
}

function placeholderOf(node: RemoteNode, path: string): FilesPlaceholder {
  return { path, kind: node.kind, size: node.kind === 'file' ? node.size : 0, mtimeMs: node.modifiedMs || Date.now(), identity: node.id };
}

function concat(parts: Uint8Array[], size: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const TYPES: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', htm: 'text/html', json: 'application/json',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  heic: 'image/heic', mp3: 'audio/mpeg', mp4: 'video/mp4', mov: 'video/quicktime', zip: 'application/zip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
};

/** A media type from the name, as the server shows it. Anything else is plain bytes. */
export function typeFor(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return (dot > 0 && TYPES[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}
