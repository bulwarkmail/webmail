import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { MissedRemindersDialog } from '@/components/calendar/missed-reminders-dialog';
import { ToastContainer } from '@/components/ui/toast';
import { useCalendarAlerts } from '../use-calendar-alerts';
import { useStoreReminders } from '../use-store-reminders';
import { claimKey, claimNow } from '@/lib/calendar-reminders/claims';
import { useMissedReminders, useReminderSource } from '@/lib/calendar-reminders/state';
import { setAppLockCheck } from '@/lib/desktop/app-lock-state';
import type { BulwarkDesktopBridge, DesktopOsNotification, DesktopOsNotifyResult } from '@/lib/desktop/types';
import { clearAllHooks, uiHooks } from '@/lib/plugin-hooks';
import { useOfflineStore } from '@/lib/offline/state';
import { CALENDAR_SESSION, FakeCalendarJmap } from '@/lib/store/__tests__/helpers/fake-calendar';
import { InProcessStore } from '@/lib/store/__tests__/helpers/in-process-store';
import { setStoreBackend } from '@/lib/store/client/api';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarNotificationStore } from '@/stores/calendar-notification-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useToastStore } from '@/stores/toast-store';

const sounds = vi.hoisted(() => ({ play: vi.fn() }));
vi.mock('@/lib/notification-sound', () => ({ playNotificationSound: sounds.play }));
vi.mock('@/lib/title-alert', () => ({ startTitleAlert: vi.fn() }));
// Real crypto takes real time, and fake time would run ahead of it.
vi.mock('@/lib/pwa-notify/login-fingerprint', () => ({ loginFingerprint: async () => 'fingerprint' }));
vi.mock('@/lib/offline/availability', () => ({ offlineActive: () => true }));
const policy = vi.hoisted(() => ({ pushWithoutContent: false }));
vi.mock('@/lib/device-policy', async (original) => ({
  ...await original<typeof import('@/lib/device-policy')>(),
  devicesForAccount: () => ({ pushWithoutContent: policy.pushWithoutContent }),
}));

const MIN = 60_000;
const ACCOUNT = 'acc';
const START = Date.UTC(2026, 10, 10, 9);
const FIRE = START - 15 * MIN;
const ALERT = { '@type': 'Alert', action: 'display', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' } };
const FOREIGN_LINK = { virtualLocations: { v: { '@type': 'VirtualLocation', uri: 'https://calls.example.org/room' } } };

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

/** The login fingerprint is real crypto, in real time. Fake time must not run ahead of it. */
async function untilToast() {
  for (let tries = 0; tries < 500 && toastTitles().length === 0; tries += 1) {
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
}

/** Two alerts due with the app closed. Leaves the hook unmounted and the clock moved on. */
async function missedTwo(...extra: Record<string, unknown>[]) {
  await syncedWith(event(extra[0] ?? {}), event({ id: 'e2', uid: 'uid-2', title: 'Review' }));
  const before = renderHook(() => useStoreReminders());
  await advance(0);
  before.unmount();
  vi.setSystemTime(FIRE + 3 * 60 * MIN);
}

beforeEach(() => {
  vi.useFakeTimers({ now: FIRE - 30 * MIN, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.clearAllMocks();
  clearAllHooks();
  localStorage.clear();
  setAppLockCheck(null);
  setVisibility('visible');
  policy.pushWithoutContent = false;
  notifyResult = { shown: true, playSound: false };
  useToastStore.setState({ toasts: [] });
  useReminderSource.setState({ driven: {} });
  useMissedReminders.getState().close();
  useCalendarNotificationStore.getState().clearAll();
  useOfflineStore.setState({ enabled: [ACCOUNT] });
  useAuthStore.setState({ isAuthenticated: true, client: null, activeAccountId: ACCOUNT });
  useCalendarStore.setState({ events: [], calendars: [] });
  usePolicyStore.setState({ loaded: true, policy: { ...usePolicyStore.getState().policy, features: { ...usePolicyStore.getState().policy.features, calendarEnabled: true } } });
  useAccountStore.setState({ accounts: [{ id: ACCOUNT, cookieSlot: 1, serverUrl: 'https://one.example', username: 'a@example.org' }] as never });
  useEmailStore.setState({ isPushConnected: true });
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
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

function grantNotifications() {
  const showNotification = vi.fn(async (_title: string, _options: NotificationOptions) => {});
  vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'granted' }));
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: async () => ({ showNotification, getNotifications: async () => [] }) },
  });
  return showNotification;
}

describe('Join', () => {
  beforeEach(desktop);

  it('says the host of a link to a service nobody knows', async () => {
    await syncedWith(event(FOREIGN_LINK));
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now());
    const join = notify.mock.calls[0][0].actions!.find((action) => action.id === 'join')!;
    expect(join.label).toBe('join_host');
  });

  it('asks the link check, and a stopped link opens nothing and leaves the reminder standing', async () => {
    await syncedWith(event(FOREIGN_LINK));
    notifyResult = { shown: false, reason: 'focused', playSound: false };
    uiHooks.onBeforeExternalLink.register('t', () => false);
    render(<Toasts />);
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now());
    await untilToast();
    const dismiss = vi.spyOn(store, 'area');
    fireEvent.click(screen.getByText('join_host'));
    await advance(100);
    expect(openExternal).not.toHaveBeenCalled();
    expect(dismiss.mock.calls.filter(([, name]) => name === 'reminders.dismiss')).toEqual([]);
  });

  it('goes out through the app when the link check lets it', async () => {
    await syncedWith(event(FOREIGN_LINK));
    notifyResult = { shown: false, reason: 'focused', playSound: false };
    render(<Toasts />);
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now());
    await untilToast();
    const area = vi.spyOn(store, 'area');
    fireEvent.click(screen.getByText('join_host'));
    await advance(100);
    expect(openExternal).toHaveBeenCalledWith('https://calls.example.org/room');
    expect(area.mock.calls.filter(([, name]) => name === 'reminders.dismiss')).toHaveLength(1);
  });

  it('names each Join in the summary for a screen reader', async () => {
    await missedTwo(FOREIGN_LINK);
    notifyResult = { shown: false, reason: 'focused', playSound: false };
    render(<><Toasts /><MissedRemindersDialog /></>);
    renderHook(() => useStoreReminders());
    await advance(20_000);
    await untilToast();
    fireEvent.click(screen.getByText('missed_show'));
    await advance(0);
    expect(screen.getByText('join_host').getAttribute('aria-label')).toBe('join_named');
  });
});

describe('with pushWithoutContent', () => {
  it('keeps the title off a browser system notification, on the store path', async () => {
    policy.pushWithoutContent = true;
    const shown = grantNotifications();
    setVisibility('hidden');
    await syncedWith(event());
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now() + 3000);
    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown.mock.calls[0][0]).toBe('generic_title');
    expect(shown.mock.calls[0][1].body).toBe('');
    expect(toastTitles()).toEqual(['Standup']);
  });

  it('keeps the titles off the summary as well', async () => {
    policy.pushWithoutContent = true;
    await missedTwo();
    const shown = grantNotifications();
    setVisibility('hidden');
    renderHook(() => useStoreReminders());
    await advance(20_000 + 3000);
    expect(shown).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(shown.mock.calls[0])).not.toContain('Standup');
  });

  it('keeps it off on the path without a store', async () => {
    policy.pushWithoutContent = true;
    useOfflineStore.setState({ enabled: [] });
    const shown = grantNotifications();
    setVisibility('hidden');
    useCalendarStore.setState({
      events: [{ id: 'e1', uid: 'uid-1', title: 'Standup', start: '2026-11-10T10:00:00', utcStart: new Date(START).toISOString(), duration: 'PT30M', calendarIds: { c: true }, useDefaultAlerts: false, alerts: { a: { '@type': 'Alert', action: 'display', trigger: { '@type': 'AbsoluteTrigger', when: new Date(FIRE).toISOString() } } } }] as never,
    });
    renderHook(() => useCalendarAlerts());
    await advance(FIRE - Date.now() + 3000);
    expect(shown).toHaveBeenCalledTimes(1);
    expect(shown.mock.calls[0][0]).toBe('alert_title');
    expect(shown.mock.calls[0][1].body).toBe('');
  });
});

describe('when the OS refuses or fails', () => {
  beforeEach(desktop);

  it('a rejected notify keeps a reminder for the summary', async () => {
    await syncedWith(event());
    notify.mockRejectedValueOnce(new Error('main is gone'));
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now());
    await advance(5 * MIN);
    expect(notify.mock.calls.at(-1)![0].id).toMatch(/^reminder-missed:/);
  });

  it('a failed toast keeps a reminder for the summary', async () => {
    await syncedWith(event());
    notifyResult = { shown: false, reason: 'failed', playSound: false };
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now());
    notifyResult = { shown: true, playSound: false };
    await advance(5 * MIN);
    expect(notify.mock.calls.at(-1)![0].id).toMatch(/^reminder-missed:/);
    expect(notify.mock.calls.at(-1)![0].body).toBe('Standup');
  });

  it('a rejected notify puts a summary straight back', async () => {
    await missedTwo();
    notify.mockRejectedValueOnce(new Error('main is gone'));
    renderHook(() => useStoreReminders());
    await advance(20_000);
    expect(notify).toHaveBeenCalledTimes(1);
    await advance(5 * MIN);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

describe('a summary in the app', () => {
  beforeEach(desktop);

  it('comes back after a reload that lost the toast', async () => {
    await missedTwo();
    notifyResult = { shown: false, reason: 'focused', playSound: false };
    const page = renderHook(() => useStoreReminders());
    await advance(20_000);
    await untilToast();
    expect(toastTitles()).toEqual(['missed_title']);

    // A reload: the toast and the page are gone, nobody dismissed anything.
    page.unmount();
    useToastStore.setState({ toasts: [] });
    renderHook(() => useStoreReminders());
    await advance(10 * MIN);
    expect(toastTitles()).toEqual(['missed_title']);
  });

  it('stays one toast for as long as it is on screen', async () => {
    await missedTwo();
    notifyResult = { shown: false, reason: 'focused', playSound: false };
    renderHook(() => useStoreReminders());
    await advance(20_000);
    await untilToast();
    await advance(30 * MIN);
    expect(toastTitles()).toEqual(['missed_title']);
  });

  it('does not come back after it was closed', async () => {
    await missedTwo();
    notifyResult = { shown: false, reason: 'focused', playSound: false };
    render(<Toasts />);
    const page = renderHook(() => useStoreReminders());
    await advance(20_000);
    await untilToast();
    act(() => useToastStore.getState().toasts[0].onDismiss!());
    useToastStore.setState({ toasts: [] });
    await advance(30 * MIN);
    page.unmount();
    renderHook(() => useStoreReminders());
    await advance(30 * MIN);
    expect(toastTitles()).toEqual([]);
  });

  it('leaves out what the path without a store already rang', async () => {
    await missedTwo();
    claimNow(claimKey(ACCOUNT, 'uid-1', 'a', FIRE), FIRE);
    renderHook(() => useStoreReminders());
    await advance(20_000);
    expect(notify.mock.calls[0][0].body).toBe('Review');
  });

  it('says nothing at all when that was all of it', async () => {
    await missedTwo();
    claimNow(claimKey(ACCOUNT, 'uid-1', 'a', FIRE), FIRE);
    claimNow(claimKey(ACCOUNT, 'uid-2', 'a', FIRE), FIRE);
    renderHook(() => useStoreReminders());
    await advance(20_000 + 10 * MIN);
    expect(notify).not.toHaveBeenCalled();
    expect(toastTitles()).toEqual([]);
  });
});

describe('the organisation has the calendar off', () => {
  beforeEach(() => {
    usePolicyStore.setState({ policy: { ...usePolicyStore.getState().policy, features: { ...usePolicyStore.getState().policy.features, calendarEnabled: false } } });
  });

  it('the store path stays quiet, and nothing counts as missed later', async () => {
    desktop();
    await syncedWith(event(), event({ id: 'e2', uid: 'uid-2', title: 'Review' }));
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now() + MIN);
    expect(notify).not.toHaveBeenCalled();
    await advance(20 * MIN);
    expect(notify).not.toHaveBeenCalled();
    expect(toastTitles()).toEqual([]);
  });

  it('the path without a store stays quiet', async () => {
    useOfflineStore.setState({ enabled: [] });
    useCalendarStore.setState({
      events: [{ id: 'e1', uid: 'uid-1', title: 'Standup', start: '2026-11-10T10:00:00', utcStart: new Date(START).toISOString(), duration: 'PT30M', calendarIds: { c: true }, useDefaultAlerts: false, alerts: { a: { '@type': 'Alert', action: 'display', trigger: { '@type': 'AbsoluteTrigger', when: new Date(FIRE).toISOString() } } } }] as never,
    });
    renderHook(() => useCalendarAlerts());
    await advance(FIRE - Date.now() + MIN);
    expect(toastTitles()).toEqual([]);
  });
});

describe('the path without a store on the desktop', () => {
  const plain = () => useCalendarStore.setState({
    events: [{ id: 'e1', uid: 'uid-1', title: 'Standup', start: '2026-11-10T10:00:00', utcStart: new Date(START).toISOString(), duration: 'PT30M', calendarIds: { c: true }, useDefaultAlerts: false, alerts: { a: { '@type': 'Alert', action: 'display', trigger: { '@type': 'AbsoluteTrigger', when: new Date(FIRE).toISOString() } } } }] as never,
  });

  beforeEach(() => {
    desktop();
    useOfflineStore.setState({ enabled: [] });
    plain();
  });

  it('stands down while locked: nothing fires, nothing is used up', async () => {
    let locked = true;
    setAppLockCheck(() => locked);
    renderHook(() => useCalendarAlerts());
    await advance(FIRE - Date.now() + MIN);
    expect(notify).not.toHaveBeenCalled();
    expect(toastTitles()).toEqual([]);

    locked = false;
    await advance(MIN);
    expect(toastTitles()).toEqual(['Standup']);
  });

  it('sends an id that names nothing when the title is hidden', async () => {
    policy.pushWithoutContent = true;
    renderHook(() => useCalendarAlerts());
    await advance(FIRE - Date.now());
    expect(JSON.stringify(notify.mock.calls[0][0])).not.toContain('e1');
    expect(JSON.stringify(notify.mock.calls[0][0])).not.toContain('Standup');
  });

  it('plays no sound in quiet hours or a pause', async () => {
    notifyResult = { shown: false, reason: 'quiet-hours', playSound: false };
    renderHook(() => useCalendarAlerts());
    await advance(FIRE - Date.now());
    expect(notify.mock.calls[0][0].sound).toBe(true);
    expect(sounds.play).not.toHaveBeenCalled();
  });

  it('plays the sound main asks for', async () => {
    notifyResult = { shown: true, playSound: true };
    renderHook(() => useCalendarAlerts());
    await advance(FIRE - Date.now());
    expect(sounds.play).toHaveBeenCalledTimes(1);
  });
});

describe('the click on a browser notification', () => {
  it('carries the address in the user language', async () => {
    const shown = grantNotifications();
    setVisibility('hidden');
    await syncedWith(event());
    renderHook(() => useStoreReminders());
    await advance(FIRE - Date.now() + 3000);
    expect((shown.mock.calls[0][1].data as { url: string }).url).toMatch(/\/calendar$/);
  });
});

describe('without a push channel', () => {
  it('syncs every few minutes, so an event made elsewhere still rings', async () => {
    useEmailStore.setState({ isPushConnected: false });
    await syncedWith();
    const sync = vi.spyOn(store, 'sync');
    renderHook(() => useStoreReminders());
    await advance(11 * MIN);
    expect(sync.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('leaves it to the push channel when there is one', async () => {
    useEmailStore.setState({ isPushConnected: true });
    await syncedWith();
    const sync = vi.spyOn(store, 'sync');
    renderHook(() => useStoreReminders());
    await advance(11 * MIN);
    expect(sync).not.toHaveBeenCalled();
  });
});
