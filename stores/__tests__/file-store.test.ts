import { describe, it, expect, beforeEach } from 'vitest';
import { useFileStore, linkedPreviewResource, resourceServerRef, sharedFilesLocation } from '../file-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { FileNode } from '@/lib/jmap/types';
import { jmapError } from '@/lib/jmap/jmap-error';
import { fileErrorKind } from '@/lib/file-errors';
import { TRASH_LOCATION } from '@/lib/files-trash';

// Minimal in-memory FileNode backend that models the JMAP hierarchy via
// parentId links (the behaviour issue #379 asks for).
function makeMockClient(initial: FileNode[] = []) {
  let nodes: FileNode[] = initial.map(n => ({ ...n }));
  let seq = 0;
  const now = () => new Date().toISOString();

  const client = {
    getCapabilities: () => ({}),
    probeFileNodeSupport: async () => true,
    getFilesAccountId: () => 'acct',
    async listAllFileNodes() {
      return nodes.map(n => ({ ...n }));
    },
    async listFileNodes(parentId: string | null) {
      return nodes.filter(n => (n.parentId ?? null) === parentId).map(n => ({ ...n }));
    },
    async getFileNodes(ids: string[] | null) {
      return (ids === null ? nodes : nodes.filter(n => ids.includes(n.id))).map(n => ({ ...n }));
    },
    async createFileDirectory(name: string, parentId: string | null) {
      // A real folder has no content blob (this is how Stalwart marks a container).
      const node: FileNode = { id: `n${++seq}`, parentId, name, type: '', blobId: null, size: 0, created: now(), modified: now() };
      nodes.push(node);
      return { ...node };
    },
    async createFileNode(name: string, blobId: string, type: string, size: number, parentId: string | null) {
      const node: FileNode = { id: `n${++seq}`, parentId, name, type, blobId, size, created: now(), modified: now() };
      nodes.push(node);
      return { ...node };
    },
    async updateFileNode(id: string, updates: Partial<Pick<FileNode, 'name' | 'parentId'>>) {
      const node = nodes.find(n => n.id === id);
      if (node) Object.assign(node, updates);
    },
    async updateFileNodes(updates: Record<string, Partial<Pick<FileNode, 'name' | 'parentId'>>>) {
      const updated: string[] = [];
      const notUpdated: Record<string, string> = {};
      for (const [id, patch] of Object.entries(updates)) {
        const node = nodes.find(n => n.id === id);
        if (!node) { notUpdated[id] = 'not found'; continue; }
        // Mirror Stalwart: a parentId must point at a real folder, i.e. a node
        // with no content blob. A blob-backed node (file or old "folder marker")
        // is not a container and is rejected.
        if (patch.parentId != null) {
          const parent = nodes.find(n => n.id === patch.parentId);
          if (!parent || parent.blobId != null) {
            notUpdated[id] = 'Parent ID does not exist or is not a folder.';
            continue;
          }
        }
        Object.assign(node, patch);
        updated.push(id);
      }
      return { updated, notUpdated };
    },
    async destroyFileNodes(ids: string[]) {
      // Emulate Stalwart's onDestroyRemoveChildren: removing a directory also
      // removes its whole subtree.
      const toRemove = new Set(ids);
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of nodes) {
          if (n.parentId && toRemove.has(n.parentId) && !toRemove.has(n.id)) {
            toRemove.add(n.id);
            grew = true;
          }
        }
      }
      nodes = nodes.filter(n => !toRemove.has(n.id));
      return { destroyed: [...toRemove], notDestroyed: [] };
    },
    async copyFileNode(id: string, newName: string, parentId: string | null) {
      const original = nodes.find(n => n.id === id);
      if (!original) throw new Error('not found');
      return this.createFileNode(newName, original.blobId ?? '', original.type, original.size, parentId);
    },
    async uploadBlob(file: File) {
      return { blobId: `blob${++seq}`, type: file.type };
    },
    // test helper
    _nodes: () => nodes,
  };

  return client as unknown as IJMAPClient & { _nodes: () => FileNode[] };
}

const dir = (id: string, name: string, parentId: string | null): FileNode => ({
  id, parentId, name, type: 'd', blobId: null, size: 0, created: '', modified: '',
});
// An old build's "folder": a directory-typed node that is actually a blob-backed
// file, so the server won't let anything be parented under it.
const marker = (id: string, name: string, parentId: string | null): FileNode => ({
  id, parentId, name, type: 'd', blobId: `b-${id}`, size: 0, created: '', modified: '',
});
const file = (id: string, name: string, parentId: string | null): FileNode => ({
  id, parentId, name, type: 'text/plain', blobId: `b-${id}`, size: 10, created: '', modified: '',
});

describe('file-store hierarchy (issue #379)', () => {
  beforeEach(() => {
    useFileStore.setState({
      client: null,
      currentParentId: null,
      currentPath: '/',
      pathStack: [{ id: null, name: '' }],
      resources: [],
      selectedResources: new Set(),
      clipboard: null,
      lastAction: null,
    });
  });

  it('keeps the listing when refreshing the same folder fails, and starts empty in a new one', async () => {
    const client = makeMockClient([dir('stuff', 'Stuff', null), file('notes', 'Notes.md', null), file('inner', 'Inner.md', 'stuff')]);
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(null);
    expect(useFileStore.getState().resources.map(r => r.name).sort()).toEqual(['Notes.md', 'Stuff']);

    client.listAllFileNodes = async () => { throw new Error('offline'); };
    await useFileStore.getState().navigate(null);
    expect(useFileStore.getState().error).toBe('offline');
    expect(useFileStore.getState().resources.map(r => r.name).sort()).toEqual(['Notes.md', 'Stuff']);

    await useFileStore.getState().navigate('stuff', 'Stuff');
    expect(useFileStore.getState().error).toBe('offline');
    expect(useFileStore.getState().resources).toEqual([]);
  });

  it('lists only root-level nodes at the root, not the whole tree flattened', async () => {
    // Stuff > Nonsense > Notes.md / Other.md (the exact shape from the issue)
    const client = makeMockClient([
      dir('stuff', 'Stuff', null),
      dir('nonsense', 'Nonsense', 'stuff'),
      file('notes', 'Notes.md', 'nonsense'),
      file('other', 'Other.md', 'nonsense'),
    ]);
    useFileStore.getState().initClient(client);

    await useFileStore.getState().navigate(null);
    const names = useFileStore.getState().resources.map(r => r.name);
    expect(names).toEqual(['Stuff']);
  });

  it('navigates into a folder via parentId and shows its direct children', async () => {
    const client = makeMockClient([
      dir('stuff', 'Stuff', null),
      dir('nonsense', 'Nonsense', 'stuff'),
      file('notes', 'Notes.md', 'nonsense'),
      file('other', 'Other.md', 'nonsense'),
    ]);
    useFileStore.getState().initClient(client);

    await useFileStore.getState().navigate('stuff', 'Stuff');
    expect(useFileStore.getState().resources.map(r => r.name)).toEqual(['Nonsense']);

    await useFileStore.getState().navigate('nonsense', 'Nonsense');
    expect(useFileStore.getState().resources.map(r => r.name).sort()).toEqual(['Notes.md', 'Other.md']);
  });

  it('creates a directory as a child node with a plain name (no path encoding)', async () => {
    const client = makeMockClient([dir('stuff', 'Stuff', null)]);
    useFileStore.getState().initClient(client);

    await useFileStore.getState().navigate('stuff', 'Stuff');
    await useFileStore.getState().createDirectory('Nonsense');

    const created = client._nodes().find(n => n.name === 'Nonsense');
    expect(created).toBeDefined();
    expect(created!.parentId).toBe('stuff');
    expect(created!.name).toBe('Nonsense'); // not "Stuff/Nonsense"
  });

  it('uploads a file into the current folder as a child node', async () => {
    const client = makeMockClient([dir('stuff', 'Stuff', null)]);
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate('stuff', 'Stuff');

    await useFileStore.getState().uploadFile(new File(['hi'], 'Notes.md', { type: 'text/markdown' }));

    const uploaded = client._nodes().find(n => n.name === 'Notes.md');
    expect(uploaded!.parentId).toBe('stuff');
  });

  it('moves a node into a folder by reparenting (parentId), not by renaming', async () => {
    const client = makeMockClient([
      dir('b', 'B', null),
      file('f', 'f.txt', null),
    ]);
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(null);

    // Drag f.txt onto the B folder visible in the current (root) view.
    await useFileStore.getState().moveToFolder(['f.txt'], 'B');

    const moved = client._nodes().find(n => n.id === 'f')!;
    expect(moved.parentId).toBe('b');
    expect(moved.name).toBe('f.txt'); // name untouched
  });

  it('renames a node by changing only its name', async () => {
    const client = makeMockClient([dir('stuff', 'Stuff', null)]);
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(null);

    await useFileStore.getState().renameResource('Stuff', 'Things');
    const node = client._nodes().find(n => n.id === 'stuff')!;
    expect(node.name).toBe('Things');
    expect(node.parentId).toBeNull();
  });

  it('migrates legacy flat path-encoded nodes into the real hierarchy', async () => {
    const SEP = '∕';
    // Exactly the broken shape from issue #379: everything flat at the root
    // with the Unicode separator baked into the names.
    const client = makeMockClient([
      dir('stuff', 'Stuff', null),
      dir('nonsense', `Stuff${SEP}Nonsense`, null),
      file('notes', `Stuff${SEP}Nonsense${SEP}Notes.md`, null),
      file('other', `Stuff${SEP}Nonsense${SEP}Other.md`, null),
    ]);
    useFileStore.getState().initClient(client);

    const migrated = await useFileStore.getState().migrateLegacyFlatNodes();
    expect(migrated).toBe(true);

    const byId = Object.fromEntries(client._nodes().map(n => [n.id, n]));
    expect(byId.stuff).toMatchObject({ name: 'Stuff', parentId: null });
    expect(byId.nonsense).toMatchObject({ name: 'Nonsense', parentId: 'stuff' });
    expect(byId.notes).toMatchObject({ name: 'Notes.md', parentId: 'nonsense' });
    expect(byId.other).toMatchObject({ name: 'Other.md', parentId: 'nonsense' });

    // Browsing now reflects the real tree.
    await useFileStore.getState().navigate(null);
    expect(useFileStore.getState().resources.map(r => r.name)).toEqual(['Stuff']);
    await useFileStore.getState().navigate('nonsense', 'Nonsense');
    expect(useFileStore.getState().resources.map(r => r.name).sort()).toEqual(['Notes.md', 'Other.md']);
  });

  it('migrates legacy nodes that used a plain "/" separator (issue #379 data)', async () => {
    // A folder upload of a git checkout, stored flat with "/" in the names.
    const client = makeMockClient([
      dir('root', 'night-medieval-castle-lake', null),
      dir('branding', 'night-medieval-castle-lake/branding', null),
      dir('git', 'night-medieval-castle-lake/branding/.git', null),
      file('cfg', 'night-medieval-castle-lake/branding/.git/config', null),
      file('logo', 'kunden/logo.svg', null),
      dir('kunden', 'kunden', null),
    ]);
    useFileStore.getState().initClient(client);

    expect(await useFileStore.getState().migrateLegacyFlatNodes()).toBe(true);

    const byId = Object.fromEntries(client._nodes().map(n => [n.id, n]));
    expect(byId.root).toMatchObject({ name: 'night-medieval-castle-lake', parentId: null });
    expect(byId.branding).toMatchObject({ name: 'branding', parentId: 'root' });
    expect(byId.git).toMatchObject({ name: '.git', parentId: 'branding' });
    expect(byId.cfg).toMatchObject({ name: 'config', parentId: 'git' });
    expect(byId.logo).toMatchObject({ name: 'logo.svg', parentId: 'kunden' });

    await useFileStore.getState().navigate(null);
    expect(useFileStore.getState().resources.map(r => r.name).sort())
      .toEqual(['kunden', 'night-medieval-castle-lake']);
  });

  it('creates missing intermediate folders instead of reparenting under a non-folder', async () => {
    // The shape that produced "Parent ID does not exist or is not a folder" in
    // production (#379): flat files whose path prefixes have no real directory
    // node at all. The migration must materialize the folders, not skip them.
    const SEP = '∕';
    const client = makeMockClient([
      file('a', `Docs${SEP}report.pdf`, null),
      file('b', `Docs${SEP}Sub${SEP}notes.txt`, null),
    ]);
    useFileStore.getState().initClient(client);

    expect(await useFileStore.getState().migrateLegacyFlatNodes()).toBe(true);

    const nodes = client._nodes();
    const docs = nodes.find(n => n.name === 'Docs' && n.parentId === null);
    expect(docs?.blobId).toBeNull();
    const sub = nodes.find(n => n.name === 'Sub' && n.parentId === docs!.id);
    expect(sub?.blobId).toBeNull();

    const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
    expect(byId.a).toMatchObject({ name: 'report.pdf', parentId: docs!.id });
    expect(byId.b).toMatchObject({ name: 'notes.txt', parentId: sub!.id });

    // No leftover separators anywhere.
    expect(nodes.some(n => n.name.includes(SEP))).toBe(false);
  });

  it('replaces legacy folder-marker files with real folders and reparents children', async () => {
    // Old builds stored folders as 0-byte directory-typed FILES (blobId set).
    // The server treats those as non-containers, which is the actual cause of
    // "Parent ID does not exist or is not a folder" (#379): the migration must
    // delete the markers and recreate real folders before reparenting.
    const SEP = '∕';
    const client = makeMockClient([
      marker('docs', 'Documents', null),
      file('a', `Documents${SEP}readme.txt`, null),
      file('b', `Documents${SEP}img${SEP}logo.png`, null),
    ]);
    useFileStore.getState().initClient(client);

    expect(await useFileStore.getState().migrateLegacyFlatNodes()).toBe(true);

    const nodes = client._nodes();
    // The marker file is gone, replaced by a real folder (no blob).
    expect(nodes.find(n => n.id === 'docs')).toBeUndefined();
    const docs = nodes.find(n => n.name === 'Documents' && n.parentId === null);
    expect(docs?.blobId).toBeNull();
    const img = nodes.find(n => n.name === 'img' && n.parentId === docs!.id);
    expect(img?.blobId).toBeNull();

    const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
    expect(byId.a).toMatchObject({ name: 'readme.txt', parentId: docs!.id });
    expect(byId.b).toMatchObject({ name: 'logo.png', parentId: img!.id });
    expect(nodes.some(n => n.name.includes(SEP))).toBe(false);
  });

  it('handles a folder-marker whose own name is path-encoded', async () => {
    // A nested old "folder" was itself stored flat ("Docs∕Sub", type d + blob).
    // It is both legacy and a marker; it must be deleted (not reparented as a
    // file) and replaced by a real folder holding the child.
    const SEP = '∕';
    const client = makeMockClient([
      marker('docs', 'Docs', null),
      marker('sub', `Docs${SEP}Sub`, null),
      file('f', `Docs${SEP}Sub${SEP}file.txt`, null),
    ]);
    useFileStore.getState().initClient(client);

    expect(await useFileStore.getState().migrateLegacyFlatNodes()).toBe(true);

    const nodes = client._nodes();
    expect(nodes.find(n => n.id === 'docs')).toBeUndefined();
    expect(nodes.find(n => n.id === 'sub')).toBeUndefined();
    const docs = nodes.find(n => n.name === 'Docs' && n.parentId === null);
    const sub = nodes.find(n => n.name === 'Sub' && n.parentId === docs!.id);
    expect(sub?.blobId).toBeNull();
    expect(nodes.find(n => n.id === 'f')).toMatchObject({ name: 'file.txt', parentId: sub!.id });
    expect(nodes.some(n => n.name.includes(SEP))).toBe(false);
  });

  it('aborts and restores markers (no data loss) if the server cannot create real folders', async () => {
    const SEP = '∕';
    const client = makeMockClient([
      marker('docs', 'Documents', null),
      file('a', `Documents${SEP}readme.txt`, null),
    ]);
    // Simulate a broken/stale server: "folders" come back blob-backed (not real
    // containers). The migration must detect this and undo its marker rename.
    (client as unknown as { createFileDirectory: typeof client.createFileDirectory }).createFileDirectory =
      async (name: string, parentId: string | null) =>
        ({ id: 'bad', parentId, name, type: 'd', blobId: 'b-bad', size: 0, created: '', modified: '' });
    useFileStore.getState().initClient(client);

    expect(await useFileStore.getState().migrateLegacyFlatNodes()).toBe(false);

    const byId = Object.fromEntries(client._nodes().map(n => [n.id, n]));
    // Marker restored to its original name; content file untouched (still flat).
    expect(byId.docs).toMatchObject({ name: 'Documents' });
    expect(byId.a).toMatchObject({ name: `Documents${SEP}readme.txt`, parentId: null });
  });

  it('migration is a no-op when no legacy nodes exist', async () => {
    const client = makeMockClient([dir('a', 'A', null), file('f', 'f.txt', 'a')]);
    useFileStore.getState().initClient(client);
    expect(await useFileStore.getState().migrateLegacyFlatNodes()).toBe(false);
  });

  it('deletes a folder and the server removes its subtree', async () => {
    const client = makeMockClient([
      dir('stuff', 'Stuff', null),
      dir('nonsense', 'Nonsense', 'stuff'),
      file('notes', 'Notes.md', 'nonsense'),
    ]);
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(null);

    await useFileStore.getState().deleteResource('Stuff');
    expect(client._nodes()).toHaveLength(0);
  });
});

describe('file-store modification date (issue #700)', () => {
  beforeEach(() => {
    useFileStore.setState({
      client: null,
      currentParentId: null,
      currentPath: '/',
      pathStack: [{ id: null, name: '' }],
      resources: [],
      selectedResources: new Set(),
      clipboard: null,
      lastAction: null,
    });
  });

  it('shows the server-maintained `modified` date, not `created`', async () => {
    // Stalwart names the property `modified` (draft-ietf-jmap-filenode); there
    // is no `updated`. Asking for the wrong name used to leave lastModified
    // pinned to the creation date, so replacing a file looked unmodified.
    const client = makeMockClient([
      { ...file('notes', 'Notes.md', null), created: '2025-01-01T00:00:00Z', modified: '2026-07-30T12:00:00Z' },
    ]);
    useFileStore.getState().initClient(client);

    await useFileStore.getState().navigate(null);
    expect(useFileStore.getState().resources[0].lastModified).toBe('2026-07-30T12:00:00Z');
  });

  it('falls back to `created` when the server sends no `modified`', async () => {
    const client = makeMockClient([
      { ...file('notes', 'Notes.md', null), created: '2025-01-01T00:00:00Z', modified: '' },
    ]);
    useFileStore.getState().initClient(client);

    await useFileStore.getState().navigate(null);
    expect(useFileStore.getState().resources[0].lastModified).toBe('2025-01-01T00:00:00Z');
  });
});

describe('file-store "Shared with me"', () => {
  const NO_RIGHTS = { mayRead: false, mayAddChildren: false, mayRename: false, mayDelete: false, mayModifyContent: false, mayShare: false };
  const READ = { ...NO_RIGHTS, mayRead: true };
  const T = '2026-09-01T08:00:00Z';

  // Another user's nodes as listAllFileNodesAcrossAccounts hands them over.
  const shared = (id: string, name: string, parentId: string | null, blobId: string | null = null, owner = 'owner'): FileNode => ({
    id: `${owner}:${id}`, parentId: parentId && `${owner}:${parentId}`, name, type: blobId ? 'text/plain' : '', blobId, size: blobId ? 3 : 0,
    created: T, modified: T, myRights: READ, isShared: true, accountId: owner, accountName: owner === 'owner' ? 'Owner' : 'Other',
  });
  // Stalwart 1.0's ancestors of a shared node: no dates, no rights.
  const placeholder = (id: string, name: string, parentId: string | null): FileNode => ({
    ...shared(id, name, parentId), created: null as unknown as string, modified: null as unknown as string,
    myRights: NO_RIGHTS, discoverableOnly: true,
  });

  function withSharedDrive(nodes: FileNode[]) {
    const client = makeMockClient([]);
    Object.assign(client, { listAllFileNodesAcrossAccounts: async () => nodes.map(n => ({ ...n })) });
    return client;
  }

  beforeEach(() => {
    useFileStore.setState({
      client: null,
      currentParentId: null,
      currentPath: '/',
      pathStack: [{ id: null, name: '' }],
      resources: [],
      sharedRoots: [],
    });
  });

  it('shows the shared folder as the root, not the owner\'s folders above it, on Stalwart 1.0', async () => {
    useFileStore.getState().initClient(withSharedDrive([
      placeholder('docs', 'Documents', null),
      placeholder('projects', 'Projects', 'docs'),
      shared('x', 'Project X', 'projects'),
      shared('report', 'report.txt', 'x', 'b1'),
      // A subfolder the owner took back, with something below it still shared.
      placeholder('private', 'Private', 'x'),
      shared('deep', 'Deep', 'private'),
    ]));

    await useFileStore.getState().loadSharedRoots();
    expect(useFileStore.getState().sharedRoots.map(r => r.name)).toEqual(['Deep', 'Project X']);

    await useFileStore.getState().navigate('owner:x', 'Project X');
    expect(useFileStore.getState().resources.map(r => r.name)).toEqual(['report.txt']);
    // The folder tree leaves the owner's folders out too.
    expect(useFileStore.getState().allFolders.map(f => f.name).sort()).toEqual(['Deep', 'Project X']);
  });

  it('keeps a child that reports no rights but has dates, as 0.16 lists one the share predates', async () => {
    useFileStore.getState().initClient(withSharedDrive([
      // 0.16 leaves the owner's folders above a share out of the listing.
      shared('f', 'Shared', 'unlisted'),
      { ...shared('old', 'old.txt', 'f', 'b1'), myRights: NO_RIGHTS },
    ]));

    await useFileStore.getState().loadSharedRoots();
    expect(useFileStore.getState().sharedRoots.map(r => r.name)).toEqual(['Shared']);

    await useFileStore.getState().navigate('owner:f', 'Shared');
    expect(useFileStore.getState().resources.map(r => r.name)).toEqual(['old.txt']);
  });

  // Owner's drive on Stalwart 1.0: a file shared on its own below a folder
  // that isn't shared, one at the top, and a shared folder; plus another
  // owner's file.
  const drive10 = () => [
    placeholder('docs', 'Documents', null),
    shared('plan', 'plan.pdf', 'docs', 'b1'),
    shared('notes', 'notes.txt', null, 'b2'),
    shared('x', 'Project X', null),
    shared('sub', 'Sub', 'x'),
    shared('report', 'report.txt', 'sub', 'b3'),
    shared('theirs', 'theirs.txt', null, 'b4', 'other'),
  ];

  it('lists files shared on their own on their owner\'s page, on Stalwart 1.0', async () => {
    const client = withSharedDrive(drive10());
    useFileStore.getState().initClient(client);

    await useFileStore.getState().loadSharedRoots();
    expect(useFileStore.getState().sharedRoots.map(r => r.name)).toEqual(['Project X', 'notes.txt', 'plan.pdf', 'theirs.txt']);

    // Opened from wherever the user was, the page sits right below Home.
    useFileStore.setState({ pathStack: [{ id: null, name: '' }, { id: 'mine', name: 'Mine' }] });
    await useFileStore.getState().navigate(sharedFilesLocation('owner'), 'Files from Owner');
    const state = useFileStore.getState();
    expect(state.resources.map(r => r.name)).toEqual(['notes.txt', 'plan.pdf']);
    expect(state.resources[0]).toMatchObject({ id: 'owner:notes', blobId: 'b2', isShared: true, ownerAccountId: 'owner' });
    expect(state.currentPath).toBe('/Files from Owner');
    expect(state.pathStack.map(s => s.id)).toEqual([null, 'owner:*']);
  });

  it('lists a file shared on its own on its owner\'s page on 0.16, which leaves the folder above it out', async () => {
    useFileStore.getState().initClient(withSharedDrive([shared('plan', 'plan.pdf', 'unlisted', 'b1')]));

    await useFileStore.getState().loadSharedRoots();
    expect(useFileStore.getState().sharedRoots.map(r => r.name)).toEqual(['plan.pdf']);
    await useFileStore.getState().navigate(sharedFilesLocation('owner'), 'Files from Owner');
    expect(useFileStore.getState().resources.map(r => r.name)).toEqual(['plan.pdf']);
  });

  it('numbers same-named files from different folders on a shared-files page, so each row can be opened', async () => {
    const client = withSharedDrive([
      placeholder('a', 'A', null),
      placeholder('b', 'B', null),
      shared('p1', 'plan.pdf', 'a', 'b1'),
      shared('p2', 'plan.pdf', 'b', 'b2'),
    ]);
    const fetched: string[] = [];
    Object.assign(client, {
      fetchBlob: async (blobId: string) => { fetched.push(blobId); return new Blob(['%PDF']); },
    });
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(sharedFilesLocation('owner'), 'Files from Owner');

    const rows = useFileStore.getState().resources;
    expect(rows.map(r => [r.name, r.serverName, r.id])).toEqual([
      ['plan.pdf', 'plan.pdf', 'owner:p1'],
      ['plan (1).pdf', 'plan.pdf', 'owner:p2'],
    ]);
    // Actions find a row by its name.
    await useFileStore.getState().getImageUrl('plan (1).pdf');
    expect(fetched).toEqual(['b2']);

    // A search hit's link names the file by id, and gets that row, not the
    // first one called plan.pdf; the page's own permalink names it as listed.
    expect(linkedPreviewResource(rows, { name: 'plan.pdf', sharedId: 'owner:p2' }, 'owner:*')?.id).toBe('owner:p2');
    expect(linkedPreviewResource(rows, { name: 'plan (1).pdf', sharedId: 'owner:*' }, 'owner:*')?.id).toBe('owner:p2');
    // The page isn't listed yet: nothing to open.
    expect(linkedPreviewResource([], { name: 'plan.pdf', sharedId: 'owner:p2' }, 'owner:*')).toBeUndefined();
  });

  it('moves files cut on their owner\'s page back to their own folders on undo, not to the page', async () => {
    const client = withSharedDrive(drive10());
    const moves: Array<[string, unknown]> = [];
    Object.assign(client, { updateFileNode: async (id: string, updates: unknown) => { moves.push([id, updates]); } });
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(sharedFilesLocation('owner'), 'Files from Owner');

    useFileStore.getState().cutResources(['plan.pdf', 'notes.txt']);
    await useFileStore.getState().navigate('owner:x', 'Project X');
    await useFileStore.getState().pasteResources();
    await useFileStore.getState().undoLastAction();

    expect(moves).toEqual([
      ['owner:plan', { parentId: 'owner:x' }],
      ['owner:notes', { parentId: 'owner:x' }],
      // The folder the user can't open, and the top of the owner's drive -
      // "owner:*" names no folder (the server got parentId "*").
      ['owner:plan', { parentId: 'owner:docs' }],
      ['owner:notes', { parentId: null }],
    ]);
  });

  it('refuses to add anything to a shared-files page', async () => {
    const client = withSharedDrive(drive10());
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(sharedFilesLocation('owner'), 'Files from Owner');
    const store = useFileStore.getState();
    const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => fileErrorKind(error));

    expect(await refusal(store.createDirectory('New'))).toBe('forbidden');
    expect(await refusal(store.createFile('a.txt'))).toBe('forbidden');
    expect(await refusal(store.uploadFiles([new File(['x'], 'a.txt')]))).toBe('forbidden');
    expect(await refusal(store.uploadFolder([new File(['x'], 'a.txt')]))).toBe('forbidden');
    expect(await refusal(store.duplicateResource('notes.txt'))).toBe('forbidden');
    useFileStore.setState({ clipboard: { mode: 'copy', ids: ['owner:plan'], names: ['plan.pdf'], serverNames: ['plan.pdf'], sourceParentId: null, sourcePath: '/', files: [] } });
    expect(await refusal(useFileStore.getState().pasteResources())).toBe('forbidden');
    expect(client._nodes()).toEqual([]);
  });

  it('opens a shared node where it is listed, on Stalwart 1.0 and 0.16', async () => {
    useFileStore.getState().initClient(withSharedDrive(drive10()));
    const name = (owner: string) => `Files from ${owner}`;
    const open = async (id: string) => {
      const opened = await useFileStore.getState().openSharedNode(id, name);
      const state = useFileStore.getState();
      return { opened, parent: state.currentParentId, path: state.currentPath, listed: state.resources.map(r => r.name) };
    };

    // A file in a shared folder: that folder, with the trail from the shared root.
    expect(await open('owner:report')).toEqual({ opened: true, parent: 'owner:sub', path: '/Project X/Sub', listed: ['report.txt'] });
    // A folder opens itself.
    expect(await open('owner:x')).toEqual({ opened: true, parent: 'owner:x', path: '/Project X', listed: ['Sub'] });
    // A file shared on its own, below a 1.0 placeholder or at the top: its
    // owner's page.
    expect(await open('owner:plan')).toEqual({ opened: true, parent: 'owner:*', path: '/Files from Owner', listed: ['notes.txt', 'plan.pdf'] });
    expect(await open('other:theirs')).toEqual({ opened: true, parent: 'other:*', path: '/Files from Other', listed: ['theirs.txt'] });
    expect(await open(sharedFilesLocation('owner'))).toMatchObject({ opened: true, parent: 'owner:*' });

    // Gone, a placeholder, or not shared at all.
    for (const id of ['owner:gone', 'owner:docs', sharedFilesLocation('nobody')]) {
      expect(await useFileStore.getState().openSharedNode(id, name)).toBe(false);
    }
    expect(useFileStore.getState().currentParentId).toBe(sharedFilesLocation('owner'));

    // 0.16 leaves the unshared folder above the file out altogether.
    useFileStore.getState().initClient(withSharedDrive([shared('plan', 'plan.pdf', 'unlisted', 'b1')]));
    expect(await open('owner:plan')).toEqual({ opened: true, parent: 'owner:*', path: '/Files from Owner', listed: ['plan.pdf'] });
  });
});

describe('file-store paste', () => {
  beforeEach(() => {
    useFileStore.setState({
      client: null,
      currentParentId: null,
      currentPath: '/',
      pathStack: [{ id: null, name: '' }],
      resources: [],
      selectedResources: new Set(),
      clipboard: null,
      lastAction: null,
    });
  });

  it('hands every copy of one paste the same listings, so each tree is read once', async () => {
    const client = makeMockClient([dir('docs', 'Docs', null), file('a', 'a.txt', null), file('b', 'b.txt', null)]);
    const copyFileNode = client.copyFileNode.bind(client);
    const listingsSeen: unknown[] = [];
    Object.assign(client, {
      copyFileNode: async (id: string, name: string, parentId: string | null, listings?: unknown) => {
        listingsSeen.push(listings);
        return copyFileNode(id, name, parentId);
      },
    });
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(null);

    useFileStore.getState().copyResources(['a.txt', 'b.txt']);
    await useFileStore.getState().navigate('docs', 'Docs');
    await useFileStore.getState().pasteResources();

    expect(listingsSeen).toHaveLength(2);
    expect(listingsSeen[0]).toBeInstanceOf(Map);
    expect(listingsSeen[1]).toBe(listingsSeen[0]);
  });
});

describe('file-store symlinks (Stalwart 1.0)', () => {
  // A 1.0 symlink: no blob, size or type, like a folder, but nodeType says so.
  const link = (id: string, name: string, parentId: string | null): FileNode => ({
    id, parentId, name, nodeType: 'symlink', type: null as unknown as string, blobId: null, size: null as unknown as number,
    created: '2026-09-01T08:00:00Z', modified: '2026-09-01T08:00:00Z',
  });

  beforeEach(() => {
    useFileStore.setState({
      client: null,
      currentParentId: null,
      currentPath: '/',
      pathStack: [{ id: null, name: '' }],
      resources: [],
      selectedResources: new Set(),
      clipboard: null,
      lastAction: null,
    });
  });

  it('lists a symlink as its own kind of row, not as a folder', async () => {
    const client = makeMockClient([dir('docs', 'Docs', null), link('l', 'latest', null)]);
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(null);

    expect(useFileStore.getState().resources.find(r => r.name === 'latest'))
      .toMatchObject({ isDirectory: false, isSymlink: true, contentType: '' });
    expect(useFileStore.getState().resources.find(r => r.name === 'Docs'))
      .toMatchObject({ isDirectory: true, isSymlink: false });

    // A path through it doesn't resolve to a folder.
    await useFileStore.getState().navigateByPath('/latest');
    expect(useFileStore.getState().currentPath).toBe('/');
  });

  it('keeps symlinks out of copies and duplicates', async () => {
    const client = makeMockClient([file('f', 'a.txt', null), link('l', 'latest', null)]);
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(null);

    useFileStore.getState().copyResources(['a.txt', 'latest']);
    expect(useFileStore.getState().clipboard).toMatchObject({ mode: 'copy', ids: ['f'], names: ['a.txt'] });

    await useFileStore.getState().duplicateResource('latest');
    expect(client._nodes()).toHaveLength(2);
  });

  it('empties the clipboard when only symlinks are copied, so an earlier cut is not pasted', async () => {
    const client = makeMockClient([dir('docs', 'Docs', null), file('f', 'a.txt', null), link('l', 'latest', null)]);
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(null);

    useFileStore.getState().cutResources(['a.txt']);
    useFileStore.getState().copyResources(['latest']);
    expect(useFileStore.getState().clipboard).toBeNull();

    await useFileStore.getState().navigate('docs', 'Docs');
    await useFileStore.getState().pasteResources();
    expect(client._nodes().find(n => n.id === 'f')?.parentId).toBeNull();
  });
});

describe('file-store upload batches', () => {
  // A file dropped as part of a folder carries its path inside it.
  const inFolder = (path: string) => {
    const file = new File(['x'], path.split('/').pop()!, { type: 'text/plain' });
    Object.defineProperty(file, 'webkitRelativePath', { value: path });
    return file;
  };

  beforeEach(() => {
    useFileStore.setState({
      client: null,
      currentParentId: null,
      currentPath: '/',
      pathStack: [{ id: null, name: '' }],
      resources: [],
      selectedResources: new Set(),
      clipboard: null,
      lastAction: null,
    });
  });

  it('goes on past a file the server refuses and reports it at the end', async () => {
    const client = makeMockClient([]);
    const createFileNode = client.createFileNode.bind(client);
    Object.assign(client, {
      createFileNode: async (name: string, ...rest: [string, string, number, string | null]) => {
        if (name === 'b.txt') {
          // 1.0 once an administrator has set maxFiles.
          throw jmapError('There are too many files, please delete some before adding a new one.', { type: 'overQuota' });
        }
        return createFileNode(name, ...rest);
      },
    });
    useFileStore.getState().initClient(client);

    const report = await useFileStore.getState().uploadFiles(
      ['a.txt', 'b.txt', 'c.txt'].map(n => new File(['x'], n, { type: 'text/plain' })),
    );

    expect(report.uploaded).toBe(2);
    expect(report.failed.map(f => f.name)).toEqual(['b.txt']);
    expect(fileErrorKind(report.failed[0].error)).toBe('overQuota');
    expect(client._nodes().map(n => n.name)).toEqual(['a.txt', 'c.txt']);
  });

  it('skips the files of a folder it could not create instead of putting them in the upload\'s folder', async () => {
    const client = makeMockClient([dir('here', 'Here', null)]);
    const createFileDirectory = client.createFileDirectory.bind(client);
    Object.assign(client, {
      createFileDirectory: async (name: string, parentId: string | null) => {
        if (name === 'Locked') {
          throw jmapError('You are not allowed to create file nodes in this folder.', { type: 'forbidden' });
        }
        return createFileDirectory(name, parentId);
      },
    });
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate('here', 'Here');

    const report = await useFileStore.getState().uploadFolder([
      inFolder('Photos/a.jpg'),
      inFolder('Photos/Locked/b.jpg'),
      inFolder('Photos/Locked/Inner/c.jpg'),
    ]);

    expect(report.uploaded).toBe(1);
    expect(report.failed.map(f => f.name)).toEqual(['Photos/Locked/b.jpg', 'Photos/Locked/Inner/c.jpg']);
    expect(report.failed.every(f => fileErrorKind(f.error) === 'forbidden')).toBe(true);

    const nodes = client._nodes();
    const photos = nodes.find(n => n.name === 'Photos')!;
    expect(nodes.filter(n => n.parentId === 'here').map(n => n.name)).toEqual(['Photos']);
    expect(nodes.filter(n => n.parentId === photos.id).map(n => n.name)).toEqual(['a.jpg']);
  });

  it('leaves out what would sit deeper than maxFileNodeDepth (Stalwart 1.0)', async () => {
    // Uploading into Stuff/Nonsense, level 2, with a limit of 4 levels.
    const client = makeMockClient([dir('stuff', 'Stuff', null), dir('nonsense', 'Nonsense', 'stuff')]);
    Object.assign(client, { getMaxFileNodeDepth: () => 4 });
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate('stuff', 'Stuff');
    await useFileStore.getState().navigate('nonsense', 'Nonsense');

    const report = await useFileStore.getState().uploadFolder([
      inFolder('Up/a.txt'),
      inFolder('Up/Deep/b.txt'),
      inFolder('Up/Deep/Deeper/c.txt'),
    ]);

    expect(report.uploaded).toBe(1);
    expect(report.failed.map(f => f.name)).toEqual(['Up/Deep/b.txt', 'Up/Deep/Deeper/c.txt']);
    expect(report.failed.every(f => fileErrorKind(f.error) === 'tooDeep')).toBe(true);
    expect(client._nodes().map(n => n.name)).toEqual(['Stuff', 'Nonsense', 'Up', 'Deep', 'a.txt']);
  });

  it('has no depth to check on 0.16', async () => {
    const client = makeMockClient([dir('stuff', 'Stuff', null), dir('nonsense', 'Nonsense', 'stuff')]);
    Object.assign(client, { getMaxFileNodeDepth: () => null });
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate('nonsense', 'Nonsense');

    const report = await useFileStore.getState().uploadFolder([inFolder('Up/Deep/Deeper/c.txt')]);
    expect(report).toEqual({ uploaded: 1, failed: [], canceled: false });
  });
});

describe('resourceServerRef (issue #1094)', () => {
  it('splits a node of a shared account into its owner account and bare id', () => {
    // The WOPI editor used to send "d:b" with the user's own account, and
    // FileNode/get answered notFound.
    expect(resourceServerRef({ id: 'd:b', ownerAccountId: 'd' })).toEqual({ accountId: 'd', id: 'b' });
  });

  it('keeps own nodes as they are', () => {
    expect(resourceServerRef({ id: 'b', ownerAccountId: 'c' })).toEqual({ accountId: 'c', id: 'b' });
    expect(resourceServerRef({ id: 'b' })).toEqual({ accountId: undefined, id: 'b' });
  });
});

describe('file-store folder tree and moves', () => {
  beforeEach(() => {
    useFileStore.setState({
      client: null,
      currentParentId: null,
      currentPath: '/',
      pathStack: [{ id: null, name: '' }],
      resources: [],
      allFolders: [],
      selectedResources: new Set(),
      clipboard: null,
      lastAction: null,
    });
  });

  describe('breadcrumb trail', () => {
    const tree = () => makeMockClient([
      dir('docs', 'Documents', null),
      dir('photos', 'Photos', null),
      dir('trips', 'Trips', 'photos'),
      dir('trash', '.Trash', null),
    ]);
    const trail = () => useFileStore.getState().pathStack.map(s => s.name);

    it('follows the real ancestors when a folder is picked in the tree, not the folder open before', async () => {
      useFileStore.getState().initClient(tree());
      await useFileStore.getState().navigate(null);
      await useFileStore.getState().navigate('docs', 'Documents');
      await useFileStore.getState().navigate('trips', 'Trips');
      expect(useFileStore.getState().currentPath).toBe('/Photos/Trips');
      expect(trail()).toEqual(['', 'Photos', 'Trips']);

      // Alt+Up goes to the real parent.
      await useFileStore.getState().navigateUp();
      expect(useFileStore.getState().currentParentId).toBe('photos');
      expect(useFileStore.getState().currentPath).toBe('/Photos');
    });

    it('leaves the Trash out of the trail of a folder opened from it', async () => {
      useFileStore.getState().initClient(tree());
      await useFileStore.getState().navigate(null);
      await useFileStore.getState().navigate(TRASH_LOCATION, '.Trash');
      await useFileStore.getState().navigate('photos', 'Photos');
      expect(useFileStore.getState().currentPath).toBe('/Photos');
      expect(trail()).toEqual(['', 'Photos']);
    });

    it('sets the full trail once the listing arrives, when the folder list was not loaded yet', async () => {
      useFileStore.getState().initClient(tree());
      await useFileStore.getState().navigate('trips', 'Trips');
      expect(useFileStore.getState().currentPath).toBe('/Photos/Trips');
      expect(useFileStore.getState().pathStack.map(s => s.id)).toEqual([null, 'photos', 'trips']);
    });
  });

  it('keeps every folder from the listing for the tree, at any depth', async () => {
    const client = makeMockClient([
      dir('a', 'A', null),
      dir('b', 'B', 'a'),
      file('f', 'f.txt', 'b'),
    ]);
    useFileStore.getState().initClient(client);

    await useFileStore.getState().navigate(null);
    expect(useFileStore.getState().allFolders.map(f => f.id).sort()).toEqual(['a', 'b']);
  });

  it('moves items into any folder by id and records the move for undo', async () => {
    const client = makeMockClient([
      dir('a', 'A', null),
      dir('b', 'B', 'a'),
      file('f', 'f.txt', null),
    ]);
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(null);

    await useFileStore.getState().moveToFolderId(['f.txt'], 'b');
    expect(client._nodes().find(n => n.id === 'f')!.parentId).toBe('b');

    await useFileStore.getState().undoLastAction();
    expect(client._nodes().find(n => n.id === 'f')!.parentId).toBeNull();
  });

  it('refuses to move a folder into itself or a folder below it', async () => {
    const client = makeMockClient([
      dir('a', 'A', null),
      dir('b', 'B', 'a'),
    ]);
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(null);

    await useFileStore.getState().moveToFolderId(['A'], 'b');
    await useFileStore.getState().moveToFolderId(['A'], 'a');
    expect(client._nodes().find(n => n.id === 'a')!.parentId).toBeNull();
  });

  it('reveals a file deep in the tree: opens its folder with the full path and selects it', async () => {
    const client = makeMockClient([
      dir('a', 'A', null),
      dir('b', 'B', 'a'),
      file('f', 'f.txt', 'b'),
    ]);
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(null);

    expect(await useFileStore.getState().revealNode('f')).toBe('f.txt');
    const state = useFileStore.getState();
    expect(state.currentPath).toBe('/A/B');
    expect(state.currentParentId).toBe('b');
    expect(state.resources.map(r => r.name)).toEqual(['f.txt']);
    expect([...state.selectedResources]).toEqual(['f.txt']);
  });

  it('returns null when the revealed node no longer exists', async () => {
    const client = makeMockClient([dir('a', 'A', null)]);
    useFileStore.getState().initClient(client);
    expect(await useFileStore.getState().revealNode('gone')).toBeNull();
  });
});

describe('file-store upload result', () => {
  beforeEach(() => {
    useFileStore.setState({
      client: null,
      currentParentId: null,
      currentPath: '/',
      pathStack: [{ id: null, name: '' }],
      resources: [],
      uploadProgress: null,
      uploadAbortController: null,
    });
  });

  it('reports every file when the upload runs to the end', async () => {
    const client = makeMockClient();
    useFileStore.getState().initClient(client);
    const result = await useFileStore.getState().uploadFiles([
      new File(['a'], 'a.txt'), new File(['b'], 'b.txt'),
    ]);
    expect(result).toEqual({ uploaded: 2, failed: [], canceled: false });
  });

  it('reports a cancel and only the files that made it before it', async () => {
    const client = makeMockClient();
    const upload = client.uploadBlob.bind(client);
    let calls = 0;
    client.uploadBlob = (async (file: File) => {
      calls++;
      // Cancel while the second file is on its way up.
      if (calls === 2) useFileStore.getState().cancelUpload();
      return upload(file);
    }) as typeof client.uploadBlob;
    useFileStore.getState().initClient(client);

    const result = await useFileStore.getState().uploadFiles([
      new File(['a'], 'a.txt'), new File(['b'], 'b.txt'), new File(['c'], 'c.txt'),
    ]);
    expect(result).toEqual({ uploaded: 1, failed: [], canceled: true });
    expect(client._nodes().map(n => n.name)).toEqual(['a.txt']);
  });
});

describe('file-store actions by id', () => {
  beforeEach(() => {
    localStorage.clear();
    useFileStore.setState({
      client: null,
      currentParentId: null,
      currentPath: '/',
      pathStack: [{ id: null, name: '' }],
      resources: [],
      allFolders: [],
      favorites: [],
      recentFiles: [],
      selectedResources: new Set(),
      lastAction: null,
    });
  });

  it('renames a folder that is not listed and moves its stars along', async () => {
    const client = makeMockClient([dir('a', 'A', null), dir('b', 'B', 'a')]);
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(null);
    useFileStore.setState({ favorites: ['/A/B', '/Other'] });

    await useFileStore.getState().renameNode('a', 'Alpha');
    expect(client._nodes().find(n => n.id === 'a')!.name).toBe('Alpha');
    expect(useFileStore.getState().favorites).toEqual(['/Alpha/B', '/Other']);
  });

  it('updates the path on screen when an open folder is renamed', async () => {
    const client = makeMockClient([dir('a', 'A', null), dir('b', 'B', 'a')]);
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate('a', 'A');
    await useFileStore.getState().navigate('b', 'B');

    await useFileStore.getState().renameNode('a', 'Alpha');
    expect(useFileStore.getState().currentPath).toBe('/Alpha/B');
  });

  it('deletes the open folder and steps out to its parent, dropping its stars', async () => {
    const client = makeMockClient([dir('a', 'A', null), dir('b', 'B', 'a')]);
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate('a', 'A');
    await useFileStore.getState().navigate('b', 'B');
    useFileStore.setState({ favorites: ['/A/B', '/A'] });

    await useFileStore.getState().deleteNode('b');
    const state = useFileStore.getState();
    expect(state.currentPath).toBe('/A');
    expect(state.currentParentId).toBe('a');
    expect(state.favorites).toEqual(['/A']);
  });

  it('forgets a recent file', () => {
    useFileStore.setState({ recentFiles: [{ name: 'x', id: '1', timestamp: 1 }, { name: 'y', id: '2', timestamp: 2 }] });
    useFileStore.getState().removeRecentFile('1');
    expect(useFileStore.getState().recentFiles.map(r => r.id)).toEqual(['2']);
  });
});

describe('file-store preview content', () => {
  it('reads a file through the client, so the demo, which has no download URL, can preview it', async () => {
    const client = makeMockClient([file('a', 'notes.txt', null)]);
    Object.assign(client, {
      getBlobDownloadUrl: () => 'data:application/octet-stream;demo-blob=b-a',
      getAuthHeader: () => '',
      fetchBlob: async (blobId: string) => new Blob([`content of ${blobId}`], { type: 'text/plain' }),
    });
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(null);

    const { blob, contentType } = await useFileStore.getState().getFileContent('notes.txt');
    expect(await blob.text()).toBe('content of b-a');
    expect(contentType).toBe('text/plain');
  });
});

describe('file-store new file (#1393)', () => {
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  it('creates a document from its blank template and returns the name the server gave it', async () => {
    const client = makeMockClient([file('a', 'Report.docx', null)]);
    const uploads: File[] = [];
    const upload = client.uploadBlob.bind(client);
    const create = client.createFileNode.bind(client);
    Object.assign(client, {
      uploadBlob: async (f: File) => { uploads.push(f); return upload(f); },
      // Stalwart's onExists: "rename".
      createFileNode: (name: string, ...rest: [string, string, number, string | null]) =>
        create(name === 'Report.docx' ? 'Report (2).docx' : name, ...rest),
    });
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(null);

    const blank = new Blob(['PK blank docx'], { type: DOCX });
    expect(await useFileStore.getState().createFile('Report.docx', blank)).toBe('Report (2).docx');
    expect(await uploads[0].text()).toBe('PK blank docx');
    expect(client._nodes().find(n => n.name === 'Report (2).docx')).toMatchObject({ type: DOCX, size: 13 });
    expect(useFileStore.getState().resources.map(r => r.name)).toContain('Report (2).docx');
  });

  it('creates an empty text file without a template', async () => {
    const client = makeMockClient();
    useFileStore.getState().initClient(client);
    await useFileStore.getState().navigate(null);

    expect(await useFileStore.getState().createFile('notes.txt')).toBe('notes.txt');
    expect(client._nodes()[0]).toMatchObject({ name: 'notes.txt', type: 'text/plain', size: 0 });
  });
});
