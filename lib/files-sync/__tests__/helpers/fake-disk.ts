/**
 * The desktop app's disk side of Files on this computer, in memory, answering as main does
 * (desktop src/main/files/disk.ts, drive-controller.ts, features/files-folders.ts):
 * - `expect` is checked on write, move and remove; null on a write means nothing may be there;
 * - a move never overwrites, and a case-only rename works on a case-insensitive disk;
 * - a folder root's remove goes to the trash, the drive's deletes;
 * - `openRead` refuses folders and drive files whose content isn't here;
 * - while locked, `roots()` is empty, everything else `inactive`, and the state calls reject;
 * - the drive: placeholders with an identity, `update` refused with `changed` once someone wrote
 *   over one, `markInSync` making a file a placeholder again, fetches answered by `supply`.
 */

import type {
  FilesChangeEvent,
  FilesControls,
  FilesDriveControls,
  FilesDriveState,
  FilesDriveStatus,
  FilesExpect,
  FilesFetchRequest,
  FilesLocalEntry,
  FilesPlaceholder,
  FilesPlaceholderState,
  FilesResult,
  FilesRoot,
} from '@/lib/desktop/types';

interface DiskNode {
  kind: 'file' | 'directory';
  data: Uint8Array | null;
  /** For a dehydrated placeholder, its size. */
  size: number;
  fileId: string;
  mtimeMs: number;
  placeholder?: FilesPlaceholderState;
}

const ok = <T>(value: T): FilesResult<T> => ({ ok: true, value });
const fail = <T = never>(error: Parameters<typeof failOf>[0]): FilesResult<T> => failOf(error) as FilesResult<T>;
function failOf(error: Exclude<FilesResult<never>, { ok: true }>['error']) {
  return { ok: false as const, error };
}

export const text = (value: string) => new TextEncoder().encode(value);
export const str = (value: Uint8Array | null | undefined) => (value ? new TextDecoder().decode(value) : '');

let fileIds = 1;

export interface FakeDiskOptions {
  caseInsensitive?: boolean;
  drive?: boolean;
}

export class FakeDisk implements FilesControls {
  readonly rootsList: FilesRoot[] = [];
  readonly trees = new Map<string, Map<string, DiskNode>>();
  readonly states = new Map<string, string>();
  readonly trashed: string[] = [];
  readonly shown: { rootId: string; path: string }[] = [];
  readonly calls: string[] = [];
  locked = false;
  clock = Date.UTC(2026, 10, 1);
  private readonly listeners = new Set<(event: FilesChangeEvent) => void>();
  private readonly fetchListeners = new Set<(request: FilesFetchRequest) => void>();
  private readonly cancelListeners = new Set<(fetchId: string) => void>();
  private readonly reads = new Map<string, { rootId: string; path: string }>();
  private readonly writes = new Map<string, { rootId: string; path: string; expect: FilesExpect | null; mtimeMs: number; size: number; parts: Uint8Array[] }>();
  /** Called when a read URL is fetched, before the bytes go: to change the file meanwhile. */
  onRead: ((rootId: string, path: string) => void) | null = null;
  /** Bytes supplied per fetch. */
  readonly supplied = new Map<string, { offset: number; length: number; parts: Uint8Array[] }>();
  readonly fetchFailed = new Map<string, string>();
  /** Supply answers false from this many bytes on (Windows no longer wants them). */
  refuseSupplyAfter: number | null = null;
  readonly driveCalls: { call: string; args: unknown[] }[] = [];
  /** What the page told main for Explorer, in order. */
  readonly driveStatuses: { account: string; status: FilesDriveStatus }[] = [];
  driveWanted: string[] = [];
  /** What `disable` answers about files that weren't uploaded (main copies them to Documents). */
  rescueAnswer: { folder: string; count: number; failed: number } | null = null;
  /** Main asking the page to upload what waits before the policy removes the drive. */
  readonly flushListeners = new Set<(request: { requestId: string; accounts: string[] }) => void>();
  readonly flushed: string[] = [];
  /** Drive roots disconnected by a sign-out nobody chose: their folders stay. */
  private readonly suspended = new Map<string, FilesRoot>();
  readonly drive?: FilesDriveControls;
  private nextWrite = 1;

  constructor(private readonly options: FakeDiskOptions = {}) {
    if (options.drive) this.drive = this.makeDrive();
  }

  // ─── Test setup and what a user does ────────────────────────

  addRoot(root: Partial<FilesRoot> & { id: string; account: string }): FilesRoot {
    const full: FilesRoot = { kind: 'folder', path: `C:\\sync\\${root.id}`, remoteId: null, remoteLabel: '', paused: false, createdAt: 1, ...root };
    this.rootsList.push(full);
    this.trees.set(full.id, new Map());
    return full;
  }

  private tree(rootId: string): Map<string, DiskNode> {
    const tree = this.trees.get(rootId);
    if (!tree) throw new Error(`no root ${rootId}`);
    return tree;
  }

  private key(path: string): string {
    return this.options.caseInsensitive ? path.toLowerCase() : path;
  }

  /** The stored path for `path`, as cased on disk. */
  private find(rootId: string, path: string): string | null {
    const tree = this.tree(rootId);
    if (tree.has(path)) return path;
    if (!this.options.caseInsensitive) return null;
    const wanted = this.key(path);
    for (const stored of tree.keys()) if (this.key(stored) === wanted) return stored;
    return null;
  }

  private tick(): number {
    this.clock += 1000;
    return this.clock;
  }

  private parentOk(rootId: string, path: string): boolean {
    const slash = path.lastIndexOf('/');
    if (slash < 0) return true;
    const parent = this.find(rootId, path.slice(0, slash));
    return !!parent && this.tree(rootId).get(parent)?.kind === 'directory';
  }

  /** A user writes a file: a new one, or over the old one in place (same file id). */
  write(rootId: string, path: string, content: string | Uint8Array): void {
    const data = typeof content === 'string' ? text(content) : content;
    this.ensureParents(rootId, path);
    const tree = this.tree(rootId);
    const stored = this.find(rootId, path);
    const old = stored ? tree.get(stored) : undefined;
    const node: DiskNode = { kind: 'file', data, size: data.length, fileId: old?.fileId ?? `f${fileIds++}`, mtimeMs: this.tick() };
    if (old?.placeholder) {
      // Saved over with a plain write: no longer a placeholder.
      node.placeholder = { identity: null, inSync: false, hydrated: true, pin: 'unspecified' };
    } else if (this.isDrive(rootId)) {
      node.placeholder = { identity: null, inSync: false, hydrated: true, pin: 'unspecified' };
    }
    tree.set(stored ?? path, node);
  }

  /** An app that keeps the placeholder edits a hydrated drive file: no longer in sync. */
  editInPlace(rootId: string, path: string, content: string): void {
    const node = this.node(rootId, path);
    node.data = text(content);
    node.size = node.data.length;
    node.mtimeMs = this.tick();
    if (node.placeholder) node.placeholder = { ...node.placeholder, inSync: false, hydrated: true };
  }

  mkdirUser(rootId: string, path: string): void {
    this.ensureParents(rootId, `${path}/x`);
  }

  private ensureParents(rootId: string, path: string): void {
    const parts = path.split('/');
    const tree = this.tree(rootId);
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join('/');
      if (!this.find(rootId, dir)) {
        tree.set(dir, {
          kind: 'directory', data: null, size: 0, fileId: `f${fileIds++}`, mtimeMs: this.tick(),
          ...(this.isDrive(rootId) ? { placeholder: { identity: null, inSync: false, hydrated: true, pin: 'unspecified' as const } } : {}),
        });
      }
    }
  }

  moveUser(rootId: string, from: string, to: string): void {
    const result = this.moveTree(rootId, from, to);
    if (!result) throw new Error(`move ${from} -> ${to} failed`);
  }

  deleteUser(rootId: string, path: string): void {
    const tree = this.tree(rootId);
    const stored = this.find(rootId, path) ?? path;
    for (const key of [...tree.keys()]) if (key === stored || key.startsWith(`${stored}/`)) tree.delete(key);
  }

  node(rootId: string, path: string): DiskNode {
    const stored = this.find(rootId, path);
    const node = stored ? this.tree(rootId).get(stored) : undefined;
    if (!node) throw new Error(`nothing at ${path}`);
    return node;
  }

  has(rootId: string, path: string): boolean {
    return this.find(rootId, path) === path;
  }

  read(rootId: string, path: string): string {
    return str(this.node(rootId, path).data);
  }

  /** Every path in a root, sorted, folders with a trailing slash. */
  listing(rootId: string): string[] {
    return [...this.tree(rootId)].map(([path, node]) => (node.kind === 'directory' ? `${path}/` : path)).sort();
  }

  emit(rootId: string, paths: string[] | null = null): void {
    for (const listener of [...this.listeners]) listener({ rootId, paths });
  }

  private isDrive(rootId: string): boolean {
    return this.rootsList.find((root) => root.id === rootId)?.kind === 'drive';
  }

  private active(rootId: string): boolean {
    const root = this.rootsList.find((entry) => entry.id === rootId);
    return !this.locked && !!root && !root.paused;
  }

  private entry(path: string, node: DiskNode): FilesLocalEntry {
    return {
      path,
      kind: node.kind,
      size: node.kind === 'directory' ? 0 : node.size,
      mtimeMs: node.mtimeMs,
      fileId: node.fileId,
      ...(node.placeholder ? { placeholder: { ...node.placeholder } } : {}),
    };
  }

  private matches(node: DiskNode | undefined, expect: FilesExpect | null): boolean {
    if (expect === null) return !node;
    if (!node) return false;
    return node.fileId === expect.fileId && (node.kind === 'directory' ? 0 : node.size) === expect.size && node.mtimeMs === expect.mtimeMs;
  }

  private moveTree(rootId: string, from: string, to: string): DiskNode | null {
    const tree = this.tree(rootId);
    const source = this.find(rootId, from);
    if (!source) return null;
    const target = this.find(rootId, to);
    if (target && this.key(target) !== this.key(source)) return null;
    if (!this.parentOk(rootId, to)) return null;
    const moving = [...tree].filter(([key]) => key === source || key.startsWith(`${source}/`));
    for (const [key] of moving) tree.delete(key);
    for (const [key, node] of moving) tree.set(to + key.slice(source.length), node);
    return tree.get(to) ?? null;
  }

  // ─── FilesControls ──────────────────────────────────────────

  async roots(): Promise<FilesRoot[]> {
    return this.locked ? [] : this.rootsList.map((root) => ({ ...root }));
  }

  async addFolder(request: { account: string; remoteId: string | null; remoteLabel: string }): Promise<FilesResult<FilesRoot>> {
    this.calls.push(`addFolder ${request.account} ${request.remoteId}`);
    const root = this.addRoot({ id: `r${this.rootsList.length + 1}`, account: request.account, remoteId: request.remoteId, remoteLabel: request.remoteLabel });
    return ok(root);
  }

  async removeRoot(rootId: string): Promise<void> {
    this.calls.push(`removeRoot ${rootId}`);
    const at = this.rootsList.findIndex((root) => root.id === rootId);
    if (at >= 0) this.rootsList.splice(at, 1);
  }

  async setPaused(rootId: string, paused: boolean): Promise<void> {
    const root = this.rootsList.find((entry) => entry.id === rootId);
    if (root) root.paused = paused;
    if (!paused) this.emit(rootId, null);
  }

  async scan(rootId: string): Promise<FilesResult<FilesLocalEntry[]>> {
    if (!this.active(rootId)) return fail('inactive');
    return ok([...this.tree(rootId)].map(([path, node]) => this.entry(path, node)));
  }

  async stat(rootId: string, path: string): Promise<FilesResult<FilesLocalEntry | null>> {
    if (!this.active(rootId)) return fail('inactive');
    const stored = this.find(rootId, path);
    return ok(stored ? this.entry(stored, this.tree(rootId).get(stored) as DiskNode) : null);
  }

  async openRead(rootId: string, path: string): Promise<FilesResult<{ url: string; entry: FilesLocalEntry }>> {
    if (!this.active(rootId)) return fail('inactive');
    const stored = this.find(rootId, path);
    const node = stored ? this.tree(rootId).get(stored) : undefined;
    if (!node) return fail('missing');
    if (node.kind !== 'file' || !node.data || (node.placeholder && !node.placeholder.hydrated)) return fail('unsupported');
    const token = `mem://${this.reads.size + 1}-${Math.random().toString(36).slice(2)}`;
    this.reads.set(token, { rootId, path: stored as string });
    return ok({ url: token, entry: this.entry(stored as string, node) });
  }

  /** What the page's fetch of a read URL gets. */
  readUrl = async (url: string): Promise<Uint8Array> => {
    const grant = this.reads.get(url);
    this.reads.delete(url);
    if (!grant) throw new Error('404');
    const node = this.node(grant.rootId, grant.path);
    const data = node.data as Uint8Array;
    this.onRead?.(grant.rootId, grant.path);
    return data;
  };

  async beginWrite(rootId: string, path: string, options: { expect: FilesExpect | null; mtimeMs: number; size: number }): Promise<FilesResult<string>> {
    if (!this.active(rootId)) return fail('inactive');
    if (!this.parentOk(rootId, path)) return fail('missing');
    const stored = this.find(rootId, path);
    const node = stored ? this.tree(rootId).get(stored) : undefined;
    if (node?.kind === 'directory') return fail('exists');
    if (!this.matches(node, options.expect)) return fail(options.expect ? 'changed' : 'exists');
    const id = `w${this.nextWrite++}`;
    this.writes.set(id, { rootId, path, expect: options.expect, mtimeMs: options.mtimeMs, size: options.size, parts: [] });
    return ok(id);
  }

  async writeChunk(writeId: string, data: Uint8Array): Promise<FilesResult<null>> {
    const write = this.writes.get(writeId);
    if (!write) return fail('missing');
    write.parts.push(new Uint8Array(data));
    return ok(null);
  }

  async commitWrite(writeId: string): Promise<FilesResult<FilesLocalEntry>> {
    const write = this.writes.get(writeId);
    this.writes.delete(writeId);
    if (!write) return fail('missing');
    if (!this.active(write.rootId)) return fail('inactive');
    const size = write.parts.reduce((sum, part) => sum + part.length, 0);
    if (size !== write.size) return fail('failed');
    const stored = this.find(write.rootId, write.path);
    const tree = this.tree(write.rootId);
    const old = stored ? tree.get(stored) : undefined;
    if (!this.matches(old, write.expect)) return fail(write.expect ? 'changed' : 'exists');
    const data = new Uint8Array(size);
    let at = 0;
    for (const part of write.parts) {
      data.set(part, at);
      at += part.length;
    }
    const node: DiskNode = { kind: 'file', data, size, fileId: `f${fileIds++}`, mtimeMs: write.mtimeMs };
    tree.set(stored ?? write.path, node);
    return ok(this.entry(stored ?? write.path, node));
  }

  async abortWrite(writeId: string): Promise<void> {
    this.writes.delete(writeId);
  }

  get openWrites(): number {
    return this.writes.size;
  }

  async mkdir(rootId: string, path: string): Promise<FilesResult<FilesLocalEntry>> {
    if (!this.active(rootId)) return fail('inactive');
    if (!this.parentOk(rootId, path)) return fail('missing');
    const stored = this.find(rootId, path);
    const tree = this.tree(rootId);
    if (stored) {
      const node = tree.get(stored) as DiskNode;
      return node.kind === 'directory' ? ok(this.entry(stored, node)) : fail('exists');
    }
    const node: DiskNode = { kind: 'directory', data: null, size: 0, fileId: `f${fileIds++}`, mtimeMs: this.tick() };
    tree.set(path, node);
    return ok(this.entry(path, node));
  }

  async move(rootId: string, from: string, to: string, expect: FilesExpect | null): Promise<FilesResult<FilesLocalEntry>> {
    if (!this.active(rootId)) return fail('inactive');
    const source = this.find(rootId, from);
    if (!source) return fail('missing');
    const node = this.tree(rootId).get(source) as DiskNode;
    if (expect && !this.matches(node, expect)) return fail('changed');
    const target = this.find(rootId, to);
    if (target && this.key(target) !== this.key(source)) return fail('exists');
    if (!this.parentOk(rootId, to)) return fail('missing');
    const moved = this.moveTree(rootId, source, to);
    return moved ? ok(this.entry(to, moved)) : fail('failed');
  }

  async remove(rootId: string, path: string, expect: FilesExpect | null): Promise<FilesResult<'trash' | 'deleted'>> {
    if (!this.active(rootId)) return fail('inactive');
    const stored = this.find(rootId, path);
    if (!stored) return fail('missing');
    const node = this.tree(rootId).get(stored) as DiskNode;
    if (expect && !this.matches(node, expect)) return fail('changed');
    this.deleteUser(rootId, stored);
    this.trashed.push(stored);
    return ok(this.isDrive(rootId) ? 'deleted' : 'trash');
  }

  onChange(listener: (event: FilesChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async loadState(rootId: string): Promise<string | null> {
    if (this.locked) throw new Error('Locked');
    return this.states.get(rootId) ?? null;
  }

  async saveState(rootId: string, state: string): Promise<void> {
    if (this.locked) throw new Error('Locked');
    if (!this.rootsList.some((root) => root.id === rootId)) throw new Error('No such root');
    this.states.set(rootId, state);
  }

  async showInFolder(rootId: string, path: string): Promise<boolean> {
    this.shown.push({ rootId, path });
    return true;
  }

  // ─── The drive ──────────────────────────────────────────────

  /** Windows asks for a file someone opened. */
  requestFetch(rootId: string, path: string, offset = 0): FilesFetchRequest {
    const node = this.node(rootId, path);
    const fetchId = `fetch${this.supplied.size + this.fetchFailed.size + 1}-${Math.random().toString(36).slice(2, 6)}`;
    const start = Math.floor(offset / 4096) * 4096;
    const request: FilesFetchRequest = { fetchId, rootId, identity: node.placeholder?.identity ?? '', path, offset: start, length: node.size - start, total: node.size };
    this.supplied.set(fetchId, { offset: start, length: 0, parts: [] });
    for (const listener of [...this.fetchListeners]) listener(request);
    return request;
  }

  /** Everything supplied for a fetch, in one piece. */
  suppliedBytes(fetchId: string): Uint8Array {
    const got = this.supplied.get(fetchId);
    const out = new Uint8Array(got?.length ?? 0);
    let at = 0;
    for (const part of got?.parts ?? []) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  cancelFetch(fetchId: string): void {
    for (const listener of [...this.cancelListeners]) listener(fetchId);
  }

  private makeDrive(): FilesDriveControls {
    // The bridge hands these out as plain functions, as the preload does.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const disk = this;
    const record = (call: string, ...args: unknown[]) => disk.driveCalls.push({ call, args });
    const state = (): FilesDriveState => ({ supported: true, forcedOff: false, wanted: [...disk.driveWanted], letter: { letter: null, chosen: null, locked: false, available: ['E'] } });
    return {
      state: async () => state(),
      onStateChange: () => () => {},
      status: (account, status) => {
        disk.driveStatuses.push({ account, status });
      },
      enable: async (account, label) => {
        record('enable', account, label);
        if (!disk.driveWanted.includes(account)) disk.driveWanted.push(account);
        const existing = disk.rootsList.find((root) => root.kind === 'drive' && root.account === account);
        const back = disk.suspended.get(account);
        if (!existing && back) {
          disk.suspended.delete(account);
          disk.rootsList.push(back);
          return ok(back);
        }
        return ok(existing ?? disk.addRoot({ id: `drive-${account}`, account, kind: 'drive', remoteId: null, remoteLabel: label }));
      },
      disable: async (account, reason) => {
        record('disable', account, reason);
        if (reason !== 'signed-out' && reason !== 'suspended') disk.driveWanted = disk.driveWanted.filter((entry) => entry !== account);
        const at = disk.rootsList.findIndex((root) => root.kind === 'drive' && root.account === account);
        if (at >= 0) {
          const [root] = disk.rootsList.splice(at, 1);
          // Disconnected only: the folder and what's in it stay.
          if (reason === 'suspended') disk.suspended.set(account, root);
          else disk.trees.set(root.id, new Map());
        }
        return { rescued: reason === 'user' || reason === 'signed-out' ? disk.rescueAnswer : null };
      },
      onFlush: (listener) => {
        disk.flushListeners.add(listener);
        return () => disk.flushListeners.delete(listener);
      },
      flushed: (requestId) => {
        disk.flushed.push(requestId);
      },
      openRescue: async () => {
        record('openRescue');
        return disk.rescueAnswer !== null;
      },
      place: async (rootId, entries: FilesPlaceholder[]) => {
        record('place', rootId, entries.length);
        if (!disk.active(rootId)) return fail('inactive');
        const tree = disk.tree(rootId);
        const answers = entries.map((entry) => {
          if (!disk.parentOk(rootId, entry.path)) return { path: entry.path, error: 'missing' as const };
          if (disk.find(rootId, entry.path)) return { path: entry.path, error: 'exists' as const };
          tree.set(entry.path, {
            kind: entry.kind,
            data: null,
            size: entry.kind === 'file' ? entry.size : 0,
            fileId: `f${fileIds++}`,
            mtimeMs: entry.mtimeMs,
            placeholder: { identity: entry.identity, inSync: true, hydrated: entry.kind === 'directory', pin: 'unspecified' },
          });
          return { path: entry.path };
        });
        return ok(answers);
      },
      update: async (rootId, path, meta, expect) => {
        record('update', rootId, path, meta.dehydrate);
        if (!disk.active(rootId)) return fail('inactive');
        const stored = disk.find(rootId, path);
        const node = stored ? disk.tree(rootId).get(stored) : undefined;
        if (!node) return fail('missing');
        if (expect && !disk.matches(node, expect)) return fail('changed');
        if (!node.placeholder?.identity || !node.placeholder.inSync) return fail('changed');
        node.size = meta.size;
        node.mtimeMs = meta.mtimeMs;
        node.placeholder = { ...node.placeholder, identity: meta.identity, inSync: true };
        if (meta.dehydrate) {
          node.data = null;
          node.placeholder.hydrated = false;
        }
        return ok(disk.entry(stored as string, node));
      },
      markInSync: async (rootId, path, identity, expect) => {
        record('markInSync', rootId, path, identity);
        if (!disk.active(rootId)) return fail('inactive');
        const stored = disk.find(rootId, path);
        const node = stored ? disk.tree(rootId).get(stored) : undefined;
        if (!node) return fail('missing');
        if (!disk.matches(node, expect)) return fail('changed');
        node.placeholder = { identity, inSync: true, hydrated: true, pin: node.placeholder?.pin ?? 'unspecified' };
        return ok(disk.entry(stored as string, node));
      },
      onFetch: (listener) => {
        disk.fetchListeners.add(listener);
        return () => disk.fetchListeners.delete(listener);
      },
      onFetchCancel: (listener) => {
        disk.cancelListeners.add(listener);
        return () => disk.cancelListeners.delete(listener);
      },
      supply: async (fetchId, offset, data) => {
        const got = disk.supplied.get(fetchId);
        if (!got) return false;
        if (offset !== got.offset + got.length) return false;
        if (disk.refuseSupplyAfter !== null && got.length >= disk.refuseSupplyAfter) return false;
        got.parts.push(new Uint8Array(data));
        got.length += data.length;
        return true;
      },
      fail: (fetchId, error) => {
        disk.fetchFailed.set(fetchId, error);
      },
      setLetter: async (letter) => {
        record('setLetter', letter);
        return ok({ letter, chosen: letter, locked: false, available: ['E'] });
      },
    };
  }
}
