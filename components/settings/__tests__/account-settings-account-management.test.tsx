import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSettings } from '../account-settings';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';

// #1570: Lite has no Security tab, so a host can link Settings > Account to
// the mail server's own page for 2FA and app passwords.

const config = { accountManagementUrl: '', accountManagementLabel: '' };

vi.mock('next-intl', () => {
  const t = (key: string) => key;
  return { useTranslations: () => t, useLocale: () => 'en' };
});
vi.mock('@/hooks/use-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-config')>()),
  useConfig: () => config,
}));
vi.mock('@/lib/stalwart/principal', () => ({ fetchPrincipalDisplayName: vi.fn(async () => '') }));
vi.mock('../identity-settings', () => ({ EmailAddressesSection: () => null }));
vi.mock('../layout-settings', () => ({ MultipleAccountsSection: () => null }));
vi.mock('../sign-out-row', () => ({ SignOutRow: () => null }));
vi.mock('../account-archive-settings', () => ({ AccountArchiveSettings: () => null }));
vi.mock('../your-name-row', () => ({ YourNameRow: () => null }));

beforeEach(() => {
  config.accountManagementUrl = '';
  config.accountManagementLabel = '';
  useAccountStore.setState({ accounts: [], activeAccountId: 'a', defaultAccountId: 'a' });
  useAuthStore.setState({
    username: 'sam@x.test', serverUrl: 'https://mail.x.test', isDemoMode: false, authMode: 'oauth',
    client: { getSharedAccounts: () => [] } as never, activeAccountId: 'a', identities: [], primaryIdentity: null,
  } as never);
});

describe('Account: link to the server account page (#1570)', () => {
  it('shows no link when none is configured', () => {
    render(<AccountSettings />);
    expect(screen.getByText('auth_method_oauth')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /account_management_link/ })).toBeNull();
  });

  it('links to the configured page in a new tab under Authentication', () => {
    config.accountManagementUrl = '/account/';
    render(<AccountSettings />);
    const link = screen.getByRole('link', { name: 'account_management_link' });
    expect(link).toHaveAttribute('href', '/account/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('uses the configured link text', () => {
    config.accountManagementUrl = 'https://mail.x.test/account/';
    config.accountManagementLabel = 'Security and app passwords';
    render(<AccountSettings />);
    expect(screen.getByRole('link', { name: 'Security and app passwords' })).toHaveAttribute('href', 'https://mail.x.test/account/');
  });
});
