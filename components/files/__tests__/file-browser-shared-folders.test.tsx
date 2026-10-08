import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { FileBrowser } from '../file-browser';
import { useFileStore, type FileResource } from '@/stores/file-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { FileNode } from '@/lib/jmap/types';

vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/settings/share-collection-dialog', () => ({
  ShareCollectionDialog: ({ collectionName, shareWith }: { collectionName: string; shareWith?: Record<string, unknown> | null }) => (
    <div data-testid="share-dialog">{collectionName}:{Object.keys(shareWith ?? {}).join(',')}</div>
  ),
}));

// Shared folders must be reachable, and own folders shareable, in both
// folder layouts (#1181).

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
    contentType: '',
    contentLength: n.size,
    lastModified: n.modified ?? '',
    blobId: n.blobId,
    parentId: n.parentId,
    shareWith: n.shareWith,
    isShared: n.isShared,
  } as FileResource;
}

const OWN: FileNode[] = [
  node('f-docs', 'Documents', null),
  node('f-notes', 'notes.txt', null, { blobId: 'b-notes', type: 'text/plain', size: 10 }),
];
const SHARED = node('e:f-team', 'Team', null, { isShared: true, accountId: 'e', accountName: 'userb@example.org' });

function setLayout(folderLayout: 'inline' | 'sidebar') {
  localStorage.setItem('files-settings', JSON.stringify({ folderLayout }));
}

function renderBrowser(opts: { resources?: FileResource[]; listByParentId?: (id: string | null) => Promise<FileResource[]> } = {}) {
  const client = {
    listAllFileNodesAcrossAccounts: vi.fn(async () => [...OWN, SHARED]),
  } as unknown as IJMAPClient;
  act(() => { useFileStore.setState({ client, sharedRoots: [] }); });
  const onNavigate = vi.fn();
  const noop = vi.fn(async () => {});
  const listByParentId = opts.listByParentId
    ?? vi.fn(async (parentId: string | null) => OWN.filter(n => n.parentId === parentId).map(resource));
  render(
    <FileBrowser
      currentPath="/"
      resources={opts.resources ?? OWN.map(resource)}
      isLoading={false}
      error={null}
      selectedResources={new Set()}
      uploadProgress={null}
      clipboard={null}
      onNavigate={onNavigate}
      onCreateFolder={noop}
      onUploadFiles={noop}
      onUploadFolder={noop}
      onCancelUpload={vi.fn()}
      onDelete={noop}
      onBatchDelete={noop}
      onRename={noop}
      onDownload={noop}
      onBatchDownload={noop}
      onRefresh={noop}
      onSelectResource={vi.fn()}
      onToggleSelect={vi.fn()}
      onSelectAll={vi.fn()}
      onClearSelection={vi.fn()}
      onSetSelection={vi.fn()}
      onCut={vi.fn()}
      onCopy={vi.fn()}
      onPaste={noop}
      onMoveToFolder={noop}
      onMoveToParent={noop}
      onPreviewImage={vi.fn()}
      onPreviewFile={vi.fn()}
      onShowDetails={vi.fn()}
      onCreateTextFile={noop}
      onDuplicate={noop}
      getImageUrl={async () => ''}
      listPath={async () => []}
      listByParentId={listByParentId}
      favorites={[]}
      recentFiles={[]}
      onToggleFavorite={vi.fn()}
      showDetails={false}
      onToggleDetails={vi.fn()}
      detailResource={null}
      client={client}
      ownAccountId="a"
      sharingEnabled
      onShare={noop}
    />,
  );
  return { onNavigate, listByParentId };
}

describe('FileBrowser shared folders (#1181)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    act(() => { useFileStore.setState({ client: null, sharedRoots: [] }); });
  });

  it('lists folders shared with the user at the root in the inline layout', async () => {
    setLayout('inline');
    const { onNavigate } = renderBrowser();
    const team = await screen.findByText('Team');
    expect(screen.getAllByText('shared_with_me').length).toBeGreaterThan(0);
    fireEvent.click(team);
    expect(onNavigate).toHaveBeenCalledWith('/Team', 'e:f-team');
  });

  it('shows shared folders instead of the upload area when the own root is empty', async () => {
    setLayout('inline');
    renderBrowser({ resources: [] });
    expect(await screen.findByText('Team')).toBeInTheDocument();
  });

  it('does not repeat shared folders in the list in the sidebar layout', async () => {
    setLayout('sidebar');
    renderBrowser();
    // The tree lists it once; the file list does not.
    expect(await screen.findAllByText('Team')).toHaveLength(1);
    expect(screen.queryByRole('table')?.textContent ?? '').not.toContain('Team');
  });

  it('shares an own folder from the tree in the sidebar layout', async () => {
    setLayout('sidebar');
    const shared = { ...OWN[0], shareWith: { p1: { mayRead: true } } } as unknown as FileNode;
    const listByParentId = vi.fn(async (parentId: string | null) =>
      parentId === null ? [resource(shared), resource(OWN[1])] : []);
    // Browsing another folder: the tree's folder is not in the listing.
    renderBrowser({ resources: [resource(OWN[1])], listByParentId });

    const folder = await screen.findByText('Documents');
    fireEvent.contextMenu(folder);
    fireEvent.click(await screen.findByText('share'));

    // The dialog reads the folder fresh, so it shows the current shares.
    expect(await screen.findByTestId('share-dialog')).toHaveTextContent('Documents:p1');
  });

  it('offers no share menu on folders shared with the user', async () => {
    setLayout('sidebar');
    renderBrowser();
    const tree = (await screen.findByText('Team')).closest('div')!;
    fireEvent.contextMenu(within(tree).getByText('Team'));
    expect(screen.queryByText('share')).toBeNull();
  });
});
