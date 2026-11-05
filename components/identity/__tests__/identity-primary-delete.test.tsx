import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityManagerModal } from '@/components/identity/identity-manager-modal';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore } from '@/stores/identity-store';

// settings-p3-20 (usability pass 3, 2026-11-04): "Your email addresses" offered Delete on
// the primary address, also when it was the only one. Other addresses keep it.

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

describe('deleting addresses', () => {
  const initial = { auth: useAuthStore.getState(), identity: useIdentityStore.getState() };
  beforeEach(() => {
    useAuthStore.setState({ client: null, refreshIdentities: vi.fn(), syncIdentities: vi.fn() } as never);
  });
  afterEach(() => {
    useAuthStore.setState(initial.auth, true);
    useIdentityStore.setState(initial.identity, true);
  });

  it('offers no Delete on the only address', () => {
    useIdentityStore.setState({ identities: [{ id: 'i1', name: 'Ann', email: 'ann@example.com', mayDelete: true }] } as never);
    render(<IdentityManagerModal isOpen onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'delete_button' })).toBeNull();
  });

  it('offers Delete on the other addresses, not on the primary one', () => {
    useIdentityStore.setState({
      identities: [
        { id: 'i1', name: 'Ann', email: 'ann@example.com', mayDelete: true },
        { id: 'i2', name: 'Sales', email: 'sales@example.com', mayDelete: true },
      ],
    } as never);
    render(<IdentityManagerModal isOpen onClose={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: 'delete_button' })).toHaveLength(1);
  });
});
