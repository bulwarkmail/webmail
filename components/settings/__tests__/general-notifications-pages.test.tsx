import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import enCommon from '@/locales/en/common.json';
import enPlain from '@/locales/en/plain.json';
import { withPlainLanguage } from '@/i18n/plain-language';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';

// Usability pass 2026-11-04: General and Notifications (settings-23, -27,
// -29, -30, desktop-13, -19, -25). Labels are keys here (next-intl mock);
// the wording itself is checked on the English catalog below.

vi.mock('@/components/tour/tour-provider', () => ({
  useTour: () => ({ startTour: vi.fn(), resetTourCompletion: vi.fn() }),
}));
// A marker, so the test sees whether General still renders it at all.
vi.mock('../desktop-telemetry-settings', () => ({ DesktopTelemetrySettings: () => <div data-testid="telemetry-section" /> }));
vi.mock('@/lib/web-push', () => ({
  WebPushUnsupportedError: class WebPushUnsupportedError extends Error {},
  isWebPushSupported: () => false,
  isWebPushEnabled: vi.fn(async () => false),
  enableWebPush: vi.fn(),
  disableWebPush: vi.fn(),
  listPushDevices: vi.fn(async () => []),
  mailAccountsWithoutPush: vi.fn(() => []),
  revokePushDevice: vi.fn(),
  serverSupportsEmailPush: vi.fn(() => false),
}));

const { GeneralSettings } = await import('../general-settings');
const { NotificationSettings } = await import('../notification-settings');
const { AppLockSettings } = await import('../app-lock-settings');
const { DesktopWindowSettings } = await import('../desktop-window-settings');

const en = withPlainLanguage(enCommon as Record<string, unknown>, enPlain as Record<string, unknown>) as typeof enCommon;

const osStatus = {
  settings: {
    closeToTray: true, startAtLogin: false, startMinimized: false, attentionOnNewMail: true,
    quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '07:00', showShortcut: null,
  },
  pausedUntil: null,
  shortcutActive: false,
};

function installBridge() {
  (window as unknown as { bulwarkDesktop: unknown }).bulwarkDesktop = {
    version: 1,
    platform: 'win32',
    os: {
      getStatus: vi.fn(async () => osStatus),
      defaultAppStatus: vi.fn(async () => ({ mailto: false })),
      onStatusChange: vi.fn(() => () => {}),
      setSettings: vi.fn(async () => osStatus),
      openDefaultAppSettings: vi.fn(),
    },
  };
}

async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

beforeEach(() => {
  usePolicyStore.setState({
    ...usePolicyStore.getState(),
    policy: {},
    isSettingLocked: () => false,
    isSettingHidden: () => false,
  } as never);
  useAuthStore.setState({ client: null, username: null } as never);
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
});

describe('General page', () => {
  it('offers the browser link handlers in a browser', async () => {
    render(<GeneralSettings supportsCalendar />);
    await settle();
    expect(screen.getByText('mailto_label')).toBeTruthy();
  });

  it('has no browser link handlers and no usage info in the desktop app', async () => {
    installBridge();
    render(<GeneralSettings supportsCalendar />);
    await settle();
    // The app's own "Default mail app" row is on the Desktop app page instead (settings reorg 2026-11-05).
    expect(screen.queryByText('default_app_label')).toBeNull();
    expect(screen.queryByText('mailto_label')).toBeNull();
    expect(screen.queryByText('register_mailto')).toBeNull();
    // Usage info and crash reports moved to the Privacy page.
    expect(screen.queryByTestId('telemetry-section')).toBeNull();
  });

  it('keeps taskbar flashing and quiet hours off the General page', async () => {
    installBridge();
    render(<GeneralSettings supportsCalendar />);
    await settle();
    expect(screen.queryByText('attention_label')).toBeNull();
    expect(screen.queryByText('quiet_hours_label')).toBeNull();
  });

  it('describes the time zone for the desktop app without the browser', async () => {
    installBridge();
    render(<GeneralSettings supportsCalendar />);
    await settle();
    expect(screen.getByText('time_zone_desktop_description')).toBeTruthy();
  });
});

describe('Notifications page', () => {
  it('has taskbar flashing and quiet hours in the desktop app', async () => {
    installBridge();
    render(<NotificationSettings />);
    await settle();
    expect(screen.getByText('attention_label')).toBeTruthy();
    expect(screen.getByText('quiet_hours_label')).toBeTruthy();
  });

  it('shows none of that in a browser', async () => {
    render(<NotificationSettings />);
    await settle();
    expect(screen.queryByText('attention_label')).toBeNull();
  });
});

describe('App lock', () => {
  it('keeps the long explanation behind "What does this protect?"', async () => {
    render(<AppLockSettings />);
    await settle();
    const text = screen.getByTestId('app-lock-protects');
    const details = text.closest('details');
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(details!.querySelector('summary')?.textContent).toBe('app_lock_protects_toggle');
  });

  it('offers the long timeouts in hours', async () => {
    const { APP_LOCK_KEY } = await import('@/lib/app-lock/state');
    localStorage.setItem(APP_LOCK_KEY, JSON.stringify({ on: true, locked: false, timeoutMinutes: 15 }));
    try {
      render(<AppLockSettings />);
      await settle();
      const options = Array.from(screen.getByTestId('app-lock-timeout').querySelectorAll('option'));
      const byValue = Object.fromEntries(options.map((o) => [o.value, o.textContent]));
      expect(byValue['60']).toBe('app_lock_timeout_hours');
      expect(byValue['240']).toBe('app_lock_timeout_hours');
      expect(byValue['30']).toBe('timeout_option');
    } finally {
      localStorage.removeItem(APP_LOCK_KEY);
    }
  });

  it('offers the desktop events instead of a timeout only in the desktop app, and keeps the choice', async () => {
    const { APP_LOCK_KEY } = await import('@/lib/app-lock/state');
    localStorage.setItem(APP_LOCK_KEY, JSON.stringify({ on: true, locked: false, timeoutMinutes: 15 }));
    try {
      const { unmount } = render(<AppLockSettings />);
      await settle();
      const values = () => Array.from(screen.getByTestId('app-lock-timeout').querySelectorAll('option')).map((o) => o.value);
      expect(values()).not.toContain('screen');
      unmount();

      installBridge();
      const setScreenLock = vi.fn(async () => true);
      (window as unknown as { bulwarkDesktop: Record<string, unknown> }).bulwarkDesktop.appLock = {
        status: vi.fn(async () => ({ locked: false, enrolled: true, os: null, osEnrolled: false })),
        claim: vi.fn(() => ({ lock: vi.fn(), osUnlock: vi.fn(), setScreenLock })),
        onLockRequest: vi.fn(() => () => {}),
      };
      render(<AppLockSettings />);
      await settle();
      const select = screen.getByTestId('app-lock-timeout') as HTMLSelectElement;
      expect(values().slice(-2)).toEqual(['screen', 'session']);
      expect(screen.getByText('app_lock_until_session')).toBeTruthy();
      fireEvent.change(select, { target: { value: 'session' } });
      await settle();
      expect(setScreenLock).toHaveBeenLastCalledWith(false);
      expect(JSON.parse(localStorage.getItem(APP_LOCK_KEY)!).until).toBe('session');
      expect((screen.getByTestId('app-lock-timeout') as HTMLSelectElement).value).toBe('session');
    } finally {
      localStorage.removeItem(APP_LOCK_KEY);
    }
  });

  it('speaks of windows, not tabs, in the desktop app', async () => {
    installBridge();
    render(<AppLockSettings />);
    await settle();
    expect(screen.getByText('app_lock_desc_desktop')).toBeTruthy();
    expect(screen.queryByText('section_desc')).toBeNull();
  });
});

describe('Desktop app windows section', () => {
  it('is not called just "Windows"', () => {
    expect(en.desktopUi.settings.title).toBe('App windows');
    expect(DesktopWindowSettings).toBeTypeOf('function');
  });
});

describe('English wording', () => {
  const n = en.settings.notifications;
  it('names the two sound switches apart, and the section and tone row plainly', () => {
    expect(n.email.sound).toBe('Sound for new mail');
    expect(n.calendar.sound).toBe('Sound for reminders');
    expect(n.sound_selection.title).toBe('Sound');
    expect(n.sound_selection.choose).not.toBe(n.email.sound);
  });

  it('calls background push what it is', () => {
    expect(n.push.title).toBe('Notifications when {appName} is closed');
    expect(n.push.enable).toBe('Turn on for this device');
  });

  it('keeps the unread badge description short', () => {
    expect(en.settings.appearance.favicon_unread_badge.description.split(/\s+/).length).toBeLessThan(15);
  });

  it('says what the link handler buttons do, without "Technically"', () => {
    const p = en.protocol_handlers;
    expect(p.description).not.toMatch(/Technically|protocol handler/);
    expect(p.mailto_label).toBe('Open email links in {appName}');
    expect(p.register_mailto).toBe('Use {appName} for email links');
    expect(p.register_webcal).toBe('Use {appName} for calendar links');
  });

  it('describes the app lock without repeating itself', () => {
    expect(en.appLock.enable_desc).toBe('The PIN stays on this device.');
    expect(en.appLock.enable_body).toBe('You need it each time the app locks and after a restart.');
    expect(en.appLock.enable_body).not.toMatch(/Choose a PIN/);
  });

  it('says what the first day of the week is for', () => {
    expect(en.settings.language_region.first_day.description).toBe('First day of the week in calendars');
  });

  it("doesn't name the Node version in the usage info", () => {
    expect(en.desktopTelemetry.telemetry_description).not.toMatch(/Node/);
  });
});
