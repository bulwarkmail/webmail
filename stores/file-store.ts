import { create } from 'zustand';
import type { FileNodeListings, IJMAPClient } from '@/lib/jmap/client-interface';
import type { FileNode, FileNodeRights } from '@/lib/jmap/types';
import { fileNodeKind } from '@/lib/jmap/filenode-kind';
import { fileNodeDepth } from '@/lib/jmap/filenode-depth';
import { jmapError } from '@/lib/jmap/jmap-error';
import { folderDepthError } from '@/lib/file-errors';
import { imageBlobUrl } from '@/lib/file-preview';
import { fileHooks } from '@/lib/plugin-hooks';
import { fileToView } from '@/lib/plugin-projection';
import type { FileResourceView } from '@/lib/plugin-types';
import {
  TRASH_FOLDER_NAME, TRASH_LOCATION, TRASH_PATH, findTrashFolder, isTrashLocation, trashBatchName,
  trashSubtreeIds, trashedItems,
} from '@/lib/files-trash';
import { buildZip, planZip, saveBlob, type ZipProgress } from '@/lib/files-zip';
import { downloadAllowed } from '@/lib/download-guard';

export interface FileResource {
  id: string;
  name: string;
  serverName: string;
  isDirectory: boolean;
  // A symbolic link (Stalwart 1.0). Shown, renamed, moved and deleted like
  // any node, but it has no content and holds nothing, so it can't be opened.
  isSymlink?: boolean;
  contentType: string;
  contentLength: number;
  lastModified: string;
  blobId: string | null;
  parentId: string | null;
  // Sharing (RFC 9670). `shareWith` has entries when this node is shared out by
  // the current user; `myRights` describes what the viewer may do; `isShared`
  // marks nodes owned by another principal and surfaced under "Shared with me".
  myRights?: FileNodeRights;
  shareWith?: Record<string, FileNodeRights> | null;
  isShared?: boolean;
  ownerAccountId?: string;
  ownerName?: string;
  /** Set for an item in the trash: when it was deleted and where from (null: the root). */
  trash?: { deletedAt: string | null; fromParentId: string | null; batchId: string | null };
}

interface UploadProgress {
  name: string;
  loaded: number;
  total: number;
  current: number;
  totalFiles: number;
}

/**
 * What an upload batch did. A file the server refuses doesn't stop the rest;
 * it is listed here (by its path inside an uploaded folder) with the error.
 * `canceled` is set when the user stopped the batch.
 */
export interface UploadReport {
  uploaded: number;
  failed: { name: string; error: unknown }[];
  canceled: boolean;
}

interface ClipboardState {
  mode: 'cut' | 'copy';
  ids: string[];
  names: string[];
  serverNames: string[];
  sourceParentId: string | null;
  /**
   * Cut: the folder each node was in, which an undo of the paste moves it
   * back to. Not always `sourceParentId`: a "Files from" page lists nodes of
   * folders the user can't open, and its own id names no folder.
   */
  sourceParentIds?: (string | null)[];
  sourcePath: string;
  /** The cut or copied items as plugins see them, taken when they were picked. */
  files: FileResourceView[];
}

interface UndoAction {
  type: 'rename' | 'move';
  entries: { id: string; from: Partial<Pick<FileNode, 'name' | 'parentId'>>; to: Partial<Pick<FileNode, 'name' | 'parentId'>> }[];
  sourceParentId: string | null;
  /** A delete into the trash: the trash folder its items went into, removed on undo. */
  trashBatchId?: string;
}

interface FileState {
  currentParentId: string | null;
  currentPath: string;
  pathStack: { id: string | null; name: string }[];
  resources: FileResource[];
  isLoading: boolean;
  error: string | null;
  supportsFiles: boolean | null;
  selectedResources: Set<string>;
  uploadProgress: UploadProgress | null;
  /** Progress of the one-time legacy flat-node migration; null when idle. */
  migrationProgress: { current: number; total: number } | null;
  client: IJMAPClient | null;
  /** Which connected account's files are being browsed. Pro shell only - null in single-account contexts. */
  currentAccountId: string | null;
  clipboard: ClipboardState | null;
  uploadAbortController: AbortController | null;
  favorites: string[];
  recentFiles: { name: string; id: string; timestamp: number }[];
  lastAction: UndoAction | null;
  /** Top-level FileNodes shared with the user by other principals ("Shared with me"). */
  sharedRoots: FileResource[];
  /**
   * Every folder known from the last listing, for the folder tree. Each
   * listing already fetches the whole drive, so the tree is derived from it
   * instead of fetching again, and is current after every change.
   */
  allFolders: FileResource[];
  /** False until the first listing for the attached account has finished. */
  hasListed: boolean;
  /** How many items the trash holds, from the last listing. */
  trashCount: number;

  // Actions
  initClient: (client: IJMAPClient, accountId?: string | null) => void;
  /** Detach the current client and reset browse state. Used by the Pro shell to return to the cross-account picker. */
  clearClient: () => void;
  checkSupport: () => Promise<boolean>;
  /**
   * One-time upgrade of files created by older Bulwark builds, which encoded
   * the folder tree into flat node names with a Unicode separator. Reparents
   * those nodes into the real FileNode hierarchy. No-op once migrated.
   * Returns true if any node was migrated.
   */
  migrateLegacyFlatNodes: () => Promise<boolean>;
  navigate: (parentId: string | null, name?: string) => Promise<void>;
  navigateByPath: (path: string) => Promise<void>;
  navigateUp: () => Promise<void>;
  refresh: () => Promise<void>;
  createDirectory: (name: string) => Promise<void>;
  uploadFile: (file: File) => Promise<void>;
  uploadFiles: (files: File[]) => Promise<UploadReport>;
  uploadFolder: (files: File[]) => Promise<UploadReport>;
  cancelUpload: () => void;
  // Deletes, renames and moves resolve to false when a plugin stopped them
  // (onBeforeFileDelete / Rename / Move); nothing changed then.
  deleteResource: (name: string) => Promise<boolean>;
  deleteResources: (names: string[]) => Promise<boolean>;
  renameResource: (oldName: string, newName: string) => Promise<boolean>;
  downloadResource: (name: string) => Promise<void>;
  downloadResources: (names: string[]) => Promise<void>;
  /**
   * Download items by id as one zip built in the browser: files as they are,
   * folders with everything in them. Rejects with an AbortError when canceled.
   */
  downloadZip: (ids: string[], zipName: string, options?: { signal?: AbortSignal; onProgress?: (p: ZipProgress) => void }) => Promise<void>;
  getImageUrl: (name: string) => Promise<string>;
  getFileContent: (name: string) => Promise<{ blob: Blob; contentType: string }>;
  /**
   * A new file in the open folder: empty text, or a copy of `template` (a
   * blank document, #1393). Resolves to the name it got, which differs from
   * `name` when the server renamed it to avoid a clash.
   */
  createFile: (name: string, template?: Blob) => Promise<string | null>;
  duplicateResource: (name: string) => Promise<void>;
  moveToFolder: (names: string[], targetFolder: string) => Promise<boolean>;
  moveToParent: (names: string[]) => Promise<boolean>;
  /** Move listed items into any folder by id (null = the root), e.g. a tree or breadcrumb drop. */
  moveToFolderId: (names: string[], targetId: string | null) => Promise<boolean>;
  /** Move any node by id into a folder (null = the root), e.g. a folder of the tree. */
  moveNode: (id: string, targetId: string | null) => Promise<boolean>;
  cutResources: (names: string[]) => void;
  copyResources: (names: string[]) => void;
  pasteResources: () => Promise<boolean>;
  selectResource: (name: string | null) => void;
  toggleSelect: (name: string) => void;
  selectAll: () => void;
  clearSelection: () => void;
  setSelection: (names: Set<string>) => void;
  listPath: (path: string) => Promise<FileResource[]>;
  listByParentId: (parentId: string | null) => Promise<FileResource[]>;
  toggleFavorite: (path: string) => void;
  addRecentFile: (name: string, id: string) => void;
  /** Open the folder holding a node and return the node's name, or null when it is gone. */
  revealNode: (id: string) => Promise<string | null>;
  /** Rename any node by id, e.g. a folder in the tree that is not listed. */
  renameNode: (id: string, newName: string) => Promise<boolean>;
  /** Delete any node by id; leaves the folder on screen if it was inside it. */
  deleteNode: (id: string) => Promise<boolean>;
  /**
   * Move items of the folder on screen into the trash; how many went (0 when
   * a plugin stopped it). Undo puts them back.
   */
  trashResources: (names: string[]) => Promise<number>;
  /** Move any node by id into the trash, like deleteNode. */
  trashNode: (id: string) => Promise<boolean>;
  /** Put items listed in the trash back where they came from (the root when that is gone). */
  restoreResources: (names: string[]) => Promise<number>;
  /** Delete items listed in the trash for good. */
  purgeResources: (names: string[]) => Promise<number>;
  /** Delete everything in the trash for good. */
  emptyTrash: () => Promise<void>;
  /** Download a file by id, wherever it lives. */
  downloadNode: (id: string) => Promise<void>;
  removeRecentFile: (id: string) => void;
  undoLastAction: () => Promise<void>;
  /** Add, update (rights), or remove (rights=null) a principal's share on a node. */
  shareResource: (id: string, principalId: string, rights: FileNodeRights | null) => Promise<void>;
  /** Load the top-level nodes shared with the user by other principals. */
  loadSharedRoots: () => Promise<void>;
  /**
   * Open a node of a drive shared with the user, by the id the listings give
   * it ("<owner>:<id>"), or a shared-files page: a folder opens itself,
   * anything else the folder it is listed in. `sharedFilesName` titles an
   * owner's shared-files page. False when the node is gone or not shared.
   */
  openSharedNode: (id: string, sharedFilesName: (ownerName: string) => string) => Promise<boolean>;
}

const DIRECTORY_TYPES = new Set(['d', 'application/x-directory', 'text/directory', 'httpd/unix-directory', 'inode/directory']);

// Legacy builds encoded the folder hierarchy into flat node names using a path
// separator. Depending on the build / how the data was created (folder upload,
// WebDAV) this is either a plain "/" or the Unicode DIVISION SLASH (U+2215) that
// older webmail used to dodge Stalwart's "/" rejection. We accept both so the
// one-time migration into the real parentId hierarchy can't miss data (#379).
const LEGACY_PATH_SEPS = ['∕', '/', '⁄', '／'];

function lastLegacySepIndex(name: string): number {
  let idx = -1;
  for (const sep of LEGACY_PATH_SEPS) {
    const i = name.lastIndexOf(sep);
    if (i > idx) idx = i;
  }
  return idx;
}

// Whether an old build's `type` marks a node as a directory. Only meaningful for
// detecting legacy "folder" nodes that were really stored as 0-byte files; it is
// NOT how a real folder is identified (see isFolder).
function isDirectoryType(type: string | undefined): boolean {
  if (!type) return false;
  return DIRECTORY_TYPES.has(type) || type.includes('directory');
}

// Whether a FileNode is a folder, by `nodeType` or else by having no content
// blob (see fileNodeKind). A `type` of "d" doesn't make one: older builds
// created "folders" as blob-backed files, which can't hold children (#379).
function isFolder(node: Pick<FileNode, 'nodeType' | 'blobId'>): boolean {
  return fileNodeKind(node) === 'directory';
}

// Direct children of a given parent in the FileNode hierarchy.
function childrenOf(nodes: FileNode[], parentId: string | null): FileNode[] {
  return nodes.filter(n => (n.parentId ?? null) === parentId);
}

// Nodes from a non-primary (shared) account are namespaced "accountId:nodeId"
// by listAllFileNodesAcrossAccounts(). JMAP ids never contain ':', so the
// separator unambiguously marks a node we're browsing inside a shared account.
function isCrossAccountId(id: string | null): boolean {
  return id != null && id.includes(':');
}

// Files shared with the user on their own, outside any folder shared with
// them, have no folder to be listed in. Each owner's are listed on one page,
// "<owner>:*": JMAP ids never contain "*", so the page can't be taken for a
// node, and like the owner's nodes it counts as cross-account.
const SHARED_FILES = ':*';

/** The page listing the files `accountId` shares with the user outside any shared folder. */
export function sharedFilesLocation(accountId: string): string {
  return `${accountId}${SHARED_FILES}`;
}

function sharedFilesOwner(id: string | null): string | null {
  return id !== null && id.endsWith(SHARED_FILES) ? id.slice(0, -SHARED_FILES.length) : null;
}

/**
 * One page per owner who shares files on their own (outside any folder
 * shared with the user), from the shared roots, sorted by owner name.
 */
export function sharedFilePages(sharedRoots: FileResource[]): { id: string; ownerName: string }[] {
  const owners = new Map<string, string>();
  for (const r of sharedRoots) {
    if (!r.isDirectory && r.ownerAccountId) owners.set(r.ownerAccountId, r.ownerName || r.ownerAccountId);
  }
  return [...owners]
    .sort(([, a], [, b]) => a.localeCompare(b))
    .map(([accountId, ownerName]) => ({ id: sharedFilesLocation(accountId), ownerName }));
}

/** Whether a listing id is a page of files shared on their own, which takes no new items. */
export function isSharedFilesPage(id: string | null): boolean {
  return sharedFilesOwner(id) !== null;
}

/**
 * Whether a listing id is in a drive shared with the user: one of its
 * folders or a shared-files page. Those have no path under the user's own
 * root, so links name them by id.
 */
export function isSharedLocation(id: string | null): id is string {
  return isCrossAccountId(id);
}

/**
 * The listed file a deep link asks to preview. A link into a shared drive
 * that names the file itself by id (`?shared=<id>&preview=<name>`, from
 * search) is matched by that id: the "Files from" page listing it may hold
 * another file of the same name, and lists the two under numbered names. A
 * link that names the folder or page instead (`sharedId` is the listing on
 * screen, a permalink) and one into the own drive match the name the file has
 * in the listing.
 */
export function linkedPreviewResource(
  resources: FileResource[],
  link: { name: string; sharedId?: string },
  currentParentId: string | null,
): FileResource | undefined {
  return link.sharedId !== undefined && link.sharedId !== currentParentId
    ? resources.find(r => r.id === link.sharedId)
    : resources.find(r => r.name === link.name);
}

// A shared-files page lists files; nothing can be put into it, nor into the
// trash other than by deleting.
function assertCanAddTo(parentId: string | null): void {
  if (sharedFilesOwner(parentId) !== null) {
    throw jmapError('Nothing can be added to a list of shared files', { type: 'forbidden' });
  }
  if (isTrashLocation(parentId)) {
    throw jmapError('Nothing can be added to the trash', { type: 'forbidden' });
  }
}

/**
 * Whether what is deleted in a folder goes to the trash: in the user's own
 * drive. A drive someone shared has no trash of the user's, and what is
 * deleted there is gone.
 */
export function deletesToTrash(parentId: string | null): boolean {
  return !isCrossAccountId(parentId) && !isTrashLocation(parentId);
}

/** The trash folder, created on the first delete. */
async function ensureTrashFolder(client: IJMAPClient, nodes: FileNode[]): Promise<FileNode> {
  return findTrashFolder(nodes) ?? client.createFileDirectory(TRASH_FOLDER_NAME, null);
}

/** Remove the trash folders of deletes whose items have all left the trash. */
async function removeEmptyTrashBatches(client: IJMAPClient, gone: FileResource[]): Promise<void> {
  const batchIds = [...new Set(gone.map(r => r.trash?.batchId).filter((id): id is string => !!id))];
  if (batchIds.length === 0) return;
  const nodes = await client.listAllFileNodes();
  const empty = batchIds.filter(id => !nodes.some(n => n.parentId === id));
  if (empty.length > 0) await client.destroyFileNodes(empty);
}

/** Throw the first refusal when nothing of an update went through. */
function assertUpdated(result: { updated: string[]; notUpdated: Record<string, string> }): void {
  if (result.updated.length > 0) return;
  const [reason] = Object.values(result.notUpdated);
  throw jmapError(reason || 'The server refused the change', { type: 'forbidden' });
}

// The top of what other accounts share with the user: shared nodes whose
// parent the user can't open (none, or a folder not shared with them).
// Stalwart 1.0 also lists the owner's folders above a shared node
// (discoverableOnly); left in, the owner's top folder became the root and the
// shared folder sat somewhere below it.
function sharedRootsOf(nodes: FileNode[]): FileNode[] {
  const visible = nodes.filter(n => !n.discoverableOnly);
  const ids = new Set(visible.map(n => n.id));
  return visible.filter(n => n.isShared && (n.parentId == null || !ids.has(n.parentId)));
}

/**
 * Where a node of a shared drive is opened, as the breadcrumb trail from its
 * shared root: a folder or shared-files page opens itself, anything else its
 * folder, or its owner's shared-files page when that folder isn't shared
 * with the user. A shared-files page has no name of its own (null); the
 * caller words it.
 */
function findSharedPlace(
  nodes: FileNode[],
  id: string,
): { trail: { id: string; name: string | null }[]; ownerName: string } | null {
  const pageOwner = sharedFilesOwner(id);
  if (pageOwner !== null) {
    const files = sharedRootsOf(nodes).filter(n => n.accountId === pageOwner && !isFolder(n));
    if (files.length === 0) return null;
    return { trail: [{ id, name: null }], ownerName: files[0].accountName || pageOwner };
  }

  const visible = new Map(nodes.filter(n => !n.discoverableOnly).map(n => [n.id, n]));
  const node = visible.get(id);
  if (!node?.isShared || !node.accountId) return null;
  const ownerName = node.accountName || node.accountId;
  const folder = isFolder(node) ? node : node.parentId != null ? visible.get(node.parentId) : undefined;
  if (!folder || !isFolder(folder)) {
    return { trail: [{ id: sharedFilesLocation(node.accountId), name: null }], ownerName };
  }
  const trail: { id: string; name: string | null }[] = [];
  const seen = new Set<string>();
  let at: FileNode | undefined = folder;
  while (at && !seen.has(at.id)) {
    seen.add(at.id);
    trail.unshift({ id: at.id, name: at.name });
    at = at.parentId != null ? visible.get(at.parentId) : undefined;
  }
  return { trail, ownerName };
}

/**
 * The account and bare server id behind a listed resource, for callers that
 * address the node on the server themselves (the WOPI editor, #1094). A node
 * of a shared account is listed as "accountId:nodeId"; `accountId` is only
 * known for nodes listed across accounts.
 */
export function resourceServerRef(
  resource: Pick<FileResource, 'id' | 'ownerAccountId'>,
): { accountId?: string; id: string } {
  const owner = resource.ownerAccountId;
  if (owner && resource.id.startsWith(`${owner}:`)) {
    return { accountId: owner, id: resource.id.slice(owner.length + 1) };
  }
  return { accountId: owner, id: resource.id };
}

function nodeToResource(node: FileNode): FileResource {
  const kind = fileNodeKind(node);
  return {
    id: node.id,
    name: node.name,
    serverName: node.name,
    isDirectory: kind === 'directory',
    isSymlink: kind === 'symlink',
    contentType: kind === 'file' ? node.type : '',
    contentLength: node.size,
    lastModified: node.modified || node.created,
    blobId: node.blobId,
    parentId: node.parentId,
    myRights: node.myRights,
    shareWith: node.shareWith,
    isShared: node.isShared,
    ownerAccountId: node.accountId,
    ownerName: node.accountName,
  };
}

function sortResources(resources: FileResource[]): FileResource[] {
  // Directories first, then alphabetically.
  return resources.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// Resolve a display path (e.g. "/Documents/Notes") to a FileNode id by walking
// the hierarchy from the root. Returns null for the root, or undefined if any
// segment can't be found.
function resolvePathToId(nodes: FileNode[], path: string): string | null | undefined {
  if (path === '/' || path === '') return null;
  const segments = path.split('/').filter(Boolean);
  let parentId: string | null = null;
  for (const segment of segments) {
    const match: FileNode | undefined = childrenOf(nodes, parentId).find(n => n.name === segment && isFolder(n));
    if (!match) return undefined;
    parentId = match.id;
  }
  return parentId;
}

function getUniqueName(name: string, existingNames: Set<string>): string {
  if (!existingNames.has(name)) return name;
  const dotIndex = name.lastIndexOf('.');
  const base = dotIndex > 0 ? name.substring(0, dotIndex) : name;
  const ext = dotIndex > 0 ? name.substring(dotIndex) : '';
  let counter = 1;
  while (existingNames.has(`${base} (${counter})${ext}`)) counter++;
  return `${base} (${counter})${ext}`;
}

// The files on a shared-files page come from any of the owner's folders, so
// two may have the same name, while the Files view tells rows apart by name.
// Later ones are numbered the way uploads are; serverName keeps the real name.
function withUniqueNames(resources: FileResource[]): FileResource[] {
  const used = new Set<string>();
  return resources.map(r => {
    const name = getUniqueName(r.name, used);
    used.add(name);
    return name === r.name ? r : { ...r, name };
  });
}

// Display path of a folder ("/A/B") from the folder list, or null if unknown.
function folderPath(folders: FileResource[], id: string): string | null {
  const byId = new Map(folders.map(f => [f.id, f]));
  const names: string[] = [];
  for (let cur = byId.get(id); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    names.unshift(cur.name);
    if (names.length > 256) return null;
  }
  return names.length > 0 ? '/' + names.join('/') : null;
}

function isUnder(path: string, base: string): boolean {
  return path === base || path.startsWith(base + '/');
}

type PathStep = { id: string | null; name: string };

/**
 * The breadcrumb trail of an own-drive folder from its real ancestors: Home,
 * then each folder down to `id`. null when the chain can't be followed (a
 * parent isn't in `folders`) or runs through the hidden trash folder, which
 * never shows in the breadcrumb.
 */
function ancestorStack(
  folders: readonly { id: string; name: string; parentId?: string | null }[],
  id: string,
  trashId?: string,
): PathStep[] | null {
  const byId = new Map(folders.map(f => [f.id, f]));
  const trail: PathStep[] = [];
  const seen = new Set<string>();
  let at = byId.get(id);
  while (at) {
    if (seen.has(at.id) || at.id === trashId) return null;
    seen.add(at.id);
    trail.unshift({ id: at.id, name: at.name });
    if (at.parentId == null) return [{ id: null, name: '' }, ...trail];
    at = byId.get(at.parentId);
  }
  return null;
}

function sameStack(a: PathStep[], b: PathStep[]): boolean {
  return a.length === b.length && a.every((s, i) => s.id === b[i].id && s.name === b[i].name);
}

function buildPathFromStack(stack: { id: string | null; name: string }[]): string {
  if (stack.length <= 1) return '/';
  return '/' + stack.slice(1).map(s => s.name).join('/');
}

function joinPath(base: string, name: string): string {
  if (!name) return base;
  return base === '/' || base === '' ? `/${name}` : `${base}/${name}`;
}

/** A listed item as plugins see it; `path` is the folder that holds it. */
export function resourceToView(r: FileResource, path: string): FileResourceView {
  return fileToView({
    id: r.id,
    parentId: r.parentId,
    name: r.name,
    type: r.isDirectory ? 'd' : r.contentType,
    blobId: r.isDirectory ? null : r.blobId,
    size: r.contentLength,
    created: r.lastModified,
    modified: r.lastModified,
  }, path);
}

/** Path of the folder holding a node, from the folder list ('' when unknown). */
function parentPath(folders: FileResource[], parentId: string | null | undefined): string {
  if (parentId == null) return '/';
  return folderPath(folders, parentId) ?? '';
}

/** Views of the items whose ids the server reports as destroyed. */
function destroyedViews(views: FileResourceView[], result: { destroyed?: string[] } | undefined): FileResourceView[] {
  if (!result?.destroyed) return views;
  const gone = new Set(result.destroyed);
  return views.filter(v => gone.has(v.id));
}

/** A starred folder as plugins see it; favourites are kept by path. */
function favoriteFolderView(folders: FileResource[], path: string): FileResourceView {
  const slash = path.lastIndexOf('/');
  const parent = slash > 0 ? path.slice(0, slash) : '/';
  const folder = folders.find(f => folderPath(folders, f.id) === path);
  if (folder) return resourceToView(folder, parent);
  return { id: '', name: path.slice(slash + 1), type: 'directory', size: 0, mimeType: '', path: parent, modified: '' };
}

function sameNameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const n of a) if (!b.has(n)) return false;
  return true;
}

/** A node that is not in any listing; plugins get at least its id. */
function unknownNodeView(id: string): FileResourceView {
  return { id, name: '', type: 'file', size: 0, mimeType: '', path: '', modified: '' };
}

/** Ask plugins once about moving these items from `fromPath` to `toPath`. */
async function approveMove(items: FileResource[], fromPath: string, toPath: string): Promise<boolean> {
  if (items.length === 0) return true;
  const files = items.map(r => resourceToView(r, fromPath));
  return fileHooks.onBeforeFileMove.intercept({ files, toPath });
}

/**
 * Move each item with `moveOne`, then tell plugins which ones moved. Items
 * moved before a failure are still reported; the error is passed on.
 */
async function reportMoves(items: FileResource[], toPath: string, moveOne: (r: FileResource) => Promise<void>): Promise<void> {
  const moved: FileResourceView[] = [];
  try {
    for (const resource of items) {
      await moveOne(resource);
      moved.push(resourceToView(resource, toPath));
    }
  } finally {
    if (moved.length > 0) void fileHooks.onFileMove.emit({ files: moved, toPath });
  }
}

export const useFileStore = create<FileState>((set, get) => ({
  currentParentId: null,
  currentPath: '/',
  pathStack: [{ id: null, name: '' }],
  resources: [],
  isLoading: false,
  error: null,
  supportsFiles: null,
  selectedResources: new Set<string>(),
  uploadProgress: null,
  migrationProgress: null,
  client: null,
  currentAccountId: null,
  clipboard: null,
  uploadAbortController: null,
  lastAction: null,
  sharedRoots: [],
  allFolders: [],
  hasListed: false,
  trashCount: 0,
  favorites: (() => {
    try { return JSON.parse(localStorage.getItem('files-favorites') || '[]'); } catch { return []; }
  })(),
  recentFiles: (() => {
    try { return JSON.parse(localStorage.getItem('files-recent-files') || '[]'); } catch { return []; }
  })(),

  initClient: (client: IJMAPClient, accountId?: string | null) => {
    const patch: Partial<FileState> = { client };
    if (accountId !== undefined) patch.currentAccountId = accountId;
    set(patch);
  },

  clearClient: () => {
    set({
      client: null,
      currentAccountId: null,
      supportsFiles: null,
      pathStack: [{ id: null, name: '' }],
      currentPath: '/',
      currentParentId: null,
      resources: [],
      allFolders: [],
      hasListed: false,
      selectedResources: new Set<string>(),
      error: null,
      isLoading: false,
    });
  },

  checkSupport: async () => {
    const { client } = get();
    if (!client) {
      set({ supportsFiles: false });
      return false;
    }
    // First check capability, then probe with a real request
    const supported = await client.probeFileNodeSupport();
    if (!supported) {
      console.warn('[Files] JMAP FileNode not supported. Available capabilities:', Object.keys(client.getCapabilities()));
    }
    set({ supportsFiles: supported });
    return supported;
  },

  migrateLegacyFlatNodes: async () => {
    const { client } = get();
    if (!client) return false;

    let allNodes: FileNode[];
    try {
      allNodes = await client.listAllFileNodes();
    } catch {
      return false;
    }

    // Split an encoded name into its real path segments, accepting any of the
    // legacy separators and dropping empty segments (leading / trailing / dup
    // separators). A non-legacy name yields a single segment.
    const splitSegments = (name: string): string[] => {
      let parts = [name];
      for (const sep of LEGACY_PATH_SEPS) parts = parts.flatMap(p => p.split(sep));
      return parts.filter(Boolean);
    };

    // A legacy "folder marker": an old build stored folders as 0-byte files with
    // a directory-ish `type` and a blob. The server treats these as files, so
    // nothing can be parented under them - they must be replaced by real folders.
    const isLegacyDirMarker = (n: FileNode) => !isFolder(n) && isDirectoryType(n.type);

    const legacy = allNodes.filter(n => lastLegacySepIndex(n.name) >= 0);
    const markers = allNodes.filter(isLegacyDirMarker);
    if (legacy.length === 0 && markers.length === 0) return false;

    // Real folders that already exist, indexed by the canonical path they
    // represent, so we reuse them instead of creating duplicates. Keying on the
    // JSON-encoded segment array avoids separator-collisions between levels.
    const pathKey = (segs: string[]) => JSON.stringify(segs);
    const existingDirByPath = new Map<string, FileNode>();
    for (const n of allNodes) {
      if (!isFolder(n)) continue;
      const segs = splitSegments(n.name);
      if (segs.length > 0) existingDirByPath.set(pathKey(segs), n);
    }

    // Per-node rename+reparent operations to apply. Crucially, every parentId
    // here points at a node we have already ensured is a real folder, so the
    // server's "parent must be a folder" check can't reject them (#379).
    const updates: Record<string, { name: string; parentId: string | null }> = {};
    const dirIdByPath = new Map<string, string | null>();
    dirIdByPath.set('', null); // root
    let skipped = 0;
    let createdDirs = 0;
    let creationBroken = false;

    // Ensure a real folder exists for the given path, returning its id. Reuses an
    // existing folder at that path (scheduling it for rename/reparent into the
    // real hierarchy) or creates a fresh one. Sequential because a create hits
    // the server and deeper levels depend on its id.
    const ensureDir = async (segs: string[]): Promise<string | null> => {
      if (segs.length === 0) return null;
      const key = pathKey(segs);
      if (dirIdByPath.has(key)) return dirIdByPath.get(key)!;
      const parentId = await ensureDir(segs.slice(0, -1));
      const leaf = segs[segs.length - 1];
      const existing = existingDirByPath.get(key);
      if (existing) {
        // Reuse it; only rewrite if its name/parent isn't already correct.
        if (existing.name !== leaf || (existing.parentId ?? null) !== parentId) {
          updates[existing.id] = { name: leaf, parentId };
        }
        dirIdByPath.set(key, existing.id);
        return existing.id;
      }
      const created = await client.createFileDirectory(leaf, parentId);
      // Safety net: a real folder has no content blob. If the server (or a stale
      // build of createFileDirectory) hands back a blob-backed node, it is NOT a
      // folder - abort before we delete anything irreversible (see below).
      if (!isFolder(created)) {
        creationBroken = true;
        throw new Error('createFileDirectory returned a non-folder (has a blobId)');
      }
      createdDirs++;
      dirIdByPath.set(key, created.id);
      return created.id;
    };

    const placeDir = async (segs: string[], label: string) => {
      try {
        await ensureDir(segs);
      } catch (err) {
        skipped++;
        if (!creationBroken) console.warn('[Files] migration: could not create folder', JSON.stringify(label), '→', err instanceof Error ? err.message : String(err));
      }
    };

    // Move the legacy marker files out of the way (a reversible rename) so their
    // names are free for the real folders created in their place. They are only
    // DELETED at the very end, once the real hierarchy is safely in place - so a
    // failure can never leave a folder both gone and not recreated.
    const renamedMarkers: { id: string; name: string }[] = [];
    for (const m of markers) {
      try {
        await client.updateFileNode(m.id, { name: `__bulwark_migrating__.${m.id}` });
        renamedMarkers.push({ id: m.id, name: m.name });
      } catch (err) {
        console.warn('[Files] migration: could not set aside marker', JSON.stringify(m.name), '→', err instanceof Error ? err.message : String(err));
      }
    }

    // Recreate folders that existed only as markers, reparent any real folders
    // that still carry an encoded name, then reparent the content files.
    for (const m of markers) {
      const segs = splitSegments(m.name);
      if (segs.length > 0) await placeDir(segs, m.name);
    }
    for (const node of legacy) {
      if (!isFolder(node) || isLegacyDirMarker(node)) continue;
      const segs = splitSegments(node.name);
      if (segs.length > 0) await placeDir(segs, node.name);
    }
    for (const node of legacy) {
      if (isFolder(node) || isLegacyDirMarker(node)) continue;
      const segs = splitSegments(node.name);
      if (segs.length === 0) { skipped++; continue; }
      try {
        const parentId = await ensureDir(segs.slice(0, -1));
        updates[node.id] = { name: segs[segs.length - 1], parentId };
      } catch (err) {
        skipped++;
        if (!creationBroken) console.warn('[Files] migration: could not place', JSON.stringify(node.name), '→', err instanceof Error ? err.message : String(err));
      }
    }

    // If folder creation is fundamentally broken, restore the markers we set
    // aside and bail out without deleting or reparenting anything. No data lost.
    if (creationBroken) {
      console.error('[Files] migration aborted: the server did not return real folders ' +
        '(createFileDirectory produced blob-backed nodes). Restoring markers; nothing was deleted.');
      for (const m of renamedMarkers) {
        try { await client.updateFileNode(m.id, { name: m.name }); } catch { /* best effort */ }
      }
      set({ migrationProgress: null });
      return false;
    }

    const updateIds = Object.keys(updates);
    set({ migrationProgress: { current: 0, total: updateIds.length } });

    let migrated = 0;
    let firstError: string | null = null;
    const CHUNK = 100;
    try {
      for (let i = 0; i < updateIds.length; i += CHUNK) {
        const slice = updateIds.slice(i, i + CHUNK);
        const batch: Record<string, { name: string; parentId: string | null }> = {};
        for (const id of slice) batch[id] = updates[id];
        try {
          const { updated, notUpdated } = await client.updateFileNodes(batch);
          migrated += updated.length;
          const failedIds = Object.keys(notUpdated);
          if (failedIds.length > 0 && !firstError) firstError = notUpdated[failedIds[0]];
          for (const id of failedIds) {
            console.error('[Files] migration: server rejected node', id, '→', notUpdated[id]);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!firstError) firstError = msg;
          console.error('[Files] migration: batch failed →', msg);
        }
        set({ migrationProgress: { current: Math.min(i + CHUNK, updateIds.length), total: updateIds.length } });
      }
    } finally {
      set({ migrationProgress: null });
    }

    // The real hierarchy is now in place, so the set-aside marker files are empty
    // and safe to delete. Done last, on purpose: until here nothing irreversible
    // has happened.
    let removedMarkers = 0;
    if (renamedMarkers.length > 0) {
      try {
        const { destroyed } = await client.destroyFileNodes(renamedMarkers.map(m => m.id));
        removedMarkers = destroyed.length;
      } catch (err) {
        console.warn('[Files] migration: could not remove emptied markers →', err instanceof Error ? err.message : String(err));
      }
    }

    const didWork = migrated > 0 || createdDirs > 0 || removedMarkers > 0;
    if (!didWork && (legacy.length > 0 || markers.length > 0)) {
      console.error(`[Files] migration found ${legacy.length} legacy node(s) but changed nothing ` +
        `(skipped ${skipped}, first error: ${firstError ?? 'none'}).`);
    } else if (didWork) {
      console.info(`[Files] migration reparented ${migrated} file(s), created ${createdDirs} folder(s), ` +
        `removed ${removedMarkers} legacy marker(s) (skipped ${skipped}).`);
    }
    return didWork;
  },

  navigate: async (parentId: string | null, name?: string) => {
    const { client, pathStack, currentParentId: previousParentId, hasListed, allFolders: knownFolders } = get();
    if (!client) return;
    // A refresh lists the same folder again; plugins only hear about a new one.
    const opensFolder = !hasListed || parentId !== previousParentId;

    set({ isLoading: true, error: null, currentParentId: parentId, selectedResources: new Set() });

    // Update path stack
    let newStack: { id: string | null; name: string }[];
    if (parentId === null) {
      newStack = [{ id: null, name: '' }];
    } else if (sharedFilesOwner(parentId) !== null) {
      // A shared-files page sits right below Home, whatever was open before.
      newStack = [{ id: null, name: '' }, { id: parentId, name: name || parentId }];
    } else if (isTrashLocation(parentId)) {
      newStack = [{ id: null, name: '' }, { id: TRASH_LOCATION, name: TRASH_FOLDER_NAME }];
    } else {
      // An own-drive folder: the trail is its real ancestors, wherever it was
      // opened from (the tree, a favorite, the Trash). A folder of a shared
      // drive builds on the trail openSharedNode set up.
      const known = isCrossAccountId(parentId) ? null : ancestorStack(knownFolders, parentId);
      const existingIdx = pathStack.findIndex(s => s.id === parentId);
      if (known) {
        newStack = known;
      } else if (existingIdx >= 0) {
        newStack = pathStack.slice(0, existingIdx + 1);
      } else {
        // The Trash and shared-files pages are no folder to be inside of.
        const base = pathStack.filter(s => s.id === null || (!isTrashLocation(s.id) && sharedFilesOwner(s.id) === null));
        newStack = [...base, { id: parentId, name: name || parentId }];
      }
    }

    let newPath = buildPathFromStack(newStack);
    set({ pathStack: newStack, currentPath: newPath });

    try { localStorage.setItem('files-last-parent-id', parentId || ''); } catch { /* ignore */ }
    try { localStorage.setItem('files-path-stack', JSON.stringify(newStack)); } catch { /* ignore */ }

    try {
      // Fetch the whole tree once and select the current parent's direct
      // children locally. Hierarchy is derived from parentId links, exactly as
      // the JMAP FileNode spec intends (issue #379). When browsing inside a
      // folder shared by another principal (namespaced id), pull the tree
      // across all accessible accounts so the shared subtree is visible.
      const allNodes = isCrossAccountId(parentId)
        ? await client.listAllFileNodesAcrossAccounts()
        : await client.listAllFileNodes();
      const owner = sharedFilesOwner(parentId);
      // The trash and what is in it stay out of every listing but its own.
      const trash = findTrashFolder(allNodes);
      const inTrash = trashSubtreeIds(allNodes, trash?.id);
      const trashed = trashedItems(allNodes, trash);
      const resources = isTrashLocation(parentId)
        ? withUniqueNames(sortResources(trashed.map(item => ({
          ...nodeToResource(item.node),
          trash: {
            deletedAt: item.deletedAt !== null ? new Date(item.deletedAt).toISOString() : null,
            fromParentId: item.fromParentId,
            batchId: item.batchId,
          },
        }))))
        : owner !== null
          ? withUniqueNames(sortResources(
            sharedRootsOf(allNodes).filter(n => n.accountId === owner && !isFolder(n)).map(nodeToResource),
          ))
          // The owner's folders on the way down to a shared node aren't shown
          // (see sharedRootsOf); the user can do nothing in them.
          : sortResources(childrenOf(allNodes, parentId).filter(n => !n.discoverableOnly && !inTrash.has(n.id)).map(nodeToResource));
      // The owner's folders above a shared one stay out of the tree as well.
      const allFolders = allNodes.filter(n => isFolder(n) && !n.discoverableOnly && !inTrash.has(n.id)).map(nodeToResource);

      // The folder list was stale or empty (first visit, a link): set the
      // trail again from the fresh one, unless another folder opened since.
      if (parentId !== null && !isCrossAccountId(parentId) && !isTrashLocation(parentId)
        && sharedFilesOwner(parentId) === null && get().currentParentId === parentId) {
        const fresh = ancestorStack(allNodes.filter(n => isFolder(n)), parentId, trash?.id);
        if (fresh && !sameStack(fresh, get().pathStack)) {
          newPath = buildPathFromStack(fresh);
          set({ pathStack: fresh, currentPath: newPath });
          try { localStorage.setItem('files-path-stack', JSON.stringify(fresh)); } catch { /* ignore */ }
        }
      }

      // Prune recent files whose backing node no longer exists on the server
      // or is in the trash.
      const { recentFiles } = get();
      const existingIds = new Set(allNodes.filter(n => !inTrash.has(n.id)).map(n => n.id));
      const prunedRecent = recentFiles.filter(r => existingIds.has(r.id));
      if (prunedRecent.length !== recentFiles.length) {
        try { localStorage.setItem('files-recent-files', JSON.stringify(prunedRecent)); } catch { /* ignore */ }
        set({ resources, allFolders, trashCount: trashed.length, recentFiles: prunedRecent, isLoading: false, hasListed: true });
      } else {
        set({ resources, allFolders, trashCount: trashed.length, isLoading: false, hasListed: true });
      }
      if (opensFolder) void fileHooks.onFileNavigate.emit({ path: newPath });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to list directory',
        hasListed: true,
        isLoading: false,
        resources: [],
      });
    }
  },

  navigateByPath: async (path: string) => {
    const { pathStack, navigate } = get();
    if (path === '/') {
      await navigate(null);
      return;
    }
    if (path === TRASH_PATH) {
      await navigate(TRASH_LOCATION, TRASH_FOLDER_NAME);
      return;
    }
    // Try to match the path against the current pathStack
    const segments = path.split('/').filter(Boolean);
    const targetDepth = segments.length;
    // pathStack[0] is root (id: null, name: ''), subsequent entries match path segments
    if (targetDepth < pathStack.length) {
      const entry = pathStack[targetDepth];
      // Verify the names match
      const stackPath = pathStack.slice(1, targetDepth + 1).map(s => s.name).join('/');
      if (stackPath === segments.join('/')) {
        await navigate(entry.id, entry.name);
        return;
      }
    }
    // Fallback: resolve the path against the live hierarchy (covers favorites
    // and recent paths outside the current breadcrumb stack).
    const { client } = get();
    if (client) {
      try {
        const allNodes = await client.listAllFileNodes();
        const id = resolvePathToId(allNodes, path);
        if (id !== undefined) {
          await navigate(id, segments[segments.length - 1]);
        }
      } catch { /* ignore */ }
    }
  },

  navigateUp: async () => {
    const { pathStack, navigate } = get();
    if (pathStack.length <= 1) return;
    const parent = pathStack[pathStack.length - 2];
    await navigate(parent.id, parent.name);
  },

  refresh: async () => {
    const { currentParentId, navigate, pathStack } = get();
    const currentEntry = pathStack[pathStack.length - 1];
    await navigate(currentParentId, currentEntry?.name);
  },

  createDirectory: async (name: string) => {
    const { client, currentParentId, currentPath, refresh } = get();
    if (!client) return;
    assertCanAddTo(currentParentId);

    const created = await client.createFileDirectory(name, currentParentId);
    void fileHooks.onDirectoryCreate.emit(fileToView(created, currentPath));
    await refresh();
  },

  uploadFile: async (file: File) => {
    const { client, currentParentId, currentPath } = get();
    if (!client) return;
    assertCanAddTo(currentParentId);
    if (!(await fileHooks.onBeforeFileUpload.intercept({ name: file.name, size: file.size, type: file.type, path: currentPath }))) return;

    const abortController = new AbortController();
    set({ uploadAbortController: abortController });
    set({ uploadProgress: { name: file.name, loaded: 0, total: file.size, current: 1, totalFiles: 1 } });

    try {
      if (abortController.signal.aborted) return;
      const { blobId, type } = await client.uploadBlob(file, {
        signal: abortController.signal,
        onProgress: (loaded, total) => {
          set({ uploadProgress: { name: file.name, loaded, total, current: 1, totalFiles: 1 } });
        },
      });
      if (abortController.signal.aborted) return;
      set({ uploadProgress: { name: file.name, loaded: file.size, total: file.size, current: 1, totalFiles: 1 } });
      const node = await client.createFileNode(file.name, blobId, type || file.type || 'application/octet-stream', file.size, currentParentId);
      void fileHooks.onAfterFileUpload.emit(fileToView(node, currentPath));
    } finally {
      set({ uploadProgress: null, uploadAbortController: null });
    }
  },

  uploadFiles: async (allFiles: File[]) => {
    const { client, currentParentId, currentPath, resources } = get();
    const report: UploadReport = { uploaded: 0, failed: [], canceled: false };
    if (!client) return report;
    assertCanAddTo(currentParentId);

    // Plugins may hold back single files; the rest go up.
    const files: File[] = [];
    for (const file of allFiles) {
      if (await fileHooks.onBeforeFileUpload.intercept({ name: file.name, size: file.size, type: file.type, path: currentPath })) {
        files.push(file);
      }
    }
    if (files.length === 0) return report;

    const abortController = new AbortController();
    set({ uploadAbortController: abortController });
    const totalFiles = files.length;
    const existingNames = new Set(resources.map(r => r.name));

    for (let i = 0; i < files.length; i++) {
      if (abortController.signal.aborted) break;
      const file = files[i];
      const uniqueName = getUniqueName(file.name, existingNames);
      existingNames.add(uniqueName);
      set({ uploadProgress: { name: file.name, loaded: 0, total: file.size, current: i + 1, totalFiles } });

      try {
        const idx = i;
        const { blobId, type } = await client.uploadBlob(file, {
          signal: abortController.signal,
          onProgress: (loaded, total) => {
            set({ uploadProgress: { name: file.name, loaded, total, current: idx + 1, totalFiles } });
          },
        });
        if (abortController.signal.aborted) break;
        set({ uploadProgress: { name: file.name, loaded: file.size, total: file.size, current: i + 1, totalFiles } });
        const node = await client.createFileNode(uniqueName, blobId, type || file.type || 'application/octet-stream', file.size, currentParentId);
        report.uploaded++;
        void fileHooks.onAfterFileUpload.emit(fileToView(node, currentPath));
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') break;
        report.failed.push({ name: file.name, error: err });
      }
    }
    set({ uploadProgress: null, uploadAbortController: null });
    await get().refresh();
    report.canceled = abortController.signal.aborted;
    return report;
  },

  cancelUpload: () => {
    const { uploadAbortController, uploadProgress, currentPath } = get();
    if (uploadAbortController) {
      uploadAbortController.abort();
      set({ uploadProgress: null, uploadAbortController: null });
      void fileHooks.onFileUploadCancel.emit({ name: uploadProgress?.name ?? '', path: currentPath });
    }
  },

  uploadFolder: async (allFiles: File[]) => {
    const { client, currentParentId, currentPath } = get();
    const report: UploadReport = { uploaded: 0, failed: [], canceled: false };
    if (!client || allFiles.length === 0) return report;
    assertCanAddTo(currentParentId);

    const relativePathOf = (file: File) => (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const dirOf = (relativePath: string) => {
      const slash = relativePath.lastIndexOf('/');
      return slash >= 0 ? relativePath.slice(0, slash) : '';
    };
    const levelsOf = (path: string) => (path ? path.split('/').length : 0);

    // Ask plugins about every file before anything is created, so a folder
    // that only held refused files is not created either.
    const files: File[] = [];
    for (const file of allFiles) {
      const path = joinPath(currentPath, dirOf(relativePathOf(file)));
      if (await fileHooks.onBeforeFileUpload.intercept({ name: file.name, size: file.size, type: file.type, path })) {
        files.push(file);
      }
    }
    if (files.length === 0) return report;

    const abortController = new AbortController();
    set({ uploadAbortController: abortController });
    const totalFiles = files.length;

    // Collect unique directory paths (relative to the dropped folder) and
    // create them as real nested directories, mapping each path to its node id.
    const dirs = new Set<string>();
    for (const file of files) {
      const parts = relativePathOf(file).split('/');
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join('/'));
      }
    }

    // Stalwart 1.0 refuses nodes deeper than maxFileNodeDepth (64). Find out
    // up front what won't fit below the current folder.
    const maxDepth = client.getMaxFileNodeDepth?.() ?? null;
    let baseDepth = 0;
    if (maxDepth !== null && currentParentId !== null) {
      try {
        const nodes = isCrossAccountId(currentParentId)
          ? await client.listAllFileNodesAcrossAccounts()
          : await client.listAllFileNodes();
        baseDepth = fileNodeDepth(nodes, currentParentId);
      } catch {
        // The server still refuses what doesn't fit.
      }
    }
    const tooDeep = (levels: number) => maxDepth !== null && baseDepth + levels > maxDepth;

    // Map a directory path to its created node id. Root ('') maps to the
    // current folder we are uploading into. A folder that can't be created
    // keeps its error, and everything inside it is skipped with that error
    // instead of landing in the folder the upload started in.
    const dirIds = new Map<string, string | null>([['', currentParentId]]);
    const dirErrors = new Map<string, unknown>();

    const sortedDirs = [...dirs].sort((a, b) => levelsOf(a) - levelsOf(b));
    for (const dir of sortedDirs) {
      if (abortController.signal.aborted) break;
      const slash = dir.lastIndexOf('/');
      const parentPath = slash >= 0 ? dir.slice(0, slash) : '';
      const dirName = slash >= 0 ? dir.slice(slash + 1) : dir;
      const parentId = dirIds.get(parentPath);
      if (parentId === undefined) {
        dirErrors.set(dir, dirErrors.get(parentPath));
        continue;
      }
      if (tooDeep(levelsOf(dir))) {
        dirErrors.set(dir, folderDepthError());
        continue;
      }
      try {
        const created = await client.createFileDirectory(dirName, parentId);
        dirIds.set(dir, created.id);
        void fileHooks.onDirectoryCreate.emit(fileToView(created, joinPath(currentPath, parentPath)));
      } catch (err) {
        dirErrors.set(dir, err);
      }
    }

    // Upload files into their containing directory.
    for (let i = 0; i < files.length; i++) {
      if (abortController.signal.aborted) break;
      const file = files[i];
      const relativePath = relativePathOf(file);
      const dirPath = dirOf(relativePath);
      const parentId = dirIds.get(dirPath);
      if (parentId === undefined) {
        report.failed.push({ name: relativePath, error: dirErrors.get(dirPath) });
        continue;
      }
      if (tooDeep(levelsOf(dirPath) + 1)) {
        report.failed.push({ name: relativePath, error: folderDepthError() });
        continue;
      }

      set({ uploadProgress: { name: relativePath, loaded: 0, total: file.size, current: i + 1, totalFiles } });

      try {
        const idx = i;
        const { blobId, type } = await client.uploadBlob(file, {
          signal: abortController.signal,
          onProgress: (loaded, total) => {
            set({ uploadProgress: { name: relativePath, loaded, total, current: idx + 1, totalFiles } });
          },
        });
        if (abortController.signal.aborted) break;
        set({ uploadProgress: { name: relativePath, loaded: file.size, total: file.size, current: i + 1, totalFiles } });
        const node = await client.createFileNode(file.name, blobId, type || file.type || 'application/octet-stream', file.size, parentId);
        report.uploaded++;
        void fileHooks.onAfterFileUpload.emit(fileToView(node, joinPath(currentPath, dirPath)));
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') break;
        report.failed.push({ name: relativePath, error: err });
      }
    }
    set({ uploadProgress: null, uploadAbortController: null });
    await get().refresh();
    report.canceled = abortController.signal.aborted;
    return report;
  },

  deleteResource: async (name: string) => {
    const { client, resources, recentFiles, currentPath, refresh } = get();
    if (!client) return false;

    const resource = resources.find(r => r.name === name);
    if (!resource) return false;

    const files = [resourceToView(resource, currentPath)];
    if (!(await fileHooks.onBeforeFileDelete.intercept({ files }))) return false;

    // The server removes descendant nodes (onDestroyRemoveChildren).
    const result = await client.destroyFileNodes([resource.id]);
    const deleted = destroyedViews(files, result);
    if (deleted.length > 0) void fileHooks.onAfterFileDelete.emit({ files: deleted });
    const nextRecentFiles = recentFiles.filter(r => r.id !== resource.id);
    set({ recentFiles: nextRecentFiles });
    try { localStorage.setItem('files-recent-files', JSON.stringify(nextRecentFiles)); } catch { /* ignore */ }
    await refresh();
    return true;
  },

  deleteResources: async (names: string[]) => {
    const { client, resources, recentFiles, currentPath, refresh } = get();
    if (!client) return false;

    const idsToDelete: string[] = [];
    const files: FileResourceView[] = [];
    for (const name of names) {
      const resource = resources.find(r => r.name === name);
      if (resource) {
        idsToDelete.push(resource.id);
        files.push(resourceToView(resource, currentPath));
      }
    }

    if (idsToDelete.length === 0) return false;
    if (!(await fileHooks.onBeforeFileDelete.intercept({ files }))) return false;

    // The server removes descendant nodes (onDestroyRemoveChildren).
    const result = await client.destroyFileNodes(idsToDelete);
    const deleted = destroyedViews(files, result);
    if (deleted.length > 0) void fileHooks.onAfterFileDelete.emit({ files: deleted });
    const deletedIdSet = new Set(idsToDelete);
    const nextRecentFiles = recentFiles.filter(r => !deletedIdSet.has(r.id));
    set({ selectedResources: new Set() });
    set({ recentFiles: nextRecentFiles });
    try { localStorage.setItem('files-recent-files', JSON.stringify(nextRecentFiles)); } catch { /* ignore */ }
    await refresh();
    return true;
  },

  renameResource: async (oldName: string, newName: string) => {
    const { client, resources, currentPath, refresh } = get();
    if (!client) return false;

    const resource = resources.find(r => r.name === oldName);
    if (!resource) return false;

    const file = resourceToView(resource, currentPath);
    if (!(await fileHooks.onBeforeFileRename.intercept({ file, newName }))) return false;

    await client.updateFileNode(resource.id, { name: newName });
    void fileHooks.onFileRename.emit({ file: { ...file, name: newName }, previousName: oldName });

    set({
      lastAction: {
        type: 'rename',
        entries: [{ id: resource.id, from: { name: oldName }, to: { name: newName } }],
        sourceParentId: null,
      },
    });
    await refresh();
    return true;
  },

  downloadResource: async (name: string) => {
    const { client, resources, currentPath } = get();
    if (!client) return;

    const resource = resources.find(r => r.name === name);
    if (!resource?.blobId) return;

    await client.downloadBlob(resource.blobId, resource.name, resource.contentType, undefined, { kind: 'file' });
    void fileHooks.onFileDownload.emit(resourceToView(resource, currentPath));
  },

  downloadResources: async (names: string[]) => {
    const { downloadResource } = get();
    for (const name of names) {
      await downloadResource(name);
    }
  },

  downloadZip: async (ids, zipName, options = {}) => {
    const { client } = get();
    if (!client) return;
    // Before fetching every file: the device policy may have turned downloads off.
    if (!downloadAllowed('file', { client })) return;
    const nodes = ids.some(isCrossAccountId)
      ? await client.listAllFileNodesAcrossAccounts()
      : await client.listAllFileNodes();
    const plan = planZip(nodes, ids);
    // A node of a drive shared with the user is fetched from its owner's account.
    const blob = await buildZip(plan, (node) => client.fetchBlob(node.blobId!, node.name, node.type, node.accountId), options);
    saveBlob(blob, zipName, { subject: { client } });
  },

  getImageUrl: async (name: string) => {
    const { client, resources } = get();
    if (!client) throw new Error('No client');

    const resource = resources.find(r => r.name === name);
    if (!resource?.blobId) throw new Error('No blob');

    return imageBlobUrl(await client.fetchBlob(resource.blobId, resource.name, resource.contentType), resource.contentType);
  },

  getFileContent: async (name: string) => {
    const { client, resources } = get();
    if (!client) throw new Error('No client');

    const resource = resources.find(r => r.name === name);
    if (!resource?.blobId) throw new Error('No blob');

    // Through the client, like getImageUrl: the demo has no download URL to fetch.
    const blob = await client.fetchBlob(resource.blobId, resource.name, resource.contentType);
    return { blob, contentType: resource.contentType || 'application/octet-stream' };
  },

  createFile: async (name: string, template?: Blob) => {
    const { client, currentParentId, refresh } = get();
    if (!client) return null;
    assertCanAddTo(currentParentId);

    const type = template?.type || 'text/plain';
    const content = new File(template ? [template] : [''], name, { type });
    const { blobId } = await client.uploadBlob(content);
    const node = await client.createFileNode(name, blobId, type, content.size, currentParentId);
    await refresh();
    return node.name || name;
  },

  duplicateResource: async (name: string) => {
    const { client, resources, currentParentId, currentPath, refresh } = get();
    if (!client) return;

    const resource = resources.find(r => r.name === name);
    if (!resource || resource.isSymlink) return;
    assertCanAddTo(currentParentId);

    const dotIdx = name.lastIndexOf('.');
    const copyName = dotIdx > 0
      ? `${name.substring(0, dotIdx)} (copy)${name.substring(dotIdx)}`
      : `${name} (copy)`;

    const copy = await client.copyFileNode(resource.id, copyName, currentParentId);
    void fileHooks.onFileDuplicate.emit(fileToView(copy, currentPath));
    await refresh();
  },

  moveToFolder: async (names: string[], targetFolder: string) => {
    const { client, resources, currentPath, refresh } = get();
    if (!client) return false;

    const targetResource = resources.find(r => r.name === targetFolder && r.isDirectory);
    if (!targetResource) return false;

    const toMove = names
      .map(name => resources.find(r => r.name === name))
      .filter((r): r is FileResource => !!r && r.id !== targetResource.id);
    const toPath = joinPath(currentPath, targetFolder);
    if (!(await approveMove(toMove, currentPath, toPath))) return false;

    const entries: UndoAction['entries'] = [];
    await reportMoves(toMove, toPath, async (resource) => {
      await client.updateFileNode(resource.id, { parentId: targetResource.id });
      entries.push({ id: resource.id, from: { parentId: resource.parentId }, to: { parentId: targetResource.id } });
    });
    set({
      selectedResources: new Set(),
      lastAction: { type: 'move', entries, sourceParentId: null },
    });
    await refresh();
    return true;
  },

  moveToParent: async (names: string[]) => {
    const { client, resources, pathStack, currentPath, refresh } = get();
    if (!client || pathStack.length <= 1) return false;

    // Move into the grandparent of the current folder's contents, i.e. the
    // entry one level up in the breadcrumb stack.
    const newParentId = pathStack[pathStack.length - 2].id;

    const toMove = names
      .map(name => resources.find(r => r.name === name))
      .filter((r): r is FileResource => !!r);
    const toPath = buildPathFromStack(pathStack.slice(0, -1));
    if (!(await approveMove(toMove, currentPath, toPath))) return false;

    const entries: UndoAction['entries'] = [];
    await reportMoves(toMove, toPath, async (resource) => {
      await client.updateFileNode(resource.id, { parentId: newParentId });
      entries.push({ id: resource.id, from: { parentId: resource.parentId }, to: { parentId: newParentId } });
    });
    set({
      selectedResources: new Set(),
      lastAction: { type: 'move', entries, sourceParentId: null },
    });
    await refresh();
    return true;
  },

  moveToFolderId: async (names: string[], targetId: string | null) => {
    const { client, resources, currentParentId, currentPath, allFolders, refresh } = get();
    if (!client || targetId === currentParentId) return false;
    assertCanAddTo(targetId);

    // A folder must not move into itself or anything below it.
    const parentOf = new Map(allFolders.map(f => [f.id, f.parentId ?? null]));
    const isInside = (folderId: string | null, ancestorId: string) => {
      for (let id = folderId; id != null; id = parentOf.get(id) ?? null) {
        if (id === ancestorId) return true;
      }
      return false;
    };

    const toMove = names
      .map(name => resources.find(r => r.name === name))
      .filter((r): r is FileResource => !!r && !(r.isDirectory && isInside(targetId, r.id)));
    const toPath = parentPath(allFolders, targetId);
    if (!(await approveMove(toMove, currentPath, toPath))) return false;

    const entries: UndoAction['entries'] = [];
    await reportMoves(toMove, toPath, async (resource) => {
      await client.updateFileNode(resource.id, { parentId: targetId });
      entries.push({ id: resource.id, from: { parentId: resource.parentId }, to: { parentId: targetId } });
    });
    set({
      selectedResources: new Set(),
      lastAction: entries.length > 0 ? { type: 'move', entries, sourceParentId: null } : get().lastAction,
    });
    await refresh();
    return true;
  },

  moveNode: async (id: string, targetId: string | null) => {
    const { client, allFolders, resources, refresh } = get();
    if (!client) return false;
    assertCanAddTo(targetId);
    // A folder must not move into itself or anything below it.
    const parentOf = new Map(allFolders.map(f => [f.id, f.parentId ?? null]));
    for (let cur = targetId; cur != null; cur = parentOf.get(cur) ?? null) {
      if (cur === id) return false;
    }
    const known = allFolders.find(f => f.id === id) ?? resources.find(r => r.id === id);
    const from = known?.parentId ?? null;
    if (known && from === targetId) return false;
    const view = known ? resourceToView(known, parentPath(allFolders, from)) : unknownNodeView(id);
    const toPath = parentPath(allFolders, targetId);
    if (!(await fileHooks.onBeforeFileMove.intercept({ files: [view], toPath }))) return false;
    await client.updateFileNode(id, { parentId: targetId });
    void fileHooks.onFileMove.emit({ files: [view], toPath });
    set({ lastAction: { type: 'move', entries: [{ id, from: { parentId: from }, to: { parentId: targetId } }], sourceParentId: null } });
    await refresh();
    return true;
  },

  cutResources: (names: string[]) => {
    const { currentPath, currentParentId, resources } = get();
    const picked = names
      .map(n => resources.find(r => r.name === n))
      .filter((r): r is FileResource => !!r);
    set({
      clipboard: {
        mode: 'cut',
        ids: picked.map(r => r.id),
        names: picked.map(r => r.name),
        serverNames: picked.map(r => r.serverName),
        sourceParentId: currentParentId,
        sourceParentIds: picked.map(r => r.parentId ?? null),
        sourcePath: currentPath,
        files: picked.map(r => resourceToView(r, currentPath)),
      },
    });
  },

  copyResources: (names: string[]) => {
    const { currentPath, currentParentId, resources } = get();
    // A symlink has nothing to copy (see copyFileNode), so it stays behind.
    const picked = names
      .map(n => resources.find(r => r.name === n))
      .filter((r): r is FileResource => !!r && !r.isSymlink);
    if (picked.length === 0) {
      // Nothing to copy replaces the clipboard too, instead of leaving an
      // earlier cut or copy for the next paste.
      set({ clipboard: null });
      return;
    }
    set({
      clipboard: {
        mode: 'copy',
        ids: picked.map(r => r.id),
        names: picked.map(r => r.name),
        serverNames: picked.map(r => r.serverName),
        sourceParentId: currentParentId,
        sourcePath: currentPath,
        files: picked.map(r => resourceToView(r, currentPath)),
      },
    });
  },

  pasteResources: async () => {
    const { client, currentParentId, currentPath, clipboard, refresh } = get();
    if (!client || !clipboard) return false;
    assertCanAddTo(currentParentId);

    const viewOf = (id: string) => clipboard.files?.find(f => f.id === id);
    if (clipboard.mode === 'cut') {
      const files = clipboard.ids.map(viewOf).filter((f): f is FileResourceView => !!f);
      if (!(await fileHooks.onBeforeFileMove.intercept({ files, toPath: currentPath }))) return false;
    }

    const entries: UndoAction['entries'] = [];
    const done: FileResourceView[] = [];
    // Each copy reads the source and target trees; read them once per paste.
    const listings: FileNodeListings = new Map();

    try {
      for (let i = 0; i < clipboard.ids.length; i++) {
        const id = clipboard.ids[i];
        const displayName = clipboard.names[i];

        if (clipboard.mode === 'cut') {
          await client.updateFileNode(id, { parentId: currentParentId });
          const from = clipboard.sourceParentIds ? clipboard.sourceParentIds[i] : clipboard.sourceParentId;
          entries.push({ id, from: { parentId: from }, to: { parentId: currentParentId } });
          const view = viewOf(id);
          if (view) done.push({ ...view, path: currentPath });
        } else {
          const copy = await client.copyFileNode(id, displayName, currentParentId, listings);
          done.push(fileToView(copy, currentPath));
        }
      }
    } finally {
      // Report what really happened, also when a later item failed.
      if (done.length > 0) {
        if (clipboard.mode === 'cut') void fileHooks.onFileMove.emit({ files: done, toPath: currentPath });
        else void fileHooks.onFileCopy.emit({ files: done, toPath: currentPath });
      }
    }

    if (clipboard.mode === 'cut') {
      set({
        clipboard: null,
        lastAction: { type: 'move', entries, sourceParentId: null },
      });
    }
    await refresh();
    return true;
  },

  selectResource: (name: string | null) => {
    set({ selectedResources: name ? new Set([name]) : new Set() });
  },

  toggleSelect: (name: string) => {
    const { selectedResources } = get();
    const next = new Set(selectedResources);
    if (next.has(name)) {
      next.delete(name);
    } else {
      next.add(name);
    }
    set({ selectedResources: next });
  },

  selectAll: () => {
    const { resources } = get();
    set({ selectedResources: new Set(resources.map(r => r.name)) });
  },

  clearSelection: () => {
    set({ selectedResources: new Set() });
  },

  setSelection: (names: Set<string>) => {
    set({ selectedResources: new Set(names) });
  },

  listPath: async (path: string) => {
    const { client } = get();
    if (!client) return [];

    try {
      const allNodes = await client.listAllFileNodes();
      const parentId = resolvePathToId(allNodes, path);
      if (parentId === undefined) return [];
      return sortResources(childrenOf(allNodes, parentId).map(nodeToResource));
    } catch {
      return [];
    }
  },

  listByParentId: async (parentId: string | null) => {
    const { client } = get();
    if (!client) return [];
    try {
      const allNodes = await client.listAllFileNodes();
      return sortResources(childrenOf(allNodes, parentId).map(nodeToResource));
    } catch {
      return [];
    }
  },

  toggleFavorite: (path: string) => {
    const { favorites, allFolders } = get();
    const favorite = !favorites.includes(path);
    const next = favorite ? [...favorites, path] : favorites.filter(f => f !== path);
    set({ favorites: next });
    try { localStorage.setItem('files-favorites', JSON.stringify(next)); } catch { /* ignore */ }
    if (fileHooks.onFileFavoriteToggle.size > 0) {
      void fileHooks.onFileFavoriteToggle.emit({ file: favoriteFolderView(allFolders, path), favorite });
    }
  },

  addRecentFile: (name: string, id: string) => {
    const { recentFiles } = get();
    const entry = { name, id, timestamp: Date.now() };
    const filtered = recentFiles.filter(r => r.id !== id);
    const next = [entry, ...filtered].slice(0, 20);
    set({ recentFiles: next });
    try { localStorage.setItem('files-recent-files', JSON.stringify(next)); } catch { /* ignore */ }
  },

  revealNode: async (id: string) => {
    const { client, navigate } = get();
    if (!client) return null;
    let nodes: FileNode[];
    try {
      nodes = isCrossAccountId(id)
        ? await client.listAllFileNodesAcrossAccounts()
        : await client.listAllFileNodes();
    } catch {
      return null;
    }
    const byId = new Map(nodes.map(n => [n.id, n]));
    const node = byId.get(id);
    if (!node) return null;

    // Rebuild the breadcrumb trail so navigate() lands on the right path.
    const stack: { id: string | null; name: string }[] = [];
    for (let p = node.parentId ?? null; p != null; p = byId.get(p)?.parentId ?? null) {
      const parent = byId.get(p);
      if (!parent) break;
      stack.unshift({ id: parent.id, name: parent.name });
    }
    stack.unshift({ id: null, name: '' });
    set({ pathStack: stack });
    const parentEntry = stack[stack.length - 1];
    await navigate(parentEntry.id, parentEntry.name);
    set({ selectedResources: new Set([node.name]) });
    return node.name;
  },

  renameNode: async (id: string, newName: string) => {
    const { client, allFolders, resources, favorites, refresh } = get();
    if (!client) return false;
    const node = allFolders.find(f => f.id === id);
    const oldPath = folderPath(allFolders, id);
    const known = node ?? resources.find(r => r.id === id);
    const file = known ? resourceToView(known, parentPath(allFolders, known.parentId)) : unknownNodeView(id);
    if (!(await fileHooks.onBeforeFileRename.intercept({ file, newName }))) return false;
    await client.updateFileNode(id, { name: newName });
    void fileHooks.onFileRename.emit({ file: { ...file, name: newName }, previousName: file.name });
    // Starred folders are kept by path: follow the rename.
    if (oldPath) {
      const newPath = oldPath.slice(0, oldPath.lastIndexOf('/') + 1) + newName;
      const next = favorites.map(f => (isUnder(f, oldPath) ? newPath + f.slice(oldPath.length) : f));
      if (next.some((f, i) => f !== favorites[i])) {
        set({ favorites: next });
        try { localStorage.setItem('files-favorites', JSON.stringify(next)); } catch { /* ignore */ }
      }
    }
    set({
      lastAction: node
        ? { type: 'rename', entries: [{ id, from: { name: node.name }, to: { name: newName } }], sourceParentId: null }
        : get().lastAction,
    });
    // A renamed ancestor changes the path on screen; rebuild it from the ids.
    const { pathStack } = get();
    if (pathStack.some(s => s.id === id)) {
      set({ pathStack: pathStack.map(s => (s.id === id ? { ...s, name: newName } : s)) });
      set({ currentPath: buildPathFromStack(get().pathStack) });
    }
    await refresh();
    return true;
  },

  deleteNode: async (id: string) => {
    const { client, allFolders, resources, favorites, recentFiles, pathStack, navigate, refresh } = get();
    if (!client) return false;
    const path = folderPath(allFolders, id);
    const known = allFolders.find(f => f.id === id) ?? resources.find(r => r.id === id);
    const files = [known ? resourceToView(known, parentPath(allFolders, known.parentId)) : unknownNodeView(id)];
    if (!(await fileHooks.onBeforeFileDelete.intercept({ files }))) return false;
    const result = await client.destroyFileNodes([id]);
    const deleted = destroyedViews(files, result);
    if (deleted.length > 0) void fileHooks.onAfterFileDelete.emit({ files: deleted });

    const nextFavorites = path ? favorites.filter(f => !isUnder(f, path)) : favorites;
    // Recent files only know their own id; drop the one deleted, the rest are
    // pruned by the next listing.
    const nextRecent = recentFiles.filter(r => r.id !== id);
    set({ favorites: nextFavorites, recentFiles: nextRecent });
    try {
      localStorage.setItem('files-favorites', JSON.stringify(nextFavorites));
      localStorage.setItem('files-recent-files', JSON.stringify(nextRecent));
    } catch { /* ignore */ }

    // Standing in the deleted folder or below it: step out to its parent.
    const idx = pathStack.findIndex(s => s.id === id);
    if (idx > 0) {
      const parent = pathStack[idx - 1];
      set({ pathStack: pathStack.slice(0, idx) });
      await navigate(parent.id, parent.name);
      return true;
    }
    await refresh();
    return true;
  },

  trashResources: async (names: string[]) => {
    const { client, resources, currentParentId, currentPath, recentFiles, favorites, refresh } = get();
    if (!client) return 0;
    const items = names
      .map(name => resources.find(r => r.name === name))
      .filter((r): r is FileResource => !!r);
    if (items.length === 0) return 0;
    const files = items.map(r => resourceToView(r, currentPath));
    if (!(await fileHooks.onBeforeFileDelete.intercept({ files }))) return 0;

    const trash = await ensureTrashFolder(client, await client.listAllFileNodes());
    const batch = await client.createFileDirectory(trashBatchName(currentParentId), trash.id);
    let result: { updated: string[]; notUpdated: Record<string, string> };
    try {
      result = await client.updateFileNodes(Object.fromEntries(items.map(r => [r.id, { parentId: batch.id }])));
      assertUpdated(result);
    } catch (err) {
      await client.destroyFileNodes([batch.id]).catch(() => undefined);
      throw err;
    }
    const moved = new Set(result.updated);
    const trashed = items.filter(r => moved.has(r.id));
    void fileHooks.onAfterFileDelete.emit({ files: files.filter(f => moved.has(f.id)) });

    // Like a delete: recent files and stars of what went drop off.
    const gonePaths = trashed.filter(r => r.isDirectory).map(r => joinPath(currentPath, r.name));
    const nextFavorites = favorites.filter(f => !gonePaths.some(path => isUnder(f, path)));
    const nextRecent = recentFiles.filter(r => !moved.has(r.id));
    set({
      favorites: nextFavorites,
      recentFiles: nextRecent,
      selectedResources: new Set(),
      lastAction: {
        type: 'move',
        entries: trashed.map(r => ({ id: r.id, from: { parentId: r.parentId ?? null }, to: { parentId: batch.id } })),
        sourceParentId: currentParentId,
        trashBatchId: batch.id,
      },
    });
    try {
      localStorage.setItem('files-favorites', JSON.stringify(nextFavorites));
      localStorage.setItem('files-recent-files', JSON.stringify(nextRecent));
    } catch { /* ignore */ }
    await refresh();
    return trashed.length;
  },

  trashNode: async (id: string) => {
    const { client, allFolders, resources, favorites, recentFiles, pathStack, navigate, refresh } = get();
    if (!client) return false;
    const nodes = await client.listAllFileNodes();
    const node = nodes.find(n => n.id === id);
    if (!node) return false;
    const path = folderPath(allFolders, id);
    const known = allFolders.find(f => f.id === id) ?? resources.find(r => r.id === id);
    const files = [known ? resourceToView(known, parentPath(allFolders, known.parentId)) : unknownNodeView(id)];
    if (!(await fileHooks.onBeforeFileDelete.intercept({ files }))) return false;

    const trash = await ensureTrashFolder(client, nodes);
    const batch = await client.createFileDirectory(trashBatchName(node.parentId ?? null), trash.id);
    try {
      assertUpdated(await client.updateFileNodes({ [id]: { parentId: batch.id } }));
    } catch (err) {
      await client.destroyFileNodes([batch.id]).catch(() => undefined);
      throw err;
    }
    void fileHooks.onAfterFileDelete.emit({ files });

    const nextFavorites = path ? favorites.filter(f => !isUnder(f, path)) : favorites;
    const nextRecent = recentFiles.filter(r => r.id !== id);
    set({
      favorites: nextFavorites,
      recentFiles: nextRecent,
      lastAction: {
        type: 'move',
        entries: [{ id, from: { parentId: node.parentId ?? null }, to: { parentId: batch.id } }],
        sourceParentId: node.parentId ?? null,
        trashBatchId: batch.id,
      },
    });
    try {
      localStorage.setItem('files-favorites', JSON.stringify(nextFavorites));
      localStorage.setItem('files-recent-files', JSON.stringify(nextRecent));
    } catch { /* ignore */ }

    // Standing in the deleted folder or below it: step out to its parent.
    const idx = pathStack.findIndex(s => s.id === id);
    if (idx > 0) {
      const parent = pathStack[idx - 1];
      set({ pathStack: pathStack.slice(0, idx) });
      await navigate(parent.id, parent.name);
      return true;
    }
    await refresh();
    return true;
  },

  restoreResources: async (names: string[]) => {
    const { client, resources, refresh } = get();
    if (!client) return 0;
    const items = names
      .map(name => resources.find(r => r.name === name && r.trash))
      .filter((r): r is FileResource => !!r);
    if (items.length === 0) return 0;

    const nodes = await client.listAllFileNodes();
    const inTrash = trashSubtreeIds(nodes, findTrashFolder(nodes)?.id);
    const folderIds = new Set(nodes.filter(n => isFolder(n) && !inTrash.has(n.id)).map(n => n.id));
    // Names taken in each folder, so a restored item never clashes.
    const taken = new Map<string | null, Set<string>>();
    const namesIn = (parentId: string | null) => {
      let set = taken.get(parentId);
      if (!set) {
        set = new Set(childrenOf(nodes, parentId).filter(n => !inTrash.has(n.id)).map(n => n.name));
        taken.set(parentId, set);
      }
      return set;
    };
    const updates: Record<string, Partial<Pick<FileNode, 'name' | 'parentId'>>> = {};
    const targets = new Map<string, string | null>();
    for (const item of items) {
      const from = item.trash?.fromParentId ?? null;
      // A folder that is gone (or itself in the trash) gives the item back to the root.
      const target = from !== null && folderIds.has(from) ? from : null;
      const used = namesIn(target);
      const name = getUniqueName(item.serverName, used);
      used.add(name);
      updates[item.id] = name === item.serverName ? { parentId: target } : { parentId: target, name };
      targets.set(item.id, target);
    }
    const result = await client.updateFileNodes(updates);
    assertUpdated(result);
    const restored = new Set(result.updated);
    const allFolders = nodes.filter(n => isFolder(n) && !inTrash.has(n.id)).map(nodeToResource);
    const byTarget = new Map<string, FileResourceView[]>();
    for (const item of items.filter(r => restored.has(r.id))) {
      const toPath = parentPath(allFolders, targets.get(item.id) ?? null);
      const list = byTarget.get(toPath) ?? [];
      list.push(resourceToView(item, toPath));
      byTarget.set(toPath, list);
    }
    for (const [toPath, files] of byTarget) void fileHooks.onFileMove.emit({ files, toPath });
    await removeEmptyTrashBatches(client, items.filter(r => restored.has(r.id)));
    set({ selectedResources: new Set() });
    await refresh();
    return restored.size;
  },

  purgeResources: async (names: string[]) => {
    const { client, resources, refresh } = get();
    if (!client) return 0;
    const items = names
      .map(name => resources.find(r => r.name === name && r.trash))
      .filter((r): r is FileResource => !!r);
    if (items.length === 0) return 0;
    // The server removes what is inside a folder with it.
    const result = await client.destroyFileNodes(items.map(r => r.id));
    const destroyed = new Set(result.destroyed);
    await removeEmptyTrashBatches(client, items.filter(r => destroyed.has(r.id)));
    set({ selectedResources: new Set() });
    await refresh();
    return items.filter(r => destroyed.has(r.id)).length;
  },

  emptyTrash: async () => {
    const { client, refresh } = get();
    if (!client) return;
    const trash = findTrashFolder(await client.listAllFileNodes());
    // The folder goes with everything in it; the next delete makes a new one.
    if (trash) await client.destroyFileNodes([trash.id]);
    set({ selectedResources: new Set() });
    await refresh();
  },

  downloadNode: async (id: string) => {
    const { client } = get();
    if (!client) return;
    const nodes = isCrossAccountId(id)
      ? await client.listAllFileNodesAcrossAccounts()
      : await client.listAllFileNodes();
    const node = nodes.find(n => n.id === id);
    if (!node?.blobId) throw new Error('File not found');
    await client.downloadBlob(node.blobId, node.name, node.type, undefined, { kind: 'file' });
    const folders = nodes.filter(isFolder).map(nodeToResource);
    void fileHooks.onFileDownload.emit(fileToView(node, parentPath(folders, node.parentId)));
  },

  removeRecentFile: (id: string) => {
    const next = get().recentFiles.filter(r => r.id !== id);
    set({ recentFiles: next });
    try { localStorage.setItem('files-recent-files', JSON.stringify(next)); } catch { /* ignore */ }
  },

  undoLastAction: async () => {
    const { client, lastAction, refresh } = get();
    if (!client || !lastAction) return;

    for (const entry of lastAction.entries) {
      await client.updateFileNode(entry.id, entry.from);
    }
    // A delete's folder in the trash is empty again.
    if (lastAction.trashBatchId) await client.destroyFileNodes([lastAction.trashBatchId]);
    set({ lastAction: null });
    void fileHooks.onFileUndo.emit({
      action: {
        type: lastAction.type,
        entries: lastAction.entries.map(e => ({ id: e.id, from: { ...e.from }, to: { ...e.to } })),
      },
    });
    await refresh();
  },

  shareResource: async (id: string, principalId: string, rights: FileNodeRights | null) => {
    const { client, refresh } = get();
    if (!client) return;
    // currentAccountId is the webmail's connected-account key ("user@host"),
    // not a JMAP account id - Stalwart parses accountId strictly while
    // deserializing the request, so sending it rejects the whole call with
    // notRequest. The client is already the per-account client; let
    // setFileNodeShare resolve its own files account.
    await client.setFileNodeShare(id, principalId, rights);
    await refresh();
  },

  loadSharedRoots: async () => {
    const { client } = get();
    if (!client) {
      set({ sharedRoots: [] });
      return;
    }
    try {
      const roots = sharedRootsOf(await client.listAllFileNodesAcrossAccounts());
      set({ sharedRoots: sortResources(roots.map(nodeToResource)) });
    } catch (error) {
      console.error('[Files] Failed to load shared roots:', error);
      set({ sharedRoots: [] });
    }
  },

  openSharedNode: async (id: string, sharedFilesName: (ownerName: string) => string) => {
    const { client, navigate } = get();
    if (!client) return false;
    let nodes: FileNode[];
    try {
      nodes = await client.listAllFileNodesAcrossAccounts();
    } catch {
      return false;
    }
    const place = findSharedPlace(nodes, id);
    if (!place) return false;
    const trail = place.trail.map(step => ({ id: step.id, name: step.name ?? sharedFilesName(place.ownerName) }));
    const target = trail[trail.length - 1];
    // The breadcrumb starts at the shared root, not below whatever was open.
    set({ pathStack: [{ id: null, name: '' }, ...trail.slice(0, -1)] });
    await navigate(target.id, target.name);
    return true;
  },
}));

// Tell plugins when the selected files change, whichever action changed it
// (click, toggle, select all, clear, navigating away, after a delete or move).
// Selecting the same files again is not a change.
useFileStore.subscribe((state, prev) => {
  if (state.selectedResources === prev.selectedResources) return;
  if (fileHooks.onFileSelectionChange.size === 0) return;
  const next = state.selectedResources ?? new Set<string>();
  if (sameNameSet(next, prev.selectedResources ?? new Set<string>())) return;
  const files = state.resources.filter(r => next.has(r.name)).map(r => resourceToView(r, state.currentPath));
  void fileHooks.onFileSelectionChange.emit({ files });
});
