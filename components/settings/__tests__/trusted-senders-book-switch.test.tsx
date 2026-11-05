import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivacySettings } from '../privacy-settings';
import { useAuthStore } from '@/stores/auth-store';
import { useContactStore } from '@/stores/contact-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useToastStore } from '@/stores/toast-store';

// Settings > Privacy: "Keep the list in your address book" shows as
// unavailable, with the reason, where the account has no address books.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
  useFormatter: () => ({ dateTime: String, relativeTime: String, number: String }),
}));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ demoMode: false }) }));
vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const locks = new Set<string>();

function bookSwitch() {
  return screen.getByTestId('trusted-senders-book-switch') as HTMLButtonElement;
}

beforeEach(() => {
  locks.clear();
  usePolicyStore.setState({
    ...usePolicyStore.getState(),
    loaded: true,
    policy: {},
    isSettingLocked: (key: string) => locks.has(key),
    isSettingHidden: () => false,
    isFeatureEnabled: () => true,
    isPluginForceEnabled: () => false,
  } as never);
  useSettingsStore.getState().resetToDefaults();
  useContactStore.setState({
    trustedSenderEmails: [],
    trustedSendersBookId: null,
    trustedSendersLoaded: false,
    trustedSendersLoading: false,
    trustedSendersBookUnavailable: false,
  });
  useToastStore.setState({ toasts: [] });
});

describe('Keep the list in your address book', () => {
  it('is on where the account has address books', async () => {
    useAuthStore.setState({
      client: {
        getAccountId: () => 'acct-1',
        supportsContacts: () => true,
        getAddressBooks: vi.fn(async () => [{ id: 'book', name: 'Trusted Senders' }]),
        getContacts: vi.fn(async () => []),
      } as never,
    });
    render(<PrivacySettings />);
    await waitFor(() => expect(useContactStore.getState().trustedSendersLoaded).toBe(true));
    expect(bookSwitch()).toHaveAttribute('aria-checked', 'true');
    expect(bookSwitch()).not.toBeDisabled();
    expect(screen.getByText('trusted_senders.use_address_book_description')).toBeInTheDocument();
  });

  it('shows as unavailable, with the reason and no error, on a server without address books', async () => {
    useSettingsStore.setState({ trustedSenders: ['a@example.org', 'b@example.org'] });
    useAuthStore.setState({ client: { getAccountId: () => 'acct-1', supportsContacts: () => false } as never });
    render(<PrivacySettings />);
    expect(bookSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(bookSwitch()).toBeDisabled();
    expect(screen.getByText('unavailable')).toBeInTheDocument();
    expect(screen.getByText('trusted_senders.count_other')).toBeInTheDocument();
    await waitFor(() => expect(useContactStore.getState().trustedSendersBookUnavailable).toBe(true));
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('shows the organisation lock', () => {
    locks.add('trustedSendersAddressBook');
    useAuthStore.setState({ client: { getAccountId: () => 'acct-1', supportsContacts: () => false } as never });
    render(<PrivacySettings />);
    expect(bookSwitch().closest('[inert]')).not.toBeNull();
  });
});
