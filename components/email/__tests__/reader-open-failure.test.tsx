import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReaderOpenFailure } from '../reader-open-failure';
import { serverKey, useOfflineStore } from '@/lib/offline/state';
import { useAuthStore } from '@/stores/auth-store';

// mail-p3-2: back online, the offline bar went but the reader kept "You're
// offline. This message needs a connection to open." until Retry.

const SERVER = 'https://mail.example.org';

const setOnline = (online: boolean) => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
};

beforeEach(() => {
  useAuthStore.setState({ activeAccountId: 'login-a', serverUrl: SERVER } as never);
  useOfflineStore.setState({ browserOffline: false, downServers: [] } as never);
});
afterEach(() => {
  cleanup();
  act(() => setOnline(true));
});

describe('the reader that could not open a message offline', () => {
  it('tries again by itself when the browser is back online, once', () => {
    act(() => setOnline(false));
    const onRetry = vi.fn();
    render(<ReaderOpenFailure offline onRetry={onRetry} />);
    expect(onRetry).not.toHaveBeenCalled();
    act(() => setOnline(true));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('tries again when the app finds the mail server again', () => {
    useOfflineStore.setState({ downServers: [serverKey(SERVER)] } as never);
    const onRetry = vi.fn();
    render(<ReaderOpenFailure offline onRetry={onRetry} />);
    expect(onRetry).not.toHaveBeenCalled();
    act(() => { useOfflineStore.setState({ downServers: [] } as never); });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not retry on its own while the app still counts as online, and keeps the button', () => {
    const onRetry = vi.fn();
    render(<ReaderOpenFailure offline onRetry={onRetry} />);
    expect(onRetry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('leaves a failure that was not about the connection to the button', () => {
    act(() => setOnline(false));
    const onRetry = vi.fn();
    render(<ReaderOpenFailure offline={false} onRetry={onRetry} />);
    act(() => setOnline(true));
    expect(onRetry).not.toHaveBeenCalled();
  });
});
