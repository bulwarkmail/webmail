import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOfflineStore } from '@/lib/offline/state';
import { ContactImportDialog } from '../contact-import-dialog';

// A .vcf opened from the OS: it parses in the browser, also without a connection.

const VCARD = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Ada Lovelace', 'EMAIL:ada@example.org', 'END:VCARD', ''].join('\r\n');
const vcf = (body = VCARD) => {
  const file = new File([body], 'people.vcf', { type: 'text/vcard' });
  // jsdom's File has no text().
  if (typeof file.text !== 'function') Object.defineProperty(file, 'text', { value: async () => body });
  return file;
};

afterEach(() => {
  useOfflineStore.setState({ browserOffline: false, downServers: [] });
});

describe('ContactImportDialog with an initial file', () => {
  it('parses it at once and offers the cards', async () => {
    render(<ContactImportDialog existingContacts={[]} onImport={vi.fn()} onClose={vi.fn()} initialFile={vcf()} />);
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('parses it offline as well', async () => {
    useOfflineStore.setState({ browserOffline: true });
    render(<ContactImportDialog existingContacts={[]} onImport={vi.fn()} onClose={vi.fn()} initialFile={vcf()} />);
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('applies the size limit to it', async () => {
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.vcf');
    render(<ContactImportDialog existingContacts={[]} onImport={vi.fn()} onClose={vi.fn()} initialFile={big} />);
    expect(await screen.findByText('import.file_too_large')).toBeInTheDocument();
  });

  it('shows the file input without one', async () => {
    const { container } = render(<ContactImportDialog existingContacts={[]} onImport={vi.fn()} onClose={vi.fn()} />);
    expect(container.ownerDocument.querySelector('input[type="file"]')).not.toBeNull();
    expect(screen.queryByText('Ada Lovelace')).toBeNull();
  });

  it('says the server is needed when the import fails offline', async () => {
    const onImport = vi.fn(async () => {
      useOfflineStore.setState({ browserOffline: true });
      throw new TypeError('Failed to fetch');
    });
    render(<ContactImportDialog existingContacts={[]} onImport={onImport} onClose={vi.fn()} initialFile={vcf()} />);
    await screen.findByText('Ada Lovelace');
    fireEvent.click(screen.getByRole('button', { name: 'import.import_button' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('contacts_need_server'));
  });

  it('calls a failed import failed while online', async () => {
    const onImport = vi.fn(async () => { throw new Error('server said no'); });
    render(<ContactImportDialog existingContacts={[]} onImport={onImport} onClose={vi.fn()} initialFile={vcf()} />);
    await screen.findByText('Ada Lovelace');
    fireEvent.click(screen.getByRole('button', { name: 'import.import_button' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('import.failed'));
  });
});
