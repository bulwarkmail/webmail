import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileBrowser } from '@/components/files/file-browser';
import { FileDetailsPanel } from '@/components/files/file-details-panel';
import { useFileStore, type FileResource } from '@/stores/file-store';
import { useFilesSyncStore } from '@/stores/files-sync-store';
import type { BulwarkDesktopBridge } from '@/lib/desktop/types';
import type { FilesSyncController, FilesSyncItemStatus } from '@/lib/files-sync/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Files on this computer on the Files screen: "Show in Explorer" (Finder, file
// manager) for what a root covers, and the sync status on rows and in the
// details panel. The next-intl mock returns keys.

vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/settings/share-collection-dialog', () => ({ ShareCollectionDialog: () => null }));

const NOTES = {
  id: 'f-notes', name: 'notes.txt', serverName: 'notes.txt', isDirectory: false, contentType: 'text/plain',
  contentLength: 10, lastModified: '2026-10-01T00:00:00Z', blobId: 'b-notes', parentId: null,
} as FileResource;
const PLANS = {
  id: 'd-plans', name: 'Plans', serverName: 'Plans', isDirectory: true, contentType: '',
  contentLength: 0, lastModified: '2026-10-01T00:00:00Z', blobId: null, parentId: null,
} as unknown as FileResource;

function controller(covered: string[]) {
  return {
    coverage: vi.fn((id: string) => (covered.includes(id) ? { rootId: 'r1', kind: 'folder' as const, path: id } : null)),
    showInFolder: vi.fn(async () => true),
  } as unknown as FilesSyncController & { coverage: ReturnType<typeof vi.fn>; showInFolder: ReturnType<typeof vi.fn> };
}

function setPlatform(platform: 'win32' | 'darwin' | 'linux') {
  window.bulwarkDesktop = { version: 1, platform } as unknown as BulwarkDesktopBridge;
}

function renderBrowser(resources: FileResource[] = [NOTES, PLANS]) {
  const client = { listAllFileNodesAcrossAccounts: vi.fn(async () => []) } as unknown as IJMAPClient;
  act(() => {
    useFileStore.setState({ client, sharedRoots: [], allFolders: [], currentParentId: null, pathStack: [{ id: null, name: '' }], hasListed: true });
  });
  const noop = vi.fn(async () => {});
  render(
    <FileBrowser
      currentPath="/"
      resources={resources}
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
      onNavigate={vi.fn()}
      onSetSelection={vi.fn()}
      onToggleSelect={vi.fn()}
      onPreviewFile={vi.fn()}
      onDownload={noop}
      onRenameNode={noop}
      onDeleteNode={noop}
      onDownloadNode={noop}
      onRevealNode={noop}
      onRemoveRecent={vi.fn()}
    />,
  );
}

function moreButton(name: string) {
  return screen.getAllByRole('button', { name: 'more_actions' }).find((b) => b.closest('[data-resource]')?.getAttribute('data-resource') === name)!;
}

afterEach(() => {
  cleanup();
  window.bulwarkDesktop = undefined;
  useFilesSyncStore.getState().reset();
});

describe('Show in Explorer on the Files screen', () => {
  it('is in the row menu of a covered file and folder only, and opens it there', () => {
    setPlatform('win32');
    const c = controller(['f-notes', 'd-plans']);
    useFilesSyncStore.setState({ available: true, controller: c });
    renderBrowser();
    fireEvent.click(moreButton('notes.txt'));
    const item = within(screen.getByRole('menu')).getByRole('menuitem', { name: 'show_in.explorer' });
    fireEvent.click(item);
    expect(c.showInFolder).toHaveBeenCalledWith('f-notes');
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(moreButton('Plans'));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'show_in.explorer' }));
    expect(c.showInFolder).toHaveBeenLastCalledWith('d-plans');
  });

  it('is not offered for what no root covers, nor outside the app', () => {
    setPlatform('win32');
    useFilesSyncStore.setState({ available: true, controller: controller(['d-plans']) });
    renderBrowser();
    fireEvent.click(moreButton('notes.txt'));
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: 'show_in.explorer' })).toBeNull();
    cleanup();
    useFilesSyncStore.setState({ available: false, controller: controller(['f-notes']) });
    renderBrowser();
    fireEvent.click(moreButton('notes.txt'));
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: /show_in/ })).toBeNull();
  });

  it.each([
    ['darwin', 'show_in.finder'],
    ['linux', 'show_in.file_manager'],
  ] as const)('is named for the platform: %s', (platform, label) => {
    setPlatform(platform);
    useFilesSyncStore.setState({ available: true, controller: controller(['f-notes']) });
    renderBrowser([NOTES]);
    fireEvent.click(moreButton('notes.txt'));
    expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: label })).toBeInTheDocument();
  });
});

describe('sync status on the Files screen', () => {
  it.each<FilesSyncItemStatus>(['synced', 'syncing', 'pending', 'error', 'online-only'])('names a %s row', (state) => {
    useFilesSyncStore.setState({ available: true, controller: controller([]), items: { 'f-notes': state } });
    renderBrowser([NOTES, PLANS]);
    const row = document.querySelector('[data-resource="notes.txt"]') as HTMLElement;
    expect(within(row).getByRole('img', { name: `item.${state}` })).toBeInTheDocument();
    // Plans has no status: no badge.
    const plans = document.querySelector('[data-resource="Plans"]') as HTMLElement;
    expect(plans.querySelector('[data-files-sync-item]')).toBeNull();
  });

  it('shows nothing outside the app', () => {
    useFilesSyncStore.setState({ available: false, items: { 'f-notes': 'synced' } });
    renderBrowser([NOTES]);
    expect(document.querySelector('[data-files-sync-item]')).toBeNull();
  });
});

describe('details panel', () => {
  function renderPanel() {
    render(
      <FileDetailsPanel
        resource={NOTES}
        selection={[NOTES]}
        folderName="My files"
        folderItems={[NOTES]}
        path="/notes.txt"
        isStarred={false}
        canShare={false}
        canPreview={false}
        canEdit={false}
        iconOptions={{ showIcons: true, coloredIcons: true, showThumbnails: false }}
        getImageUrl={async () => ''}
        onClose={vi.fn()}
        onOpen={vi.fn()}
        onEdit={vi.fn()}
        onShare={vi.fn()}
        onToggleStar={vi.fn()}
      />,
    );
  }

  it('says the status and offers Show in Finder for a covered file', () => {
    setPlatform('darwin');
    const c = controller(['f-notes']);
    useFilesSyncStore.setState({ available: true, controller: c, items: { 'f-notes': 'pending' } });
    renderPanel();
    expect(screen.getByText('item.label')).toBeInTheDocument();
    expect(screen.getByText('item.pending')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'show_in.finder' }));
    expect(c.showInFolder).toHaveBeenCalledWith('f-notes');
  });

  it('has neither for a file no root covers', () => {
    setPlatform('win32');
    useFilesSyncStore.setState({ available: true, controller: controller([]) });
    renderPanel();
    expect(screen.queryByText('item.label')).toBeNull();
    expect(screen.queryByRole('button', { name: /show_in/ })).toBeNull();
  });
});

describe('the folder on screen in Explorer (files-p3-9)', () => {
  it('shows the drive at the top of Files, a covered folder inside it, and nothing elsewhere', async () => {
    const { renderHook } = await import('@testing-library/react');
    const { useShowFolderOnScreen } = await import('../files-sync-item');
    setPlatform('win32');
    const c = controller(['d-plans']);
    const openRoot = vi.fn(async () => true);
    useFilesSyncStore.setState({
      available: true,
      account: 'acc',
      controller: { ...c, openRoot } as unknown as FilesSyncController,
      roots: [{ id: 'drive1', kind: 'drive', account: 'acc', path: 'C:/drive', remoteId: null, remoteLabel: 'acc', paused: false, createdAt: 1 }],
    });
    const top = renderHook(() => useShowFolderOnScreen(null)).result.current!;
    expect(top.label).toBe('show_in.explorer');
    top.run();
    expect(openRoot).toHaveBeenCalledWith('drive1');
    renderHook(() => useShowFolderOnScreen('d-plans')).result.current!.run();
    expect(c.showInFolder).toHaveBeenCalledWith('d-plans');
    expect(renderHook(() => useShowFolderOnScreen('elsewhere')).result.current).toBeNull();
    useFilesSyncStore.setState({ roots: [] });
    expect(renderHook(() => useShowFolderOnScreen(null)).result.current).toBeNull();
    useFilesSyncStore.getState().reset();
    window.bulwarkDesktop = undefined;
  });
});
