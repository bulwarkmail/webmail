import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FileGridView } from '../file-views';
import { splitNameForMiddleCut } from '../file-item-parts';
import type { FileResource } from '@/stores/file-store';

// pim-21: long names in the grid are cut in the middle, so the extension and
// the part that tells similar names apart stay in view.

afterEach(cleanup);

describe('splitNameForMiddleCut', () => {
  it('keeps the end of the name and the extension', () => {
    expect(splitNameForMiddleCut('IMG_20250611_1003.png')).toEqual({ head: 'IMG_20250611_', tail: '1003.png' });
    expect(splitNameForMiddleCut('meeting-notes-2026-q3.md')).toEqual({ head: 'meeting-notes-202', tail: '6-q3.md' });
    expect(splitNameForMiddleCut('Großes Angebot – final (v3).txt')).toEqual({ head: 'Großes Angebot – final ', tail: '(v3).txt' });
  });

  it('leaves short names whole', () => {
    expect(splitNameForMiddleCut('a.txt')).toEqual({ head: 'a.txt', tail: '' });
    expect(splitNameForMiddleCut('readme.txt')).toEqual({ head: 'readme.txt', tail: '' });
  });

  it('cuts names without an extension near the end too', () => {
    expect(splitNameForMiddleCut('Quarterly reports archive')).toEqual({ head: 'Quarterly reports arc', tail: 'hive' });
  });
});

describe('the grid', () => {
  it('cuts the start of a long name, keeps its end, and has the whole name as title', () => {
    const resource = {
      id: 'i', name: 'IMG_20250611_1003.png', serverName: 'IMG_20250611_1003.png', isDirectory: false, contentType: 'image/png',
      contentLength: 10, lastModified: '2026-10-01T00:00:00Z', blobId: 'b', parentId: null,
    } as FileResource;
    render(
      <FileGridView
        resources={[resource]}
        selected={new Set()}
        focusedName={null}
        tabStopName={null}
        dropTarget={null}
        cutNames={new Set()}
        starredPaths={new Set()}
        pathOf={() => '/'}
        touch={false}
        iconOptions={{ showIcons: true, coloredIcons: true, showThumbnails: false }}
        getImageUrl={async () => ''}
        handlers={{
          onSelectClick: vi.fn(), onToggleSelect: vi.fn(), onOpen: vi.fn(), onContextMenu: vi.fn(), onShare: vi.fn(),
          canShare: () => false, dragProps: () => ({}), onFocusItem: vi.fn(),
        }}
      />,
    );
    const name = screen.getByTitle('IMG_20250611_1003.png');
    const [head, tail] = Array.from(name.children) as HTMLElement[];
    expect(head.textContent).toBe('IMG_20250611_');
    expect(head.className).toContain('truncate');
    expect(tail.textContent).toBe('1003.png');
    expect(tail.className).toContain('shrink-0');
    expect(name.textContent).toBe('IMG_20250611_1003.png');
  });
});
