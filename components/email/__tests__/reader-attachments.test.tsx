import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { ReaderAttachments, splitFileName, type ReaderAttachmentItem } from '../reader-attachments';

// The reader's attachment bar: equal tiles that keep the extension in view,
// a download button that needs no hover, and one row of them: the files that
// don't fit wait behind a "Show N more" tile, so the body stays in view.

const file = (id: string, name: string, type = 'application/pdf', size = 1000): ReaderAttachmentItem =>
  ({ id, name, type, size, blobId: `blob-${id}` });

function renderBar(attachments: ReaderAttachmentItem[], overrides: Partial<Parameters<typeof ReaderAttachments>[0]> = {}) {
  const props = {
    attachments,
    thumbUrls: {},
    opensPreview: () => false,
    onOpen: vi.fn(),
    onDownload: vi.fn(),
    onDownloadAll: vi.fn(),
    downloadingAll: false,
    ...overrides,
  };
  render(<ReaderAttachments {...props} />);
  return props;
}

describe('the right-click menu in the desktop app', () => {
  afterEach(() => {
    window.bulwarkDesktop = undefined;
    cleanup();
  });

  // The same HTML menu as everywhere else in the app (it was a native menu).
  const openMenu = async (overrides: Partial<Parameters<typeof ReaderAttachments>[0]> = {}) => {
    window.bulwarkDesktop = { version: 1, platform: 'win32', menu: { setState: () => {} } } as never;
    const props = renderBar([file('1', 'report.pdf')], { onCopyFile: vi.fn(), ...overrides });
    fireEvent.contextMenu(await screen.findByTestId('attachment'), { clientX: 5, clientY: 5 });
    const menu = await screen.findByRole('menu');
    const labels = within(menu).queryAllByRole('menuitem').map((item) => item.querySelector('[data-menu-label]')?.textContent ?? '');
    const pick = (label: string) => fireEvent.click(within(menu).getAllByRole('menuitem').find((item) => item.querySelector('[data-menu-label]')?.textContent === label)!);
    return { props, labels, pick };
  };

  it('has Open, Save as and Copy', async () => {
    const { labels } = await openMenu();
    expect(labels).toEqual(['open', 'save_as', 'copy']);
  });

  it.each([['open', 'onOpen'], ['save_as', 'onDownload'], ['copy', 'onCopyFile']] as const)('%s runs the action', async (label, handler) => {
    const { props, pick } = await openMenu();
    pick(label);
    await waitFor(() => expect((props as unknown as Record<string, ReturnType<typeof vi.fn>>)[handler]).toHaveBeenCalledTimes(1));
    expect((props as unknown as Record<string, ReturnType<typeof vi.fn>>)[handler].mock.calls[0][0]).toMatchObject({ id: '1' });
  });

  it('with downloads off there is nothing to save or copy', async () => {
    const { labels } = await openMenu({ downloadsOff: true, opensPreview: () => true });
    expect(labels).toEqual(['open']);
  });

  it('Edit shows when the file can be edited and runs the action', async () => {
    const onEdit = vi.fn();
    const { props, labels, pick } = await openMenu({ onEdit, canEdit: () => true });
    expect(labels).toEqual(['open', 'save_as', 'edit', 'copy']);
    pick('edit');
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith(props.attachments[0]));
  });

  it('Edit stays out for a file it cannot take', async () => {
    const { labels } = await openMenu({ onEdit: vi.fn(), canEdit: () => false });
    expect(labels).not.toContain('edit');
  });

  it('Edit stays out with downloads off, whatever else says yes', async () => {
    const { labels } = await openMenu({ onEdit: vi.fn(), canEdit: () => true, downloadsOff: true });
    expect(labels).not.toContain('edit');
  });

  it('a browser keeps its own menu', async () => {
    window.bulwarkDesktop = undefined;
    renderBar([file('1', 'report.pdf')], { onCopyFile: vi.fn() });
    const event = fireEvent.contextMenu(await screen.findByTestId('attachment'));
    // Not prevented: the browser's menu shows, and no HTML one opens.
    expect(event).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('splitFileName', () => {
  it('splits off a short extension', () => {
    expect(splitFileName('prototype-v3.png')).toEqual(['prototype-v3', '.png']);
  });

  it('keeps names without a usable extension whole', () => {
    expect(splitFileName('README')).toEqual(['README', '']);
    expect(splitFileName('.env')).toEqual(['.env', '']);
    expect(splitFileName('report.averyverylongsuffix')).toEqual(['report.averyverylongsuffix', '']);
  });
});

describe('ReaderAttachments bar', () => {
  it('truncates the stem but never the extension', () => {
    renderBar([file('a', 'Brand-guidelines-2026-final-v2.pdf')]);
    const stem = screen.getByText('Brand-guidelines-2026-final-v2');
    const ext = screen.getByText('.pdf');
    expect(stem.className).toContain('truncate');
    expect(ext.className).toContain('shrink-0');
    expect(ext.className).not.toContain('truncate');
  });

  it('shows type and size under the name', () => {
    renderBar([file('a', 'Invoice-2026-089.pdf', 'application/pdf', 51200)]);
    const tile = screen.getByTestId('attachment');
    expect(tile.textContent).toContain('PDF · ');
    expect(tile.textContent).toContain('50 KB');
  });

  it('opens the file from the tile and downloads it from its own button', () => {
    const a = file('a', 'Invoice.pdf');
    const props = renderBar([a]);
    const tile = screen.getByTestId('attachment');
    const [open, download] = within(tile).getAllByRole('button');
    fireEvent.click(open);
    expect(props.onOpen).toHaveBeenCalledWith(a);
    expect(props.onDownload).not.toHaveBeenCalled();
    fireEvent.click(download);
    expect(props.onDownload).toHaveBeenCalledWith(a);
  });

  it('offers Download all only for two or more files', () => {
    renderBar([file('a', 'one.pdf')]);
    expect(screen.queryByTitle('download_all')).toBeNull();
  });

  it('bundles every file from the summary line', () => {
    const props = renderBar([file('a', 'one.pdf'), file('b', 'two.pdf')]);
    fireEvent.click(screen.getByTitle('download_all'));
    expect(props.onDownloadAll).toHaveBeenCalledTimes(1);
  });

  describe('one row of tiles', () => {
    // jsdom lays nothing out: tiles take rows of `columns`, as the grid would.
    let columns = 3;
    beforeEach(() => {
      columns = 3;
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const parent = this.parentElement;
        const index = parent?.dataset.testid === 'reader-attachments-row' ? Array.from(parent.children).indexOf(this) : 0;
        return { top: Math.floor(index / columns) * 72, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
      cleanup();
    });

    it('fills the first row and puts the rest behind "Show N more", which expands in place', () => {
      const files = Array.from({ length: 8 }, (_, i) => file(String(i), `file-${i}.pdf`));
      renderBar(files);
      // Two files and the "Show 6 more" tile make the row of three.
      expect(screen.getAllByTestId('attachment')).toHaveLength(2);
      const more = screen.getByRole('button', { name: /attachments_show_more/ });
      expect(more.textContent).toContain('file-2.pdf, file-3.pdf, file-4.pdf');
      fireEvent.click(more);
      expect(screen.getAllByTestId('attachment')).toHaveLength(8);
      fireEvent.click(screen.getByRole('button', { name: /attachments_show_fewer/ }));
      expect(screen.getAllByTestId('attachment')).toHaveLength(2);
    });

    it('shows a full row without collapsing', () => {
      renderBar(Array.from({ length: 3 }, (_, i) => file(String(i), `file-${i}.pdf`)));
      expect(screen.getAllByTestId('attachment')).toHaveLength(3);
      expect(screen.queryByRole('button', { name: /attachments_show_more/ })).toBeNull();
    });

    it('keeps one file and "Show N more" under it where a tile fills the width', () => {
      columns = 1;
      renderBar(Array.from({ length: 4 }, (_, i) => file(String(i), `file-${i}.pdf`)));
      expect(screen.getAllByTestId('attachment')).toHaveLength(1);
      expect(screen.getByRole('button', { name: /attachments_show_more/ })).toBeTruthy();
    });

    it('shows the last file itself rather than "Show 1 more" in its place', () => {
      columns = 1;
      renderBar([file('a', 'one.pdf'), file('b', 'two.pdf')]);
      expect(screen.getAllByTestId('attachment')).toHaveLength(2);
      expect(screen.queryByRole('button', { name: /attachments_show_more/ })).toBeNull();
    });

    it('starts collapsed again for the next message', () => {
      const first = Array.from({ length: 5 }, (_, i) => file(`a${i}`, `a-${i}.pdf`));
      const props = { thumbUrls: {}, opensPreview: () => false, onOpen: vi.fn(), onDownload: vi.fn(), onDownloadAll: vi.fn(), downloadingAll: false };
      const view = render(<ReaderAttachments attachments={first} {...props} />);
      fireEvent.click(screen.getByRole('button', { name: /attachments_show_more/ }));
      expect(screen.getAllByTestId('attachment')).toHaveLength(5);
      view.rerender(<ReaderAttachments attachments={Array.from({ length: 5 }, (_, i) => file(`b${i}`, `b-${i}.pdf`))} {...props} />);
      expect(screen.getAllByTestId('attachment')).toHaveLength(2);
    });
  });

  it('draws the image itself when there is a thumbnail', () => {
    const { container } = render(
      <ReaderAttachments
        attachments={[file('img', 'photo.png', 'image/png')]}
        thumbUrls={{ img: 'blob:thumb' }}
        opensPreview={() => true}
        onOpen={vi.fn()}
        onDownload={vi.fn()}
        onDownloadAll={vi.fn()}
        downloadingAll={false}
      />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:thumb');
  });
});
