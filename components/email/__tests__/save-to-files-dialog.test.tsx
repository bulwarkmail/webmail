import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { FileNode } from '@/lib/jmap/types';
import { useToastStore } from '@/stores/toast-store';
import { fileHooks } from '@/lib/plugin-hooks';
import { SaveToFilesDialog } from '../save-to-files-dialog';

// "Save to Files" files an attachment in a folder of the Files app by its
// blobId: no download, no upload.

const folder = (id: string, name: string, parentId: string | null = null) =>
  ({ id, name, parentId, blobId: null, type: 'd', size: 0, created: '', modified: '' }) as FileNode;
const nodes = [folder('docs', 'Documents'), folder('invoices', 'Invoices', 'docs'), folder('hidden', '.Trash')];
const attachment = { name: 'invoice.pdf', type: 'application/pdf', size: 1234, blobId: 'blob-1' };

describe('SaveToFilesDialog', () => {
  it('saves the attachment into the picked folder by its blob', async () => {
    const createFileNode = vi.fn().mockResolvedValue({});
    const client = { listAllFileNodes: vi.fn().mockResolvedValue(nodes), createFileNode } as unknown as IJMAPClient;
    const onClose = vi.fn();
    render(<SaveToFilesDialog attachment={attachment} client={client} onClose={onClose} />);

    fireEvent.click(await screen.findByText('Documents'));
    expect(screen.queryByText('.Trash')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'save_here' }));

    await waitFor(() => expect(createFileNode).toHaveBeenCalledWith('invoice.pdf', 'blob-1', 'application/pdf', 1234, 'docs'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(useToastStore.getState().toasts.some((toast) => toast.title === 'saved')).toBe(true);
  });

  // A shared mailbox's attachment: the blob is in the team's account, the
  // file goes into the user's own Files account.
  it('copies the blob of a shared account into the Files account first', async () => {
    const createFileNode = vi.fn().mockResolvedValue({});
    const copyBlobs = vi.fn().mockResolvedValue({ 'blob-1': 'blob-mine' });
    const client = {
      listAllFileNodes: vi.fn().mockResolvedValue(nodes),
      getFilesAccountId: () => 'me',
      copyBlobs,
      createFileNode,
    } as unknown as IJMAPClient;
    render(<SaveToFilesDialog attachment={attachment} client={client} blobAccountId="team" onClose={vi.fn()} />);

    fireEvent.click(await screen.findByText('Documents'));
    fireEvent.click(screen.getByRole('button', { name: 'save_here' }));

    await waitFor(() => expect(createFileNode).toHaveBeenCalledWith('invoice.pdf', 'blob-mine', 'application/pdf', 1234, 'docs'));
    expect(copyBlobs).toHaveBeenCalledWith('team', ['blob-1'], 'me');
  });

  // "Save here" was greyed out until My files was clicked, with nothing on
  // screen saying why.
  it('starts with My files selected, so Save here saves there right away', async () => {
    const createFileNode = vi.fn().mockResolvedValue({});
    const client = { listAllFileNodes: vi.fn().mockResolvedValue(nodes), createFileNode } as unknown as IJMAPClient;
    render(<SaveToFilesDialog attachment={attachment} client={client} onClose={vi.fn()} />);

    await screen.findByText('Documents');
    const saveHere = screen.getByRole('button', { name: 'save_here' }) as HTMLButtonElement;
    expect(saveHere.disabled).toBe(false);
    fireEvent.click(saveHere);
    await waitFor(() => expect(createFileNode).toHaveBeenCalledWith('invoice.pdf', 'blob-1', 'application/pdf', 1234, null));
  });

  // The dialog used to file the blob without the upload hooks, so a plugin
  // that checks what goes into Files never heard about it.
  it('asks plugins first, as an upload into Files does, and saves nothing when one says no', async () => {
    const createFileNode = vi.fn().mockResolvedValue({});
    const veto = vi.fn(() => false);
    const reg = fileHooks.onBeforeFileUpload.register('dlp', veto);
    const client = { listAllFileNodes: vi.fn().mockResolvedValue(nodes), createFileNode } as unknown as IJMAPClient;
    render(<SaveToFilesDialog attachment={attachment} client={client} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByText('Documents'));
    fireEvent.click(screen.getByRole('button', { name: 'save_here' }));

    await waitFor(() => expect(veto).toHaveBeenCalledWith({ name: 'invoice.pdf', size: 1234, type: 'application/pdf', path: '/Documents' }));
    expect(createFileNode).not.toHaveBeenCalled();
    reg.dispose();
  });
});
