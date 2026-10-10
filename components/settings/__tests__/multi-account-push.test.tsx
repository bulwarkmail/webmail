import { render, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MultiAccountPushSettings } from '../multi-account-push';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import * as webPush from '@/lib/web-push';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
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
});
