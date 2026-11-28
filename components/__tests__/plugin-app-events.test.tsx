import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { appLifecycleHooks, clearAllHooks, routerHooks } from '@/lib/plugin-hooks';
import { usePluginStore } from '@/stores/plugin-store';
import { useAuthStore } from '@/stores/auth-store';
import { useThemeStore } from '@/stores/theme-store';

let pathname = '/';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

import { PluginAppEvents, PLUGIN_INTERVAL_MS } from '../providers/plugin-app-events';

function listen<T extends { register: (id: string, fn: (...a: unknown[]) => unknown) => unknown }>(bus: T) {
  const fn = vi.fn();
  bus.register('test', fn);
  return fn;
}

beforeEach(() => {
  clearAllHooks();
  pathname = '/';
  usePluginStore.setState({ initialized: false, initializePlugins: vi.fn().mockResolvedValue(undefined) });
  useThemeStore.setState({ syncServerThemes: vi.fn().mockResolvedValue(undefined) });
  useAuthStore.setState({ isAuthenticated: false, tokenExpiresAt: null });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('app events for plugins', () => {
  // These used to live in the mail view and stopped on every other page.
  it('reports the network and tab state on any page', () => {
    const online = listen(appLifecycleHooks.onOnline);
    const visibility = listen(appLifecycleHooks.onVisibilityChange);
    render(<PluginAppEvents />);

    act(() => { window.dispatchEvent(new Event('online')); });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });

    expect(online).toHaveBeenCalledTimes(1);
    expect(visibility).toHaveBeenCalledWith({ visible: true });
  });

  it('reports unhandled errors', () => {
    const errors = listen(appLifecycleHooks.onAppError);
    render(<PluginAppEvents />);

    act(() => { window.dispatchEvent(new ErrorEvent('error', { message: 'boom' })); });

    expect(errors).toHaveBeenCalledWith({ message: 'boom' });
  });

  it('ticks once a minute', () => {
    vi.useFakeTimers();
    const tick = listen(appLifecycleHooks.onInterval);
    render(<PluginAppEvents />);

    act(() => { vi.advanceTimersByTime(PLUGIN_INTERVAL_MS * 2 + 10); });

    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('says the app is ready once, after sign-in and plugin start', () => {
    const ready = listen(appLifecycleHooks.onAppReady);
    const { rerender } = render(<PluginAppEvents />);
    expect(ready).not.toHaveBeenCalled();

    act(() => {
      useAuthStore.setState({ isAuthenticated: true });
      usePluginStore.setState({ initialized: true });
    });
    rerender(<PluginAppEvents />);
    act(() => { usePluginStore.setState({ initialized: false }); });
    act(() => { usePluginStore.setState({ initialized: true }); });

    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('starts the plugins once the user is signed in, on any page', () => {
    render(<PluginAppEvents />);
    expect(usePluginStore.getState().initializePlugins).not.toHaveBeenCalled();

    act(() => { useAuthStore.setState({ isAuthenticated: true }); });

    expect(usePluginStore.getState().initializePlugins).toHaveBeenCalledTimes(1);
  });

  // A tab that slept past its token got a 401 from /api/plugins, and the
  // start was never tried again (#1895).
  it('starts the plugins again once the session is renewed, while they are not started', () => {
    act(() => { useAuthStore.setState({ isAuthenticated: true, tokenExpiresAt: 1000 }); });
    render(<PluginAppEvents />);
    const initialize = usePluginStore.getState().initializePlugins as ReturnType<typeof vi.fn>;
    initialize.mockClear();

    act(() => { useAuthStore.setState({ tokenExpiresAt: 2000 }); });
    expect(initialize).toHaveBeenCalledTimes(1);

    act(() => { usePluginStore.setState({ initialized: true }); });
    act(() => { useAuthStore.setState({ tokenExpiresAt: 3000 }); });
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(useThemeStore.getState().syncServerThemes).toHaveBeenCalledTimes(1);
  });

  // A theme the admin installed used to arrive only once the mail view had
  // been opened, so Settings opened directly never listed it.
  it('syncs the server themes once the user is signed in, on any page', () => {
    pathname = '/settings';
    render(<PluginAppEvents />);
    expect(useThemeStore.getState().syncServerThemes).not.toHaveBeenCalled();

    act(() => { useAuthStore.setState({ isAuthenticated: true }); });

    expect(useThemeStore.getState().syncServerThemes).toHaveBeenCalledTimes(1);
  });

  it('reports navigation between pages', () => {
    const navigate = listen(routerHooks.onNavigate);
    const { rerender } = render(<PluginAppEvents />);

    pathname = '/calendar';
    rerender(<PluginAppEvents />);

    expect(navigate).toHaveBeenCalledWith({ path: '/calendar', from: '/' });
  });
});
