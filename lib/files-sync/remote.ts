/**
 * The Files side of Files on this computer: one account's FileNode tree, read once and then
 * kept current with FileNode/changes, and the writes the engine makes.
 *
 * It goes through a JmapTransport (lib/store/engine/transport.ts): the host gives it one that
 * borrows the app's own JMAP session and Authorization header, so nothing new holds a token or a
 * password. Tests give it a fake server, and the real-server tests a FetchTransport.
 *
 * Reading the whole tree is done as lib/store/files/sync.ts does it, because neither server
 * gives it in one call: `FileNode/get` with ids null stops at maxObjectsInGet on 0.16 and is
 * refused on 1.0 (`requestTooLarge`); past that, ids come from paging FileNode/query from the
 * last id read (`anchor`), and before 0.16.6 that query leaves out folders, so parents still
 * unknown afterwards are read by id. Unlike the Files screen, a listing that breaks off fails:
 * a partial tree would read as files deleted.
 *
 * Writes follow lib/jmap/client.ts: a folder is a node without blobId, type or size (0.16 makes
 * a 0-byte file of anything else); Stalwart 1.0 wants `@type` and `mediaType` in a create; size
 * is never sent; `onExists: "rename"` is not used here, since a name the engine didn't choose
 * would be a second copy the disk doesn't know about.
 */

import { acceptedFileName, fileNameRulesFrom, type FileNameRules } from '@/lib/file-name-rules';
import { fileNodeKind, fromDraftFileNode, toDraftFileNodeCreate } from '@/lib/jmap/filenode-kind';
import { decodeFileNodeName } from '@/lib/jmap/filenode-name';
import type { FileNode } from '@/lib/jmap/types';
import { mediaTypeEssence, OCTET_STREAM } from '@/lib/media-type';
import { TRASH_FOLDER_NAME, trashBatchName } from '@/lib/files-trash';
import { runChangesLoop } from '@/lib/store/engine/changes';
import { requestLimits } from '@/lib/store/engine/limits';
import { JmapMethodError, responseFor, type JmapTransport, type MethodCall, type StoreSession } from '@/lib/store/engine/transport';

export const FILES_CAPABILITY = 'urn:ietf:params:jmap:filenode';
export const FILES_USING = ['urn:ietf:params:jmap:core', FILES_CAPABILITY];
const PROPERTIES = ['id', 'parentId', 'name', 'type', 'blobId', 'size', 'created', 'modified', 'nodeType', '@type', 'mediaType'];
const QUERY_PAGE = 5000;
const MOST_GETS_PER_REQUEST = 8;
const MOST_IDS = 2_000_000;

export interface RemoteNode {
  id: string;
  parentId: string | null;
  name: string;
  kind: 'file' | 'directory';
  blobId: string | null;
  size: number;
  /** Milliseconds; 0 when the server gave none. */
  modifiedMs: number;
  type: string;
}

/** A set call the server refused for one object. */
export class RemoteSetError extends Error {
  constructor(readonly type: string, description?: string) {
    super(description ? `${type}: ${description}` : type);
    this.name = 'RemoteSetError';
  }
}

type Wire = Record<string, unknown> & { id: string };

/** A node as the engine uses it, from either draft. Symlinks (1.0) are left out: nothing to sync. */
export function nodeFromWire(raw: Wire): RemoteNode | null {
  const node = fromDraftFileNode(raw as unknown as FileNode & { '@type'?: unknown; mediaType?: unknown });
  const kind = fileNodeKind(node);
  if (kind === 'symlink') return null;
  const modified = typeof node.modified === 'string' ? Date.parse(node.modified) : NaN;
  return {
    id: String(node.id),
    parentId: node.parentId == null ? null : String(node.parentId),
    name: decodeFileNodeName(String(node.name ?? '')),
    kind,
    blobId: kind === 'file' ? (node.blobId ?? null) : null,
    size: kind === 'file' && typeof node.size === 'number' ? node.size : 0,
    modifiedMs: Number.isFinite(modified) ? modified : 0,
    type: typeof node.type === 'string' && node.type ? node.type : OCTET_STREAM,
  };
}

export interface ChangeBatch {
  changed: RemoteNode[];
  destroyed: string[];
}

export class FilesRemote {
  constructor(
    readonly transport: JmapTransport,
    private readonly session: () => StoreSession,
  ) {}

  /** The account Files lives in. */
  jmap(): string {
    const session = this.session();
    return session.primaryAccounts[FILES_CAPABILITY] ?? session.primaryAccounts['urn:ietf:params:jmap:core'] ?? Object.keys(session.accounts)[0] ?? '';
  }

  supported(): boolean {
    const session = this.session();
    const account = session.accounts[this.jmap()];
    return !!session.capabilities[FILES_CAPABILITY] && !!account?.accountCapabilities?.[FILES_CAPABILITY];
  }

  /** The largest upload the server takes, in bytes. 0: it doesn't say. */
  maxUpload(): number {
    const core = this.session().capabilities['urn:ietf:params:jmap:core'] as { maxSizeUpload?: unknown } | undefined;
    return typeof core?.maxSizeUpload === 'number' && core.maxSizeUpload > 0 ? core.maxSizeUpload : 0;
  }

  private limits(): Record<string, unknown> | undefined {
    const session = this.session();
    return (session.accounts[this.jmap()]?.accountCapabilities?.[FILES_CAPABILITY] ?? session.capabilities[FILES_CAPABILITY]) as Record<string, unknown> | undefined;
  }

  nameRules(): FileNameRules | null {
    return fileNameRulesFrom(this.limits());
  }

  /** Stalwart 1.0 (File Storage draft 18): `@type` and `mediaType` in a create. */
  private usesDraftCreate(): boolean {
    const limits = this.limits();
    return !!limits && 'supportedNodeTypes' in limits;
  }

  /** Before 0.16.6: 30 characters of media type at most. */
  private legacy(): boolean {
    const limits = this.limits();
    return !!limits && !('forbiddenNameChars' in limits);
  }

  private mediaType(type: string): string {
    const essence = mediaTypeEssence(type);
    return this.legacy() && essence.length > 30 ? OCTET_STREAM : essence;
  }

  /** The name a new node gets on this server: what the disk had, made acceptable. */
  acceptedName(name: string): string {
    return acceptedFileName(name, this.nameRules());
  }

  private async fetchByIds(ids: string[]): Promise<Wire[]> {
    const jmap = this.jmap();
    const { maxObjectsInGet, maxCallsInRequest } = requestLimits(this.session());
    const perRequest = Math.min(MOST_GETS_PER_REQUEST, maxCallsInRequest);
    const out: Wire[] = [];
    for (let at = 0; at < ids.length;) {
      const calls: MethodCall[] = [];
      for (let i = 0; i < perRequest && at < ids.length; i += 1, at += maxObjectsInGet) {
        calls.push(['FileNode/get', { accountId: jmap, ids: ids.slice(at, at + maxObjectsInGet), properties: PROPERTIES }, `g${i}`]);
      }
      const response = await this.transport.request(calls, FILES_USING);
      for (const [, , callId] of calls) out.push(...(responseFor(response, callId)[1].list as Wire[]));
    }
    return out;
  }

  async get(ids: string[]): Promise<RemoteNode[]> {
    if (ids.length === 0) return [];
    return (await this.fetchByIds(ids)).map(nodeFromWire).filter((node): node is RemoteNode => !!node);
  }

  /** The state to go on from: read before the listing, so nothing that changes meanwhile is missed. */
  async currentState(): Promise<string> {
    const response = await this.transport.request([['FileNode/get', { accountId: this.jmap(), ids: [], properties: ['id'] }, 's']], FILES_USING);
    return String(responseFor(response, 's')[1].state);
  }

  /** Every node of the account, and the state it was read at. Throws rather than give part of it. */
  async listAll(): Promise<{ nodes: RemoteNode[]; state: string }> {
    const jmap = this.jmap();
    const state = await this.currentState();
    const known = new Map<string, Wire>();
    const { maxObjectsInGet } = requestLimits(this.session());
    let complete = false;
    try {
      const response = await this.transport.request([['FileNode/get', { accountId: jmap, ids: null, properties: PROPERTIES }, 'a']], FILES_USING);
      const list = responseFor(response, 'a')[1].list as Wire[];
      for (const node of list) known.set(String(node.id), node);
      complete = list.length < maxObjectsInGet;
    } catch (error) {
      if (!((error as Error)?.name === 'JmapMethodError' && (error as JmapMethodError).type === 'requestTooLarge')) throw error;
    }
    if (!complete) {
      let anchor: string | null = null;
      let position = 0;
      for (let pages = 0; position < MOST_IDS; pages += 1) {
        const from: Record<string, unknown> = anchor === null ? { position: 0 } : { anchor, anchorOffset: 1 };
        const response = await this.transport.request([['FileNode/query', { accountId: jmap, filter: {}, ...from, limit: QUERY_PAGE, calculateTotal: true }, 'q']], FILES_USING);
        let query: { ids: string[]; position?: number; total?: number };
        try {
          [, query] = responseFor(response, 'q');
        } catch (error) {
          if ((error as JmapMethodError)?.type === 'anchorNotFound' && pages < 50) {
            anchor = null;
            position = 0;
            continue;
          }
          throw error;
        }
        const ids = query.ids ?? [];
        const missing = ids.filter((id) => !known.has(id));
        for (const node of await this.fetchByIds(missing)) known.set(String(node.id), node);
        position = Number(query.position ?? 0) + ids.length;
        if (ids.length > 0) anchor = ids[ids.length - 1];
        if (ids.length === 0 || (typeof query.total === 'number' && position >= query.total)) break;
      }
      const asked = new Set<string>();
      for (;;) {
        const parents = new Set<string>();
        for (const node of known.values()) {
          const parent = node.parentId == null ? null : String(node.parentId);
          if (parent && !known.has(parent) && !asked.has(parent)) parents.add(parent);
        }
        if (parents.size === 0) break;
        for (const id of parents) asked.add(id);
        for (const node of await this.fetchByIds([...parents])) known.set(String(node.id), node);
      }
    }
    const nodes = [...known.values()].map(nodeFromWire).filter((node): node is RemoteNode => !!node);
    return { nodes, state };
  }

  /**
   * What changed since `since`, page by page. `resync`: the server can't say (the state is too
   * old or unknown), and the tree has to be read again.
   */
  async changes(since: string, apply: (batch: ChangeBatch, newState: string) => void): Promise<{ outcome: 'done' | 'resync'; state: string }> {
    const outcome = await runChangesLoop({
      transport: this.transport,
      type: 'FileNode',
      jmap: this.jmap(),
      using: FILES_USING,
      since,
      apply: async (page) => {
        const ids = [...new Set([...page.created, ...page.updated])];
        const wires = await this.fetchByIds(ids);
        const seen = new Set(wires.map((node) => String(node.id)));
        const changed = wires.map(nodeFromWire).filter((node): node is RemoteNode => !!node);
        // Asked for and gone already: as good as destroyed. A symlink is nothing to this side either.
        const gone = ids.filter((id) => !seen.has(id) || !changed.some((node) => node.id === id));
        apply({ changed, destroyed: [...page.destroyed, ...gone] }, page.newState);
      },
    });
    return { outcome: outcome.outcome === 'resync' ? 'resync' : 'done', state: outcome.state };
  }

  private async set(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.transport.request([['FileNode/set', { accountId: this.jmap(), ...args }, 's']], FILES_USING);
    return responseFor(response, 's')[1] as Record<string, unknown>;
  }

  private async createNode(props: Record<string, unknown>): Promise<RemoteNode> {
    const wire = this.usesDraftCreate() ? toDraftFileNodeCreate(props) : props;
    const result = await this.set({ create: { c: wire } });
    const created = (result.created as Record<string, Wire> | undefined)?.c;
    if (!created) {
      const error = (result.notCreated as Record<string, { type?: string; description?: string }> | undefined)?.c;
      throw new RemoteSetError(error?.type ?? 'serverFail', error?.description);
    }
    // A create answers with what the server set; the rest is what was sent.
    const [node] = await this.get([String(created.id)]);
    if (node) return node;
    const merged = nodeFromWire({ ...wire, ...created, id: String(created.id) } as Wire);
    if (!merged) throw new RemoteSetError('serverFail', 'The new node is gone');
    return merged;
  }

  createFolder(name: string, parentId: string | null): Promise<RemoteNode> {
    return this.createNode({ name, ...(parentId !== null ? { parentId } : {}) });
  }

  createFile(name: string, parentId: string | null, blob: { blobId: string; type: string }): Promise<RemoteNode> {
    return this.createNode({ name, type: this.mediaType(blob.type), blobId: blob.blobId, ...(parentId !== null ? { parentId } : {}) });
  }

  private async updateOne(id: string, patch: Record<string, unknown>): Promise<void> {
    const result = await this.set({ update: { [id]: patch } });
    const refused = (result.notUpdated as Record<string, { type?: string; description?: string }> | undefined)?.[id];
    if (refused) throw new RemoteSetError(refused.type ?? 'serverFail', refused.description);
  }

  async move(id: string, change: { name?: string; parentId?: string | null }): Promise<RemoteNode> {
    await this.updateOne(id, change);
    const [node] = await this.get([id]);
    if (!node) throw new RemoteSetError('notFound');
    return node;
  }

  /** New content for a file. `modified: null` has the server stamp it (1.0 keeps a set one otherwise). */
  async replaceBlob(id: string, blobId: string): Promise<RemoteNode> {
    await this.updateOne(id, { blobId, modified: null });
    const [node] = await this.get([id]);
    if (!node) throw new RemoteSetError('notFound');
    return node;
  }

  /**
   * Into Files' trash, the way the Files screen does it (lib/files-trash.ts): a folder per delete
   * inside `/.Trash`, named after when and where from, so Restore puts the items back.
   */
  async trash(ids: string[], fromParentId: string | null, trashId: string | null, now = Date.now()): Promise<{ trashId: string; batchId: string }> {
    let trash = trashId;
    if (!trash) trash = (await this.createFolder(TRASH_FOLDER_NAME, null)).id;
    const batch = await this.createFolder(trashBatchName(fromParentId, now), trash);
    const result = await this.set({ update: Object.fromEntries(ids.map((id) => [id, { parentId: batch.id }])) });
    const refused = Object.entries((result.notUpdated as Record<string, { type?: string; description?: string }> | undefined) ?? {});
    if (refused.length > 0) {
      const gone = refused.every(([, error]) => error?.type === 'notFound');
      if (refused.length === ids.length) await this.destroy([batch.id]).catch(() => {});
      if (!gone) throw new RemoteSetError(refused[0][1]?.type ?? 'serverFail', refused[0][1]?.description);
    }
    return { trashId: trash, batchId: batch.id };
  }

  async destroy(ids: string[]): Promise<void> {
    const result = await this.set({ destroy: ids, onDestroyRemoveChildren: true });
    const refused = Object.values((result.notDestroyed as Record<string, { type?: string; description?: string }> | undefined) ?? {})
      .filter((error) => error?.type !== 'notFound');
    if (refused.length > 0) throw new RemoteSetError(refused[0]?.type ?? 'serverFail', refused[0]?.description);
  }

  upload(data: Uint8Array, type: string): Promise<{ blobId: string; type: string; size: number }> {
    return this.transport.upload(this.jmap(), data, type || OCTET_STREAM);
  }

  /** A file's bytes, piece by piece. An error thrown by `sink` stops it and comes out as it is. */
  async download(node: Pick<RemoteNode, 'blobId' | 'type' | 'name'>, sink: (part: Uint8Array) => void): Promise<void> {
    if (!node.blobId) throw new RemoteSetError('notFound', 'No content');
    const jmap = this.jmap();
    if (this.transport.downloadStream) {
      await this.transport.downloadStream(jmap, node.blobId, node.type || OCTET_STREAM, node.name || 'file', sink);
      return;
    }
    sink(await this.transport.download(jmap, node.blobId, node.type || OCTET_STREAM, node.name || 'file'));
  }
}

/** One account's tree in memory, with where each node is. */
export class RemoteTree {
  readonly nodes = new Map<string, RemoteNode>();
  private childIndex: Map<string, Set<string>> | null = null;
  state: string | null = null;
  /**
   * Nodes the engine wrote since `state`. FileNode/changes leaves out a node created and
   * destroyed after the state it starts from, so one of these gone meanwhile is never said
   * to be gone: they are looked at once the changes are read.
   */
  readonly written = new Set<string>();

  reset(nodes: RemoteNode[], state: string): void {
    this.nodes.clear();
    this.written.clear();
    for (const node of nodes) this.nodes.set(node.id, node);
    this.state = state;
    this.childIndex = null;
  }

  apply(batch: ChangeBatch): void {
    for (const id of batch.destroyed) this.nodes.delete(id);
    for (const node of batch.changed) this.nodes.set(node.id, node);
    // A folder destroyed takes what was in it; the server says so too, but not always in the same page.
    if (batch.destroyed.length > 0) {
      let removed = true;
      while (removed) {
        removed = false;
        for (const node of this.nodes.values()) {
          if (node.parentId && !this.nodes.has(node.parentId)) {
            this.nodes.delete(node.id);
            removed = true;
          }
        }
      }
    }
    this.childIndex = null;
  }

  /** What the engine itself wrote. */
  put(node: RemoteNode): void {
    this.nodes.set(node.id, node);
    this.written.add(node.id);
    this.childIndex = null;
  }

  remove(id: string): void {
    for (const child of this.children(id)) this.remove(child.id);
    this.nodes.delete(id);
    this.childIndex = null;
  }

  get(id: string): RemoteNode | undefined {
    return this.nodes.get(id);
  }

  children(parentId: string | null): RemoteNode[] {
    if (!this.childIndex) {
      this.childIndex = new Map();
      for (const node of this.nodes.values()) {
        const key = node.parentId ?? '';
        let set = this.childIndex.get(key);
        if (!set) this.childIndex.set(key, (set = new Set()));
        set.add(node.id);
      }
    }
    return [...(this.childIndex.get(parentId ?? '') ?? [])].map((id) => this.nodes.get(id)).filter((node): node is RemoteNode => !!node);
  }

  /** The Files trash folder (`/.Trash`), if there is one. */
  trashId(): string | null {
    for (const node of this.children(null)) {
      if (node.name === TRASH_FOLDER_NAME && node.kind === 'directory') return node.id;
    }
    return null;
  }

  /** Whether `id` is `ancestor` or below it. `ancestor` null: the top of Files. */
  isUnder(id: string, ancestor: string | null): boolean {
    let current: string | null = id;
    for (let hops = 0; current !== null && hops < 10_000; hops += 1) {
      if (current === ancestor) return true;
      const node = this.nodes.get(current);
      if (!node) return false;
      current = node.parentId;
    }
    return ancestor === null && current === null;
  }

  /** Whether the node is in the trash. */
  inTrash(id: string): boolean {
    const trash = this.trashId();
    return !!trash && this.isUnder(id, trash);
  }

  /**
   * Everything below `rootId` (null: the whole account, minus the trash), parents before
   * children. Null when the root folder itself is gone or in the trash.
   */
  subtree(rootId: string | null): RemoteNode[] | null {
    if (rootId !== null && (!this.nodes.has(rootId) || this.inTrash(rootId))) return null;
    const trash = this.trashId();
    const out: RemoteNode[] = [];
    const queue: (string | null)[] = [rootId];
    while (queue.length > 0) {
      const parent = queue.shift() as string | null;
      for (const child of this.children(parent)) {
        if (child.id === trash) continue;
        out.push(child);
        if (child.kind === 'directory') queue.push(child.id);
      }
    }
    return out;
  }
}
