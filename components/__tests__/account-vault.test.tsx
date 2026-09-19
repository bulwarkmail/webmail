import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { AccountVaultImportPrompt, AccountVaultSettings } from '../account-vault';
import { encryptVault, type VaultContents, type VaultRecord } from '@/lib/account-vault';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), put: vi.fn(), del: vi.fn(), collect: vi.fn(), restore: vi.fn(), enablePush: vi.fn(),
  registry: { accounts: [] as { id: string; username: string; serverUrl: string; authMode: string }[], defaultAccountId: null as string | null, updateAccount: vi.fn() },
  auth: { isAuthenticated: false, authMode: 'basic', isDemoMode: false, username: 'owner@example.com', serverUrl: 'https://mail.example.com' } }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string, values?: Record<string, unknown>) => values ? `${key}:${Object.values(values).join(',')}` : key }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ settingsSyncEnabled: true, oauthOnly: false }) }));
vi.mock('@/lib/account-vault-client', () => ({ fetchVaults: mocks.fetch, putVault: mocks.put, deleteVault: mocks.del, collectVault: mocks.collect }));
vi.mock('@/stores/auth-store', () => ({ useAuthStore: Object.assign(
  (selector: (s: typeof mocks.auth) => unknown) => selector(mocks.auth),
  { getState: () => ({ restoreVault: mocks.restore, getClientForAccount: (id: string) => ({ id }) }) },
) }));
vi.mock('@/lib/web-push', () => ({ enableWebPushForAccounts: mocks.enablePush }));
vi.mock('@/stores/account-store', () => {
  const state = mocks.registry;
  return { useAccountStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), { getState: () => state }) };
});
vi.mock('@/stores/toast-store', () => ({ toast: { success: vi.fn(), warning: vi.fn() } }));

const owner = { username: 'owner@example.com', serverUrl: 'https://mail.example.com' };
const other = { username: 'second@example.com', serverUrl: 'https://mail.example.com' };
const contents: VaultContents = { owner, accounts: [
  { ...owner, password: 'mail-password', label: 'Owner', avatarColor: '#112233' },
  { ...other, password: 'p2', label: 'Second', avatarColor: '#445566' },
], defaultAccountId: null };
const password = 'one archive passphrase';
const revision = (c: string) => c.repeat(64);
async function record(name: string, id = 'a'.repeat(32), rev = 'a'): Promise<VaultRecord> {
  return { id, name, revision: revision(rev), envelope: await encryptVault(contents, password) };
}
const ownerAccount = { ...owner, id: 'owner', authMode: 'basic' };
const secondAccount = { ...other, id: 'second', authMode: 'basic' };

beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('crypto', webcrypto); localStorage.clear();
  Object.assign(mocks.auth, { isAuthenticated: false, authMode: 'basic', isDemoMode: false, ...owner });
  mocks.registry.accounts = [ownerAccount]; mocks.registry.defaultAccountId = null;
  mocks.collect.mockReturnValue(contents); mocks.restore.mockResolvedValue({ connected: 2, failed: 0, pending: 0, connectedIds: [`${owner.username}@mail.example.com`, `${other.username}@mail.example.com`] });
  mocks.enablePush.mockResolvedValue({ enabled: ['owner'], failed: [] });
  mocks.fetch.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllGlobals());

async function unlockWith(pw: string) {
  fireEvent.change(await screen.findByLabelText('password'), { target: { value: pw } });
  fireEvent.submit(screen.getByLabelText('password').closest('form')!);
}

describe('import prompt', () => {
  it('offers a single archive after login, lets the user untick accounts and restores the rest', async () => {
    const laptop = await record('Laptop');
    mocks.fetch.mockResolvedValue([laptop]);
    mocks.auth.isAuthenticated = true;
    render(<AccountVaultImportPrompt />);
    await screen.findByRole('dialog');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument(); // one archive: nothing to choose
    fireEvent.click(screen.getByRole('button', { name: 'import' }));
    await unlockWith(password);
    await screen.findByRole('button', { name: 'next' });
    const chooser = screen.getByRole('group', { name: 'choose_accounts' });
    const boxes = within(chooser).getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).disabled).toBe(true);
    // Notifications live on the second step: eight accounts and their
    // checkboxes together overflowed the dialog.
    expect(screen.queryByRole('group', { name: 'notifications' })).not.toBeInTheDocument();
    fireEvent.click(boxes[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'next' }));
    fireEvent.click(screen.getByRole('button', { name: /import_chosen/ }));
    await waitFor(() => expect(mocks.restore).toHaveBeenCalledTimes(1));
    expect(mocks.restore.mock.calls[0]![0].accounts.map((a: { username: string }) => a.username)).toEqual([owner.username]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(localStorage.getItem(`account-vault-revision:${JSON.stringify([owner.username, owner.serverUrl])}:${laptop.id}`)).toBe(laptop.revision);
  });

  it('restores without notifications unless they are asked for', async () => {
    const laptop = await record('Laptop');
    mocks.fetch.mockResolvedValue([laptop]);
    mocks.auth.isAuthenticated = true;
    render(<AccountVaultImportPrompt />);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'import' }));
    await unlockWith(password);
    await screen.findByRole('button', { name: 'next' });
    fireEvent.click(screen.getByRole('button', { name: 'next' }));

    // A new device must not start buzzing on its own.
    const notifications = screen.getByRole('group', { name: 'notifications' });
    expect(within(notifications).getAllByRole('checkbox').every(b => !(b as HTMLInputElement).checked)).toBe(true);

    fireEvent.click(within(notifications).getByRole('checkbox', { name: 'notifications_all' }));
    fireEvent.click(screen.getByRole('button', { name: /import_chosen/ }));

    await waitFor(() => expect(mocks.enablePush).toHaveBeenCalledTimes(1));
    expect(mocks.enablePush.mock.calls[0]![0].map((t: { accountId: string }) => t.accountId))
      .toEqual([`${owner.username}@mail.example.com`, `${other.username}@mail.example.com`]);
  });

  it('leaves notifications alone when the user does not ask for them', async () => {
    const laptop = await record('Laptop');
    mocks.fetch.mockResolvedValue([laptop]);
    mocks.auth.isAuthenticated = true;
    render(<AccountVaultImportPrompt />);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'import' }));
    await unlockWith(password);
    await screen.findByRole('button', { name: 'next' });
    fireEvent.click(screen.getByRole('button', { name: 'next' }));
    fireEvent.click(screen.getByRole('button', { name: /import_chosen/ }));

    await waitFor(() => expect(mocks.restore).toHaveBeenCalledTimes(1));
    expect(mocks.enablePush).not.toHaveBeenCalled();
  });

  it('walks back to the account list without losing what was unticked', async () => {
    mocks.fetch.mockResolvedValue([await record('Laptop')]);
    mocks.auth.isAuthenticated = true;
    render(<AccountVaultImportPrompt />);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'import' }));
    await unlockWith(password);
    await screen.findByRole('button', { name: 'next' });

    const boxes = within(screen.getByRole('group', { name: 'choose_accounts' })).getAllByRole('checkbox');
    fireEvent.click(boxes[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'next' }));
    expect(screen.queryByRole('group', { name: 'choose_accounts' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'back' }));
    const again = within(screen.getByRole('group', { name: 'choose_accounts' })).getAllByRole('checkbox');
    expect((again[1] as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole('group', { name: 'notifications' })).not.toBeInTheDocument();
  });

  it('lets the user pick among several archives and names the archive in a wrong-password error', async () => {
    const laptop = await record('Laptop', 'a'.repeat(32));
    const phone = await record('Phone', 'b'.repeat(32), 'b');
    mocks.fetch.mockResolvedValue([laptop, phone]);
    mocks.auth.isAuthenticated = true;
    render(<AccountVaultImportPrompt />);
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: phone.id } });
    fireEvent.click(screen.getByRole('button', { name: 'import' }));
    expect(screen.getByRole('heading', { name: 'Phone' })).toBeInTheDocument();
    await unlockWith('wrong');
    expect(await screen.findByRole('alert')).toHaveTextContent('errors.unlock_failed_owner:Phone,owner@example.com,mail.example.com');
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it('skips archives this browser already restored and remembers a dismissal', async () => {
    const laptop = await record('Laptop');
    localStorage.setItem(`account-vault-revision:${JSON.stringify([owner.username, owner.serverUrl])}:${laptop.id}`, laptop.revision);
    mocks.fetch.mockResolvedValue([laptop]);
    mocks.auth.isAuthenticated = true;
    const view = render(<AccountVaultImportPrompt />);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.unmount(); localStorage.clear();
    render(<AccountVaultImportPrompt />);
    fireEvent.click(await screen.findByRole('button', { name: 'not_now' }));
    expect(localStorage.getItem(`account-vault-prompt:${JSON.stringify([owner.username, owner.serverUrl])}`)).toBe('dismissed');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('settings', () => {
  it('lists the archives of every account in the browser and creates a named one', async () => {
    mocks.registry.accounts = [ownerAccount, secondAccount];
    const laptop = await record('Laptop');
    mocks.fetch.mockImplementation(async (o: { username: string }) => o.username === owner.username ? [laptop] : []);
    mocks.put.mockImplementation(async (_o: unknown, archive: { id: string | null; name: string }, envelope: unknown) => ({ id: 'c'.repeat(32), name: archive.name, revision: revision('c'), envelope }));
    render(<AccountVaultSettings />);
    const list = await screen.findByRole('combobox');
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(Array.from(list.querySelectorAll('option')).map(o => o.textContent)).toEqual(['option:Laptop,owner@example.com', 'new_archive']);
    fireEvent.change(list, { target: { value: '__new__' } });
    fireEvent.click(screen.getByRole('button', { name: 'create' }));
    fireEvent.change(await screen.findByLabelText('name'), { target: { value: 'Work laptop' } });
    fireEvent.change(screen.getByLabelText('password'), { target: { value: password } });
    fireEvent.change(screen.getByLabelText('confirm_password'), { target: { value: password } });
    fireEvent.click(screen.getByLabelText('save_passwords')); // metadata only
    fireEvent.submit(screen.getByLabelText('password').closest('form')!);
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(1));
    expect(mocks.put.mock.calls[0]![1]).toEqual({ id: null, name: 'Work laptop', revision: null });
    expect(mocks.collect).toHaveBeenCalledWith(owner, false);
    expect(mocks.put.mock.calls[0]![2]).not.toHaveProperty('password');
  });

  it('renames an archive with its password, even one this browser never restored, and deletes after confirmation', async () => {
    const laptop = await record('Laptop');
    mocks.fetch.mockResolvedValue([laptop]);
    mocks.put.mockImplementation(async (_o: unknown, archive: { id: string; name: string; revision: string }, envelope: unknown) => ({ ...archive, revision: revision('d'), envelope }));
    mocks.del.mockResolvedValue(undefined);
    render(<AccountVaultSettings />);
    await screen.findByRole('combobox');
    // A wrong password writes nothing.
    fireEvent.click(screen.getByRole('button', { name: 'manage' }));
    fireEvent.change(await screen.findByLabelText('name'), { target: { value: 'Old laptop' } });
    await unlockWith('wrong');
    expect(await screen.findByRole('alert')).toHaveTextContent('errors.unlock_failed_owner');
    expect(mocks.put).not.toHaveBeenCalled();
    // The right one renames with the revision just listed; no prior restore is needed (migrated archives have none).
    await unlockWith(password);
    await waitFor(() => expect(mocks.put).toHaveBeenCalledWith(owner, { id: laptop.id, name: 'Old laptop', revision: laptop.revision }, expect.anything()));
    // Delete asks for confirmation and needs no archive password.
    fireEvent.click(await screen.findByRole('button', { name: 'delete' }));
    expect(mocks.del).not.toHaveBeenCalled();
    expect(screen.getByText('delete_confirm:Laptop,owner@example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'delete_confirm_button' }));
    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith(owner, { id: laptop.id, revision: laptop.revision }));
  });

  it('shows the empty state and the creation form when no archive exists', async () => {
    render(<AccountVaultSettings />);
    await screen.findByText('none');
    expect(screen.getByRole('button', { name: 'create' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'delete' })).not.toBeInTheDocument();
  });
});
