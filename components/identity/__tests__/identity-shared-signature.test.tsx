import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityManagerModal } from '@/components/identity/identity-manager-modal';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore } from '@/stores/identity-store';
import { useAccountStore } from '@/stores/account-store';
import { useSettingsStore } from '@/stores/settings-store';

// #1190: an address that uses another address's signature shows it read-only
// in the address editor, saying where to edit it.

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

describe('the address editor of an address using another signature', () => {
  const initial = {
    auth: useAuthStore.getState(),
    identity: useIdentityStore.getState(),
    account: useAccountStore.getState(),
  };
  beforeEach(() => {
    useAuthStore.setState({ client: null, refreshIdentities: vi.fn(), syncIdentities: vi.fn() } as never);
    useAccountStore.setState({ activeAccountId: 'acc-a' });
    useSettingsStore.setState({ plainTextMode: true, signatureSources: { 'acc-a': { sales: 'me' } } });
    useIdentityStore.setState({
      identities: [
        { id: 'me', name: 'Ann', email: 'ann@example.com', textSignature: 'Ann Lee', mayDelete: true },
        { id: 'sales', name: 'Sales', email: 'sales@example.com', textSignature: 'Ann Lee', mayDelete: true },
      ],
    } as never);
  });
  afterEach(() => {
    useAuthStore.setState(initial.auth, true);
    useIdentityStore.setState(initial.identity, true);
    useAccountStore.setState(initial.account, true);
    useSettingsStore.setState({ plainTextMode: false, signatureSources: {} });
  });

  const editCard = (index: number) => {
    render(<IdentityManagerModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'edit' })[index]);
    return screen.getByRole('dialog');
  };

  it('shows the signature read-only, with where to edit it', () => {
    const dialog = editCard(1);
    expect(within(dialog).getByTestId('shared-signature-note')).toBeTruthy();
    expect(within(dialog).getByTestId('identity-locked-signature')).toHaveTextContent('Ann Lee');
  });

  it('leaves the editor on the address whose signature it is', () => {
    const dialog = editCard(0);
    expect(within(dialog).queryByTestId('shared-signature-note')).toBeNull();
    expect(within(dialog).queryByTestId('identity-locked-signature')).toBeNull();
  });
});
