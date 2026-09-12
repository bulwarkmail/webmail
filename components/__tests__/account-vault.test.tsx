import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { AccountVault, AccountVaultImportPrompt, AccountVaultSettings } from '../account-vault';
import { decryptVault, encryptVault, type VaultContents, type VaultEnvelope } from '@/lib/account-vault';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), put: vi.fn(), collect: vi.fn(), restore: vi.fn(),
  registry: { accounts: [] as { id: string; username: string; serverUrl: string; authMode: string }[], defaultAccountId: null as string | null, updateAccount: vi.fn() },
  auth: { isAuthenticated: false, authMode: 'basic', isDemoMode: false, username: 'owner@example.com', serverUrl: 'https://mail.example.com' } }));
vi.mock('next-intl', () => {
  const translate = (key: string) => key;
  return { useTranslations: () => translate };
});
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ settingsSyncEnabled: true, oauthOnly: false }) }));
vi.mock('@/lib/account-vault-client', () => ({ fetchVault: mocks.fetch, putVault: mocks.put, collectVault: mocks.collect }));
vi.mock('@/stores/auth-store', () => ({ useAuthStore: Object.assign(
  (selector: (s: typeof mocks.auth) => unknown) => selector(mocks.auth),
  { getState: () => ({ restoreVault: mocks.restore }) },
) }));
vi.mock('@/stores/account-store', () => {
  const state = mocks.registry;
  return { useAccountStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), { getState: () => state }) };
});
const owner = { username: 'owner@example.com', serverUrl: 'https://mail.example.com' };
const contents: VaultContents = { owner, accounts: [{ ...owner, password: 'mail-password', label: 'Owner', avatarColor: '#112233' }], defaultAccountId: null };
const password = 'one archive passphrase';
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('crypto', webcrypto); localStorage.clear();
  Object.assign(mocks.auth, { isAuthenticated: false, authMode: 'basic', isDemoMode: false, ...owner });
  mocks.registry.accounts = []; mocks.registry.defaultAccountId = null;
  mocks.collect.mockReturnValue(contents); mocks.restore.mockResolvedValue({ connected: 1, failed: 0, pending: 0 });
});
afterEach(() => vi.unstubAllGlobals());

describe('account archive dialog', () => {
  it('rescans from settings even after dismissal and fetches fresh data each time', async () => {
    mocks.registry.accounts = [{ ...owner, id: 'owner', authMode: 'basic' }];
    localStorage.setItem(`account-vault-prompt:${JSON.stringify([owner.username, owner.serverUrl])}`, 'dismissed');
    mocks.fetch.mockResolvedValueOnce(null).mockResolvedValueOnce({ revision: 'a'.repeat(64), envelope: await encryptVault(contents, password) });
    render(<AccountVaultSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'rescan' }));
    await screen.findByText('not_found');
    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    fireEvent.click(screen.getByRole('button', { name: 'rescan' }));
    await screen.findByLabelText('password');
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.fetch).toHaveBeenLastCalledWith(owner);
  });

  it('imports only metadata when mailbox password import is unchecked', async () => {
    mocks.fetch.mockResolvedValue({ revision: 'a'.repeat(64), envelope: await encryptVault(contents, password) });
    mocks.restore.mockResolvedValue({ connected: 0, failed: 0, pending: 1 });
    render(<AccountVault owner={owner} />);
    fireEvent.click(screen.getByRole('button', { name: 'unlock' }));
    await screen.findByLabelText('password');
    fireEvent.click(screen.getByLabelText('import_passwords'));
    expect(screen.queryByLabelText('remember')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('password'), { target: { value: password } });
    fireEvent.submit(screen.getByLabelText('password').closest('form')!);
    await waitFor(() => expect(mocks.restore).toHaveBeenCalledWith(contents, true, false));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('saves an encrypted archive with no mailbox passwords when the option is unchecked', async () => {
    const metadata = { ...contents, accounts: contents.accounts.map(({ password: _password, ...account }) => account) };
    mocks.fetch.mockResolvedValue(null);
    mocks.collect.mockImplementation((_owner: unknown, includePasswords: boolean) => includePasswords ? contents : metadata);
    mocks.put.mockImplementation(async (_owner: unknown, envelope: VaultEnvelope) => ({ revision: 'a'.repeat(64), envelope }));
    render(<AccountVault owner={owner} manage />);
    fireEvent.click(screen.getByRole('button', { name: 'manage' }));
    await screen.findByLabelText('password');
    fireEvent.click(screen.getByLabelText('save_passwords'));
    fireEvent.change(screen.getByLabelText('password'), { target: { value: password } });
    fireEvent.change(screen.getByLabelText('confirm_password'), { target: { value: password } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledOnce());
    expect(mocks.collect).toHaveBeenCalledWith(owner, false);
    expect(await decryptVault(mocks.put.mock.calls[0][1], password, owner)).toEqual(metadata);
  });

  it('offers an existing archive only after login and asks for the password only after consent', async () => {
    mocks.fetch.mockResolvedValue({ revision: 'a'.repeat(64), envelope: await encryptVault(contents, password) });
    const view = render(<AccountVaultImportPrompt />);
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.auth.isAuthenticated = true;
    view.rerender(<AccountVaultImportPrompt />);
    await screen.findByRole('dialog');
    expect(mocks.fetch).toHaveBeenCalledWith(owner);
    expect(screen.queryByLabelText('password')).not.toBeInTheDocument();
    expect(mocks.restore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'import' }));
    fireEvent.change(await screen.findByLabelText('password'), { target: { value: password } });
    fireEvent.click(screen.getByRole('button', { name: 'unlock' }));
    await waitFor(() => expect(mocks.restore).toHaveBeenCalledWith(contents, true, true));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    view.unmount();
    render(<AccountVaultImportPrompt />);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('remembers a declined import in this browser without touching account sessions', async () => {
    mocks.auth.isAuthenticated = true;
    mocks.fetch.mockResolvedValue({ revision: 'a'.repeat(64), envelope: await encryptVault(contents, password) });
    const view = render(<AccountVaultImportPrompt />);
    fireEvent.click(await screen.findByRole('button', { name: 'not_now' }));
    view.unmount();
    render(<AccountVaultImportPrompt />);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not interrupt login when no archive exists or the lookup fails', async () => {
    mocks.auth.isAuthenticated = true;
    mocks.fetch.mockResolvedValue(null);
    const view = render(<AccountVaultImportPrompt />);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.unmount();
    mocks.fetch.mockRejectedValue(new Error('offline'));
    render(<AccountVaultImportPrompt />);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('ignores a lookup that finishes after switching accounts', async () => {
    mocks.auth.isAuthenticated = true;
    const record = { revision: 'a'.repeat(64), envelope: await encryptVault(contents, password) };
    let resolve!: (value: typeof record) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue(null);
    const view = render(<AccountVaultImportPrompt />);
    mocks.auth.username = 'other@example.com';
    view.rerender(<AccountVaultImportPrompt />);
    resolve(record);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not submit the surrounding login form through portal event bubbling', async () => {
    mocks.fetch.mockResolvedValue({ revision: 'a'.repeat(64), envelope: await encryptVault(contents, password) });
    const loginSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(<form onSubmit={loginSubmit}><AccountVault owner={owner} /></form>);
    fireEvent.click(screen.getByRole('button', { name: 'unlock' }));
    await screen.findByLabelText('password');
    fireEvent.change(screen.getByLabelText('password'), { target: { value: password } });
    fireEvent.submit(screen.getByLabelText('password').closest('form')!);
    await waitFor(() => expect(mocks.restore).toHaveBeenCalledWith(contents, true, true));
    expect(loginSubmit).not.toHaveBeenCalled();
  });

  it('creates a server archive with ciphertext only after confirming the password', async () => {
    mocks.fetch.mockResolvedValue(null);
    mocks.put.mockImplementation(async (_owner: unknown, envelope: VaultEnvelope) => ({ revision: 'a'.repeat(64), envelope }));
    render(<AccountVault owner={owner} manage />);
    fireEvent.click(screen.getByRole('button', { name: 'manage' }));
    await screen.findByLabelText('password');
    fireEvent.change(screen.getByLabelText('password'), { target: { value: password } });
    fireEvent.change(screen.getByLabelText('confirm_password'), { target: { value: 'mismatch' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('password_mismatch');
    expect(mocks.put).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('confirm_password'), { target: { value: password } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledOnce());
    const envelope = mocks.put.mock.calls[0][1] as VaultEnvelope;
    expect(JSON.stringify(envelope)).not.toContain('mail-password');
    expect(await decryptVault(envelope, password, owner)).toEqual(contents);
    await waitFor(() => expect(screen.getByLabelText('password')).toHaveValue(''));
  });

  it('does not touch sessions for a wrong password, then restores with a single correct password', async () => {
    const envelope = await encryptVault(contents, password);
    mocks.fetch.mockResolvedValue({ revision: 'a'.repeat(64), envelope });
    render(<AccountVault owner={owner} />);
    fireEvent.click(screen.getByRole('button', { name: 'unlock' }));
    await screen.findByLabelText('password');
    fireEvent.change(screen.getByLabelText('password'), { target: { value: 'wrong' } });
    fireEvent.submit(screen.getByLabelText('password').closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('errors.unlock_failed');
    expect(mocks.restore).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('password'), { target: { value: password } });
    fireEvent.submit(screen.getByLabelText('password').closest('form')!);
    await waitFor(() => expect(mocks.restore).toHaveBeenCalledWith(contents, true, true));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('blocks overwriting an archive this browser has not restored', async () => {
    mocks.fetch.mockResolvedValue({ revision: 'a'.repeat(64), envelope: await encryptVault(contents, password) });
    render(<AccountVault owner={owner} manage />);
    fireEvent.click(screen.getByRole('button', { name: 'manage' }));
    await screen.findByLabelText('password');
    fireEvent.change(screen.getByLabelText('password'), { target: { value: password } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('errors.conflict');
    expect(mocks.put).not.toHaveBeenCalled();
  });
});
