/**
 * A first visit installs the service worker once the first screen is up, not
 * during it: once a worker takes over, every request of the page goes through
 * it. A page a worker already serves registers at once (the update check),
 * and so does a browser that keeps accounts or mail for offline use.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { ServiceWorkerRegistration, FIRST_INSTALL_DELAY_MS } from '@/components/service-worker-registration';
import { useOfflineStore } from '@/lib/offline/state';
import { LOCAL_COOKIE } from '@/lib/signed-out-start';

vi.mock('@/lib/app-update', () => ({
  adoptWaitingWorker: vi.fn(),
  announceBuildToServiceWorker: vi.fn(),
  serviceWorkerUrl: () => '/sw.js?v=test',
  SW_SCOPE: '/',
}));

const register = vi.fn(() => Promise.resolve({}));
let controller: object | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('NODE_ENV', 'production');
  register.mockClear();
  controller = null;
  delete (window as unknown as Record<string, unknown>).__bulwarkSwRegistering;
  useOfflineStore.setState({ enabled: [] });
  document.cookie = `${LOCAL_COOKIE}=; Max-Age=0; Path=/`;
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register,
      get controller() { return controller; },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  // No idle callbacks in jsdom: the timer path runs.
  delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('ServiceWorkerRegistration', () => {
  it('waits with the first install until the first screen is up', () => {
    render(<ServiceWorkerRegistration />);
    expect(register).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FIRST_INSTALL_DELAY_MS - performance.now() - 50);
    expect(register).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FIRST_INSTALL_DELAY_MS);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('registers at once when a worker already serves the page', () => {
    controller = {};
    render(<ServiceWorkerRegistration />);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('does not install after the page went away', () => {
    const { unmount } = render(<ServiceWorkerRegistration />);
    unmount();
    vi.advanceTimersByTime(FIRST_INSTALL_DELAY_MS * 2);
    expect(register).not.toHaveBeenCalled();
  });

  it('registers at once in a browser that keeps mail for offline use', () => {
    useOfflineStore.setState({ enabled: ['acct-1'] });
    render(<ServiceWorkerRegistration />);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('registers at once in a browser that keeps accounts', () => {
    document.cookie = `${LOCAL_COOKIE}=1; Path=/`;
    render(<ServiceWorkerRegistration />);
    expect(register).toHaveBeenCalledTimes(1);
  });
});
