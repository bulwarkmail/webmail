import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopKeystoreSettings } from '../desktop-keystore-settings';

// Taking back a server's use of the certificates on this computer. The stored yes lives
// in the shell; this row is the way out, and only shows when there is something to take back.

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast }));
vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function bridge(state: string) {
  const revokeAccess = vi.fn(async () => {});
  (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop = {
    version: 1,
    platform: 'win32',
    keystore: { accessState: vi.fn(async () => state), revokeAccess },
  };
  return revokeAccess;
}

afterEach(() => {
  delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
  toast.success.mockClear();
});

describe('the keystore access row', () => {
  it('takes back a stored yes through the shell, and goes away', async () => {
    const revoke = bridge('stored');
    render(<DesktopKeystoreSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'revoke' }));
    await waitFor(() => expect(revoke).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'revoke' })).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('revoked');
  });

  it.each(['off', 'policy', 'app'])('shows nothing when the state is %s', async (state) => {
    bridge(state);
    const { container } = render(<DesktopKeystoreSettings />);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(container.textContent).toBe('');
  });

  it('shows nothing in a browser', async () => {
    const { container } = render(<DesktopKeystoreSettings />);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(container.textContent).toBe('');
  });
});
