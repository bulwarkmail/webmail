import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { MissedRemindersDialog } from '@/components/calendar/missed-reminders-dialog';
import { ToastContainer } from '@/components/ui/toast';
import { useCalendarAlerts } from '../use-calendar-alerts';
import { useStoreReminders } from '../use-store-reminders';
import { useMissedReminders, useReminderSource } from '@/lib/calendar-reminders/state';
import { setAppLockCheck } from '@/lib/desktop/app-lock-state';
import type { BulwarkDesktopBridge, DesktopOsNotification, DesktopOsNotifyResult } from '@/lib/desktop/types';
import { calendarHooks, clearAllHooks } from '@/lib/plugin-hooks';
import { useOfflineStore } from '@/lib/offline/state';
import { emitStoreEvent } from '@/lib/offline/store-events';
import { CALENDAR_SESSION, FakeCalendarJmap } from '@/lib/store/__tests__/helpers/fake-calendar';
import { InProcessStore } from '@/lib/store/__tests__/helpers/in-process-store';
import { setStoreBackend } from '@/lib/store/client/api';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarNotificationStore } from '@/stores/calendar-notification-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useToastStore } from '@/stores/toast-store';

const sounds = vi.hoisted(() => ({ play: vi.fn() }));
vi.mock('@/lib/notification-sound', () => ({ playNotificationSound: sounds.play }));
vi.mock('@/lib/title-alert', () => ({ startTitleAlert: vi.fn() }));
// Real crypto takes real time, and fake time would run ahead of it.
vi.mock('@/lib/pwa-notify/login-fingerprint', () => ({ loginFingerprint: async () => 'fingerprint' }));
vi.mock('@/lib/offline/availability', () => ({ offlineActive: () => true }));
const popout = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/popout/window-role', async (original) => ({
  ...await original<typeof import('@/lib/popout/window-role')>(),
  isPopoutWindow: () => popout.value,
}));

const MIN = 60_000;
const ACCOUNT = 'acc';
const START = Date.UTC(2026, 10, 10, 9);
const FIRE = START - 15 * MIN;
const ALERT = { '@type': 'Alert', action: 'display', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' } };
const LINK = { virtualLocations: { v: { '@type': 'VirtualLocation', uri: 'https://meet.jit.si/standup' } } };

function event(partial: Record<string, unknown> = {}) {
  return { id: 'e1', uid: 'uid-1', title: 'Standup', start: '2026-11-10T10:00:00', timeZone: 'Europe/Berlin', duration: 'PT30M', alerts: { a: ALERT }, ...partial };
}

let store: InProcessStore;
let server: FakeCalendarJmap;
let notifyResult: DesktopOsNotifyResult;
const notify = vi.fn(async (_notification: DesktopOsNotification) => notifyResult);
const openExternal = vi.fn();

function desktop() {
  window.bulwarkDesktop = { version: 1, platform: 'win32', windows: { focus: vi.fn() }, shell: { openExternal }, os: { notify } } as unknown as BulwarkDesktopBridge;
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);
  return <ToastContainer toasts={toasts} onClose={removeToast} />;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function syncedWith(...events: Record<string, unknown>[]) {
  for (const partial of events) server.addEvent(partial);
  await store.sync(ACCOUNT);
}

const toastTitles = () => useToastStore.getState().toasts.map((toast) => toast.title);

beforeEach(() => {
  vi.useFakeTimers({ now: FIRE - 30 * MIN, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.clearAllMocks();
  popout.value = false;
  clearAllHooks();
  localStorage.clear();
  setAppLockCheck(null);
  setVisibility('visible');
  notifyResult = { shown: true, playSound: false };
  useToastStore.setState({ toasts: [] });
  useReminderSource.setState({ driven: {} });
  useMissedReminders.getState().close();
  useCalendarNotificationStore.getState().clearAll();
  useOfflineStore.setState({ enabled: [ACCOUNT] });
  useAuthStore.setState({ isAuthenticated: true, client: null, activeAccountId: ACCOUNT });
  useCalendarStore.setState({ events: [], calendars: [] });
  useSettingsStore.setState({
    calendarNotificationsEnabled: true, calendarNotificationSound: true, enableCalendarTasks: true,
    doNotDisturb: false, visualAlerts: false, timeZone: 'Europe/Berlin',
  });
  server = new FakeCalendarJmap('1.0');
  store = new InProcessStore(server, CALENDAR_SESSION);
  setStoreBackend(store);
});

afterEach(() => {
  setStoreBackend(null);
  window.bulwarkDesktop = undefined;
  setAppLockCheck(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('in the desktop app', () => {
  beforeEach(desktop);

  it('fires a native notification with the window hidden, at the time, with the network gone', async () => {
    await syncedWith(event(LINK));
    await store.setOnline(false);
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now() - 1000);
    expect(notify).not.toHaveBeenCalled();
    await advance(1000);
    expect(notify).toHaveBeenCalledTimes(1);
    const sent = notify.mock.calls[0][0];
    expect(sent.title).toBe('Standup');
    expect(sent.actions!.map((action) => action.id)).toEqual(['join', 'open', 'snooze-5', 'snooze-10', 'snooze-15']);
    expect(toastTitles()).toEqual([]);
  });

  it('shows no Join for an event without a link', async () => {
    await syncedWith(event());
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now());
    expect(notify.mock.calls[0][0].actions!.map((action) => action.id)).not.toContain('join');
  });

  it('plays the sound main asks for, and asks for none in Do not disturb', async () => {
    await syncedWith(event());
    notifyResult = { shown: true, playSound: true };
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now());
    expect(notify.mock.calls[0][0].sound).toBe(true);
    expect(sounds.play).toHaveBeenCalledTimes(1);

    useSettingsStore.setState({ doNotDisturb: true });
    await syncedWith(event({ id: 'e2', uid: 'uid-2', start: '2026-11-10T10:01:00' }));
    emitStoreEvent({ type: 'changed', account: ACCOUNT, collections: ['CalendarEvent'] });
    await advance(MIN);
    expect(notify.mock.calls[1][0].sound).toBe(false);
  });

  it('shows it in the app when the window is in front, with the same choices', async () => {
    await syncedWith(event(LINK));
    notifyResult = { shown: false, reason: 'focused', playSound: true };
    render(<Toasts />);
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now());
    expect(toastTitles()).toEqual(['Standup']);
    expect(sounds.play).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('button').map((button) => button.textContent).filter(Boolean)).toEqual(['snooze', 'snooze', 'snooze', 'join', 'open']);
    fireEvent.click(screen.getByText('join'));
    await advance(0);
    expect(openExternal).toHaveBeenCalledWith('https://meet.jit.si/standup');
  });

  it('snoozing from the in-app toast brings it back, and closing it does not', async () => {
    await syncedWith(event());
    notifyResult = { shown: false, reason: 'focused', playSound: false };
    render(<Toasts />);
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now());
    fireEvent.click(screen.getAllByText('snooze')[0]);
    await advance(5 * MIN);
    expect(notify).toHaveBeenCalledTimes(2);

    await advance(1000);
    const again = useToastStore.getState().toasts.at(-1)!;
    act(() => again.onDismiss!());
    await advance(60 * MIN);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('holds what fires while paused or in quiet hours for the summary afterwards', async () => {
    await syncedWith(event());
    notifyResult = { shown: false, reason: 'quiet-hours', playSound: false };
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now());
    expect(notify).toHaveBeenCalledTimes(1);
    expect(toastTitles()).toEqual([]);

    // Still quiet: the summary is tried and put back.
    await advance(5 * MIN);
    const tried = notify.mock.calls.length;
    expect(notify.mock.calls.at(-1)![0].id).toMatch(/^reminder-missed:/);

    notifyResult = { shown: true, playSound: false };
    await advance(5 * MIN);
    expect(notify.mock.calls.length).toBe(tried + 1);
    expect(notify.mock.calls.at(-1)![0].body).toBe('Standup');

    await advance(30 * MIN);
    expect(notify.mock.calls.length).toBe(tried + 1);
  });

  it('says nothing of the event while locked, and tells afterwards', async () => {
    await syncedWith(event());
    let locked = true;
    setAppLockCheck(() => locked);
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now());
    expect(notify).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(notify.mock.calls[0][0])).not.toContain('Standup');
    expect(notify.mock.calls[0][0].actions).toBeUndefined();
    expect(toastTitles()).toEqual([]);

    await advance(10 * MIN);
    expect(notify).toHaveBeenCalledTimes(1);

    locked = false;
    await advance(5 * MIN);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0].body).toBe('Standup');
  });

  it('summarises what was missed once, with a native notification, across a restart', async () => {
    await syncedWith(event(), event({ id: 'e2', uid: 'uid-2', title: 'Review' }));
    const before = renderHook(() => useStoreReminders());
    await advance(0);
    before.unmount();
    vi.setSystemTime(FIRE + 3 * 60 * MIN);

    const after = renderHook(() => useStoreReminders());
    await advance(20_000);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ title: 'missed_title', body: 'Standup, Review' });
    after.unmount();

    renderHook(() => useStoreReminders());
    await advance(60 * MIN);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('summarises in the app when the window is in front, and the dialog lists them', async () => {
    await syncedWith(event(LINK), event({ id: 'e2', uid: 'uid-2', title: 'Review' }));
    notifyResult = { shown: false, reason: 'focused', playSound: false };
    const before = renderHook(() => useStoreReminders());
    await advance(0);
    before.unmount();
    vi.setSystemTime(FIRE + 3 * 60 * MIN);
    render(<><Toasts /><MissedRemindersDialog /></>);
    renderHook(() => useStoreReminders());
    await advance(20_000);
    expect(toastTitles()).toEqual(['missed_title']);
    fireEvent.click(screen.getByText('missed_show'));
    await advance(0);
    const list = screen.getByTestId('missed-reminders');
    expect(list.textContent).toContain('Standup');
    expect(list.textContent).toContain('Review');
    expect(screen.getAllByText('join')).toHaveLength(1);
    fireEvent.click(screen.getByText('done'));
    await advance(0);
    expect(screen.queryByTestId('missed-reminders')).toBeNull();
  });

  it('tells plugins, and lets one take the reminder over', async () => {
    await syncedWith(event());
    const fired = vi.fn();
    calendarHooks.onCalendarAlert.register('t', fired);
    calendarHooks.onBeforeCalendarAlert.register('t', () => false);
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now());
    expect(fired).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', eventId: 'e1', eventTitle: 'Standup' }));
    expect(notify).not.toHaveBeenCalled();
  });

  function calendarStoreHas(uid: string, title: string) {
    useCalendarStore.setState({
      events: [{ id: 'e1', uid, title, start: '2026-11-10T10:00:00', utcStart: new Date(START).toISOString(), duration: 'PT30M', calendarIds: { c: true }, useDefaultAlerts: false, alerts: { a: { '@type': 'Alert', action: 'display', trigger: { '@type': 'AbsoluteTrigger', when: new Date(FIRE).toISOString() } } } }] as never,
    });
  }

  it('makes the old path stand down once the store has this account', async () => {
    await syncedWith(event());
    // Not the same event as far as the claim can tell: only standing down keeps it quiet.
    calendarStoreHas('another-uid', 'Old path');
    renderHook(() => {
      useCalendarAlerts();
      useStoreReminders();
    });
    await advance(FIRE - Date.now() + 2 * MIN);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(toastTitles()).toEqual([]);
  });

  it('lets the two paths tell each other what fired, for the moment the store takes over', async () => {
    await syncedWith(event());
    calendarStoreHas('uid-1', 'Standup');
    const { claimKey, claimNow } = await import('@/lib/calendar-reminders/claims');
    // The old path got there just before the store was ready.
    expect(claimNow(claimKey(ACCOUNT, 'uid-1', 'a', FIRE), FIRE)).toBe(true);
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now() + 2 * MIN);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('in a browser', () => {
  function grantNotifications(showNotification = vi.fn(async () => {})) {
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'granted' }));
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: async () => ({ showNotification, getNotifications: async () => [] }) },
    });
    return showNotification;
  }

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  it('keeps the in-app toast, without desktop buttons', async () => {
    await syncedWith(event(LINK));
    render(<Toasts />);
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now());
    const toast = useToastStore.getState().toasts[0];
    expect(toast.title).toBe('Standup');
    expect(toast.action).toBeUndefined();
    expect(toast.extraActions).toBeUndefined();
    expect(sounds.play).toHaveBeenCalledTimes(1);
  });

  it('adds a system notification only where permission is granted and the tab is out of view', async () => {
    await syncedWith(event());
    const shown = grantNotifications();
    setVisibility('hidden');
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now() + 3000);
    expect(toastTitles()).toEqual(['Standup']);
    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown).toHaveBeenCalledWith('Standup', expect.objectContaining({ data: expect.objectContaining({ kind: 'calendar-reminder' }), silent: false }));
  });

  it('asks for no permission and shows none when it was not granted', async () => {
    await syncedWith(event());
    const request = vi.fn();
    vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'default', requestPermission: request }));
    setVisibility('hidden');
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now() + 3000);
    expect(toastTitles()).toEqual(['Standup']);
    expect(request).not.toHaveBeenCalled();
  });

  it('fires in one of two tabs', async () => {
    await syncedWith(event());
    renderHook(() => useStoreReminders());
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now() + MIN);
    expect(toastTitles()).toEqual(['Standup']);
  });

  it('closes the toast in this window when another acknowledges the reminder', async () => {
    await syncedWith(event());
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now());
    expect(toastTitles()).toEqual(['Standup']);
    const key = `${Object.keys(CALENDAR_SESSION.accounts)[0]}:uid-1:a:${FIRE}`;
    const other = new BroadcastChannel('bulwark-calendar-reminders');
    other.postMessage({ kind: 'acknowledged', keys: [key] });
    other.close();
    vi.useRealTimers();
    await vi.waitFor(() => expect(toastTitles()).toEqual([]));
  });

  it('gives nothing to a pop-out', async () => {
    popout.value = true;
    await syncedWith(event());
    const area = vi.spyOn(store, 'area');
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now() + MIN);
    expect(area).not.toHaveBeenCalled();
    expect(toastTitles()).toEqual([]);
  });
});
