import { describe, expect, it, vi } from 'vitest';
import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { FilesHeader } from '../files-header';
import { EmptyFolder } from '../file-empty-state';

// Xenaxio step 115: creating a note or a file is visible, not only behind the
// small "+" of the folder column.
function header(props: Partial<React.ComponentProps<typeof FilesHeader>> = {}) {
  return render(
    <FilesHeader
      crumbs={[{ name: 'Meine Dateien', path: '/', id: null }]}
      onNavigateCrumb={() => {}}
      onDropOnCrumb={() => {}}
      searchQuery=""
      onSearchChange={() => {}}
      searchInputRef={createRef<HTMLInputElement>()}
      sortKey="name"
      sortDir="asc"
      onSortChange={() => {}}
      viewMode="list"
      onViewModeChange={() => {}}
      showDetails={false}
      onToggleDetails={() => {}}
      clipboardCount={0}
      onPaste={() => {}}
      onRefresh={() => {}}
      isLoading={false}
      compact={false}
      selection={null}
      {...props}
    />,
  );
}

describe('creating in Files (step 115)', () => {
  it('shows "New" in the header, which opens the create menu', () => {
    const onNew = vi.fn();
    header({ onNew });
    fireEvent.click(screen.getByRole('button', { name: 'new' }));
    expect(onNew).toHaveBeenCalledWith(screen.getByRole('button', { name: 'new' }));
  });

  it('leaves it out on a phone (the round "+" is there) and where nothing can be created', () => {
    header({ onNew: () => {}, compact: true });
    expect(screen.queryByRole('button', { name: 'new' })).toBeNull();
  });

  it('offers a new note in an empty folder', () => {
    const onNewNote = vi.fn();
    render(<EmptyFolder isRoot={false} canCreate onUpload={() => {}} onCreateFolder={() => {}} onNewNote={onNewNote} newNoteLabel="Neue Notiz" />);
    fireEvent.click(screen.getByRole('button', { name: 'Neue Notiz' }));
    expect(onNewNote).toHaveBeenCalled();
  });

  it('offers nothing to create in a folder the user may only read', () => {
    render(<EmptyFolder isRoot={false} canCreate={false} onUpload={() => {}} onCreateFolder={() => {}} onNewNote={() => {}} newNoteLabel="Neue Notiz" />);
    expect(screen.queryByRole('button', { name: 'Neue Notiz' })).toBeNull();
  });
});
