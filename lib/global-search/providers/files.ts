import { matchesTerms, type ParsedQuery } from '@/lib/global-search/query-parser';
import type { FileHit, SearchAccount, SearchProvider } from '@/lib/global-search/types';
import type { FileNode } from '@/lib/jmap/types';
import { fileNodeKind } from '@/lib/jmap/filenode-kind';
import { findTrashFolder, trashSubtreeIds } from '@/lib/files-trash';
import { useFileStore } from '@/stores/file-store';

/**
 * Files have no usable server search (`FileNode/query` matches `name` exactly
 * and `text` matches everything - plan §2.1), so both passes filter the full
 * listing the Files app fetches anyway (`FileNode/get {ids: null}`), cached
 * per login for a short while. Thousands of nodes filter client-side without
 * noticeable cost.
 */
export const FILE_LISTING_TTL_MS = 60_000;

interface CachedListing {
  fetchedAt: number;
  promise: Promise<FileNode[]>;
  nodes: FileNode[] | null;
}

const listings = new Map<string, CachedListing>();

export function invalidateFileSearchCache(localAccountId?: string): void {
  if (localAccountId) listings.delete(localAccountId);
  else listings.clear();
}

/** Mutations through the Files app (move/delete/upload/rename) leave a stale listing behind. */
let subscribed = false;
function subscribeToFileMutations(): void {
  if (subscribed) return;
  subscribed = true;
  useFileStore.subscribe((state, previous) => {
    if (state.lastAction !== previous.lastAction
      || (previous.uploadProgress !== null && state.uploadProgress === null)
      || (previous.isLoading && !state.isLoading)) {
      invalidateFileSearchCache(state.currentAccountId ?? undefined);
    }
  });
}

function loadListing(account: SearchAccount): CachedListing {
  subscribeToFileMutations();
  const cached = listings.get(account.localAccountId);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < FILE_LISTING_TTL_MS) return cached;
  const entry: CachedListing = {
    fetchedAt: now,
    nodes: null,
    promise: account.client.listAllFileNodesAcrossAccounts().then((nodes) => {
      entry.nodes = nodes;
      return nodes;
    }, (error) => {
      // A failed fetch must not be served as "no files" for a minute.
      if (listings.get(account.localAccountId) === entry) listings.delete(account.localAccountId);
      throw error;
    }),
  };
  listings.set(account.localAccountId, entry);
  return entry;
}

/** Cached nodes for a login when they are already in memory (the palette's synchronous pass). */
export function peekFileListing(localAccountId: string): FileNode[] | null {
  const cached = listings.get(localAccountId);
  return cached?.nodes ?? null;
}

/** Inverse of the Files store's `resolvePathToId`: the folder path a node lives in. */
export function pathOfNode(nodes: FileNode[], node: FileNode): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const segments: string[] = [];
  const seen = new Set<string>();
  let parentId = node.parentId;
  while (parentId != null && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    segments.unshift(parent.name);
    parentId = parent.parentId;
  }
  return `/${segments.join('/')}`;
}

/** Raw server id of a node (`listAllFileNodesAcrossAccounts` namespaces shared ones as `${owner}:${id}`). */
export function rawFileNodeId(node: FileNode): string {
  if (node.isShared && node.accountId && node.id.startsWith(`${node.accountId}:`)) {
    return node.id.slice(node.accountId.length + 1);
  }
  return node.id;
}

function filterNodes(parsed: ParsedQuery, nodes: FileNode[], account: SearchAccount, limit: number, source: 'local' | 'remote'): FileHit[] {
  const hits: FileHit[] = [];
  // The Files trash (.Trash, one folder per delete, what was deleted) is no hit.
  const trashed = trashSubtreeIds(nodes, findTrashFolder(nodes)?.id);
  for (const node of nodes) {
    // The owner's folders above a shared node only feed the path below.
    if (node.discoverableOnly || trashed.has(node.id)) continue;
    const kind = fileNodeKind(node);
    // A symlink has nothing a hit could open.
    if (kind === 'symlink') continue;
    if (!matchesTerms(parsed.terms, [node.name, kind === 'directory' ? 'folder' : node.type])) continue;
    const folderPath = pathOfNode(nodes, node);
    hits.push({
      kind: 'files',
      serverUrl: account.serverUrl,
      localAccountId: account.localAccountId,
      jmapAccountId: node.accountId ?? account.client.getFilesAccountId(),
      id: rawFileNodeId(node),
      accountLabel: account.label,
      title: node.name,
      subtitle: [node.isShared && node.accountName ? node.accountName : '', folderPath].filter(Boolean).join(' · '),
      date: node.modified || node.created || null,
      source,
      node,
      folderPath,
      isFolder: kind === 'directory',
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

export const filesProvider: SearchProvider = {
  kind: 'files',

  supports: (account) => account.client.supportsFiles(),

  local: (parsed, accounts, limit) => {
    const hits: FileHit[] = [];
    for (const account of accounts) {
      const nodes = peekFileListing(account.localAccountId);
      if (!nodes) continue;
      hits.push(...filterNodes(parsed, nodes, account, limit - hits.length, 'local'));
      if (hits.length >= limit) break;
    }
    return hits;
  },

  remote: async (parsed, account, { limit, signal }) => {
    const nodes = await loadListing(account).promise;
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const hits = filterNodes(parsed, nodes, account, limit + 1, 'remote');
    return { hits: hits.slice(0, limit), hasMore: hits.length > limit };
  },
};
