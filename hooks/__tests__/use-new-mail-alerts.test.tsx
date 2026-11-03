import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useNewMailAlerts, NEW_MAIL_BATCH_MS } from '../use-new-mail-alerts';
import { useEmailStore } from '@/stores/email-store';
import { useSettingsStore } from '@/stores/settings-store';
import { LIVE_REGION_IDS, resetAnnouncerForTests } from '@/lib/announce';
import { stopTitleAlert, TITLE_ALERT_INTERVAL_MS, TITLE_ALERT_MAX_SWAPS } from '@/lib/title-alert';
import type { Email } from '@/lib/jmap/types';

// The count must reach the words, so t shows its values.
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

const playNotificationSound = vi.hoisted(() => vi.fn());
vi.mock('@/lib/notification-sound', () => ({ playNotificationSound }));

const polite = () => document.getElementById(LIVE_REGION_IDS.polite)?.textContent ?? '';
const arrive = (id: string) => act(() => {
  useEmailStore.getState().handleNewEmailNotification({ id, subject: `Secret ${id}` } as Email);
});

describe('new mail alerts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAnnouncerForTests();
    playNotificationSound.mockClear();
    useEmailStore.setState({ newEmailNotification: null });
    useSettingsStore.setState({
      emailNotificationsEnabled: true, emailNotificationSound: true, announceNewMail: true,
      doNotDisturb: false, visualAlerts: false,
    });
    document.title = 'Inbox - Bulwark';
  });
  afterEach(() => {
    stopTitleAlert();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('in the desktop app leaves the sound to the notification path, so it plays once', () => {
    window.bulwarkDesktop = { version: 1, platform: 'win32', os: {} } as never;
    renderHook(() => useNewMailAlerts());
    arrive('a');
    expect(playNotificationSound).not.toHaveBeenCalled();
    window.bulwarkDesktop = undefined;
  });

  it('tells screen readers once how many messages came, never what they say', () => {
    renderHook(() => useNewMailAlerts());
    arrive('a');
    arrive('b');
    arrive('c');
    expect(polite()).toBe('');
    act(() => { vi.advanceTimersByTime(NEW_MAIL_BATCH_MS + 100); });
    expect(polite()).toBe('new_mail_count:{"count":3}');
    expect(polite()).not.toContain('Secret');
    // One sound for the batch, not three.
    expect(playNotificationSound).toHaveBeenCalledTimes(1);
    expect(useEmailStore.getState().newEmailNotification).toBeNull();
  });

  it('stays quiet for screen readers with "Announce new mail" off', () => {
    useSettingsStore.setState({ announceNewMail: false });
    renderHook(() => useNewMailAlerts());
    arrive('a');
    act(() => { vi.advanceTimersByTime(NEW_MAIL_BATCH_MS + 100); });
    expect(polite()).toBe('');
    expect(playNotificationSound).toHaveBeenCalledTimes(1);
  });

  it('plays no sound, says nothing and leaves the title alone with Do not disturb on', () => {
    useSettingsStore.setState({ doNotDisturb: true, visualAlerts: true });
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    renderHook(() => useNewMailAlerts());
    arrive('a');
    act(() => { vi.advanceTimersByTime(NEW_MAIL_BATCH_MS + 100); });
    expect(playNotificationSound).not.toHaveBeenCalled();
    expect(polite()).toBe('');
    expect(document.title).toBe('Inbox - Bulwark');
  });

  it('swaps the tab title slowly with Visual alerts on while the tab is in the background', () => {
    useSettingsStore.setState({ visualAlerts: true });
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    renderHook(() => useNewMailAlerts());
    arrive('a');
    expect(document.title).toBe('new_mail_count:{"count":1}');
    arrive('b');
    expect(document.title).toBe('new_mail_count:{"count":2}');
    act(() => { vi.advanceTimersByTime(TITLE_ALERT_INTERVAL_MS); });
    expect(document.title).toBe('Inbox - Bulwark');
    act(() => { vi.advanceTimersByTime(TITLE_ALERT_INTERVAL_MS * TITLE_ALERT_MAX_SWAPS); });
    expect(document.title).toBe('Inbox - Bulwark');
  });
});
