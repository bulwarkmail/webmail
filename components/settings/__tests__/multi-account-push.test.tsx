import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MultiAccountPushSettings } from '../multi-account-push';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import * as webPush from '@/lib/web-push';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}));

vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Push state is stored under the JMAP account id the server assigned: only
// "jmap-a" has a registration here.
vi.mock('@/lib/web-push', () => ({
  isWebPushSupported: () => true,
  isWebPushEnabled: vi.fn(async (id: string) => id === 'jmap-a'),
  enableWebPushForAccounts: vi.fn(),
  disableWebPush: vi.fn(),
}));

describe('MultiAccountPushSettings', () => {
  it('reads each login\'s push state under its JMAP account id', async () => {
    const clients: Record<string, { getAccountId: () => string }> = {
      'a@mail.example.com': { getAccountId: () => 'jmap-a' },
      'b@mail.example.com': { getAccountId: () => 'jmap-b' },
    };
    useAccountStore.setState({
      accounts: [
        { id: 'a@mail.example.com', username: 'a', email: 'a@example.com', isConnected: true },
        { id: 'b@mail.example.com', username: 'b', email: 'b@example.com', isConnected: true },
      ] as never,
    });
    useAuthStore.setState({ getClientForAccount: ((id: string) => clients[id]) as never });

    const { container } = render(<MultiAccountPushSettings />);

    await waitFor(() => expect(container.textContent).toContain('a@example.com · state_on'));
    expect(container.textContent).toContain('b@example.com · state_off');
    expect(webPush.isWebPushEnabled).toHaveBeenCalledWith('jmap-a');
    expect(webPush.isWebPushEnabled).not.toHaveBeenCalledWith('a@mail.example.com');
  });

  it('names each account the bulk enable left off, with the reason', async () => {
    const clients: Record<string, { getAccountId: () => string }> = {
      'a@mail.example.com': { getAccountId: () => 'jmap-a' },
      'b@mail.example.com': { getAccountId: () => 'jmap-b' },
      'c@mail.example.com': { getAccountId: () => 'jmap-c' },
    };
    useAccountStore.setState({
      accounts: [
        { id: 'a@mail.example.com', username: 'a', email: 'a@example.com', displayName: 'Alice', isConnected: true },
        { id: 'b@mail.example.com', username: 'b', email: 'b@example.com', displayName: 'Bob', isConnected: true },
        { id: 'c@mail.example.com', username: 'c', email: 'c@example.com', displayName: 'Carol', isConnected: true },
      ] as never,
    });
    useAuthStore.setState({ getClientForAccount: ((id: string) => clients[id]) as never });
    vi.mocked(webPush.enableWebPushForAccounts).mockResolvedValueOnce({
      enabled: ['a@mail.example.com'],
      failed: [
        { accountId: 'b@mail.example.com', error: new Error('relay unreachable') },
        { accountId: 'c@mail.example.com', error: 'timeout' },
      ],
    });

    render(<MultiAccountPushSettings />);
    await waitFor(() => expect(screen.getByText('select_all')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('select_all'));
    fireEvent.click(screen.getByText('enable_selected'));

    const alert = await screen.findByRole('alert');
    expect(screen.getByText(/result_partial/).textContent).toContain('"enabled":1,"failed":2');
    expect(alert.textContent).toContain('Bob (b@example.com): relay unreachable');
    expect(alert.textContent).toContain('Carol (c@example.com): timeout');
    expect(alert.textContent).not.toContain('Alice');
  });
});
