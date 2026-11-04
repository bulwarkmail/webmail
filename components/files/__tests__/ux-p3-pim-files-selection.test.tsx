import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FileBrowser } from '../file-browser';
import { FilesHeader, type Crumb } from '../files-header';
import { useFileStore, type FileResource } from '@/stores/file-store';
import { useSettingsStore } from '@/stores/settings-store';
import { DEFAULT_FILES_SETTINGS } from '@/lib/files-settings';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// pim-p3-11: a ticked file turned the toolbar into the selection bar without
// the folder path or the folder button, and opening a file left it ticked.

vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/settings/share-collection-dialog', () => ({ ShareCollectionDialog: () => null }));
vi.mock('@/lib/standalone-display', () => ({ canOpenUrlInNewWindow: () => false }));

const notes = {
  id: 'n', name: 'notes.txt', serverName: 'notes.txt', isDirectory: false, contentType: 'text/plain', contentLength: 10,
  lastModified: '2026-10-01T00:00:00Z', blobId: 'b-n', parentId: null,
} as FileResource;

function renderBrowser() {
  const client = { listAllFileNodesAcrossAccounts: vi.fn(async () => []) } as unknown as IJMAPClient;
  act(() => {
    useFileStore.setState({ client, sharedRoots: [], allFolders: [], currentParentId: null, pathStack: [{ id: null, name: '' }], hasListed: true });
  });
  const h = { onPreviewFile: vi.fn(), onSetSelection: vi.fn() };
  const noop = vi.fn(async () => {});
  render(
    <FileBrowser
      currentPath="/" resources={[notes]} isLoading={false} error={null} selectedResources={new Set()} uploadProgress={null}
      clipboard={null} onNavigate={vi.fn()} onToggleSelect={vi.fn()} onCreateFolder={noop} onUploadFolder={noop}
      onCancelUpload={vi.fn()} onDelete={noop} onBatchDelete={noop} onRename={noop} onBatchDownload={noop} onRefresh={noop}
      onClearSelection={vi.fn()} onCut={vi.fn()} onCopy={vi.fn()} onPaste={noop} onMoveTo={noop} onCreateFile={noop}
      onDuplicate={noop} getImageUrl={async () => ''} favorites={[]} recentFiles={[]} onToggleFavorite={vi.fn()}
      onOpenRecent={vi.fn()} onRenameNode={noop} onDeleteNode={noop} onDownloadNode={noop} onRevealNode={noop}
      onRemoveRecent={vi.fn()} client={client} ownAccountId="a" onPreviewImage={vi.fn()} onDownload={noop}
      onShowFileInfo={vi.fn()} onUploadFiles={noop} {...h}
    />,
  );
  return h;
}

beforeEach(() => {
  localStorage.clear();
  act(() => { useSettingsStore.setState({ filesSettings: DEFAULT_FILES_SETTINGS }); });
});
afterEach(() => cleanup());

describe('Files selection (pim-p3-11)', () => {
  it('opens a file on double-click without leaving it ticked', () => {
    const h = renderBrowser();
    fireEvent.doubleClick(screen.getAllByText('notes.txt')[0]);
    expect(h.onPreviewFile).toHaveBeenCalledWith('notes.txt');
    expect(h.onSetSelection).toHaveBeenLastCalledWith(new Set());
  });

  it('keeps the folder button and the folder you are in on the selection bar, before the actions', () => {
    const crumbs: Crumb[] = [
      { id: null, name: 'my_files', path: '/' },
      { id: 'd', name: 'Documents', path: '/Documents' },
      { id: 'r', name: 'Reports', path: '/Documents/Reports' },
    ];
    const onNavigateCrumb = vi.fn();
    const onMenuClick = vi.fn();
    const noop = vi.fn();
    render(
      <FilesHeader
        crumbs={crumbs} onNavigateCrumb={onNavigateCrumb} onDropOnCrumb={noop} onMenuClick={onMenuClick}
        searchQuery="" onSearchChange={noop} searchInputRef={{ current: null }} sortKey="name" sortDir="asc"
        onSortChange={noop} viewMode="list" onViewModeChange={noop} showDetails={false} onToggleDetails={noop}
        clipboardCount={0} onPaste={noop} onRefresh={noop} isLoading={false} compact={false}
        selection={{
          count: 1, fileCount: 1, canOpen: true, canRename: true, canShare: false, onOpen: noop, onDownload: noop,
          onShare: noop, onRename: noop, onCut: noop, onCopy: noop, onDelete: noop, onClear: noop, pluginFiles: [],
        }}
      />,
    );
    const bar = screen.getByRole('toolbar', { name: 'selection_actions' });
    const buttons = within(bar).getAllByRole('button');
    // The folder button first, then the path, then the selection's own buttons.
    expect(buttons[0]).toHaveAccessibleName('open_folder_tree');
    fireEvent.click(buttons[0]);
    expect(onMenuClick).toHaveBeenCalled();
    const path = within(bar).getByRole('navigation', { name: 'breadcrumbs' });
    expect(within(path).getByText('Reports')).toHaveAttribute('aria-current', 'page');
    fireEvent.click(within(path).getByRole('button', { name: 'show_path' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Documents' }));
    expect(onNavigateCrumb).toHaveBeenCalledWith(crumbs[1]);
    const clear = within(bar).getByRole('button', { name: 'clear_selection' });
    expect(path.compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
