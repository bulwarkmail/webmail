import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { FileBrowser } from '../file-browser';
import { FileDetailsPanel } from '../file-details-panel';
import { FilePreviewModal } from '../file-preview-modal';
import { ImagePreviewModal } from '../image-preview-modal';
import { useFileStore, type FileResource } from '@/stores/file-store';
import { resetActions, setActionDispatcher, setPluginActions } from '@/lib/plugin-sandbox/actions';
import { clearSlotOffers, framePropsOf, offerSlots } from '@/components/plugins/__tests__/fake-slot-offer';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { FileResourceView } from '@/lib/plugin-types';

// Plugin surfaces in Files: entries in an item's menu and buttons in the
// selection toolbar (file-actions), and a section in the previews and the
// details panel (file-preview-section).

vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/settings/share-collection-dialog', () => ({ ShareCollectionDialog: () => null }));
vi.mock('@/components/plugins/plugin-iframe-slot', () => import('@/components/plugins/__tests__/fake-slot-offer'));
const device = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@/hooks/use-media-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-media-query')>()),
  useIsMobile: () => device.isMobile,
}));

const folder = {
  id: 'f-docs', name: 'Documents', serverName: 'Documents', isDirectory: true, contentType: '', contentLength: 0,
  lastModified: '2026-10-01T00:00:00Z', blobId: null, parentId: null,
} as FileResource;
const notes = {
  id: 'f-notes', name: 'notes.txt', serverName: 'notes.txt', isDirectory: false, contentType: 'text/plain', contentLength: 10,
  lastModified: '2026-10-01T00:00:00Z', blobId: 'b-notes', parentId: null,
} as FileResource;
const photo = {
  id: 'f-photo', name: 'photo.png', serverName: 'photo.png', isDirectory: false, contentType: 'image/png', contentLength: 99,
  lastModified: '2026-10-02T00:00:00Z', blobId: 'b-photo', parentId: null,
} as FileResource;

const notesView: FileResourceView = {
  id: 'f-notes', name: 'notes.txt', type: 'file', size: 10, mimeType: 'text/plain', path: '/', modified: '2026-10-01T00:00:00Z',
};

function renderBrowser(selected: string[] = []) {
  const client = { listAllFileNodesAcrossAccounts: vi.fn(async () => []) } as unknown as IJMAPClient;
  act(() => {
    useFileStore.setState({
      client, sharedRoots: [], allFolders: [folder], currentParentId: null, pathStack: [{ id: null, name: '' }], hasListed: true,
    });
  });
  const noop = vi.fn(async () => {});
  render(
    <FileBrowser
      currentPath="/"
      resources={[folder, notes, photo]}
      isLoading={false}
      error={null}
      selectedResources={new Set(selected)}
      uploadProgress={null}
      clipboard={null}
      onNavigate={vi.fn()}
      onSetSelection={vi.fn()}
      onToggleSelect={vi.fn()}
      onPreviewFile={vi.fn()}
      onDownload={noop}
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
      onRenameNode={noop}
      onDeleteNode={noop}
      onDownloadNode={noop}
      onRevealNode={noop}
      onRemoveRecent={vi.fn()}
      client={client}
      ownAccountId="a"
    />,
  );
}

function rowOf(name: string): HTMLElement {
  return within(screen.getByRole('grid', { name: 'file_list' })).getByText(name).closest('[role=row]') as HTMLElement;
}

const dispatch = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  device.isMobile = false;
  localStorage.clear();
  dispatch.mockClear();
  setActionDispatcher(dispatch);
});

afterEach(() => {
  cleanup();
  clearSlotOffers();
  resetActions();
  setActionDispatcher(null);
  act(() => { useFileStore.setState({ client: null, sharedRoots: [], allFolders: [] }); });
});

describe('file-actions', () => {
  it('adds entries to an item menu, filtered by its type, and sends the item', async () => {
    act(() => setPluginActions('ocr', 'OCR', 'file-actions', [
      { id: 'read-text', label: 'Read text', mimeTypes: ['text/'] },
      { id: 'edit-image', label: 'Edit image', mimeTypes: ['image/'] },
      { id: 'archive', label: 'Archive' },
    ]));
    renderBrowser();

    fireEvent.contextMenu(rowOf('notes.txt'));
    expect(await screen.findByRole('menuitem', { name: 'Read text' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Edit image' })).toBeNull();
    // After the app's own entries.
    const items = screen.getAllByRole('menuitem').map((el) => el.textContent);
    expect(items.indexOf('Archive')).toBeGreaterThan(items.findIndex((text) => text?.includes('delete')));

    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Read text' })); });
    expect(dispatch).toHaveBeenCalledWith('ocr', 'file-actions', 'read-text', { files: [notesView] });
  });

  it('keeps type-specific entries off folders', async () => {
    act(() => setPluginActions('ocr', 'OCR', 'file-actions', [
      { id: 'read-text', label: 'Read text', mimeTypes: ['text/'] },
      { id: 'archive', label: 'Archive' },
    ]));
    renderBrowser();

    fireEvent.contextMenu(rowOf('Documents'));
    expect(await screen.findByRole('menuitem', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Read text' })).toBeNull();
  });

  it('adds buttons to the selection toolbar with the selected items', async () => {
    act(() => setPluginActions('ocr', 'OCR', 'file-actions', [
      { id: 'archive', label: 'Archive' },
      { id: 'read-text', label: 'Read text', mimeTypes: ['text/'] },
    ]));
    renderBrowser(['notes.txt', 'photo.png']);

    const toolbar = screen.getByRole('toolbar', { name: 'selection_actions' });
    const button = within(toolbar).getByRole('button', { name: 'Archive' });
    // Several items: no type filter applies, so every entry shows.
    expect(within(toolbar).getByRole('button', { name: 'Read text' })).toBeInTheDocument();

    await act(async () => { fireEvent.click(button); });
    const context = dispatch.mock.calls[0][3] as { files: FileResourceView[] };
    expect(context.files.map((f) => f.id)).toEqual(['f-notes', 'f-photo']);
  });

  it('puts them behind one more button in the phone selection toolbar', async () => {
    device.isMobile = true;
    act(() => setPluginActions('ocr', 'OCR', 'file-actions', [
      { id: 'archive', label: 'Archive' },
      { id: 'read-text', label: 'Read text', mimeTypes: ['text/'] },
    ]));
    renderBrowser(['notes.txt']);

    const toolbar = screen.getByRole('toolbar', { name: 'selection_actions' });
    expect(within(toolbar).queryByRole('button', { name: 'Archive' })).toBeNull();
    const more = within(toolbar).getByRole('button', { name: 'more_actions' });
    // Not in the row that scrolls sideways, where it could end up out of sight.
    expect(more.closest('.overflow-x-auto')).toBeNull();
    fireEvent.click(more);
    expect(await screen.findByRole('menuitem', { name: 'Read text' })).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' })); });
    const context = dispatch.mock.calls[0][3] as { files: FileResourceView[] };
    expect(context.files.map((f) => f.id)).toEqual(['f-notes']);
  });

  it('filters the toolbar by the type of a single selected file', () => {
    act(() => setPluginActions('ocr', 'OCR', 'file-actions', [{ id: 'read-text', label: 'Read text', mimeTypes: ['text/'] }]));
    renderBrowser(['photo.png']);

    const toolbar = screen.getByRole('toolbar', { name: 'selection_actions' });
    expect(within(toolbar).queryByRole('button', { name: 'Read text' })).toBeNull();
  });

  it('adds nothing without a plugin', async () => {
    renderBrowser(['notes.txt']);
    expect(document.querySelector('[data-plugin-actions]')).toBeNull();
    fireEvent.contextMenu(rowOf('notes.txt'));
    await screen.findAllByRole('menuitem');
    expect(screen.queryByRole('menuitem', { name: 'Archive' })).toBeNull();
  });
});

describe('file-preview-section', () => {
  const panelProps = {
    resource: notes,
    selection: [notes],
    folderName: 'Files',
    folderItems: [notes],
    path: '/notes.txt',
    isStarred: false,
    canShare: false,
    canPreview: true,
    canEdit: false,
    iconOptions: { showIcons: true, coloredIcons: true, showThumbnails: false },
    getImageUrl: async () => '',
    onClose: vi.fn(),
    onOpen: vi.fn(),
    onEdit: vi.fn(),
    onDownload: vi.fn(),
    onShare: vi.fn(),
    onToggleStar: vi.fn(),
  } as unknown as React.ComponentProps<typeof FileDetailsPanel>;

  it('gives the details panel the same header height as the other side panels', () => {
    render(<FileDetailsPanel {...panelProps} pluginFile={notesView} />);
    const header = document.querySelector('[data-details-header]') as HTMLElement;
    expect(header.className).toContain('h-14');
    expect(header.className).toContain('box-content');
    expect(header.className).not.toContain('h-11');
  });

  it('shows the selected file in the details panel', () => {
    offerSlots('p1', ['file-preview-section']);
    render(<FileDetailsPanel {...panelProps} pluginFile={notesView} />);
    expect(framePropsOf(screen.getByTestId('plugin-frame-file-preview-section')).file).toEqual(notesView);
  });

  it('passes the selection from the browser to the details panel', () => {
    offerSlots('p1', ['file-preview-section']);
    localStorage.setItem('files-show-details', '1');
    renderBrowser(['notes.txt']);
    expect(framePropsOf(screen.getByTestId('plugin-frame-file-preview-section')).file).toEqual(notesView);
  });

  it('shows the previewed file under the text preview', async () => {
    offerSlots('p1', ['file-preview-section']);
    render(
      <FilePreviewModal
        name="notes.txt"
        file={notesView}
        onClose={vi.fn()}
        onDownload={vi.fn()}
        getFileContent={async () => ({ blob: new Blob(['hi'], { type: 'text/plain' }), contentType: 'text/plain' })}
      />,
    );
    expect(framePropsOf(await screen.findByTestId('plugin-frame-file-preview-section')).file).toEqual(notesView);
  });

  it('keeps clicks on the section from closing the image preview', () => {
    offerSlots('p1', ['file-preview-section']);
    const onClose = vi.fn();
    render(<ImagePreviewModal name="photo.png" file={{ ...notesView, id: 'f-photo' }} onClose={onClose} onDownload={async () => {}} getImageUrl={async () => ''} />);

    const frame = screen.getByTestId('plugin-frame-file-preview-section');
    expect(framePropsOf(frame).file).toMatchObject({ id: 'f-photo' });
    fireEvent.click(frame);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders nothing without a plugin or a file', () => {
    render(<FileDetailsPanel {...panelProps} pluginFile={notesView} />);
    expect(document.querySelector('[data-plugin-slot]')).toBeNull();
    cleanup();

    offerSlots('p1', ['file-preview-section']);
    render(<ImagePreviewModal name="photo.png" onClose={vi.fn()} onDownload={async () => {}} getImageUrl={async () => ''} />);
    expect(document.querySelector('[data-plugin-slot]')).toBeNull();
  });
});
