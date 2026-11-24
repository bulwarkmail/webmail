import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityManagerModal } from '@/components/identity/identity-manager-modal';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore } from '@/stores/identity-store';
import { useAccountStore } from '@/stores/account-store';
import { useSettingsStore } from '@/stores/settings-store';

// #1673: an address can be kept for replies only, so it isn't offered in
// From for new mail. The default address can't: new mail starts from it.

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

describe('offering an address for new mail', () => {
  const initial = {
    auth: useAuthStore.getState(),
    identity: useIdentityStore.getState(),
    account: useAccountStore.getState(),
  };
  beforeEach(() => {
    useAuthStore.setState({ client: null, refreshIdentities: vi.fn(), syncIdentities: vi.fn() } as never);
    useAccountStore.setState({ activeAccountId: 'acc-a' });
    useSettingsStore.setState({ replyOnlyIdentities: {} });
    useIdentityStore.setState({
      identities: [
        { id: 'me', name: 'Ann', email: 'ann@example.com', mayDelete: true },
        { id: 'family', name: 'Family', email: 'family@example.com', mayDelete: false },
      ],
    } as never);
  });
  afterEach(() => {
    useAuthStore.setState(initial.auth, true);
    useIdentityStore.setState(initial.identity, true);
    useAccountStore.setState(initial.account, true);
    useSettingsStore.setState({ replyOnlyIdentities: {} });
  });

  const switches = () => screen.queryAllByTestId('identity-offer-new-mail');

  it('has a switch on the other addresses, not on the default one', () => {
    render(<IdentityManagerModal isOpen onClose={vi.fn()} />);
    expect(switches()).toHaveLength(1);
    expect(switches()[0]).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps an address for replies only, per account', () => {
    render(<IdentityManagerModal isOpen onClose={vi.fn()} />);
    fireEvent.click(switches()[0]);
    expect(useSettingsStore.getState().replyOnlyIdentities).toEqual({ 'acc-a': ['family'] });
    expect(switches()[0]).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(switches()[0]);
    expect(useSettingsStore.getState().replyOnlyIdentities).toEqual({});
  });

  it('offers an address again once it becomes the default', () => {
    useSettingsStore.setState({ replyOnlyIdentities: { 'acc-a': ['family'], 'acc-b': ['x'] } });
    render(<IdentityManagerModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'set_as_primary' }));
    expect(useSettingsStore.getState().replyOnlyIdentities).toEqual({ 'acc-b': ['x'] });
  });
});
