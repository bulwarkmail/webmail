import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FileNoPreview } from '../file-no-preview';
import { FilePreviewModal } from '../file-preview-modal';
import { fileAppAction } from '@/lib/files-app-actions';
import type { FileResource } from '@/stores/file-store';

// pim-p2-18: the pane of a file with no preview has the preview's header with
// Previous/Next and one Download. pim-p2-7: the app's own action for a file.

vi.mock('@/lib/debug', () => ({ debug: { log: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('@/lib/standalone-display', () => ({ canOpenUrlInNewWindow: () => false }));

const budget = {
  id: 'x', name: 'budget.xlsx', serverName: 'budget.xlsx', isDirectory: false, contentType: 'application/vnd.ms-excel',
  contentLength: 10, lastModified: '2026-10-01T00:00:00Z', blobId: 'b-x', parentId: null,
} as FileResource;

afterEach(() => cleanup());

describe('the pane of a file with no preview (pim-p2-18)', () => {
  it('shows Download once and goes to the next file', () => {
    const onGo = vi.fn();
    render(<FileNoPreview resource={budget} onClose={vi.fn()} onDownload={vi.fn()} neighbours={{ previous: 'a.zip', next: 'c.bin', onGo }} />);
    expect(screen.getAllByRole('button', { name: /download/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'next_file' }));
    expect(onGo).toHaveBeenCalledWith('c.bin');
  });

  it('has the app action first', () => {
    const onRun = vi.fn();
    render(<FileNoPreview resource={budget} onClose={vi.fn()} onDownload={vi.fn()} appAction={{ label: 'import_contacts', onRun }} />);
    fireEvent.click(screen.getByTestId('file-app-action'));
    expect(onRun).toHaveBeenCalled();
  });
});

describe('the preview offers the app action (pim-p2-7)', () => {
  it('as a labelled button in the header', () => {
    const onClick = vi.fn();
    render(
      <FilePreviewModal
        name="contacts-export.csv"
        onClose={vi.fn()}
        onDownload={vi.fn()}
        getFileContent={() => new Promise(() => {})}
        extraAction={{ label: 'import_contacts', onClick }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'import_contacts' }));
    expect(onClick).toHaveBeenCalled();
  });

  it('knows which files have one', () => {
    expect(fileAppAction('forwarded.eml')).toBe('import-mail');
    expect(fileAppAction('contacts-export.csv')).toBe('import-contacts');
    expect(fileAppAction('team.vcf')).toBe('import-contacts');
    expect(fileAppAction('trip.ics')).toBe('add-calendar');
    expect(fileAppAction('budget.xlsx')).toBeNull();
  });
});
