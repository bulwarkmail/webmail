import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OfflineBanner } from '../offline-banner';
import { useAuthStore } from '@/stores/auth-store';
import { useOfflineStore } from '@/lib/offline/state';

// pass-2 mail-p2-7: in a browser tab that keeps no mail on the device, going
// offline showed no bar anywhere; a click on a message then did nothing.

const setOnline = (online: boolean) => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
};

beforeEach(() => {
  useAuthStore.setState({ activeAccountId: 'acc', serverUrl: 'https://mail.example.org' });
  useOfflineStore.setState({ enabled: [], outbox: [], conflicts: [], areaConflicts: [], localDrafts: [], browserOffline: false, downServers: [], startedOffline: false });
});

afterEach(() => {
  cleanup();
  setOnline(true);
});

describe('the offline bar for an account that keeps no mail here', () => {
  it('says that reading and changing mail needs a connection, and goes once online', () => {
    render(<OfflineBanner />);
    expect(screen.queryByTestId('offline-banner-no-store')).toBeNull();
    act(() => setOnline(false));
    expect(screen.getByTestId('offline-banner-no-store').textContent).toBe('offline_bar');
    act(() => setOnline(true));
    expect(screen.queryByTestId('offline-banner-no-store')).toBeNull();
  });

  it('leaves an account with offline mode its own bar', () => {
    useOfflineStore.setState({ enabled: ['acc'], browserOffline: true });
    render(<OfflineBanner />);
    expect(screen.queryByTestId('offline-banner-no-store')).toBeNull();
    expect(screen.getByTestId('offline-banner')).toBeTruthy();
  });

  it('shows nothing when signed out', () => {
    useAuthStore.setState({ activeAccountId: null });
    act(() => setOnline(false));
    render(<OfflineBanner />);
    expect(screen.queryByTestId('offline-banner-no-store')).toBeNull();
  });
});
