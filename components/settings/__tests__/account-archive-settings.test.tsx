import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountArchiveSettings } from '../account-archive-settings';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), stored: null as unknown }));

vi.mock('next-intl', () => {
  const t = (key: string, values?: Record<string, unknown>) => values ? `${key} ${JSON.stringify(values)}` : key;
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('@/lib/browser-navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/browser-navigation')>()),
  apiFetch: mocks.apiFetch,
}));

const owner = { username: 'owner@x.test', serverUrl: 'https://mail.x.test' };
const account = {
  id: 'owner@x.test@mail.x.test', label: 'Work', ...owner, authMode: 'basic' as const, rememberMe: true, cookieSlot: 0,
  displayName: 'Work', email: owner.username, isConnected: true, hasError: false, lastLoginAt: 1, avatarColor: '#2563eb', isDefault: true,
};

beforeEach(() => {
  mocks.stored = null;
  mocks.apiFetch.mockReset().mockImplementation(async (_url: string, init: RequestInit = {}) => {
    if (init.method === 'PUT') mocks.stored = JSON.parse(String(init.body)).envelope;
    if (init.method === 'DELETE') mocks.stored = null;
    return new Response(JSON.stringify(init.method ? { ok: true } : { envelope: mocks.stored }), { status: 200 });
  });
  useAuthStore.setState(owner);
  useAccountStore.setState({ accounts: [account] as never, activeAccountId: account.id, defaultAccountId: account.id });
});

const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('AccountArchiveSettings', () => {
  it('saves the list encrypted, then restores it on a browser that lacks the accounts', async () => {
    render(<AccountArchiveSettings />);
    await screen.findByText(/^status_none/);
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    fill('password', 'a long backup password');
    fill('confirm', 'a different password!');
    fireEvent.submit(screen.getByLabelText('confirm').closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('errors.mismatch');
    expect(mocks.apiFetch).not.toHaveBeenCalledWith('/api/account-archive', expect.objectContaining({ method: 'PUT' }));

    fill('confirm', 'a long backup password');
    fireEvent.submit(screen.getByLabelText('confirm').closest('form')!);
    expect(await screen.findByRole('status', {}, { timeout: 5000 })).toHaveTextContent('saved {"count":1}');
    const [, init] = mocks.apiFetch.mock.calls.find(([, i]) => i?.method === 'PUT')!;
    expect(init.headers).toMatchObject({ 'x-archive-username': owner.username, 'x-archive-server': owner.serverUrl });
    expect(String(init.body)).not.toContain('x.test');
    expect(String(init.body)).not.toContain('Work');

    // Another browser: same owner signed in, the other account not there yet.
    useAccountStore.setState({ accounts: [{ ...account, label: 'Renamed', avatarColor: '#000000' }] as never });
    fireEvent.click(screen.getByRole('button', { name: 'restore' }));
    fill('password', 'a long backup password');
    fireEvent.submit(screen.getByLabelText('password').closest('form')!);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('restored'), { timeout: 5000 });
    expect(useAccountStore.getState().accounts[0]).toMatchObject({ label: 'Work', avatarColor: '#2563eb' });
  });

  it('reports a wrong restore password', async () => {
    render(<AccountArchiveSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'save' }));
    fill('password', 'a long backup password');
    fill('confirm', 'a long backup password');
    fireEvent.submit(screen.getByLabelText('confirm').closest('form')!);
    await screen.findByRole('status', {}, { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: 'restore' }));
    fill('password', 'not the password');
    fireEvent.submit(screen.getByLabelText('password').closest('form')!);
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent('errors.unlock_failed');
  });
});
