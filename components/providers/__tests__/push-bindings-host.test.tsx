import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import { PushBindingsHost } from '../push-bindings-host';
import { useCalendarPushRefresh } from '@/hooks/use-calendar-push-refresh';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { emitPushStateChange, subscribePushStateChanges } from '@/lib/push-events';
import type { JMAPClient } from '@/lib/jmap/client';
import type { StateChange } from '@/lib/jmap/types';

// Push was bound only inside the mail view, so the calendar page never heard
// of changes made elsewhere (#1349). The bindings now live at the app level
// and every surface subscribes to them.

function fakeClient() {
  let callback: ((change: StateChange) => void) | null = null;
  const client = {
    onStateChange: vi.fn((cb: (change: StateChange) => void) => { callback = cb; }),
    setupPushNotifications: vi.fn(() => true),
    closePushNotifications: vi.fn(),
    hasSSEStream: () => true,
  };
  return { client: client as unknown as JMAPClient, mock: client, push: (change: StateChange) => callback?.(change) };
}

const eventChange: StateChange = { '@type': 'StateChange', changed: { own: { CalendarEvent: 's2' } } };

describe('app-level push bindings', () => {
  const original = useAuthStore.getState().getAllConnectedClients;

  beforeEach(() => {
    useAccountStore.setState({ accounts: [] });
  });
  afterEach(() => {
    useAuthStore.setState({ isAuthenticated: false, client: null, activeAccountId: null, getAllConnectedClients: original });
  });

  it('binds the signed-in login without the mail view and hands its changes to subscribers', () => {
    const own = fakeClient();
    useAuthStore.setState({
      isAuthenticated: true,
      client: own.client,
      activeAccountId: 'acc1',
      getAllConnectedClients: () => new Map([['acc1', own.client]]),
    });
    const received = vi.fn();
    const unsubscribe = subscribePushStateChanges(received);

    const { unmount } = render(<PushBindingsHost />);
    expect(own.mock.setupPushNotifications).toHaveBeenCalledTimes(1);

    own.push(eventChange);
    expect(received).toHaveBeenCalledWith(eventChange, own.client, 'active');

    unmount();
    expect(own.mock.closePushNotifications).toHaveBeenCalled();
    unsubscribe();
  });
});

describe('calendar push refresh', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const own = fakeClient();
  const emit = (change: StateChange, role: 'active' | 'background') => emitPushStateChange(change, own.client, role);

  it('reloads once for a burst of calendar changes of the active login', () => {
    const refresh = vi.fn();
    renderHook(() => useCalendarPushRefresh(refresh, { enabled: true, includeBackground: false }));
    emit(eventChange, 'active');
    emit({ '@type': 'StateChange', changed: { own: { Calendar: 'c2' } } }, 'active');
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('ignores mail-only changes and, outside the merged view, background logins', () => {
    const refresh = vi.fn();
    renderHook(() => useCalendarPushRefresh(refresh, { enabled: true, includeBackground: false }));
    emit({ '@type': 'StateChange', changed: { own: { Email: 'e2' } } }, 'active');
    emit(eventChange, 'background');
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('takes background logins in the merged view', () => {
    const refresh = vi.fn();
    renderHook(() => useCalendarPushRefresh(refresh, { enabled: true, includeBackground: true }));
    emit(eventChange, 'background');
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
