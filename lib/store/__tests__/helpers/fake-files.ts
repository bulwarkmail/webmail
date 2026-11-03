/**
 * FakeJmap with files, as measured on both Stalwarts (2026-11-03) and as the
 * client's comments record: `filter: {parentId: null}` is an HTTP 400 that
 * fails the whole request, a folder has null blobId, type and size. What differs
 * between versions is set per server:
 * - `style` is how a node says what it is: `nodeType` (0.16.6 and later, 1.0 as
 *   tested), `blob` (0.16.0-5: nothing but blobId null), `draft` (1.0.0: `@type`
 *   and `mediaType`).
 * - `getAll`: ids null past 500 is silently cut on 0.16 and refused on 1.0.
 * - `queryOmitsFolders`: FileNode/query before 0.16.6.
 */

import { TransportError, type StoreSession } from '../../engine/transport';
import { changesFor } from './fake-contacts';
import { Collection, FAKE_SESSION, FakeJmap, JMAP_ACCOUNT } from './fake-jmap';

export const FILES = 'urn:ietf:params:jmap:filenode';
export const SHARED_FILES_ACCOUNT = 'shared1';

export const FILES_SESSION: StoreSession = {
  ...FAKE_SESSION,
  primaryAccounts: { ...FAKE_SESSION.primaryAccounts, [FILES]: JMAP_ACCOUNT },
  accounts: {
    [JMAP_ACCOUNT]: { name: 'a@example.org', isPersonal: true, accountCapabilities: { [FILES]: {} } },
    [SHARED_FILES_ACCOUNT]: { name: 'team@example.org', isPersonal: false, accountCapabilities: { [FILES]: {} } },
  },
  capabilities: { [FILES]: {} },
};

export interface FakeNode {
  id: string;
  parentId: string | null;
  name: string;
  blobId: string | null;
  type: string | null;
  size: number | null;
  modified?: string;
}

export type FolderStyle = 'nodeType' | 'blob' | 'draft';

export interface FakeFilesOptions {
  style?: FolderStyle;
  getAll?: 'cut' | 'refuse';
  queryOmitsFolders?: boolean;
}

class FilesAccount {
  readonly nodes = new Map<string, FakeNode>();
  readonly coll = new Collection();
}

export class FakeFiles extends FakeJmap {
  private readonly fileAccounts = new Map<string, FilesAccount>();
  private readonly options: Required<FakeFilesOptions>;
  private nextNode = 1;
  readonly blobs = new Map<string, Uint8Array>();
  /** In order, with the account. */
  readonly downloads: Array<{ jmap: string; blobId: string }> = [];
  downloading = 0;
  mostAtOnce = 0;

  constructor(options: FakeFilesOptions = {}) {
    super();
    this.options = { style: 'nodeType', getAll: 'cut', queryOmitsFolders: false, ...options };
  }

  account(id: string = JMAP_ACCOUNT): FilesAccount {
    let found = this.fileAccounts.get(id);
    if (!found) {
      found = new FilesAccount();
      this.fileAccounts.set(id, found);
    }
    return found;
  }

  addFolder(name: string, parentId: string | null = null, id?: string, accountId: string = JMAP_ACCOUNT): FakeNode {
    const account = this.account(accountId);
    const node: FakeNode = { id: id ?? `n${this.nextNode++}`, parentId, name, blobId: null, type: null, size: null };
    account.nodes.set(node.id, node);
    account.coll.push('created', node.id);
    return node;
  }

  addFile(name: string, parentId: string | null = null, content: Uint8Array | number = 10, extra: Partial<FakeNode> = {}, accountId: string = JMAP_ACCOUNT): FakeNode {
    const account = this.account(accountId);
    const id = extra.id ?? `n${this.nextNode++}`;
    const blobId = extra.blobId ?? `blob-${id}`;
    const data = typeof content === 'number' ? new Uint8Array(content).fill(id.length) : content;
    this.blobs.set(blobId, data);
    const node: FakeNode = { id, parentId, name, blobId, type: 'text/plain', size: data.length, ...extra };
    account.nodes.set(id, node);
    account.coll.push('created', id);
    return node;
  }

  /** A new version of the file: new blob, same node. */
  replaceContent(id: string, content: Uint8Array, accountId: string = JMAP_ACCOUNT): string {
    const account = this.account(accountId);
    const node = account.nodes.get(id) as FakeNode;
    const blobId = `${node.blobId as string}-v`;
    this.blobs.set(blobId, content);
    node.blobId = blobId;
    node.size = content.length;
    account.coll.push('updated', id);
    return blobId;
  }

  renameNode(id: string, name: string, accountId: string = JMAP_ACCOUNT): void {
    const account = this.account(accountId);
    (account.nodes.get(id) as FakeNode).name = name;
    account.coll.push('updated', id);
  }

  removeNode(id: string, accountId: string = JMAP_ACCOUNT): void {
    const account = this.account(accountId);
    account.nodes.delete(id);
    account.coll.push('destroyed', id);
  }

  private wire(node: FakeNode, properties: string[] | undefined): Record<string, unknown> {
    const isFolder = node.blobId === null;
    const full: Record<string, unknown> = { id: node.id, parentId: node.parentId, name: node.name, blobId: node.blobId, size: node.size, created: '2026-10-01T00:00:00Z', modified: node.modified ?? '2026-10-01T00:00:00Z' };
    if (this.options.style === 'draft') {
      full['@type'] = isFolder ? 'Directory' : 'File';
      full.mediaType = node.type;
    } else {
      full.type = node.type;
      if (this.options.style === 'nodeType') full.nodeType = isFolder ? 'directory' : 'file';
    }
    if (!properties) return full;
    const out: Record<string, unknown> = { id: node.id };
    for (const p of properties) if (p in full) out[p] = full[p];
    return out;
  }

  protected override handle(name: string, args: Record<string, unknown>): Record<string, unknown> {
    if (!name.startsWith('FileNode/')) return super.handle(name, args);
    const account = this.account(String(args.accountId));
    switch (name) {
      case 'FileNode/changes':
        return changesFor(account.coll, args);
      case 'FileNode/get': {
        const ids = args.ids as string[] | null;
        if (ids && ids.length > 500) throw Object.assign(new Error('requestTooLarge'), { jmapError: 'requestTooLarge' });
        if (!ids && account.nodes.size > 500 && this.options.getAll === 'refuse') {
          throw Object.assign(new Error('requestTooLarge'), { jmapError: 'requestTooLarge' });
        }
        const chosen = ids ?? [...account.nodes.keys()].slice(0, 500);
        const properties = args.properties as string[] | undefined;
        return {
          accountId: args.accountId,
          state: account.coll.state(),
          list: chosen.filter((id) => account.nodes.has(id)).map((id) => this.wire(account.nodes.get(id) as FakeNode, properties)),
          notFound: chosen.filter((id) => !account.nodes.has(id)),
        };
      }
      case 'FileNode/query': {
        const filter = (args.filter ?? {}) as { parentId?: string | null };
        // Measured on both servers: this fails the whole request.
        if (filter.parentId === null) throw new TransportError('http', 'JMAP request failed: 400', 400, 'urn:ietf:params:jmap:error:notRequest');
        let list = [...account.nodes.values()];
        if (this.options.queryOmitsFolders) list = list.filter((n) => n.blobId !== null);
        if (filter.parentId) list = list.filter((n) => n.parentId === filter.parentId);
        const position = Number(args.position ?? 0);
        const limit = Math.min(Number(args.limit ?? 5000) || 5000, 5000);
        return {
          accountId: args.accountId,
          queryState: account.coll.state(),
          canCalculateChanges: true,
          position,
          ids: list.slice(position, position + limit).map((n) => n.id),
          ...(args.calculateTotal ? { total: list.length } : {}),
        };
      }
      default:
        throw Object.assign(new Error(name), { jmapError: 'unknownMethod' });
    }
  }

  override async download(jmap: string, blobId: string): Promise<Uint8Array> {
    if (this.offline) throw new TransportError('network', 'Failed to fetch');
    this.downloads.push({ jmap, blobId });
    this.downloading += 1;
    this.mostAtOnce = Math.max(this.mostAtOnce, this.downloading);
    await Promise.resolve();
    this.downloading -= 1;
    const data = this.blobs.get(blobId);
    if (!data) throw new TransportError('http', 'Download failed: 404', 404);
    return data;
  }
}
