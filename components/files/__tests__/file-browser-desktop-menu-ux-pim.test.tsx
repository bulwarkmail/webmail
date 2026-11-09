import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { FileBrowser } from '../file-browser';
import { useFileStore, type FileResource } from '@/stores/file-store';
import { resetDesktopCommands, runDesktopCommand } from '@/lib/desktop/commands';
import type { BulwarkDesktopBridge } from '@/lib/desktop/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// pim-15: the desktop app's Edit > Search files.

vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/settings/share-collection-dialog', () => ({ ShareCollectionDialog: () => null }));

const NOTES = {
  id: 'f-notes', name: 'notes.txt', serverName: 'notes.txt', isDirectory: false, contentType: 'text/plain',
  contentLength: 10, lastModified: '2026-10-01T00:00:00Z', blobId: 'b-notes', parentId: null,
} as FileResource;

function renderBrowser() {
  const client = { listAllFileNodesAcrossAccounts: vi.fn(async () => []) } as unknown as IJMAPClient;
  act(() => {
    useFileStore.setState({ client, sharedRoots: [], allFolders: [], currentParentId: null, pathStack: [{ id: null, name: '' }], hasListed: true });
  });
  const noop = vi.fn(async () => {});
  render(
    <FileBrowser
      currentPath="/"
      resources={[NOTES]}
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

afterEach(() => {
  cleanup();
  window.bulwarkDesktop = undefined;
  resetDesktopCommands();
});

describe('Files in the desktop menus', () => {
  it('Edit > Search files is on offer and puts the cursor in the files search', async () => {
    const setState = vi.fn();
    window.bulwarkDesktop = { version: 1, platform: 'win32', menu: { setState, onCommand: () => () => {} } } as unknown as BulwarkDesktopBridge;
    renderBrowser();
    await waitFor(() => expect(setState).toHaveBeenCalled());
    expect(setState.mock.lastCall![0]).toMatchObject({ 'edit.search': true });
    let ran = false;
    act(() => { ran = runDesktopCommand('edit.search'); });
    expect(ran).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'search_placeholder' }));
  });

  // pim-p3-18: File > New folder… and Upload files… in Files.
  it('File > New folder… and Upload files… are on offer and do what the toolbar does', async () => {
    const setState = vi.fn();
    window.bulwarkDesktop = { version: 1, platform: 'win32', menu: { setState, onCommand: () => () => {} } } as unknown as BulwarkDesktopBridge;
    renderBrowser();
    await waitFor(() => expect(setState).toHaveBeenCalled());
    expect(setState.mock.lastCall![0]).toMatchObject({ 'file.newFolder': true, 'file.uploadFiles': true });

    const input = document.querySelector('input[type="file"]:not([webkitdirectory])') as HTMLInputElement;
    const picked = vi.spyOn(input, 'click').mockImplementation(() => {});
    let ran = false;
    act(() => { ran = runDesktopCommand('file.uploadFiles'); });
    expect(ran).toBe(true);
    expect(picked).toHaveBeenCalled();

    act(() => { ran = runDesktopCommand('file.newFolder'); });
    expect(ran).toBe(true);
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});
