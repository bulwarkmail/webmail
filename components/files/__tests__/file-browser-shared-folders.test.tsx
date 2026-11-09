import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FileBrowser } from '../file-browser';
import { useFileStore, type FileResource } from '@/stores/file-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useRegisteredCommandGroups, type CommandGroup } from '@/lib/command-registry';
import { DEFAULT_FILES_SETTINGS } from '@/lib/files-settings';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { FileNode } from '@/lib/jmap/types';

vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/settings/share-collection-dialog', () => ({
  ShareCollectionDialog: ({ collectionName, shareWith }: { collectionName: string; shareWith?: Record<string, unknown> | null }) => (
    <div data-testid="share-dialog">{collectionName}:{Object.keys(shareWith ?? {}).join(',')}</div>
  ),
}));

function node(id: string, name: string, parentId: string | null, extra: Partial<FileNode> = {}): FileNode {
  return {
    id,
    name,
    parentId,
    type: 'd',
    blobId: null,
    size: 0,
    created: '2026-10-01T00:00:00Z',
    modified: '2026-10-01T00:00:00Z',
    ...extra,
  };
}

function resource(n: FileNode): FileResource {
  return {
    id: n.id,
    name: n.name,
    serverName: n.name,
    isDirectory: n.blobId == null,
    contentType: n.blobId == null ? '' : n.type,
    contentLength: n.size,
    lastModified: n.modified ?? '',
    blobId: n.blobId,
    parentId: n.parentId,
    shareWith: n.shareWith,
    isShared: n.isShared,
    ownerName: n.accountName,
  } as FileResource;
}

const OWN: FileNode[] = [
  node('f-docs', 'Documents', null),
  node('f-notes', 'notes.txt', null, { blobId: 'b-notes', type: 'text/plain', size: 10 }),
];
const SHARED = node('e:f-team', 'Team', null, { isShared: true, accountId: 'e', accountName: 'userb@example.org' });

type Overrides = Partial<React.ComponentProps<typeof FileBrowser>>;

function renderBrowser(opts: { resources?: FileResource[]; allFolders?: FileResource[]; props?: Overrides; hasListed?: boolean; shared?: FileNode[] } = {}) {
  const client = {
    listAllFileNodesAcrossAccounts: vi.fn(async () => [...OWN, ...(opts.shared ?? [SHARED])]),
  } as unknown as IJMAPClient;
  act(() => {
    useFileStore.setState({
      client,
      sharedRoots: [],
      allFolders: opts.allFolders ?? OWN.filter((n) => n.blobId == null).map(resource),
      currentParentId: null,
      pathStack: [{ id: null, name: '' }],
      hasListed: opts.hasListed ?? true,
    });
  });
  const handlers = {
    onNavigate: vi.fn(),
    onSetSelection: vi.fn(),
    onToggleSelect: vi.fn(),
    onPreviewFile: vi.fn(),
    onDownload: vi.fn(async () => {}),
    onRenameNode: vi.fn(async () => {}),
    onDeleteNode: vi.fn(async () => {}),
    onDownloadNode: vi.fn(async () => {}),
    onRevealNode: vi.fn(async () => {}),
    onRemoveRecent: vi.fn(),
  };
  const noop = vi.fn(async () => {});
  render(
    <FileBrowser
      currentPath="/"
      resources={opts.resources ?? OWN.map(resource)}
      isLoading={false}
      error={null}
      selectedResources={new Set()}
      uploadProgress={null}
      clipboard={null}
      onCreateFolder={noop}
      onUploadFiles={noop}
      onUploadFolder={noop}
      onCancelUpload={vi.fn()}
      onDelete={noop}
      onBatchDelete={noop}
      onRename={noop}
      onBatchDownload={noop}
      onRefresh={noop}
      onClearSelection={vi.fn()}
      onCut={vi.fn()}
      onCopy={vi.fn()}
      onPaste={noop}
      onMoveTo={noop}
      onPreviewImage={vi.fn()}
      onCreateFile={noop}
      onDuplicate={noop}
      getImageUrl={async () => ''}
      favorites={[]}
      recentFiles={[]}
      onToggleFavorite={vi.fn()}
      onOpenRecent={vi.fn()}
      client={client}
      ownAccountId="a"
      sharingEnabled
      onShare={noop}
      {...handlers}
      {...opts.props}
    />,
  );
  return handlers;
}

// Narrow panes (and jsdom) show the sidebar as a drawer; open it like a user would.
function tree() {
  const toggle = screen.queryByRole('button', { name: 'open_folder_tree' });
  if (toggle && toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
  return screen.getByRole('navigation', { name: 'folders' });
}

function list() {
  return screen.getByRole('grid', { name: 'file_list' });
}

describe('FileBrowser', () => {
  beforeEach(() => {
    localStorage.clear();
    act(() => { useSettingsStore.setState({ filesSettings: DEFAULT_FILES_SETTINGS }); });
  });
  afterEach(() => {
    act(() => { useFileStore.setState({ client: null, sharedRoots: [], allFolders: [] }); });
  });

  it('draws the loading listing in the list view, as the page skeleton did', () => {
    renderBrowser({ resources: [], hasListed: false });
    expect(screen.getByTestId('files-list-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('files-grid-skeleton')).toBeNull();
  });

  it('draws the loading listing as tiles when the grid view is picked', () => {
    act(() => { useSettingsStore.setState({ filesSettings: { ...DEFAULT_FILES_SETTINGS, defaultViewMode: 'grid' } }); });
    renderBrowser({ resources: [], hasListed: false });
    expect(screen.getByTestId('files-grid-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('files-list-skeleton')).toBeNull();
  });

  it('lists folders shared with the user at the root and in the sidebar (#1181)', async () => {
    const { onNavigate } = renderBrowser();
    await screen.findAllByText('Team');
    const section = screen.getByRole('region', { name: 'shared_with_me' });
    fireEvent.click(within(section).getByText('Team'));
    expect(onNavigate).toHaveBeenCalledWith('/Team', 'e:f-team');
    expect(within(tree()).getByText('Team')).toBeInTheDocument();
  });

  it('lists files shared on their own on a page per owner, at the root and in the sidebar', async () => {
    const lone = node('e:f-plan', 'plan.pdf', 'e:f-private', {
      blobId: 'b-plan', type: 'application/pdf', size: 5, isShared: true, accountId: 'e', accountName: 'userb@example.org',
    });
    const { onNavigate } = renderBrowser({ shared: [SHARED, lone] });
    const section = await screen.findByRole('region', { name: 'shared_with_me' });
    fireEvent.click(await within(section).findByText('shared_files_from'));
    expect(onNavigate).toHaveBeenCalledWith('/shared_files_from', 'e:*');
    fireEvent.click(within(tree()).getByText('shared_files_from'));
    expect(onNavigate).toHaveBeenLastCalledWith('/shared_files_from', 'e:*');
  });

  it('offers no download for a symlink', () => {
    const link = { ...resource(node('f-link', 'shortcut.txt', null, { blobId: null, nodeType: 'symlink' } as Partial<FileNode>)), isDirectory: false, isSymlink: true };
    renderBrowser({ resources: [...OWN.map(resource), link] });
    const row = within(list()).getByText('shortcut.txt').closest('[role="row"]') as HTMLElement;
    expect(within(row).queryByRole('button', { name: 'download' })).toBeNull();
    const notes = within(list()).getByText('notes.txt').closest('[role="row"]') as HTMLElement;
    expect(within(notes).getByRole('button', { name: 'download' })).toBeInTheDocument();
  });

  it('shows shared folders instead of the empty state when the own root is empty', async () => {
    renderBrowser({ resources: [], allFolders: [] });
    expect(await screen.findAllByText('Team')).not.toHaveLength(0);
    expect(screen.queryByText('empty_state_title')).toBeNull();
  });

  it('lists folders in the file list as well as the tree', () => {
    renderBrowser();
    expect(within(list()).getByText('Documents')).toBeInTheDocument();
    expect(within(tree()).getByText('Documents')).toBeInTheDocument();
  });

  // pim-3: the name is plain text, as in a file manager. A click selects, a
  // double-click opens.
  it('selects a folder from its name and opens it on a double-click', () => {
    const { onNavigate, onSetSelection } = renderBrowser();
    fireEvent.click(within(list()).getByText('Documents'));
    expect(onSetSelection).toHaveBeenCalledWith(new Set(['Documents']));
    expect(onNavigate).not.toHaveBeenCalled();

    fireEvent.doubleClick(within(list()).getByText('Documents'));
    expect(onNavigate).toHaveBeenCalledWith('/Documents', 'f-docs');
  });

  it('previews a text file when its name is double-clicked', () => {
    const { onPreviewFile } = renderBrowser();
    fireEvent.click(within(list()).getByText('notes.txt'));
    expect(onPreviewFile).not.toHaveBeenCalled();
    fireEvent.doubleClick(within(list()).getByText('notes.txt'));
    expect(onPreviewFile).toHaveBeenCalledWith('notes.txt');
  });

  it('shares an own folder from the tree with its current shares', async () => {
    const shared = resource({ ...OWN[0], shareWith: { p1: { mayRead: true } } } as unknown as FileNode);
    // Browsing another folder: the tree's folder is not in the listing.
    renderBrowser({ resources: [resource(OWN[1])], allFolders: [shared] });

    fireEvent.contextMenu(within(tree()).getByText('Documents'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'files_share' }));

    expect(await screen.findByTestId('share-dialog')).toHaveTextContent('Documents:p1');
  });

  it('offers no share action on folders shared with the user', async () => {
    renderBrowser();
    await screen.findAllByText('Team');
    fireEvent.contextMenu(within(tree()).getByText('Team'));
    expect(screen.queryByRole('menuitem', { name: 'files_share' })).toBeNull();
  });

  it('hides dot files unless the setting shows them', () => {
    const hidden = resource(node('f-env', '.env', null, { blobId: 'b-env', type: 'text/plain', size: 1 }));
    renderBrowser({ resources: [...OWN.map(resource), hidden] });
    expect(within(list()).queryByText('.env')).toBeNull();
  });

  it('shows dot files when the setting is on', () => {
    localStorage.setItem('files-settings', JSON.stringify({ showHiddenFiles: true }));
    const hidden = resource(node('f-env', '.env', null, { blobId: 'b-env', type: 'text/plain', size: 1 }));
    renderBrowser({ resources: [...OWN.map(resource), hidden] });
    expect(within(list()).getByText('.env')).toBeInTheDocument();
  });

  it('starts in the default view and sort from the settings', () => {
    act(() => { useSettingsStore.setState({ filesSettings: { ...DEFAULT_FILES_SETTINGS, defaultSortKey: 'name', defaultSortDir: 'desc' } }); });
    const files = ['a.txt', 'c.txt', 'b.txt'].map((n, i) => resource(node(`f${i}`, n, null, { blobId: `b${i}`, type: 'text/plain', size: 1 })));
    renderBrowser({ resources: files, allFolders: [] });
    const names = within(list()).getAllByRole('row').slice(1).map((r) => r.getAttribute('data-resource'));
    expect(names).toEqual(['c.txt', 'b.txt', 'a.txt']);
  });

  it('shows the loading skeleton, not the empty state, before the first listing', () => {
    renderBrowser({ resources: [], allFolders: [], hasListed: false });
    expect(screen.queryByText('empty_state_title')).toBeNull();
    expect(screen.queryByText('empty_folder_title')).toBeNull();
  });

  it('shows an empty state with upload and new folder in an empty folder', () => {
    renderBrowser({ resources: [], allFolders: [], props: { currentPath: '/Documents' } });
    expect(screen.getByText('empty_folder_title')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /upload_files/ }).length).toBeGreaterThan(0);
  });

  it('keeps a drag selection when the mouse is released', () => {
    const onClearSelection = vi.fn();
    const { onSetSelection } = renderBrowser({ props: { onClearSelection, selectedResources: new Set(['notes.txt']) } });
    const area = list().parentElement!;
    // jsdom lays everything out at 0,0, so a box from -5,-5 to 20,20 covers every row.
    fireEvent.mouseDown(area, { button: 0, clientX: -5, clientY: -5 });
    fireEvent.mouseMove(window, { clientX: 20, clientY: 20 });
    fireEvent.mouseUp(window, { clientX: 20, clientY: 20 });
    fireEvent.click(area);

    expect(onSetSelection).toHaveBeenLastCalledWith(new Set(['Documents', 'notes.txt']));
    // Only the press that started the drag cleared the old selection.
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  it('offers new and upload entries on My files in the sidebar', () => {
    renderBrowser();
    fireEvent.contextMenu(within(tree()).getByText('my_files'));
    for (const name of ['open', 'files_new_folder', 'files_new_text_file', 'files_upload_files', 'files_upload_folder']) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
    }
  });

  it('renames and deletes a folder from the tree', async () => {
    const { onRenameNode, onDeleteNode } = renderBrowser();
    fireEvent.contextMenu(within(tree()).getByText('Documents'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'rename' }));
    const input = await screen.findByDisplayValue('Documents');
    fireEvent.change(input, { target: { value: 'Docs' } });
    fireEvent.submit(input.closest('form')!);
    await vi.waitFor(() => expect(onRenameNode).toHaveBeenCalledWith('f-docs', 'Docs'));

    fireEvent.contextMenu(within(tree()).getByText('Documents'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'delete' }));
    expect(onDeleteNode).toHaveBeenCalledWith('f-docs', 'Documents');
  });

  it('offers no rename or delete on a folder shared with the user', async () => {
    renderBrowser();
    await screen.findAllByText('Team');
    fireEvent.contextMenu(within(tree()).getByText('Team'));
    expect(screen.getByRole('menuitem', { name: 'open' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'rename' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'delete' })).toBeNull();
  });

  it('shows, downloads and forgets a recent file from its menu', () => {
    const { onRevealNode, onDownloadNode, onRemoveRecent } = renderBrowser({
      props: { recentFiles: [{ name: 'notes.txt', id: 'f-notes', timestamp: 1 }] },
    });
    const open = (name: string) => {
      fireEvent.contextMenu(within(tree()).getByText('notes.txt'));
      fireEvent.click(screen.getByRole('menuitem', { name }));
    };
    open('show_in_folder');
    expect(onRevealNode).toHaveBeenCalledWith('f-notes');
    open('download');
    expect(onDownloadNode).toHaveBeenCalledWith('f-notes');
    open('remove_from_recent');
    expect(onRemoveRecent).toHaveBeenCalledWith('f-notes');
  });

  it('outlines the clicked item while it is selected', () => {
    renderBrowser({ props: { selectedResources: new Set(['notes.txt']) } });
    const row = within(list()).getByText('notes.txt').closest('[role=row]')!;
    fireEvent.click(row);
    expect(row.className).toContain('ring-ring');
  });

  it('drops the outline once the clicked item is deselected, but keeps it for the keyboard', () => {
    // The selection prop stays empty, as after deselecting.
    renderBrowser();
    const row = () => within(list()).getByText('notes.txt').closest('[role=row]')!;
    fireEvent.click(row());
    expect(row().className).not.toContain('ring-ring');

    fireEvent.keyDown(window, { key: 'ArrowUp' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(row().className).toContain('ring-ring');
  });

  it('replaces the toolbar with selection actions when items are selected', () => {
    renderBrowser({ props: { selectedResources: new Set(['notes.txt']) } });
    const bar = screen.getByRole('toolbar', { name: 'selection_actions' });
    expect(within(bar).getByRole('button', { name: 'download' })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'delete' })).toBeInTheDocument();
  });

  it("takes the closed folder drawer out of reach, so it can't cover the nav rail or catch Tab", () => {
    renderBrowser();
    const drawer = screen.getByTestId('files-sidebar-drawer');
    expect(drawer).toHaveAttribute('inert');
    expect(drawer.className).toContain('invisible');
    tree();
    expect(drawer).not.toHaveAttribute('inert');
  });

  // The same drawer as Mail's folders (usability test 2026-11-04): it opened
  // beside the app rail with only the file list dimmed, ignored Escape and
  // left the focus on the page.
  it("opens the folder drawer from the window's edge, with the whole window dimmed", () => {
    renderBrowser();
    const drawer = screen.getByTestId('files-sidebar-drawer');
    const classes = drawer.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(['fixed', 'start-0', 'top-[var(--drawer-top)]', 'bottom-0']));
    expect(classes).not.toContain('absolute');
    // Where the window's controls are over the page, app/globals.css places it by this.
    expect(drawer).toHaveAttribute('data-window-drawer');
    tree();
    expect(screen.getByTestId('drawer-scrim').className.split(/\s+/)).toEqual(expect.arrayContaining(['fixed', 'inset-0']));
  });

  it('takes the focus into the folder drawer, keeps Tab there and gives it back on Escape without clearing the search', () => {
    renderBrowser();
    const drawer = screen.getByTestId('files-sidebar-drawer');
    const menu = screen.getByRole('button', { name: 'open_folder_tree' });
    fireEvent.change(screen.getAllByRole('searchbox')[0], { target: { value: 'notes' } });
    menu.focus();
    fireEvent.click(menu);
    // The folder on screen.
    expect(drawer.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toHaveAttribute('aria-current', 'page');
    const stops = Array.from(drawer.querySelectorAll<HTMLElement>('button:not(:disabled)'));
    stops.at(-1)!.focus();
    fireEvent.keyDown(stops.at(-1)!, { key: 'Tab' });
    expect(document.activeElement).toBe(stops[0]);

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(drawer).toHaveAttribute('inert');
    expect(document.activeElement).toBe(menu);
    expect(screen.getAllByRole('searchbox')[0]).toHaveValue('notes');
  });

  it('closes the folder drawer on a click on the dimmed window and gives the focus back to the menu button', () => {
    renderBrowser();
    const drawer = screen.getByTestId('files-sidebar-drawer');
    const menu = screen.getByRole('button', { name: 'open_folder_tree' });
    menu.focus();
    fireEvent.click(menu);
    // A press on the scrim drops the focus to the page.
    (document.activeElement as HTMLElement).blur();
    fireEvent.click(screen.getByTestId('drawer-scrim'));
    expect(drawer).toHaveAttribute('inert');
    expect(document.activeElement).toBe(menu);
  });

  it("renames in a dialog that selects the name without its extension and closes on Escape", async () => {
    renderBrowser({ props: { selectedResources: new Set(['notes.txt']) } });
    fireEvent.keyDown(window, { key: 'F2' });
    const dialog = screen.getByRole('dialog', { name: 'rename_title' });
    const input = within(dialog).getByRole('textbox') as HTMLInputElement;
    await waitFor(() => expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5]));

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'rename_title' })).toBeNull();
  });

  it("deletes the selection with Backspace, as Mail does, and goes up a folder only with Alt+Up", () => {
    const onDelete = vi.fn(async () => {});
    const onNavigate = vi.fn();
    renderBrowser({ props: { currentPath: '/Documents', selectedResources: new Set(['notes.txt']), onDelete, onNavigate } });
    fireEvent.keyDown(window, { key: 'Backspace' });
    expect(onDelete).toHaveBeenCalledWith('notes.txt');
    expect(onNavigate).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'ArrowUp', altKey: true });
    expect(onNavigate).toHaveBeenCalled();
  });

  it("keeps the selection when Escape closes an item's menu", () => {
    const onClearSelection = vi.fn();
    renderBrowser({ props: { selectedResources: new Set(['notes.txt', 'Documents']), onClearSelection } });
    fireEvent.contextMenu(within(list()).getByText('notes.txt'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onClearSelection).not.toHaveBeenCalled();
  });

  it("offers Restore and Delete permanently in the trash, and Empty trash in its toolbar", () => {
    const onRestore = vi.fn(async () => {});
    const onEmptyTrash = vi.fn();
    const trashed = { ...resource(OWN[1]), trash: { deletedAt: '2026-10-20T10:00:00Z', fromParentId: null, batchId: 'b1' } };
    act(() => { useFileStore.setState({ trashCount: 1 }); });
    renderBrowser({ resources: [trashed], props: { currentPath: '/.Trash', onRestore, onEmptyTrash } });
    act(() => { useFileStore.setState({ currentParentId: '*trash', trashCount: 1 }); });

    fireEvent.click(screen.getByRole('button', { name: 'empty_trash' }));
    expect(onEmptyTrash).toHaveBeenCalled();

    fireEvent.contextMenu(within(list()).getByText('notes.txt'));
    expect(screen.queryByText('rename')).toBeNull();
    fireEvent.click(screen.getByText('restore'));
    expect(onRestore).toHaveBeenCalledWith(['notes.txt']);
    expect(screen.getByRole('columnheader', { name: 'deleted' })).toBeInTheDocument();
  });

  it("lists the trash in the sidebar", () => {
    const { onNavigate } = renderBrowser();
    fireEvent.click(within(tree()).getByRole('button', { name: /trash/ }));
    expect(onNavigate).toHaveBeenCalledWith('/.Trash', '*trash');
  });

  it("moves an item to a folder picked in Move to…, without dragging", () => {
    const onMoveTo = vi.fn(async () => {});
    renderBrowser({ props: { onMoveTo } });
    fireEvent.contextMenu(within(list()).getByText('notes.txt'));
    fireEvent.click(screen.getByText('move_to'));
    const dialog = screen.getByRole('dialog', { name: 'move_to_title' });
    expect(within(dialog).getByRole('button', { name: 'move_here' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('treeitem', { name: /Documents/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'move_here' }));
    expect(onMoveTo).toHaveBeenCalledWith(['notes.txt'], 'f-docs');
  });

  it("leaves a folder out of its own Move to… picker", () => {
    renderBrowser();
    fireEvent.contextMenu(within(list()).getByText('Documents'));
    fireEvent.click(screen.getByText('move_to'));
    const dialog = screen.getByRole('dialog', { name: 'move_to_title' });
    expect(within(dialog).queryByRole('treeitem', { name: /Documents/ })).toBeNull();
  });

  it("downloads a folder as a zip named after it", () => {
    const onDownloadZip = vi.fn(async () => {});
    renderBrowser({ props: { onDownloadZip } });
    fireEvent.contextMenu(within(list()).getByText('Documents'));
    fireEvent.click(screen.getByText('download_zip'));
    expect(onDownloadZip).toHaveBeenCalledWith(['f-docs'], 'Documents.zip');
  });

  it("adds Upload, New folder and Trash to the command palette, and focuses search with /", () => {
    renderBrowser();
    let groups: CommandGroup[] = [];
    function Probe() {
      groups = useRegisteredCommandGroups();
      return null;
    }
    render(<Probe />);
    const files = groups.find((g) => g.label === 'files');
    expect(files?.commands.map((c) => c.label)).toEqual(expect.arrayContaining(['files_upload_files', 'files_new_folder', 'trash']));

    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toHaveAttribute('role', 'searchbox');
  });

  it("lists a folder's actions in the same order in the list and in the tree", () => {
    renderBrowser({ props: { onDownloadZip: vi.fn(async () => {}), onMoveNode: vi.fn(async () => {}) } });
    const labels = () => within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => (i.textContent ?? '').replace(/(F2|Del|Ctrl\+[A-Z]|⌘[A-Z])$/, ''));
    fireEvent.contextMenu(within(list()).getByText('Documents'));
    const inList = labels();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.contextMenu(within(tree()).getByText('Documents'));
    const inTree = labels();
    const shared = inTree.filter((l) => inList.includes(l));
    expect(shared).toEqual(inList.filter((l) => inTree.includes(l)));
    expect(shared).toEqual(expect.arrayContaining(['open', 'star', 'rename', 'move_to', 'download_zip', 'delete']));
  });

  it("closes the details panel over a narrow list with Escape", async () => {
    renderBrowser({ props: { selectedResources: new Set(['notes.txt']) } });
    fireEvent.click(screen.getByRole('button', { name: 'details' }));
    expect(screen.getByRole('button', { name: 'details' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'details' })).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('FileBrowser keyboard focus (SR-15)', () => {
  beforeEach(() => {
    localStorage.clear();
    act(() => { useSettingsStore.setState({ filesSettings: DEFAULT_FILES_SETTINGS }); });
  });
  afterEach(() => {
    act(() => { useFileStore.setState({ client: null, sharedRoots: [], allFolders: [] }); });
  });

  const rowOf = (name: string) => within(list()).getByText(name).closest('[role="row"]') as HTMLElement;

  it('gives the list one tab stop, on the first item', () => {
    renderBrowser();
    expect(rowOf('Documents')).toHaveAttribute('tabindex', '0');
    expect(rowOf('notes.txt')).toHaveAttribute('tabindex', '-1');
  });

  it('moves real focus with the arrow keys, so screen readers follow', () => {
    renderBrowser();
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rowOf('Documents'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rowOf('notes.txt'));
    // The tab stop follows, so Tab out and back returns to the same item.
    expect(rowOf('notes.txt')).toHaveAttribute('tabindex', '0');
    expect(rowOf('Documents')).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(rowOf('Documents'));
  });

  it('nests the card view as grid, row group, row, cell', () => {
    act(() => { useSettingsStore.setState({ filesSettings: { ...DEFAULT_FILES_SETTINGS, defaultViewMode: 'grid' } }); });
    renderBrowser();
    const grid = list();
    expect(grid.querySelector('section')).toBeNull();
    const groups = within(grid).getAllByRole('rowgroup');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['folders', 'files_heading']);
    for (const group of groups) {
      expect(within(group).getByRole('row')).toBeInTheDocument();
    }
    const tile = within(grid).getByText('notes.txt').closest('[role="gridcell"]') as HTMLElement;
    expect(tile.parentElement).toHaveAttribute('role', 'row');
    fireEvent.keyDown(window, { key: 'End' });
    expect(document.activeElement).toBe(tile);
  });

  it('lists the sidebar folders as lists of buttons, not a tree without tree keys', async () => {
    renderBrowser();
    await screen.findAllByText('Team');
    const nav = tree();
    expect(within(nav).queryByRole('tree')).toBeNull();
    expect(within(nav).queryByRole('treeitem')).toBeNull();
    for (const list of within(nav).getAllByRole('list')) {
      for (const child of Array.from(list.children)) expect(child).toHaveAttribute('role', 'listitem');
    }
    // The folder open now is marked as the current page.
    expect(within(nav).getByRole('button', { name: 'my_files' })).toHaveAttribute('aria-current', 'page');
  });

  it('shows an item\'s select box while the keyboard is in the item, not only on hover', () => {
    renderBrowser();
    const box = within(rowOf('notes.txt')).getByRole('checkbox');
    expect(box.className).toContain('group-focus-within:opacity-100');
    expect(box.className).toContain('pointer-coarse:opacity-100');
  });
});
