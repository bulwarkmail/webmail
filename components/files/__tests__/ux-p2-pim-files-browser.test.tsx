import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FileBrowser } from '../file-browser';
import { useFileStore, type FileResource } from '@/stores/file-store';
import { useSettingsStore } from '@/stores/settings-store';
import { DEFAULT_FILES_SETTINGS } from '@/lib/files-settings';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// Usability pass 2, Files (pim-5): the ⋮ of a row near the bottom opened its
// menu over itself, so a second click on the button hit "Delete".

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

export function renderBrowser(props: Partial<React.ComponentProps<typeof FileBrowser>> = {}, resources: FileResource[] = [docs, notes, budget]) {
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
    onUploadFiles: vi.fn(async () => {}),
  };
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
      onNavigate={vi.fn()}
      onToggleSelect={vi.fn()}
      onCreateFolder={noop}
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  localStorage.clear();
  act(() => { useSettingsStore.setState({ filesSettings: DEFAULT_FILES_SETTINGS }); });
});

describe('the ⋮ of a row opens its menu beside the button, never over it (pim-5)', () => {
  it('goes above a button near the bottom of the window', () => {
    // 1280×720, as in the audit: the last row's ⋮ at y 536–568, a menu 357 px tall.
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(720);
    const button = { left: 1200, right: 1232, top: 536, bottom: 568, width: 32, height: 32 };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute('role') === 'menu') return { x: 0, y: 0, left: 0, top: 0, right: 220, bottom: 357, width: 220, height: 357, toJSON: () => ({}) } as DOMRect;
      if (this.hasAttribute('data-item-action')) return { x: button.left, y: button.top, ...button, toJSON: () => ({}) } as DOMRect;
      return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
    });
    renderBrowser();
    const kebab = document.querySelector<HTMLElement>('[data-resource="budget.xlsx"] [data-item-action][title="context_menu"]')!;
    expect(kebab).toBeTruthy();
    fireEvent.click(kebab, { detail: 1, clientX: 1216, clientY: 552 });
    const menu = screen.getByRole('menu');
    const top = parseFloat(menu.style.top);
    // Above the button: the menu ends before the button starts.
    expect(top + 357).toBeLessThanOrEqual(button.top);
    // The row stays marked while its menu is open.
    expect(document.querySelector('[data-resource="budget.xlsx"]')?.closest('[data-menu-opener]') ?? document.querySelector('[data-menu-opener]')).toBeTruthy();
  });
});
