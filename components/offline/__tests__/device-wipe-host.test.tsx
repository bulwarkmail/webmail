import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The one toast when an account beside this one signs out by itself.

const warning = vi.hoisted(() => vi.fn());
vi.mock('@/stores/toast-store', () => ({ toast: { warning } }));
vi.mock('@/lib/offline/device-wipe', () => ({ startDeviceWipe: () => () => {} }));

const { DeviceWipeHost } = await import('../device-wipe-host');
const { useAuthStore } = await import('@/stores/auth-store');
const { markLoginRefused, setRefusedCount } = await import('@/lib/devices/wipe-state');
const { useOfflineStore, markEvicted } = await import('@/lib/offline/state');

const A = 'a@example.com';
const B = 'b@example.com';

beforeEach(() => {
  warning.mockClear();
  localStorage.clear();
  useOfflineStore.setState({ enabled: [A, B] });
  useAuthStore.setState({ activeAccountId: A, isAuthenticated: true } as never);
});

function refuseB(): void {
  markLoginRefused(B, { certain: true, seenBy: [A], label: B, username: B });
  markEvicted(B);
}

describe('the toast', () => {
  it('comes once, when the count is in, and names the account, the count and the date', () => {
    render(<DeviceWipeHost />);
    act(() => refuseB());
    expect(warning).not.toHaveBeenCalled();
    act(() => setRefusedCount(B, 2));
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0]).toBe('sibling_waiting');
    act(() => setRefusedCount(B, 2));
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('says the other thing with nothing unsent, or no number', () => {
    render(<DeviceWipeHost />);
    act(() => { refuseB(); setRefusedCount(B, null); });
    expect(warning.mock.calls[0][0]).toBe('sibling_kept');
  });

  it('isn\'t for someone signed in later', () => {
    useAuthStore.setState({ activeAccountId: 'stranger@example.com' } as never);
    refuseB();
    setRefusedCount(B, 2);
    render(<DeviceWipeHost />);
    expect(warning).not.toHaveBeenCalled();
  });

  it('shows at the next page for the one it was meant for, if it got no chance before', () => {
    refuseB();
    setRefusedCount(B, 2);
    render(<DeviceWipeHost />);
    expect(warning).toHaveBeenCalledTimes(1);
  });
});
