import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UploadConflictDialog } from '../upload-conflict-dialog';
import { FileNoPreview } from '../file-no-preview';
import { EmptyFolder } from '../file-empty-state';
import { FileBrowser } from '../file-browser';
import { sharedNodeLink } from '../share-message';
import { useFileStore, type FileResource } from '@/stores/file-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
// The share dialog itself isn't ours: a stand-in that adds and changes a share.
vi.mock('@/components/settings/share-collection-dialog', () => ({
  ShareCollectionDialog: ({ onShare }: { onShare: (principalId: string, rights: unknown) => Promise<void> }) => (
    <div>
      <button type="button" onClick={() => void onShare('p-new', { mayRead: true })}>add new</button>
      <button type="button" onClick={() => void onShare('p-old', { mayRead: true, mayWrite: true })}>change old</button>
      <button type="button" onClick={() => void onShare('p-new', null)}>remove</button>
    </div>
  ),
}));

afterEach(cleanup);

describe('the upload conflict question (pim-10)', () => {
  const conflict = { name: 'report.txt', kind: 'file' as const };

  it('offers Replace, Keep both, Skip and Cancel, and "for all" only with more conflicts left', () => {
    const answer = vi.fn();
    const { rerender } = render(<UploadConflictDialog question={{ conflict, remaining: 1, answer }} />);
    expect(screen.getByRole('alertdialog', { name: 'conflict_title' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'keep_both' }));
    expect(answer).toHaveBeenLastCalledWith({ choice: 'keep', applyToAll: false });

    rerender(<UploadConflictDialog question={{ conflict, remaining: 3, answer }} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'apply_to_all' }));
    fireEvent.click(screen.getByRole('button', { name: 'replace' }));
    expect(answer).toHaveBeenLastCalledWith({ choice: 'replace', applyToAll: true });
    fireEvent.click(screen.getByRole('button', { name: 'skip' }));
    expect(answer).toHaveBeenLastCalledWith({ choice: 'skip', applyToAll: true });
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(answer).toHaveBeenLastCalledWith(null);
  });

  it('explains Replace for a folder as a merge', () => {
    render(<UploadConflictDialog question={{ conflict: { name: 'Docs', kind: 'folder' }, remaining: 1, answer: vi.fn() }} />);
    expect(screen.getByText('conflict_folder_hint')).toBeInTheDocument();
  });
});

describe('the pane for a file with no preview (pim-16)', () => {
  const budget = {
    id: 'x', name: 'budget-2026.xlsx', serverName: 'budget-2026.xlsx', isDirectory: false, contentType: 'application/octet-stream',
    contentLength: 1600, lastModified: '', blobId: 'b', parentId: null,
  } as FileResource;

  it('shows the name, size and Download, and Open in default app only when the desktop app can', () => {
    const onDownload = vi.fn();
    const onOpenInApp = vi.fn();
    const { rerender } = render(<FileNoPreview resource={budget} onClose={vi.fn()} onDownload={onDownload} />);
    const pane = screen.getByTestId('file-no-preview');
    expect(pane).toHaveTextContent('budget-2026.xlsx');
    expect(pane).toHaveTextContent('1.6 KB');
    expect(screen.queryByRole('button', { name: 'open_in_app' })).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'download' }).at(-1)!);
    expect(onDownload).toHaveBeenCalled();

    rerender(<FileNoPreview resource={budget} onClose={vi.fn()} onDownload={onDownload} onOpenInApp={onOpenInApp} />);
    fireEvent.click(screen.getByRole('button', { name: 'open_in_app' }));
    expect(onOpenInApp).toHaveBeenCalled();
  });
});

describe('"Upload files…" ends in "…" (pim-26)', () => {
  it('in an empty folder too', () => {
    render(<EmptyFolder isRoot canCreate onUpload={vi.fn()} onCreateFolder={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'files_upload_files' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'files_new_folder' })).toBeInTheDocument();
  });
});

describe('after sharing with someone new (pim-26)', () => {
  it('reports who was added, not a change or a removal', async () => {
    const report = {
      id: 'r1', name: 'report.pdf', serverName: 'report.pdf', isDirectory: false, contentType: 'application/pdf', contentLength: 5,
      lastModified: '', blobId: 'b', parentId: null, shareWith: { 'p-old': { mayRead: true } },
    } as unknown as FileResource;
    const client = { listAllFileNodesAcrossAccounts: vi.fn(async () => []) } as unknown as IJMAPClient;
    act(() => {
      useFileStore.setState({ client, sharedRoots: [], allFolders: [], currentParentId: null, pathStack: [{ id: null, name: '' }], hasListed: true });
    });
    const onShare = vi.fn(async () => {});
    const onShared = vi.fn();
    const noop = vi.fn(async () => {});
    render(
      <FileBrowser
        currentPath="/" resources={[report]} isLoading={false} error={null} selectedResources={new Set()} uploadProgress={null} clipboard={null}
        onNavigate={vi.fn()} onSetSelection={vi.fn()} onToggleSelect={vi.fn()} onPreviewFile={vi.fn()} onPreviewImage={vi.fn()} onDownload={noop}
        onCreateFolder={noop} onUploadFiles={noop} onUploadFolder={noop} onCancelUpload={vi.fn()} onDelete={noop} onBatchDelete={noop}
        onRename={noop} onBatchDownload={noop} onRefresh={noop} onClearSelection={vi.fn()} onCut={vi.fn()} onCopy={vi.fn()} onPaste={noop}
        onMoveTo={noop} onCreateFile={noop} onDuplicate={noop} getImageUrl={async () => ''} favorites={[]} recentFiles={[]}
        onToggleFavorite={vi.fn()} onOpenRecent={vi.fn()} onRenameNode={noop} onDeleteNode={noop} onDownloadNode={noop} onRevealNode={noop}
        onRemoveRecent={vi.fn()} client={client} ownAccountId="a" sharingEnabled onShare={onShare} onShared={onShared}
      />,
    );
    fireEvent.contextMenu(screen.getByTitle('report.pdf'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'files_share' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'change old' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'remove' })); });
    expect(onShared).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'add new' })); });
    expect(onShare).toHaveBeenLastCalledWith('r1', 'p-new', { mayRead: true });
    expect(onShared).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }), 'p-new');
  });

  it('links the person to the node as it is listed for them, a file with its preview', () => {
    expect(sharedNodeLink('https://mail.example', 'acc1', { id: 'n7', name: 'report.pdf', isDirectory: false }))
      .toBe('https://mail.example/files?shared=acc1%3An7&preview=report.pdf');
    expect(sharedNodeLink('https://mail.example', 'acc1', { id: 'd2', name: 'Team', isDirectory: true }))
      .toBe('https://mail.example/files?shared=acc1%3Ad2');
  });
});
