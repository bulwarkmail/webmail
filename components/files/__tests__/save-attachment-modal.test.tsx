import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SaveAttachmentModal } from '../save-attachment-modal';
import type { FileNode } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, string | number>) => {
    const strings: Record<string, string> = {
      title: 'Save to Files',
      loading: 'Loading folders...',
      load_error: 'Failed to load folders',
      no_folders: 'No subfolders',
      save_here: 'Save to {folder}',
      success: '"{name}" saved to Files',
      save_error: 'Failed to save to Files',
      breadcrumb_root: 'Home',
      close: 'Close',
      cancel: 'Cancel',
    };
    let message = strings[key] ?? key;
    if (values) {
      for (const [name, value] of Object.entries(values)) {
        message = message.replace(`{${name}}`, String(value));
      }
    }
    return message;
  },
}));

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function makeClient(overrides: Partial<IJMAPClient> = {}): IJMAPClient {
  return {
    getAccountId: vi.fn(() => 'account-1'),
    getFilesAccountId: vi.fn(() => 'account-1'),
    listFileNodes: vi.fn().mockResolvedValue([]),
    createFileNode: vi.fn(),
    uploadBlob: vi.fn(),
    fetchBlob: vi.fn(),
    ...overrides,
  } as unknown as IJMAPClient;
}

// Real Stalwart FileNode folders are NOT reliably typed "d" - blobId === null
// is the only authoritative "this is a container" signal (see isFolder() in
// stores/file-store.ts, #379). Deliberately using a non-"d" type here so this
// test would have caught the original type==='d' bug (#901 follow-up).
function folder(id: string, name: string): FileNode {
  return { id, parentId: null, name, type: '', blobId: null, size: 0, created: '', modified: '' };
}

function file(id: string, name: string): FileNode {
  return { id, parentId: null, name, type: 'application/pdf', blobId: `blob-${id}`, size: 100, created: '', modified: '' };
}

describe('SaveAttachmentModal (#901)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists root folders on open and lets the user navigate into one', async () => {
    const client = makeClient({
      listFileNodes: vi.fn()
        .mockResolvedValueOnce([folder('f1', 'Invoices'), folder('f2', 'Receipts')])
        .mockResolvedValueOnce([folder('f1a', 'Q1')]),
    });

    render(
      <SaveAttachmentModal
        client={client}
        source={{ client, accountId: 'account-1', blobId: 'blob-1', name: 'report.pdf', type: 'application/pdf', size: 1024 }}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('Invoices')).toBeInTheDocument());
    expect(client.listFileNodes).toHaveBeenCalledWith(null);

    fireEvent.click(screen.getByText('Invoices'));

    await waitFor(() => expect(screen.getByText('Q1')).toBeInTheDocument());
    expect(client.listFileNodes).toHaveBeenCalledWith('f1');
  });

  it('shows folders (blobId === null) and hides files, regardless of the "type" field', async () => {
    const client = makeClient({
      listFileNodes: vi.fn().mockResolvedValue([folder('f1', 'Invoices'), file('doc1', 'notes.pdf')]),
    });

    render(
      <SaveAttachmentModal
        client={client}
        source={{ client, accountId: 'account-1', blobId: 'blob-1', name: 'report.pdf', type: 'application/pdf', size: 1024 }}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText('Invoices')).toBeInTheDocument());
    expect(screen.queryByText('notes.pdf')).not.toBeInTheDocument();
  });

  it('reuses the existing blobId directly when the attachment already lives in the Files account (no re-upload)', async () => {
    const client = makeClient();
    const onClose = vi.fn();

    render(
      <SaveAttachmentModal
        client={client}
        source={{ client, accountId: 'account-1', blobId: 'blob-1', name: 'report.pdf', type: 'application/pdf', size: 1024 }}
        onClose={onClose}
      />,
    );

    await waitFor(() => expect(client.listFileNodes).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /save to home/i }));

    await waitFor(() => {
      expect(client.createFileNode).toHaveBeenCalledWith('report.pdf', 'blob-1', 'application/pdf', 1024, null);
    });
    expect(client.fetchBlob).not.toHaveBeenCalled();
    expect(client.uploadBlob).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('fetches and re-uploads the blob when the attachment lives in a different account', async () => {
    const sourceClient = makeClient({
      getAccountId: vi.fn(() => 'other-account'),
      fetchBlob: vi.fn().mockResolvedValue(new Blob(['hello'], { type: 'application/pdf' })),
    });
    const filesClient = makeClient({
      uploadBlob: vi.fn().mockResolvedValue({ blobId: 'blob-new', size: 5, type: 'application/pdf' }),
    });
    const onClose = vi.fn();

    render(
      <SaveAttachmentModal
        client={filesClient}
        source={{ client: sourceClient, accountId: 'other-account', blobId: 'blob-1', name: 'report.pdf', type: 'application/pdf', size: 1024 }}
        onClose={onClose}
      />,
    );

    await waitFor(() => expect(filesClient.listFileNodes).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /save to home/i }));

    await waitFor(() => {
      expect(sourceClient.fetchBlob).toHaveBeenCalledWith('blob-1', 'report.pdf', 'application/pdf', 'other-account');
    });
    expect(filesClient.uploadBlob).toHaveBeenCalledWith(expect.any(File), { accountId: 'account-1' });
    expect(filesClient.createFileNode).toHaveBeenCalledWith('report.pdf', 'blob-new', 'application/pdf', 5, null);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows an error and stays open when saving fails', async () => {
    const client = makeClient({
      createFileNode: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const onClose = vi.fn();

    render(
      <SaveAttachmentModal
        client={client}
        source={{ client, accountId: 'account-1', blobId: 'blob-1', name: 'report.pdf', type: 'application/pdf', size: 1024 }}
        onClose={onClose}
      />,
    );

    await waitFor(() => expect(client.listFileNodes).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /save to home/i }));

    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });
});
