import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FileBrowser } from '../file-browser';
import { useFileStore, type FileResource } from '@/stores/file-store';
import { useSettingsStore } from '@/stores/settings-store';
import { DEFAULT_FILES_SETTINGS } from '@/lib/files-settings';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

// pim-p3-17: after Del in Files the focus fell to the whole list, which drew a
// thick frame round everything; and Files said "canceled" where the rest of
// the app says "cancelled".

vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/components/settings/share-collection-dialog', () => ({ ShareCollectionDialog: () => null }));
vi.mock('@/lib/standalone-display', () => ({ canOpenUrlInNewWindow: () => false }));

const file = (name: string) => ({
  id: name, name, serverName: name, isDirectory: false, contentType: 'text/plain', contentLength: 10,
  lastModified: '2026-10-01T00:00:00Z', blobId: `b-${name}`, parentId: null,
} as FileResource);

const client = { listAllFileNodesAcrossAccounts: vi.fn(async () => []) } as unknown as IJMAPClient;
const onSetSelection = vi.fn();

function browser(resources: FileResource[], currentPath = '/') {
  const noop = vi.fn(async () => {});
  return (
    <FileBrowser
      currentPath={currentPath} resources={resources} isLoading={false} error={null} selectedResources={new Set()} uploadProgress={null}
      clipboard={null} onNavigate={vi.fn()} onToggleSelect={vi.fn()} onCreateFolder={noop} onUploadFolder={noop}
      onCancelUpload={vi.fn()} onDelete={noop} onBatchDelete={noop} onRename={noop} onBatchDownload={noop} onRefresh={noop}
      onClearSelection={vi.fn()} onCut={vi.fn()} onCopy={vi.fn()} onPaste={noop} onMoveTo={noop} onCreateFile={noop}
      onDuplicate={noop} getImageUrl={async () => ''} favorites={[]} recentFiles={[]} onToggleFavorite={vi.fn()}
      onOpenRecent={vi.fn()} onRenameNode={noop} onDeleteNode={noop} onDownloadNode={noop} onRevealNode={noop}
      onRemoveRecent={vi.fn()} client={client} ownAccountId="a" onPreviewImage={vi.fn()} onDownload={noop}
      onShowFileInfo={vi.fn()} onUploadFiles={noop} onPreviewFile={vi.fn()} onSetSelection={onSetSelection}
    />
  );
}

const row = (name: string) => document.querySelector<HTMLElement>(`[data-resource="${name}"]`)!;

beforeEach(() => {
  localStorage.clear();
  onSetSelection.mockClear();
  act(() => {
    useSettingsStore.setState({ filesSettings: DEFAULT_FILES_SETTINGS });
    useFileStore.setState({ client, sharedRoots: [], allFolders: [], currentParentId: null, pathStack: [{ id: null, name: '' }], hasListed: true });
  });
});
afterEach(() => cleanup());

describe('after Del in Files (pim-p3-17)', () => {
  it('puts the focus on the item now in the deleted one\'s place', () => {
    const a = file('a.txt'), b = file('b.txt'), c = file('c.txt');
    const view = render(browser([a, b, c]));
    act(() => { row('b.txt').focus(); });
    expect(document.activeElement).toBe(row('b.txt'));
    view.rerender(browser([a, c]));
    expect(document.activeElement).toBe(row('c.txt'));
    expect(onSetSelection).toHaveBeenLastCalledWith(new Set(['c.txt']));
  });

  it('leaves the focus alone when another folder opens', () => {
    const view = render(browser([file('a.txt'), file('b.txt')]));
    act(() => { row('b.txt').focus(); });
    view.rerender(browser([file('x.txt'), file('y.txt')], '/Other'));
    expect(onSetSelection).not.toHaveBeenCalled();
  });
});

describe('Files says "cancelled" as the rest of the app does', () => {
  it('uses the "cancelled" strings for a stopped upload or download', () => {
    const en = JSON.parse(readFileSync(path.join(process.cwd(), 'locales/en/common.json'), 'utf8'));
    expect(en.ux_p3_pim_pc.upload_cancelled).toBe('Upload cancelled');
    expect(en.ux_p3_pim_pc.download_cancelled).toBe('Download cancelled');
    const app = readFileSync(path.join(process.cwd(), 'components/files/files-app.tsx'), 'utf8');
    expect(app).not.toMatch(/t\("(upload|download)_canceled/);
  });
});
