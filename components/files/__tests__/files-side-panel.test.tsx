import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FileBrowser } from '../file-browser';
import { useFileStore, type FileResource } from '@/stores/file-store';
import { clearSlotOffers, framePropsOf, offerSlots } from '@/components/plugins/__tests__/fake-slot-offer';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// The plugin side panel (app-side-panel) in Files: its button right after
// the details button, at the end of the header in both of its shapes, the
// panel last in the row under it with the selected files and the folder,
// and the details panel and it taking turns.

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

beforeEach(() => {
  device.isMobile = false;
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  clearSlotOffers();
});

const frame = () => screen.queryByTestId('plugin-frame-app-side-panel');
const toggle = () => document.querySelector<HTMLElement>('[data-plugin-panel-toggle]')!;
const details = () => screen.getByRole('button', { name: 'details' });

describe('Files side panel', () => {
  it('has no button without a plugin', () => {
    renderBrowser();
    expect(document.querySelector('[data-plugin-panel-toggle]')).toBeNull();
  });

  it('puts the button right after the details button, last in the header, and the folder in the context', () => {
    offerSlots('p1', ['app-side-panel']);
    renderBrowser();
    const header = details().closest('.h-14')!;
    const buttons: HTMLElement[] = Array.from(header.querySelectorAll('button'));
    expect(buttons.indexOf(toggle())).toBe(buttons.indexOf(details()) + 1);
    expect(buttons[buttons.length - 1]).toBe(toggle());
    const panel = document.querySelector<HTMLElement>('[data-app-side-panel]')!;
    expect(panel.parentElement!.lastElementChild).toBe(panel);
    expect(framePropsOf(frame()!)).toEqual({ view: 'files', context: { folder: { id: null, path: '/' } }, focusRequest: 0 });
  });

  it('names the selected files, and keeps the button last in the selection bar', () => {
    offerSlots('p1', ['app-side-panel']);
    renderBrowser(['notes.txt', 'photo.png']);
    const bar = screen.getByRole('toolbar', { name: 'selection_actions' });
    const buttons = Array.from(bar.querySelectorAll('button'));
    expect(buttons[buttons.length - 1]).toBe(toggle());
    expect(buttons[buttons.length - 2]).toBe(details());
    const context = framePropsOf(frame()!).context as { files: { name: string }[]; fileCount: number };
    expect(context.files.map((f) => f.name)).toEqual(['notes.txt', 'photo.png']);
    expect(context.fileCount).toBe(2);
  });

  it('folds the details when the panel opens, and the panel when the details open', () => {
    offerSlots('p1', ['app-side-panel']);
    localStorage.setItem('appSidePanelCollapsed', '1');
    renderBrowser();
    expect(frame()).toBeNull();
    fireEvent.click(details());
    expect(details()).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(toggle());
    expect(frame()).not.toBeNull();
    expect(details()).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(details());
    expect(details()).toHaveAttribute('aria-pressed', 'true');
    expect(frame()).toBeNull();
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    // Only here: the other views keep the panel open as the user left it.
    expect(localStorage.getItem('appSidePanelCollapsed')).toBe('0');
    // The details go, the panel is back.
    fireEvent.click(details());
    expect(frame()).not.toBeNull();
  });

  it('never shows both: with both stored open the details fold when the page loads', () => {
    offerSlots('p1', ['app-side-panel']);
    localStorage.setItem('appSidePanelCollapsed', '0');
    localStorage.setItem('files-show-details', '1');
    renderBrowser();
    expect(frame()).not.toBeNull();
    expect(details()).toHaveAttribute('aria-pressed', 'false');
    expect(document.querySelector('[data-app-side-panel]')).toBeTruthy();
  });

  it('has no button in the header on a phone', () => {
    device.isMobile = true;
    offerSlots('p1', ['app-side-panel']);
    act(() => renderBrowser());
    expect(document.querySelector('[data-plugin-panel-toggle]')).toBeNull();
    expect(frame()).toBeNull();
  });
});
