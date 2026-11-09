import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PreviewShell } from '../preview-shell';
import { Dialog } from '@/components/ui/dialog';

// pim-p2-7: Escape in "Import to a mail folder…", opened from a saved mail's
// preview, closed the preview behind the dialog and left the dialog open.
describe('Escape with a dialog over the file preview', () => {
  it('closes the dialog, not the preview', () => {
    const closePreview = vi.fn();
    const closeDialog = vi.fn();
    const { getByLabelText } = render(
      <>
        <PreviewShell name="saved.eml" onClose={closePreview} onDownload={vi.fn()}>
          <p>mail</p>
        </PreviewShell>
        <Dialog isOpen onClose={closeDialog} title="Import to a mail folder">
          <input aria-label="Filter" />
        </Dialog>
      </>,
    );
    fireEvent.keyDown(getByLabelText('Filter'), { key: 'Escape' });
    expect(closePreview).not.toHaveBeenCalled();
    expect(closeDialog).toHaveBeenCalledTimes(1);
  });

  it('still closes the preview when nothing is above it', () => {
    const closePreview = vi.fn();
    render(
      <PreviewShell name="saved.eml" onClose={closePreview} onDownload={vi.fn()}>
        <button type="button">inside</button>
      </PreviewShell>,
    );
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(closePreview).toHaveBeenCalledTimes(1);
  });
});
