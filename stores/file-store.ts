import { create } from 'zustand';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { FileNode, FileNodeRights } from '@/lib/jmap/types';

export interface FileResource {
  id: string;
  name: string;
  serverName: string;
  isDirectory: boolean;
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
}

interface UploadProgress {
  name: string;
  loaded: number;
  total: number;
  current: number;
  totalFiles: number;
}

interface ClipboardState {
  mode: 'cut' | 'copy';
  ids: string[];
  names: string[];
  serverNames: string[];
  sourceParentId: string | null;
  sourcePath: string;
}

interface UndoAction {
  type: 'rename' | 'move';
  entries: { id: string; from: Partial<Pick<FileNode, 'name' | 'parentId'>>; to: Partial<Pick<FileNode, 'name' | 'parentId'>> }[];
  sourceParentId: string | null;
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
  uploadFiles: (files: File[]) => Promise<void>;
  uploadFolder: (files: File[]) => Promise<void>;
  cancelUpload: () => void;
  deleteResource: (name: string) => Promise<void>;
  deleteResources: (names: string[]) => Promise<void>;
  renameResource: (oldName: string, newName: string) => Promise<void>;
  downloadResource: (name: string) => Promise<void>;
  downloadResources: (names: string[]) => Promise<void>;
  getImageUrl: (name: string) => Promise<string>;
  getFileContent: (name: string) => Promise<{ blob: Blob; contentType: string }>;
  createTextFile: (name: string) => Promise<void>;
  duplicateResource: (name: string) => Promise<void>;
  moveToFolder: (names: string[], targetFolder: string) => Promise<void>;
  moveToParent: (names: string[]) => Promise<void>;
  cutResources: (names: string[]) => void;
  copyResources: (names: string[]) => void;
  pasteResources: () => Promise<void>;
  selectResource: (name: string | null) => void;
  toggleSelect: (name: string) => void;
  selectAll: () => void;
  clearSelection: () => void;
  setSelection: (names: Set<string>) => void;
  listPath: (path: string) => Promise<FileResource[]>;
  listByParentId: (parentId: string | null) => Promise<FileResource[]>;
  toggleFavorite: (path: string) => void;
  addRecentFile: (name: string, id: string) => void;
  undoLastAction: () => Promise<void>;
  /** Add, update (rights), or remove (rights=null) a principal's share on a node. */
  shareResource: (id: string, principalId: string, rights: FileNodeRights | null) => Promise<void>;
  /** Load the top-level nodes shared with the user by other principals. */
  loadSharedRoots: () => Promise<void>;
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

// A FileNode is a folder iff it has no content blob. This is the authoritative
// signal in the JMAP FileNode spec and in Stalwart (a node is a container when
// its `file`/`blobId` is null); a `type` of "d" is not — older builds created
// "folders" as blob-backed files, which can't hold children (#379).
function isFolder(node: Pick<FileNode, 'blobId'>): boolean {
  return node.blobId == null;
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

function nodeToResource(node: FileNode): FileResource {
  const isDir = isFolder(node);
  return {
    id: node.id,
    name: node.name,
    serverName: node.name,
    isDirectory: isDir,
    contentType: isDir ? '' : node.type,
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

function buildPathFromStack(stack: { id: string | null; name: string }[]): string {
  if (stack.length <= 1) return '/';
  return '/' + stack.slice(1).map(s => s.name).join('/');
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
      if (created.blobId != null) {
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
    const { client, pathStack } = get();
    if (!client) return;

    set({ isLoading: true, error: null, currentParentId: parentId, selectedResources: new Set() });

    // Update path stack
    let newStack: { id: string | null; name: string }[];
    if (parentId === null) {
      newStack = [{ id: null, name: '' }];
    } else {
      // Check if navigating to a parent in the stack
      const existingIdx = pathStack.findIndex(s => s.id === parentId);
      if (existingIdx >= 0) {
        newStack = pathStack.slice(0, existingIdx + 1);
      } else {
        newStack = [...pathStack, { id: parentId, name: name || parentId }];
      }
    }

    const newPath = buildPathFromStack(newStack);
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
      const resources = sortResources(childrenOf(allNodes, parentId).map(nodeToResource));

      // Prune recent files whose backing node no longer exists on the server
      const { recentFiles } = get();
      const existingIds = new Set(allNodes.map(n => n.id));
      const prunedRecent = recentFiles.filter(r => existingIds.has(r.id));
      if (prunedRecent.length !== recentFiles.length) {
        try { localStorage.setItem('files-recent-files', JSON.stringify(prunedRecent)); } catch { /* ignore */ }
        set({ resources, recentFiles: prunedRecent, isLoading: false });
      } else {
        set({ resources, isLoading: false });
      }
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to list directory',
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
    const { client, currentParentId, refresh } = get();
    if (!client) return;

    await client.createFileDirectory(name, currentParentId);
    await refresh();
  },

  uploadFile: async (file: File) => {
    const { client, currentParentId } = get();
    if (!client) return;

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
      await client.createFileNode(file.name, blobId, type || file.type || 'application/octet-stream', file.size, currentParentId);
    } finally {
      set({ uploadProgress: null, uploadAbortController: null });
    }
  },

  uploadFiles: async (files: File[]) => {
    const { client, currentParentId, resources } = get();
    if (!client) return;

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
        await client.createFileNode(uniqueName, blobId, type || file.type || 'application/octet-stream', file.size, currentParentId);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') break;
        set({ uploadProgress: null, uploadAbortController: null });
        throw err;
      }
    }
    set({ uploadProgress: null, uploadAbortController: null });
    await get().refresh();
  },

  cancelUpload: () => {
    const { uploadAbortController } = get();
    if (uploadAbortController) {
      uploadAbortController.abort();
      set({ uploadProgress: null, uploadAbortController: null });
    }
  },

  uploadFolder: async (files: File[]) => {
    const { client, currentParentId } = get();
    if (!client || files.length === 0) return;

    const abortController = new AbortController();
    set({ uploadAbortController: abortController });
    const totalFiles = files.length;

    // Collect unique directory paths (relative to the dropped folder) and
    // create them as real nested directories, mapping each path to its node id.
    const dirs = new Set<string>();
    for (const file of files) {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const parts = relativePath.split('/');
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join('/'));
      }
    }

    // Map a directory path to its created node id. Root ('') maps to the
    // current folder we are uploading into.
    const dirIds = new Map<string, string | null>();
    dirIds.set('', currentParentId);

    const sortedDirs = [...dirs].sort((a, b) => a.split('/').length - b.split('/').length);
    for (const dir of sortedDirs) {
      if (abortController.signal.aborted) break;
      const slash = dir.lastIndexOf('/');
      const parentPath = slash >= 0 ? dir.slice(0, slash) : '';
      const dirName = slash >= 0 ? dir.slice(slash + 1) : dir;
      const parentId = dirIds.get(parentPath) ?? currentParentId;
      try {
        const created = await client.createFileDirectory(dirName, parentId);
        dirIds.set(dir, created.id);
      } catch {
        // Directory may already exist - leave it unmapped; files fall back to
        // the closest known parent below.
      }
    }

    // Upload files into their containing directory.
    for (let i = 0; i < files.length; i++) {
      if (abortController.signal.aborted) break;
      const file = files[i];
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const slash = relativePath.lastIndexOf('/');
      const dirPath = slash >= 0 ? relativePath.slice(0, slash) : '';
      const parentId = dirIds.get(dirPath) ?? currentParentId;

      set({ uploadProgress: { name: relativePath, loaded: 0, total: file.size, current: i + 1, totalFiles } });

      try {
        const { blobId, type } = await client.uploadBlob(file);
        if (abortController.signal.aborted) break;
        set({ uploadProgress: { name: relativePath, loaded: file.size, total: file.size, current: i + 1, totalFiles } });
        await client.createFileNode(file.name, blobId, type || file.type || 'application/octet-stream', file.size, parentId);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') break;
        set({ uploadProgress: null, uploadAbortController: null });
        throw err;
      }
    }
    set({ uploadProgress: null, uploadAbortController: null });
    await get().refresh();
  },

  deleteResource: async (name: string) => {
    const { client, resources, recentFiles, refresh } = get();
    if (!client) return;

    const resource = resources.find(r => r.name === name);
    if (!resource) return;

    // The server removes descendant nodes (onDestroyRemoveChildren).
    await client.destroyFileNodes([resource.id]);
    const nextRecentFiles = recentFiles.filter(r => r.id !== resource.id);
    set({ recentFiles: nextRecentFiles });
    try { localStorage.setItem('files-recent-files', JSON.stringify(nextRecentFiles)); } catch { /* ignore */ }
    await refresh();
  },

  deleteResources: async (names: string[]) => {
    const { client, resources, recentFiles, refresh } = get();
    if (!client) return;

    const idsToDelete: string[] = [];
    for (const name of names) {
      const resource = resources.find(r => r.name === name);
      if (resource) idsToDelete.push(resource.id);
    }

    if (idsToDelete.length === 0) return;

    // The server removes descendant nodes (onDestroyRemoveChildren).
    await client.destroyFileNodes(idsToDelete);
    const deletedIdSet = new Set(idsToDelete);
    const nextRecentFiles = recentFiles.filter(r => !deletedIdSet.has(r.id));
    set({ selectedResources: new Set() });
    set({ recentFiles: nextRecentFiles });
    try { localStorage.setItem('files-recent-files', JSON.stringify(nextRecentFiles)); } catch { /* ignore */ }
    await refresh();
  },

  renameResource: async (oldName: string, newName: string) => {
    const { client, resources, refresh } = get();
    if (!client) return;

    const resource = resources.find(r => r.name === oldName);
    if (!resource) return;

    await client.updateFileNode(resource.id, { name: newName });

    set({
      lastAction: {
        type: 'rename',
        entries: [{ id: resource.id, from: { name: oldName }, to: { name: newName } }],
        sourceParentId: null,
      },
    });
    await refresh();
  },

  downloadResource: async (name: string) => {
    const { client, resources } = get();
    if (!client) return;

    const resource = resources.find(r => r.name === name);
    if (!resource?.blobId) return;

    await client.downloadBlob(resource.blobId, resource.name, resource.contentType);
  },

  downloadResources: async (names: string[]) => {
    const { downloadResource } = get();
    for (const name of names) {
      await downloadResource(name);
    }
  },

  getImageUrl: async (name: string) => {
    const { client, resources } = get();
    if (!client) throw new Error('No client');

    const resource = resources.find(r => r.name === name);
    if (!resource?.blobId) throw new Error('No blob');

    return client.fetchBlobAsObjectUrl(resource.blobId, resource.name, resource.contentType);
  },

  getFileContent: async (name: string) => {
    const { client, resources } = get();
    if (!client) throw new Error('No client');

    const resource = resources.find(r => r.name === name);
    if (!resource?.blobId) throw new Error('No blob');

    const url = client.getBlobDownloadUrl(resource.blobId, resource.name, resource.contentType);
    const response = await fetch(url, {
      headers: { 'Authorization': client.getAuthHeader() },
    });
    if (!response.ok) throw new Error(`Failed to fetch file: ${response.status}`);
    const blob = await response.blob();
    return { blob, contentType: resource.contentType || 'application/octet-stream' };
  },

  createTextFile: async (name: string) => {
    const { client, currentParentId, refresh } = get();
    if (!client) return;

    const emptyBlob = new File([''], name, { type: 'text/plain' });
    const { blobId } = await client.uploadBlob(emptyBlob);
    await client.createFileNode(name, blobId, 'text/plain', 0, currentParentId);
    await refresh();
  },

  duplicateResource: async (name: string) => {
    const { client, resources, currentParentId, refresh } = get();
    if (!client) return;

    const resource = resources.find(r => r.name === name);
    if (!resource) return;

    const dotIdx = name.lastIndexOf('.');
    const copyName = dotIdx > 0
      ? `${name.substring(0, dotIdx)} (copy)${name.substring(dotIdx)}`
      : `${name} (copy)`;

    await client.copyFileNode(resource.id, copyName, currentParentId);
    await refresh();
  },

  moveToFolder: async (names: string[], targetFolder: string) => {
    const { client, resources, refresh } = get();
    if (!client) return;

    const targetResource = resources.find(r => r.name === targetFolder && r.isDirectory);
    if (!targetResource) return;

    const entries: UndoAction['entries'] = [];
    for (const name of names) {
      const resource = resources.find(r => r.name === name);
      if (!resource || resource.id === targetResource.id) continue;
      await client.updateFileNode(resource.id, { parentId: targetResource.id });
      entries.push({ id: resource.id, from: { parentId: resource.parentId }, to: { parentId: targetResource.id } });
    }
    set({
      selectedResources: new Set(),
      lastAction: { type: 'move', entries, sourceParentId: null },
    });
    await refresh();
  },

  moveToParent: async (names: string[]) => {
    const { client, resources, pathStack, refresh } = get();
    if (!client || pathStack.length <= 1) return;

    // Move into the grandparent of the current folder's contents, i.e. the
    // entry one level up in the breadcrumb stack.
    const newParentId = pathStack[pathStack.length - 2].id;

    const entries: UndoAction['entries'] = [];
    for (const name of names) {
      const resource = resources.find(r => r.name === name);
      if (!resource) continue;
      await client.updateFileNode(resource.id, { parentId: newParentId });
      entries.push({ id: resource.id, from: { parentId: resource.parentId }, to: { parentId: newParentId } });
    }
    set({
      selectedResources: new Set(),
      lastAction: { type: 'move', entries, sourceParentId: null },
    });
    await refresh();
  },

  cutResources: (names: string[]) => {
    const { currentPath, currentParentId, resources } = get();
    const ids = names.map(n => resources.find(r => r.name === n)?.id).filter(Boolean) as string[];
    const serverNames = names.map(n => resources.find(r => r.name === n)?.serverName).filter(Boolean) as string[];
    set({ clipboard: { mode: 'cut', ids, names, serverNames, sourceParentId: currentParentId, sourcePath: currentPath } });
  },

  copyResources: (names: string[]) => {
    const { currentPath, currentParentId, resources } = get();
    const ids = names.map(n => resources.find(r => r.name === n)?.id).filter(Boolean) as string[];
    const serverNames = names.map(n => resources.find(r => r.name === n)?.serverName).filter(Boolean) as string[];
    set({ clipboard: { mode: 'copy', ids, names, serverNames, sourceParentId: currentParentId, sourcePath: currentPath } });
  },

  pasteResources: async () => {
    const { client, currentParentId, clipboard, refresh } = get();
    if (!client || !clipboard) return;

    const entries: UndoAction['entries'] = [];

    for (let i = 0; i < clipboard.ids.length; i++) {
      const id = clipboard.ids[i];
      const displayName = clipboard.names[i];

      if (clipboard.mode === 'cut') {
        await client.updateFileNode(id, { parentId: currentParentId });
        entries.push({ id, from: { parentId: clipboard.sourceParentId }, to: { parentId: currentParentId } });
      } else {
        await client.copyFileNode(id, displayName, currentParentId);
      }
    }

    if (clipboard.mode === 'cut') {
      set({
        clipboard: null,
        lastAction: { type: 'move', entries, sourceParentId: null },
      });
    }
    await refresh();
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
    const { favorites } = get();
    const next = favorites.includes(path)
      ? favorites.filter(f => f !== path)
      : [...favorites, path];
    set({ favorites: next });
    try { localStorage.setItem('files-favorites', JSON.stringify(next)); } catch { /* ignore */ }
  },

  addRecentFile: (name: string, id: string) => {
    const { recentFiles } = get();
    const entry = { name, id, timestamp: Date.now() };
    const filtered = recentFiles.filter(r => r.id !== id);
    const next = [entry, ...filtered].slice(0, 20);
    set({ recentFiles: next });
    try { localStorage.setItem('files-recent-files', JSON.stringify(next)); } catch { /* ignore */ }
  },

  undoLastAction: async () => {
    const { client, lastAction, refresh } = get();
    if (!client || !lastAction) return;

    for (const entry of lastAction.entries) {
      await client.updateFileNode(entry.id, entry.from);
    }
    set({ lastAction: null });
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
      const all = await client.listAllFileNodesAcrossAccounts();
      const idSet = new Set(all.map(n => n.id));
      // A shared node is a "root" of the shared-with-me tree when its parent is
      // not among the nodes the user can see (either null, or owned by a
      // principal whose ancestor folders weren't shared).
      const roots = all.filter(n =>
        n.isShared && (n.parentId == null || !idSet.has(n.parentId)),
      );
      set({ sharedRoots: sortResources(roots.map(nodeToResource)) });
    } catch (error) {
      console.error('[Files] Failed to load shared roots:', error);
      set({ sharedRoots: [] });
    }
  },
}));
