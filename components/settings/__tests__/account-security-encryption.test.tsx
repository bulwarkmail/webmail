import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AccountSecuritySettings } from '@/components/settings/account-security-settings';
import { useAccountSecurityStore, type EncryptionType } from '@/stores/account-security-store';
import { useAuthStore } from '@/stores/auth-store';

// Settings > Security, encryption at rest: Stalwart 1.0.2 and later report
// `Enabled` and take the cipher from the key; 1.0.0 and 1.0.1 report the
// per-account cipher (Aes128 / Aes256).

function renderWith(type: EncryptionType) {
  useAuthStore.setState({ isAuthenticated: false, authMode: 'basic', client: null } as never);
  useAccountSecurityStore.setState({
    isStalwart: true, isProbing: false, otpEnabled: false, isSaving: false,
    isLoadingAuth: false, isLoadingPrincipal: false, displayName: 'Ann',
    appPasswords: [], apiKeys: [],
    publicKeys: [
      { id: 'k1', description: 'Used key', key: 'ARMORED-1', emailAddresses: [] },
      { id: 'k2', description: 'Other key', key: 'ARMORED-2', emailAddresses: [] },
    ],
    encryptionConfig: { type, publicKeyId: 'k1', encryptOnAppend: false, allowSpamTraining: false },
  } as never);
  render(<AccountSecuritySettings />);
}

function openConfigureForOtherKey() {
  const buttons = screen.getAllByRole('button', { name: /encryption\.enable_tooltip/ });
  act(() => { fireEvent.click(buttons[0]); });
  expect(screen.getByText(/encryption\.configure_title/)).toBeTruthy();
}

describe('encryption at rest settings', () => {
  it('labels the key in use without the raw Enabled type (Stalwart 1.0.2 and later)', () => {
    renderWith('Enabled');
    expect(screen.queryByText('Enabled')).toBeNull();
    expect(screen.getByText(/encryption\.in_use/)).toBeTruthy();

    openConfigureForOtherKey();
    expect(screen.queryByLabelText(/encryption\.algorithm_label/)).toBeNull();
  });

  it('shows the cipher and the cipher picker when the server reports one (Stalwart 1.0.0 and 1.0.1)', () => {
    renderWith('Aes256');
    expect(screen.getByText('AES-256', { selector: 'span' })).toBeTruthy();

    openConfigureForOtherKey();
    expect(screen.getByLabelText(/encryption\.algorithm_label/)).toBeTruthy();
  });
});
