import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// pim-p2-1: a document opened from Files in its program goes back into Files
// when the program saves, first choice on the card. If the file changed on
// the server meanwhile, the card asks Keep both or Replace.

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const files = vi.hoisted(() => ({ client: null as unknown, refresh: vi.fn(async () => {}), resources: [] as unknown[], trashCount: 0 }));

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
vi.mock('@/stores/file-store', () => {
  const state = () => ({ client: files.client, currentAccountId: 'acct', refresh: files.refresh, resources: files.resources, trashCount: files.trashCount });
  const useFileStore = (select: (s: ReturnType<typeof state>) => unknown) => select(state());
  useFileStore.getState = state;
  return { useFileStore };
});

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
  listAllFileNodes: ReturnType<typeof vi.fn>;
};

function show() {
  const sessions = [session()];
  edit.list.mockResolvedValue(sessions);
  useEditSessions.setState({ sessions });
  return render(<EditedFilesHost />);
}

let serverBlob = 'b-old';
let serverParent = 'p1';

beforeEach(() => {
  vi.clearAllMocks();
  serverBlob = 'b-old';
  serverParent = 'p1';
  client = {
    // The server keeps a new content under a blob id of its own, as Stalwart 1.0 does (pim-p3-1).
    getFileNodes: vi.fn(async (ids: string[]) => {
      if (ids.includes('n1')) return [{ id: 'n1', blobId: serverBlob, name: 'budget-2026.xlsx', parentId: serverParent }];
      // A delete in Files moves the node into a folder in the trash.
      if (ids.includes('batch')) return [{ id: 'batch', name: '1~p1', parentId: 'trash' }];
      if (ids.includes('trash')) return [{ id: 'trash', name: '.Trash', parentId: null }];
      return [];
    }),
    uploadBlob: vi.fn(async () => ({ blobId: 'b-new', size: 1, type: 'x/y' })),
    replaceFileNodeBlob: vi.fn(async () => { serverBlob = 'b-server'; }),
    createFileNode: vi.fn(async () => ({ id: 'n2', name: 'budget-2026 (2).xlsx', parentId: 'p1' })),
    listAllFileNodes: vi.fn(async () => [{ id: 'p1', name: 'Budgets', parentId: null, type: 'd', blobId: null }, { id: 'n1', name: 'budget-2026.xlsx', parentId: serverParent, type: 'x/y', blobId: serverBlob }]),
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
    expect(edit.setSource).toHaveBeenCalledWith('s1', JSON.stringify({ kind: 'node', nodeId: 'n1', blobId: 'b-server', parentId: 'p1', auto: true }));
    expect(edit.taken).toHaveBeenCalledWith('s1', 'h2');
    expect(toast.success).toHaveBeenCalledWith('saved_auto');
    expect(files.refresh).toHaveBeenCalled();
  });

  it('asks Keep both or Replace when the file changed on the server, and Keep both adds a copy beside it', async () => {
    serverBlob = 'b-someone-else';
    show();
    fireEvent.click(screen.getByText('save_to_files'));
    await waitFor(() => expect(screen.getByTestId('edited-file-conflict').textContent).toBe('changed_on_server'));
    expect(client.replaceFileNodeBlob).not.toHaveBeenCalled();
    expect(edit.taken).not.toHaveBeenCalled();
    expect(screen.getByText('replace')).toBeTruthy();
    fireEvent.click(screen.getByText('keep_both'));
    await waitFor(() => expect(client.createFileNode).toHaveBeenCalledWith('budget-2026.xlsx', 'b-new', 'x/y', 2, 'p1'));
    expect(client.replaceFileNodeBlob).not.toHaveBeenCalled();
    expect(edit.setSource).toHaveBeenCalledWith('s1', JSON.stringify({ kind: 'node', nodeId: 'n2', blobId: 'b-new', parentId: 'p1', auto: true }));
    expect(edit.taken).toHaveBeenCalledWith('s1', 'h2');
    expect(toast.success).toHaveBeenCalledWith('saved_copy');
  });

  it('Replace writes over the change', async () => {
    serverBlob = 'b-someone-else';
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

// pim-p3-6: once the user chose Save to Files, later saves from the program go
// back by themselves with a quiet toast; the card comes back only for a real
// conflict, sits in the toast corner and goes when the file is deleted.
describe('later saves of a file sent to Files once (pim-p3-6)', () => {
  const AUTO_SOURCE = JSON.stringify({ kind: 'node', nodeId: 'n1', blobId: 'b-old', parentId: 'p1', auto: true });

  function showSessions(...list: ReturnType<typeof session>[]) {
    edit.list.mockResolvedValue(list);
    useEditSessions.setState({ sessions: list });
    return render(<EditedFilesHost />);
  }

  it('saves by itself, with a quiet toast and no card', async () => {
    showSessions(session({ source: AUTO_SOURCE, version: 3 }));
    await waitFor(() => expect(client.replaceFileNodeBlob).toHaveBeenCalledWith('n1', 'b-new'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('saved'));
    expect(edit.taken).toHaveBeenCalledWith('s1', 'h2');
    expect(screen.queryByTestId('edited-file')).toBeNull();
  });

  it('saves each new version once', async () => {
    const view = showSessions(session({ source: AUTO_SOURCE, version: 3 }));
    await waitFor(() => expect(client.replaceFileNodeBlob).toHaveBeenCalledTimes(1));
    // Main keeps the source the save set: the node as the server holds it now.
    await waitFor(() => expect(edit.setSource).toHaveBeenCalled());
    const next = [session({ source: edit.setSource.mock.calls[0][1], version: 4, hash: 'h4' })];
    edit.list.mockResolvedValue(next);
    act(() => useEditSessions.setState({ sessions: next }));
    view.rerender(<EditedFilesHost />);
    await waitFor(() => expect(client.replaceFileNodeBlob).toHaveBeenCalledTimes(2));
  });

  it('asks on its card when someone else changed it, and Cancel closes the card', async () => {
    serverBlob = 'b-someone-else';
    showSessions(session({ source: AUTO_SOURCE, version: 3 }));
    await waitFor(() => expect(screen.getByTestId('edited-file-conflict').textContent).toBe('changed_on_server'));
    expect(client.replaceFileNodeBlob).not.toHaveBeenCalled();
    expect(screen.getByText('keep_both')).toBeTruthy();
    fireEvent.click(screen.getByText('cancel'));
    expect(screen.queryByTestId('edited-file')).toBeNull();
    // Not tried again until the program saves again.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.getFileNodes.mock.calls.filter(([ids]) => ids.includes('n1'))).toHaveLength(1);
  });

  it('puts the cards in the toast corner, above which toasts stack', () => {
    show();
    const section = screen.getByTestId('edited-files');
    expect(section.getAttribute('data-toast-avoid')).toBe('bottom');
    expect(section.className).toContain('end-4');
    expect(section.className).not.toContain('mx-auto');
  });

  it('takes the card away when the file is moved to the trash in Files', async () => {
    client.listAllFileNodes.mockResolvedValue([
      { id: 'trash', name: '.Trash', parentId: null, type: 'd', blobId: null },
      { id: 'batch', name: '1~p1', parentId: 'trash', type: 'd', blobId: null },
      { id: 'n1', name: 'budget-2026.xlsx', parentId: 'batch', type: 'x/y', blobId: 'b-old' },
    ]);
    show();
    expect(screen.getByTestId('edited-file')).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('edited-file')).toBeNull());
  });

  it('doesn\'t save into a file that is in the trash', async () => {
    serverParent = 'batch';
    showSessions(session({ source: AUTO_SOURCE, version: 3 }));
    await waitFor(() => expect(screen.getByTestId('edited-file-conflict').textContent).toBe('gone_on_server'));
    expect(client.replaceFileNodeBlob).not.toHaveBeenCalled();
    expect(screen.getByText('save_as_new')).toBeTruthy();
  });
});
