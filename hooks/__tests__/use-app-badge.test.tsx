import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAppBadge } from '@/hooks/use-app-badge';

function stubBadgingApi() {
  const setAppBadge = vi.fn(async (_count?: number) => {});
  const clearAppBadge = vi.fn(async () => {});
  Object.defineProperty(navigator, 'setAppBadge', {
    value: setAppBadge,
    configurable: true,
  });
  Object.defineProperty(navigator, 'clearAppBadge', {
    value: clearAppBadge,
    configurable: true,
  });
  return { setAppBadge, clearAppBadge };
}

function removeBadgingApi() {
  // @ts-expect-error - deleting a test-only stub; the properties are typed
  // as required on Navigator (lib.dom.d.ts), so a real browser lacking them
  // is exactly what this simulates.
  delete navigator.setAppBadge;
  // @ts-expect-error - see above
  delete navigator.clearAppBadge;
}

afterEach(() => {
  removeBadgingApi();
  vi.clearAllMocks();
});

describe('useAppBadge', () => {
  it('calls setAppBadge with the count when positive', async () => {
    const { setAppBadge, clearAppBadge } = stubBadgingApi();
    renderHook(() => useAppBadge(5));

    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(5));
    expect(clearAppBadge).not.toHaveBeenCalled();
  });

  it('calls clearAppBadge when the count is zero', async () => {
    const { setAppBadge, clearAppBadge } = stubBadgingApi();
    renderHook(() => useAppBadge(0));

    await waitFor(() => expect(clearAppBadge).toHaveBeenCalled());
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it('treats disabled as a count of zero, even with unread mail', async () => {
    const { setAppBadge, clearAppBadge } = stubBadgingApi();
    renderHook(() => useAppBadge(12, false));

    await waitFor(() => expect(clearAppBadge).toHaveBeenCalled());
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it('updates the badge when the count changes', async () => {
    const { setAppBadge } = stubBadgingApi();
    const { rerender } = renderHook(({ count }) => useAppBadge(count), {
      initialProps: { count: 1 },
    });
    await waitFor(() => expect(setAppBadge).toHaveBeenLastCalledWith(1));

    rerender({ count: 7 });
    await waitFor(() => expect(setAppBadge).toHaveBeenLastCalledWith(7));
  });

  it('clears an already-set badge when count becomes zero or the setting is disabled', async () => {
    const { setAppBadge, clearAppBadge } = stubBadgingApi();
    const { rerender } = renderHook(
      ({ count, enabled }: { count: number; enabled: boolean }) => useAppBadge(count, enabled),
      { initialProps: { count: 5, enabled: true } },
    );
    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(5));

    rerender({ count: 0, enabled: true });
    await waitFor(() => expect(clearAppBadge).toHaveBeenCalledTimes(1));

    rerender({ count: 5, enabled: true });
    await waitFor(() => expect(setAppBadge).toHaveBeenCalledTimes(2));

    rerender({ count: 5, enabled: false });
    await waitFor(() => expect(clearAppBadge).toHaveBeenCalledTimes(2));
  });

  it('does not clear an unrelated window/instance on unmount', async () => {
    // The badge is scoped to the installed app, not this component — an
    // unmount must not fire a clear that would blank another open window
    // still showing a nonzero count. See the hook's doc comment.
    const { setAppBadge, clearAppBadge } = stubBadgingApi();
    const { unmount } = renderHook(() => useAppBadge(3));
    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(3));

    unmount();
    expect(clearAppBadge).not.toHaveBeenCalled();
  });

  it('is a silent no-op when the Badging API is unsupported', async () => {
    removeBadgingApi();
    expect(() => renderHook(() => useAppBadge(5))).not.toThrow();
    // Nothing to await: there is no API to have called. The assertion is
    // simply that mounting/unmounting never throws without the API present.
  });

  it('swallows a rejected setAppBadge call without throwing', async () => {
    const setAppBadge = vi.fn(async () => {
      throw new Error('boom');
    });
    Object.defineProperty(navigator, 'setAppBadge', { value: setAppBadge, configurable: true });
    Object.defineProperty(navigator, 'clearAppBadge', {
      value: vi.fn(async () => {}),
      configurable: true,
    });

    expect(() => renderHook(() => useAppBadge(2))).not.toThrow();
    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(2));
  });

  it('swallows a rejected clearAppBadge call without throwing', async () => {
    const clearAppBadge = vi.fn(async () => {
      throw new Error('boom');
    });
    Object.defineProperty(navigator, 'setAppBadge', {
      value: vi.fn(async () => {}),
      configurable: true,
    });
    Object.defineProperty(navigator, 'clearAppBadge', { value: clearAppBadge, configurable: true });

    expect(() => renderHook(() => useAppBadge(0))).not.toThrow();
    await waitFor(() => expect(clearAppBadge).toHaveBeenCalled());
  });
});
