import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useCalendarAlerts } from '../use-calendar-alerts';
import { ToastContainer } from '@/components/ui/toast';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useCalendarNotificationStore } from '@/stores/calendar-notification-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useToastStore } from '@/stores/toast-store';
import { calendarHooks, clearAllHooks } from '@/lib/plugin-hooks';
import { useTaskStore } from '@/stores/task-store';
import type { CalendarEvent, CalendarTask } from '@/lib/jmap/types';

const sounds = vi.hoisted(() => ({ play: vi.fn(), title: vi.fn() }));
vi.mock('@/lib/notification-sound', () => ({ playNotificationSound: sounds.play }));
vi.mock('@/lib/title-alert', () => ({ startTitleAlert: sounds.title }));

// A reminder that fires tells plugins (onCalendarAlert); the user closing
// its toast tells them it was dismissed (onCalendarAlertAcknowledge). A
// toast that just times out is not a dismissal.

const fireTime = new Date(Date.now() - 60_000).toISOString();

const event = {
  id: 'e1',
  uid: 'uid-1',
  title: 'Dentist',
  start: new Date(Date.now() + 10 * 60_000).toISOString().slice(0, 19),
  utcStart: new Date(Date.now() + 10 * 60_000).toISOString(),
  duration: 'PT1H',
  calendarIds: { c1: true },
  useDefaultAlerts: false,
  alerts: {
    a1: { '@type': 'Alert', action: 'display', trigger: { '@type': 'AbsoluteTrigger', when: fireTime } },
  },
} as unknown as CalendarEvent;

const task = {
  id: 't1',
  '@type': 'Task',
  uid: 'uid-t1',
  title: 'Call back Anna',
  calendarIds: { c1: true },
  due: new Date(Date.now() + 60 * 60_000).toISOString().slice(0, 19),
  start: null,
  progress: 'needs-action',
  useDefaultAlerts: false,
  alerts: {
    'follow-up': { '@type': 'Alert', action: 'display', trigger: { '@type': 'AbsoluteTrigger', when: fireTime } },
  },
} as unknown as CalendarTask;

function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);
  return <ToastContainer toasts={toasts} onClose={removeToast} />;
}

beforeEach(() => {
  clearAllHooks();
  useToastStore.setState({ toasts: [] });
  useCalendarNotificationStore.getState().clearAll();
  useAuthStore.setState({ isAuthenticated: true, client: null });
  useSettingsStore.setState({
    calendarNotificationsEnabled: true, calendarNotificationSound: false, enableCalendarTasks: false,
    doNotDisturb: false, visualAlerts: false,
  });
  useCalendarStore.setState({ events: [event], calendars: [] });
  useTaskStore.setState({ tasks: [] });
  sounds.play.mockClear();
  sounds.title.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('reminder hooks', () => {
  it('reports a fired reminder once, and its dismissal when the user closes it', async () => {
    const fired = vi.fn();
    const acknowledged = vi.fn();
    calendarHooks.onCalendarAlert.register('t', fired);
    calendarHooks.onCalendarAlertAcknowledge.register('t', acknowledged);

    renderHook(() => useCalendarAlerts());
    render(<Toasts />);

    await waitFor(() => expect(fired).toHaveBeenCalledTimes(1));
    expect(fired).toHaveBeenCalledWith({
      id: 'a1', eventId: 'e1', eventTitle: 'Dentist', triggerTime: new Date(fireTime).toISOString(),
    });
    expect(acknowledged).not.toHaveBeenCalled();

    const close = screen.getByText('Dentist').closest('.toast-item')!.querySelector('button:last-of-type')!;
    fireEvent.click(close);
    expect(acknowledged).toHaveBeenCalledTimes(1);
    expect(acknowledged).toHaveBeenCalledWith({ alertId: 'a1', eventId: 'e1' });

    // Re-checking does not fire the same reminder again.
    act(() => { useCalendarStore.setState({ events: [{ ...event }] }); });
    expect(fired).toHaveBeenCalledTimes(1);
  });
});

describe('a task reminder', () => {
  beforeEach(() => {
    useSettingsStore.setState({ enableCalendarTasks: true });
    useCalendarStore.setState({ events: [] });
    useTaskStore.setState({ tasks: [task] });
  });

  it('reaches plugins with its task id, and its dismissal too', async () => {
    const fired = vi.fn();
    const acknowledged = vi.fn();
    calendarHooks.onCalendarAlert.register('t', fired);
    calendarHooks.onCalendarAlertAcknowledge.register('t', acknowledged);

    renderHook(() => useCalendarAlerts());
    render(<Toasts />);

    await waitFor(() => expect(fired).toHaveBeenCalledTimes(1));
    expect(fired).toHaveBeenCalledWith({
      id: 'follow-up', taskId: 't1', taskTitle: 'Call back Anna', triggerTime: new Date(fireTime).toISOString(),
    });

    const close = screen.getByText('Call back Anna').closest('.toast-item')!.querySelector('button:last-of-type')!;
    fireEvent.click(close);
    expect(acknowledged).toHaveBeenCalledWith({ alertId: 'follow-up', taskId: 't1' });
  });
});

describe('a plugin that shows the reminder itself', () => {
  beforeEach(() => {
    useSettingsStore.setState({ calendarNotificationSound: true, visualAlerts: true, enableCalendarTasks: true });
    useTaskStore.setState({ tasks: [task] });
  });

  it('takes over a task reminder: no toast, sound or title alert, the event reminder as before', async () => {
    const fired = vi.fn();
    const before = vi.fn((alert: { taskId?: string }) => (alert.taskId ? false : undefined));
    calendarHooks.onCalendarAlert.register('t', fired);
    calendarHooks.onBeforeCalendarAlert.register('t', before);

    renderHook(() => useCalendarAlerts());
    render(<Toasts />);

    await waitFor(() => expect(screen.queryByText('Dentist')).not.toBeNull());
    expect(before).toHaveBeenCalledWith({
      id: 'follow-up', taskId: 't1', taskTitle: 'Call back Anna', triggerTime: new Date(fireTime).toISOString(),
    });
    expect(before).toHaveBeenCalledWith({
      id: 'a1', eventId: 'e1', eventTitle: 'Dentist', triggerTime: new Date(fireTime).toISOString(),
    });
    // Both still reported as fired, so the plugin knows.
    expect(fired).toHaveBeenCalledTimes(2);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText('Call back Anna')).toBeNull();
    expect(sounds.play).toHaveBeenCalledTimes(1);
    expect(sounds.title).toHaveBeenCalledTimes(1);
  });

  it('takes over an event reminder too', async () => {
    useTaskStore.setState({ tasks: [] });
    const before = vi.fn(() => false);
    calendarHooks.onBeforeCalendarAlert.register('t', before);

    renderHook(() => useCalendarAlerts());
    render(<Toasts />);

    await waitFor(() => expect(before).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText('Dentist')).toBeNull();
    expect(sounds.play).not.toHaveBeenCalled();
    expect(sounds.title).not.toHaveBeenCalled();
  });

  it('leaves the reminder to Bulwark when the handler fails', async () => {
    useTaskStore.setState({ tasks: [] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    calendarHooks.onBeforeCalendarAlert.register('t', () => { throw new Error('broken'); });

    renderHook(() => useCalendarAlerts());
    render(<Toasts />);

    await waitFor(() => expect(screen.queryByText('Dentist')).not.toBeNull());
    expect(sounds.play).toHaveBeenCalledTimes(1);
    expect(sounds.title).toHaveBeenCalledTimes(1);
  });
});

describe('toast onDismiss', () => {
  it('runs when the user closes the toast, not when it times out', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toasts />);

    act(() => { useToastStore.getState().addToast({ type: 'info', title: 'Times out', duration: 1000, onDismiss }); });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.queryByText('Times out')).toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => { useToastStore.getState().addToast({ type: 'info', title: 'Closed', duration: 10_000, onDismiss }); });
    const close = screen.getByText('Closed').closest('.toast-item')!.querySelector('button:last-of-type')!;
    fireEvent.click(close);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
