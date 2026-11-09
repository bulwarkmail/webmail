import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/locales/en/common.json';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { matchesSubResult, settingsSubResults, type SettingsSearchTab } from '@/lib/settings-search';

// settings-p3-6 (usability pass 3, 2026-11-04): "Do not disturb" was on Accessibility,
// "Quiet hours" on Notifications, two names on two pages. Both are on Notifications now,
// at the top; Accessibility keeps a link. The stored setting is still doNotDisturb.
// Strings are keys here (next-intl mock).

vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Bulwark' }) }));
vi.mock('@/lib/web-push', () => ({
  WebPushUnsupportedError: class WebPushUnsupportedError extends Error {},
  isWebPushSupported: () => false,
  isWebPushEnabled: vi.fn(async () => false),
  enableWebPush: vi.fn(),
  enableWebPushForAccounts: vi.fn(),
  disableWebPush: vi.fn(),
  listPushDevices: vi.fn(async () => []),
  mailAccountsWithoutPush: vi.fn(() => []),
  revokePushDevice: vi.fn(),
  serverSupportsEmailPush: vi.fn(() => false),
}));

const { NotificationSettings } = await import('../notification-settings');
const { AccessibilitySettings } = await import('../accessibility-settings');

const osStatus = {
  settings: {
    closeToTray: true, startAtLogin: false, startMinimized: false, attentionOnNewMail: true,
    quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '07:00', showShortcut: null,
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

const pauseSection = () => document.querySelector('[data-settings-section="pause"]') as HTMLElement | null;

beforeEach(() => {
  usePolicyStore.setState({ policy: { ...DEFAULT_POLICY }, loaded: true });
  useSettingsStore.setState({ doNotDisturb: false });
});

afterEach(() => {
  delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
});

describe('Do not disturb on Notifications', () => {
  it('is the first section, and its switch is the doNotDisturb setting', async () => {
    render(<NotificationSettings />);
    await settle();
    const section = pauseSection();
    expect(section).not.toBeNull();
    expect(document.querySelector('[data-settings-section]')).toBe(section);
    expect(within(section!).getByText('dnd_title')).toBeInTheDocument();
    expect(within(section!).getByText('pause_label')).toBeInTheDocument();
    fireEvent.click(within(section!).getByRole('switch'));
    expect(useSettingsStore.getState().doNotDisturb).toBe(true);
  });

  it('has quiet hours right under it in the desktop app', async () => {
    installBridge();
    render(<NotificationSettings />);
    await settle();
    const section = pauseSection()!;
    expect(within(section).getByText('quiet_hours_label')).toBeInTheDocument();
    expect(within(section).getByLabelText('quiet_hours_from')).toBeInTheDocument();
    // Not a second time in the app's own notification section.
    expect(screen.getAllByText('quiet_hours_label')).toHaveLength(1);
  });

  it('Accessibility has no switch of its own, only the way to Notifications', async () => {
    const dispatched: unknown[] = [];
    const listener = (event: Event) => dispatched.push((event as CustomEvent).detail);
    window.addEventListener('settings-tab-change', listener);
    render(<AccessibilitySettings />);
    expect(screen.queryByText('do_not_disturb.label')).toBeNull();
    // The row of that label: the nearest box around it with a button.
    let row: HTMLElement | null = screen.getByText('dnd_title');
    while (row && !row.querySelector('button')) row = row.parentElement;
    fireEvent.click(row!.querySelector('button')!);
    window.removeEventListener('settings-tab-change', listener);
    expect(dispatched).toContainEqual({ tab: 'notifications', section: 'pause' });
  });
});

describe('settings search', () => {
  const pagesFor = (query: string) => (['notifications', 'accessibility'] as SettingsSearchTab[])
    .filter((tab) => settingsSubResults(en, tab, 'Bulwark').some((result) => matchesSubResult(result, query)));

  it.each(['do not disturb', 'quiet hours', 'pause notifications'])('"%s" leads to Notifications only', (query) => {
    expect(pagesFor(query)).toEqual(['notifications']);
  });
});
