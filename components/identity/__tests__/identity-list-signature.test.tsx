import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityManagerModal } from '@/components/identity/identity-manager-modal';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore } from '@/stores/identity-store';

// The identity list shows each identity's signature. One set only as HTML
// showed as no signature at all; it shows as its text, without tags.

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

describe('identity list signature', () => {
  const initial = { auth: useAuthStore.getState(), identity: useIdentityStore.getState() };
  beforeEach(() => {
    useAuthStore.setState({ client: null, refreshIdentities: vi.fn(), syncIdentities: vi.fn() } as never);
  });
  afterEach(() => {
    useAuthStore.setState(initial.auth, true);
    useIdentityStore.setState(initial.identity, true);
  });

  it('shows an HTML-only signature as text', () => {
    useIdentityStore.setState({
      identities: [{ id: 'i1', name: 'Work', email: 'work@example.com', textSignature: '', htmlSignature: '<p>Best, <b>Ann</b></p>', mayDelete: true }],
    } as never);
    render(<IdentityManagerModal isOpen onClose={vi.fn()} />);
    const line = screen.getByText(/display\.signature/);
    expect(line.textContent).toContain('Best, Ann');
    expect(line.textContent).not.toContain('<');
  });

  it('shows a text signature as it is', () => {
    useIdentityStore.setState({
      identities: [{ id: 'i1', name: 'Work', email: 'work@example.com', textSignature: 'Cheers, Ann', htmlSignature: '', mayDelete: true }],
    } as never);
    render(<IdentityManagerModal isOpen onClose={vi.fn()} />);
    expect(screen.getByText(/display\.signature/).textContent).toContain('Cheers, Ann');
  });
});
