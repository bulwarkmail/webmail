import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FileGridView, FileListView, type FileItemHandlers } from '../file-views';
import { FileBrowser } from '../file-browser';
import { FilePreviewModal } from '../file-preview-modal';
import { BACKDROP_GRACE_MS } from '../preview-shell';
import { useFileStore, type FileResource } from '@/stores/file-store';
import { useSettingsStore } from '@/stores/settings-store';
import { DEFAULT_FILES_SETTINGS } from '@/lib/files-settings';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// pim-3: a double-click opens a file and the preview stays open; the name is
// plain text in both views (a click selects). pim-16: a file with no preview
// and no editor opens a pane with Download instead of downloading at once.

vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/settings/share-collection-dialog', () => ({ ShareCollectionDialog: () => null }));
vi.mock('@/lib/standalone-display', () => ({ canOpenUrlInNewWindow: () => false }));

const res = (id: string, name: string, extra: Partial<FileResource> = {}): FileResource => ({
  id, name, serverName: name, isDirectory: false, contentType: 'text/plain', contentLength: 10,
  lastModified: '2026-10-01T00:00:00Z', blobId: `b-${id}`, parentId: null, ...extra,
} as FileResource);
const notes = res('n', 'notes.txt');
const budget = res('x', 'budget.xlsx', { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
const docs = res('d', 'Documents', { isDirectory: true, contentType: '', blobId: null });

type Spy = ReturnType<typeof vi.fn>;
function handlers(): FileItemHandlers & { onOpen: Spy; onSelectClick: Spy } {
  return {
    onSelectClick: vi.fn(),
    onToggleSelect: vi.fn(),
    onOpen: vi.fn(),
    onContextMenu: vi.fn(),
    onDownload: vi.fn(),
    onShare: vi.fn(),
    canShare: () => false,
    dragProps: () => ({}),
    onFocusItem: vi.fn(),
  } as never;
}

const viewProps = (h: FileItemHandlers) => ({
  resources: [docs, notes],
  selected: new Set<string>(),
  focusedName: null,
  tabStopName: null,
  dropTarget: null,
  cutNames: new Set<string>(),
  starredPaths: new Set<string>(),
  pathOf: (r: FileResource) => `/${r.name}`,
  touch: false,
  iconOptions: { showIcons: true, coloredIcons: true, showThumbnails: false },
  getImageUrl: async () => '',
  handlers: h,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a click on a name selects, a double-click opens (pim-3)', () => {
  it('in the list', () => {
    const h = handlers();
    render(<FileListView {...viewProps(h)} sortKey="name" sortDir="asc" onSort={vi.fn()} allSelected={false} someSelected={false} onToggleAll={vi.fn()} />);
    for (const name of ['notes.txt', 'Documents']) {
      const row = screen.getByTitle(name).closest('[role="row"]')!;
      expect(within(row as HTMLElement).queryByRole('button', { name })).toBeNull();
      fireEvent.click(screen.getByTitle(name));
      expect(h.onOpen).not.toHaveBeenCalled();
      expect(h.onSelectClick).toHaveBeenLastCalledWith(expect.objectContaining({ name }), expect.anything());
      fireEvent.doubleClick(screen.getByTitle(name));
      expect(h.onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ name }));
      h.onOpen.mockClear();
    }
  });

  it('in the grid', () => {
    const h = handlers();
    render(<FileGridView {...viewProps(h)} />);
    for (const name of ['notes.txt', 'Documents']) {
      fireEvent.click(screen.getByTitle(name));
      expect(h.onOpen).not.toHaveBeenCalled();
      expect(h.onSelectClick).toHaveBeenLastCalledWith(expect.objectContaining({ name }), expect.anything());
      fireEvent.doubleClick(screen.getByTitle(name));
      expect(h.onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ name }));
      h.onOpen.mockClear();
    }
  });

  it('on touch a tap on the name still opens', () => {
    const h = handlers();
    render(<FileListView {...viewProps(h)} touch sortKey="name" sortDir="asc" onSort={vi.fn()} allSelected={false} someSelected={false} onToggleAll={vi.fn()} />);
    fireEvent.click(screen.getByTitle('notes.txt'));
    expect(h.onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: 'notes.txt' }));
  });
});

describe('the preview stays open after the click that opened it (pim-3)', () => {
  it('ignores a backdrop click in the first 400 ms', () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const onClose = vi.fn();
    render(<FilePreviewModal name="notes.txt" onClose={onClose} onDownload={vi.fn()} getFileContent={() => new Promise(() => {})} />);
    const backdrop = screen.getByRole('dialog');
    now += BACKDROP_GRACE_MS - 50;
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    now += 100;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

function renderBrowser(props: Partial<React.ComponentProps<typeof FileBrowser>> = {}) {
  const client = { listAllFileNodesAcrossAccounts: vi.fn(async () => []) } as unknown as IJMAPClient;
  act(() => {
    useFileStore.setState({ client, sharedRoots: [], allFolders: [docs], currentParentId: null, pathStack: [{ id: null, name: '' }], hasListed: true });
  });
  const h = {
    onPreviewFile: vi.fn(),
    onPreviewImage: vi.fn(),
    onDownload: vi.fn(async () => {}),
    onShowFileInfo: vi.fn(),
    onSetSelection: vi.fn(),
  };
  const noop = vi.fn(async () => {});
  render(
    <FileBrowser
      currentPath="/"
      resources={[docs, notes, budget]}
      isLoading={false}
      error={null}
      selectedResources={new Set()}
      uploadProgress={null}
      clipboard={null}
      onNavigate={vi.fn()}
      onToggleSelect={vi.fn()}
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
      onCreateFile={noop}
      onDuplicate={noop}
      getImageUrl={async () => ''}
      favorites={[]}
      recentFiles={[]}
      onToggleFavorite={vi.fn()}
      onOpenRecent={vi.fn()}
      onRenameNode={noop}
      onDeleteNode={noop}
      onDownloadNode={noop}
      onRevealNode={noop}
      onRemoveRecent={vi.fn()}
      client={client}
      ownAccountId="a"
      {...h}
      {...props}
    />,
  );
  return h;
}

describe('a file with no preview and no editor (pim-16)', () => {
  beforeEach(() => {
    localStorage.clear();
    act(() => { useSettingsStore.setState({ filesSettings: DEFAULT_FILES_SETTINGS }); });
  });

  it('opens the pane instead of downloading', () => {
    const h = renderBrowser();
    fireEvent.doubleClick(screen.getByTitle('budget.xlsx'));
    expect(h.onShowFileInfo).toHaveBeenCalledWith('budget.xlsx');
    expect(h.onDownload).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByTitle('notes.txt'));
    expect(h.onPreviewFile).toHaveBeenCalledWith('notes.txt');
  });

  it('has Open in its menu, and in the desktop app Open in default app', () => {
    const onOpenInApp = vi.fn();
    const h = renderBrowser({ canOpenInApp: (r) => r.name === 'budget.xlsx', onOpenInApp });
    fireEvent.contextMenu(screen.getByTitle('budget.xlsx'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'open' }));
    expect(h.onShowFileInfo).toHaveBeenCalledWith('budget.xlsx');
    fireEvent.contextMenu(screen.getByTitle('budget.xlsx'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'open_in_app' }));
    expect(onOpenInApp).toHaveBeenCalledWith(expect.objectContaining({ name: 'budget.xlsx' }));
    // A text file previews: no extra Open there.
    fireEvent.contextMenu(screen.getByTitle('notes.txt'));
    expect(screen.queryByRole('menuitem', { name: 'open' })).toBeNull();
  });

  it('Enter opens the row Tab put the focus on', () => {
    const h = renderBrowser();
    const row = document.querySelector<HTMLElement>('[data-resource="budget.xlsx"]')!;
    fireEvent.focus(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(h.onShowFileInfo).toHaveBeenCalledWith('budget.xlsx');
  });
});
