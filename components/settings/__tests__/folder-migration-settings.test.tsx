import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mailbox } from '@/lib/jmap/types';

const migrateFolder = vi.fn();
vi.mock('@/lib/folder-migration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/folder-migration')>()),
  migrateFolder: (...args: unknown[]) => migrateFolder(...args),
}));

const { FolderMigrationSettings } = await import('../folder-migration-settings');
const { useAuthStore } = await import('@/stores/auth-store');
const { useAccountStore } = await import('@/stores/account-store');
const { useEmailStore } = await import('@/stores/email-store');

const folders = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', myRights: { mayAddItems: true } },
  { id: 'old', name: 'Old', myRights: { mayAddItems: true } },
] as unknown as Mailbox[];

function fakeClient(url: string, accountId: string) {
  return { getServerUrl: () => url, getAccountId: () => accountId, getMailboxes: vi.fn(async () => folders) };
}

function setup(accountIds: string[]) {
  const clients = new Map(accountIds.map((id) => [id, fakeClient(`https://${id}`, id)]));
  useAccountStore.setState({ accounts: accountIds.map((id) => ({ id, label: id, email: id })) } as never);
  useAuthStore.setState({
    activeAccountId: accountIds[0],
    getAllConnectedClients: () => new Map(clients) as never,
    getClientForAccount: (id: string) => clients.get(id) as never,
  } as never);
  useEmailStore.setState({ fetchMailboxes: vi.fn(async () => {}), fetchAccountMailboxes: vi.fn(async () => {}) } as never);
  return clients;
}

async function pick(label: string, value: string) {
  const select = screen.getByLabelText(label) as HTMLSelectElement;
  await waitFor(() => expect([...select.options].some((o) => o.value === value)).toBe(true));
  fireEvent.change(select, { target: { value } });
}

describe('FolderMigrationSettings', () => {
  beforeEach(() => migrateFolder.mockReset());

  it('is hidden with a single connected account', () => {
    setup(['a']);
    const { container } = render(<FolderMigrationSettings />);
    expect(container.innerHTML).toBe('');
  });

  it('refuses a destination in the same account', async () => {
    setup(['a', 'b']);
    render(<FolderMigrationSettings />);
    await pick('source_account', 'a');
    await pick('source_folder', 'old');
    await pick('destination_account', 'a');
    await pick('destination_folder', 'inbox');
    expect(screen.getByText('same_account')).toBeTruthy();
    expect((screen.getByText('start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('runs the chosen copy and reports the outcome', async () => {
    const clients = setup(['a', 'b']);
    migrateFolder.mockResolvedValue({ total: 2, done: 2, kept: 0, stopped: false });
    render(<FolderMigrationSettings />);
    await pick('source_account', 'a');
    await pick('source_folder', 'old');
    await pick('destination_account', 'b');
    await pick('destination_folder', 'inbox');
    fireEvent.click(screen.getByText('start'));

    await waitFor(() => expect(screen.getByText('finished', { exact: false })).toBeTruthy());
    expect(migrateFolder).toHaveBeenCalledWith(expect.objectContaining({
      source: clients.get('a'), sourceMailboxId: 'old', destination: clients.get('b'), destMailboxId: 'inbox', mode: 'copy',
    }));
  });
});
