import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// pim-p2-1: a document opened from Files in its program goes back into Files
// when the program saves, first choice on the card. If the file changed on
// the server meanwhile, the card asks Keep both or Replace.

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const files = vi.hoisted(() => ({ client: null as unknown, refresh: vi.fn() }));

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/stores/toast-store', () => ({ toast }));
vi.mock('@/lib/device-policy', () => ({ canDownload: () => true, canExport: () => true }));
vi.mock('@/lib/offline/offline-mode', () => ({ scopeDecided: () => true }));
vi.mock('@/lib/desktop/mail-links', () => ({ openMailLink: vi.fn() }));
vi.mock('@/lib/desktop/mail-notifications', () => ({ contentHiddenFor: () => false }));
vi.mock('@/lib/launch-handoff', () => ({ handOffDraft: vi.fn() }));
vi.mock('@/lib/popout/open', () => ({ openDraftWindow: vi.fn() }));
vi.mock('@/lib/download-guard', () => ({ saveBlobAs: vi.fn(() => true) }));
vi.mock('@/lib/org/account-subjects', () => ({ useAccountSubjects: { subscribe: () => () => {} } }));
vi.mock('@/stores/policy-store', () => ({ usePolicyStore: { subscribe: () => () => {} } }));
vi.mock('@/lib/sign-out-cleanup', () => ({ addSignOutGate: () => () => {}, onBeforeSignOut: () => () => {}, onFullSignOut: () => {} }));
vi.mock('@/stores/account-store', () => {
  const list = [{ id: 'acct', cookieSlot: 2 }];
  const useAccountStore = (select: (s: { accounts: typeof list }) => unknown) => select({ accounts: list });
  useAccountStore.getState = () => ({ accounts: list });
  return { useAccountStore };
});
vi.mock('@/stores/auth-store', () => {
  const useAuthStore = (select: (s: { activeAccountId: string | null }) => unknown) => select({ activeAccountId: 'acct' });
  useAuthStore.getState = () => ({ activeAccountId: 'acct', client: null, getClientForAccount: () => undefined });
  return { useAuthStore };
});
vi.mock('@/stores/file-store', () => ({
  useFileStore: { getState: () => ({ client: files.client, currentAccountId: 'acct', refresh: files.refresh }) },
}));

import { EditedFilesHost } from '../edited-files-host';
import { parseEditSource, resetEditSessions, useEditSessions } from '@/lib/desktop/edit-attachments';

const NODE_SOURCE = JSON.stringify({ kind: 'node', nodeId: 'n1', blobId: 'b-old', parentId: 'p1' });
const session = (over: Record<string, unknown> = {}) => ({
  id: 's1', name: 'budget-2026.xlsx', type: 'x/y', account: 'acct', source: NODE_SOURCE, changed: true, version: 2, hash: 'h2', claimed: false, held: false, savedAs: false, lastChance: false, ...over,
});

let edit: Record<string, ReturnType<typeof vi.fn>>;
let client: {
  getFileNodes: ReturnType<typeof vi.fn>;
  uploadBlob: ReturnType<typeof vi.fn>;
  replaceFileNodeBlob: ReturnType<typeof vi.fn>;
  createFileNode: ReturnType<typeof vi.fn>;
};

function show() {
  const sessions = [session()];
  edit.list.mockResolvedValue(sessions);
  useEditSessions.setState({ sessions });
  return render(<EditedFilesHost />);
}

beforeEach(() => {
  vi.clearAllMocks();
  client = {
    getFileNodes: vi.fn(async () => [{ id: 'n1', blobId: 'b-old', name: 'budget-2026.xlsx', parentId: 'p1' }]),
    uploadBlob: vi.fn(async () => ({ blobId: 'b-new', size: 1, type: 'x/y' })),
    replaceFileNodeBlob: vi.fn(async () => {}),
    createFileNode: vi.fn(async () => ({ id: 'n2', name: 'budget-2026 (2).xlsx', parentId: 'p1' })),
  };
  files.client = client;
  edit = {
    canEdit: vi.fn(() => true),
    list: vi.fn(async () => []),
    read: vi.fn(async () => ({ ok: true, name: 'budget-2026.xlsx', type: 'x/y', data: new Uint8Array([1, 2]), hash: 'h2' })),
    taken: vi.fn(async () => {}),
    setSource: vi.fn(),
    discard: vi.fn(async () => ({ held: [] })),
    forceDiscard: vi.fn(async () => ({ held: [] })),
    askClear: vi.fn(async () => true),
    shown: vi.fn(),
    onChange: vi.fn(() => () => {}),
  };
  (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, edit, os: { notify: vi.fn(async () => ({})) } };
  resetEditSessions();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
});

describe('a file opened from Files remembers its node', () => {
  it('reads the node source back', () => {
    expect(parseEditSource(JSON.stringify({ kind: 'node', nodeId: 'acct2:n1', blobId: 'b1', parentId: null })))
      .toEqual({ kind: 'node', nodeId: 'acct2:n1', blobId: 'b1', parentId: null });
    // Older sessions keep working.
    expect(parseEditSource('{"kind":"file"}')).toEqual({ kind: 'file' });
    expect(parseEditSource(JSON.stringify({ kind: 'node' }))).toEqual({ kind: 'file' });
  });
});

describe('Save to Files (pim-p2-1)', () => {
  it('is the first choice on the card of a file from Files', () => {
    show();
    const buttons = screen.getAllByRole('button').filter((b) => b.textContent);
    expect(buttons[0].textContent).toBe('save_to_files');
    expect(screen.getByText('new_message')).toBeTruthy();
    expect(screen.getByText('save_copy')).toBeTruthy();
  });

  it('puts the new content into the same node when nobody changed it', async () => {
    show();
    fireEvent.click(screen.getByText('save_to_files'));
    await waitFor(() => expect(client.replaceFileNodeBlob).toHaveBeenCalledWith('n1', 'b-new'));
    expect(client.createFileNode).not.toHaveBeenCalled();
    expect(edit.setSource).toHaveBeenCalledWith('s1', JSON.stringify({ kind: 'node', nodeId: 'n1', blobId: 'b-new', parentId: 'p1' }));
    expect(edit.taken).toHaveBeenCalledWith('s1', 'h2');
    expect(toast.success).toHaveBeenCalledWith('saved');
    expect(files.refresh).toHaveBeenCalled();
  });

  it('asks Keep both or Replace when the file changed on the server, and Keep both adds a copy beside it', async () => {
    client.getFileNodes.mockResolvedValue([{ id: 'n1', blobId: 'b-someone-else', name: 'budget-2026.xlsx', parentId: 'p1' }]);
    show();
    fireEvent.click(screen.getByText('save_to_files'));
    await waitFor(() => expect(screen.getByTestId('edited-file-conflict').textContent).toBe('changed_on_server'));
    expect(client.replaceFileNodeBlob).not.toHaveBeenCalled();
    expect(edit.taken).not.toHaveBeenCalled();
    expect(screen.getByText('replace')).toBeTruthy();
    fireEvent.click(screen.getByText('keep_both'));
    await waitFor(() => expect(client.createFileNode).toHaveBeenCalledWith('budget-2026.xlsx', 'b-new', 'x/y', 2, 'p1'));
    expect(client.replaceFileNodeBlob).not.toHaveBeenCalled();
    expect(edit.setSource).toHaveBeenCalledWith('s1', JSON.stringify({ kind: 'node', nodeId: 'n2', blobId: 'b-new', parentId: 'p1' }));
    expect(edit.taken).toHaveBeenCalledWith('s1', 'h2');
    expect(toast.success).toHaveBeenCalledWith('saved_copy');
  });

  it('Replace writes over the change', async () => {
    client.getFileNodes.mockResolvedValue([{ id: 'n1', blobId: 'b-someone-else', name: 'budget-2026.xlsx', parentId: 'p1' }]);
    show();
    fireEvent.click(screen.getByText('save_to_files'));
    fireEvent.click(await screen.findByText('replace'));
    await waitFor(() => expect(client.replaceFileNodeBlob).toHaveBeenCalledWith('n1', 'b-new'));
  });

  it('offers a new file when the original is gone', async () => {
    client.getFileNodes.mockResolvedValue([]);
    show();
    fireEvent.click(screen.getByText('save_to_files'));
    await waitFor(() => expect(screen.getByTestId('edited-file-conflict').textContent).toBe('gone_on_server'));
    expect(screen.queryByText('replace')).toBeNull();
    expect(screen.getByText('save_as_new')).toBeTruthy();
  });
});
