/**
 * Files on a fake server for the engine: lib/store's FakeFiles (FileNode/get, query and changes
 * as both Stalwarts answer them) with FileNode/set and uploads added, as Stalwart does them:
 * - a folder is a node without blobId; a node can only go under a folder;
 * - two siblings with the same name are refused (`alreadyExists`);
 * - a destroy with onDestroyRemoveChildren takes the subtree;
 * - an upload over maxSizeUpload is an HTTP 413;
 * - the session's filenode capability names forbidden characters (0.16.6+ style).
 */

import { TransportError, type StoreSession } from '@/lib/store/engine/transport';
import { FakeFiles, FILES, FILES_SESSION, type FakeFilesOptions, type FakeNode } from '@/lib/store/__tests__/helpers/fake-files';
import { JMAP_ACCOUNT } from '@/lib/store/__tests__/helpers/fake-jmap';
import { FilesRemote } from '../../remote';

export { JMAP_ACCOUNT };

export interface FakeServerOptions extends FakeFilesOptions {
  maxSizeUpload?: number;
  forbiddenNameChars?: string;
}

export class FakeServer extends FakeFiles {
  readonly session: StoreSession;
  readonly sets: Record<string, unknown>[] = [];
  readonly uploads: number[] = [];
  /** Fails the next N uploads like a network drop. */
  failUploads = 0;
  private serverClock = Date.UTC(2026, 9, 1);
  private nextNodeId = 1000;
  private nextBlob = 1;

  constructor(options: FakeServerOptions = {}) {
    super(options);
    this.session = {
      ...FILES_SESSION,
      capabilities: {
        ...FILES_SESSION.capabilities,
        'urn:ietf:params:jmap:core': { maxSizeUpload: options.maxSizeUpload ?? 50_000_000, maxObjectsInGet: 500, maxObjectsInSet: 500, maxCallsInRequest: 16 },
      },
      accounts: {
        ...FILES_SESSION.accounts,
        [JMAP_ACCOUNT]: {
          ...FILES_SESSION.accounts[JMAP_ACCOUNT],
          accountCapabilities: { [FILES]: { forbiddenNameChars: options.forbiddenNameChars ?? '/', forbiddenNodeNames: ['.', '..'], maxSizeFileNodeName: 255 } },
        },
      },
    };
  }

  remote(): FilesRemote {
    return new FilesRemote(this, () => this.session);
  }

  private stamp(): string {
    this.serverClock += 1000;
    return new Date(this.serverClock).toISOString();
  }

  get nodes(): Map<string, FakeNode> {
    return this.account().nodes;
  }

  /** What another device does in Files. */
  folder(name: string, parentId: string | null = null): FakeNode {
    const node = this.addFolder(name, parentId, `n${this.nextNodeId++}`);
    node.modified = this.stamp();
    return node;
  }

  file(name: string, parentId: string | null, content: string | Uint8Array): FakeNode {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const node = this.addFile(name, parentId, data, { id: `n${this.nextNodeId++}`, blobId: `b${this.nextBlob++}`, modified: this.stamp() });
    return node;
  }

  edit(id: string, content: string): void {
    const data = new TextEncoder().encode(content);
    const blobId = `b${this.nextBlob++}`;
    this.blobs.set(blobId, data);
    const node = this.nodes.get(id) as FakeNode;
    node.blobId = blobId;
    node.size = data.length;
    node.modified = this.stamp();
    this.account().coll.push('updated', id);
  }

  rename(id: string, name: string, parentId?: string | null): void {
    const node = this.nodes.get(id) as FakeNode;
    node.name = name;
    if (parentId !== undefined) node.parentId = parentId;
    this.account().coll.push('updated', id);
  }

  destroyTree(id: string): void {
    for (const child of [...this.nodes.values()].filter((node) => node.parentId === id)) this.destroyTree(child.id);
    this.removeNode(id);
  }

  /** The content of a node, as text. */
  content(id: string): string {
    const node = this.nodes.get(id);
    return node?.blobId ? new TextDecoder().decode(this.blobs.get(node.blobId)) : '';
  }

  /** Path from the top to each node, sorted, folders with a slash. Without the trash unless asked. */
  listing(withTrash = false): string[] {
    const out: string[] = [];
    const pathOf = (node: FakeNode): string | null => {
      const parts = [node.name];
      let parent = node.parentId;
      while (parent) {
        const up = this.nodes.get(parent);
        if (!up) return null;
        parts.unshift(up.name);
        parent = up.parentId;
      }
      return parts.join('/');
    };
    for (const node of this.nodes.values()) {
      const path = pathOf(node);
      if (path === null) continue;
      if (!withTrash && (path === '.Trash' || path.startsWith('.Trash/'))) continue;
      out.push(node.blobId === null ? `${path}/` : path);
    }
    return out.sort();
  }

  find(path: string): FakeNode | undefined {
    const parts = path.split('/');
    let parent: string | null = null;
    let found: FakeNode | undefined;
    for (const part of parts) {
      found = [...this.nodes.values()].find((node) => node.parentId === parent && node.name === part);
      if (!found) return undefined;
      parent = found.id;
    }
    return found;
  }

  override async upload(_jmap?: string, data?: Uint8Array, type?: string): Promise<{ blobId: string; type: string; size: number }> {
    if (this.offline) throw new TransportError('network', 'Failed to fetch');
    if (this.failUploads > 0) {
      this.failUploads -= 1;
      throw new TransportError('network', 'Connection reset');
    }
    const bytes = data ?? new Uint8Array();
    const max = (this.session.capabilities['urn:ietf:params:jmap:core'] as { maxSizeUpload: number }).maxSizeUpload;
    if (bytes.length > max) throw new TransportError('http', 'Upload failed: 413', 413);
    const blobId = `up${this.nextBlob++}`;
    this.blobs.set(blobId, new Uint8Array(bytes));
    this.uploads.push(bytes.length);
    return { blobId, type: type ?? 'application/octet-stream', size: bytes.length };
  }

  protected override handle(name: string, args: Record<string, unknown>): Record<string, unknown> {
    if (name !== 'FileNode/set') return super.handle(name, args);
    this.sets.push(args);
    const account = this.account(String(args.accountId));
    const nodes = account.nodes;
    const forbidden = String(((this.session.accounts[JMAP_ACCOUNT].accountCapabilities as Record<string, Record<string, unknown>>)[FILES]).forbiddenNameChars ?? '');
    const clash = (parentId: string | null, nodeName: string, except?: string) =>
      [...nodes.values()].some((node) => node.parentId === parentId && node.name === nodeName && node.id !== except);
    const isFolder = (id: string | null) => id === null || nodes.get(id)?.blobId === null;
    const created: Record<string, unknown> = {};
    const notCreated: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries((args.create ?? {}) as Record<string, Record<string, unknown>>)) {
      const parentId = (raw.parentId as string | undefined) ?? null;
      const nodeName = String(raw.name ?? '');
      if (!nodeName || [...nodeName].some((ch) => forbidden.includes(ch))) {
        notCreated[key] = { type: 'invalidProperties', description: 'Name contains a forbidden character.' };
        continue;
      }
      if (parentId !== null && !nodes.has(parentId)) {
        notCreated[key] = { type: 'invalidProperties', description: 'Parent ID does not exist or is not a folder.' };
        continue;
      }
      if (!isFolder(parentId)) {
        notCreated[key] = { type: 'invalidProperties', description: 'Parent ID does not exist or is not a folder.' };
        continue;
      }
      if (clash(parentId, nodeName)) {
        notCreated[key] = { type: 'alreadyExists', description: 'A node with the same name already exists.' };
        continue;
      }
      const id = `n${this.nextNodeId++}`;
      const blobId = (raw.blobId as string | undefined) ?? null;
      const type = (raw.type as string | undefined) ?? (raw.mediaType as string | undefined) ?? null;
      const node: FakeNode = { id, parentId, name: nodeName, blobId, type: blobId ? type : null, size: blobId ? (this.blobs.get(blobId)?.length ?? 0) : null, modified: this.stamp() };
      nodes.set(id, node);
      account.coll.push('created', id);
      created[key] = { id };
    }
    const updated: Record<string, unknown> = {};
    const notUpdated: Record<string, unknown> = {};
    for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>)) {
      const node = nodes.get(id);
      if (!node) {
        notUpdated[id] = { type: 'notFound' };
        continue;
      }
      const parentId = 'parentId' in patch ? ((patch.parentId as string | null) ?? null) : node.parentId;
      const nodeName = 'name' in patch ? String(patch.name) : node.name;
      if ('parentId' in patch && !isFolder(parentId)) {
        notUpdated[id] = { type: 'invalidProperties', description: 'Parent ID does not exist or is not a folder.' };
        continue;
      }
      if (clash(parentId, nodeName, id)) {
        notUpdated[id] = { type: 'alreadyExists' };
        continue;
      }
      node.parentId = parentId;
      node.name = nodeName;
      if ('blobId' in patch) {
        node.blobId = patch.blobId as string;
        node.size = this.blobs.get(node.blobId)?.length ?? 0;
      }
      node.modified = this.stamp();
      account.coll.push('updated', id);
      updated[id] = null;
    }
    const destroyed: string[] = [];
    const notDestroyed: Record<string, unknown> = {};
    for (const id of (args.destroy ?? []) as string[]) {
      if (!nodes.has(id)) {
        notDestroyed[id] = { type: 'notFound' };
        continue;
      }
      if (!args.onDestroyRemoveChildren && [...nodes.values()].some((node) => node.parentId === id)) {
        notDestroyed[id] = { type: 'nodeHasChildren' };
        continue;
      }
      this.destroyTree(id);
      destroyed.push(id);
    }
    return {
      accountId: args.accountId,
      newState: account.coll.state(),
      created,
      notCreated,
      updated,
      notUpdated,
      destroyed,
      notDestroyed,
    };
  }
}
