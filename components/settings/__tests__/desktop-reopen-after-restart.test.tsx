import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopOsSettings as Settings } from '@/lib/desktop/types';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Bulwark' }) }));

const { DesktopOsSettings } = await import('../desktop-os-settings');

const BASE: Settings = {
  closeToTray: true, startAtLogin: false, startMinimized: false, attentionOnNewMail: true,
  quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '07:00', showShortcut: null,
};

function shell(settings: Settings) {
  let current = { settings, pausedUntil: null, shortcutActive: false };
  const setSettings = vi.fn(async (patch: Partial<Settings>) => {
    current = { ...current, settings: { ...current.settings, ...patch } };
    return current;
  });
  window.bulwarkDesktop = {
    version: 1,
    platform: 'win32',
    os: {
      getStatus: vi.fn(async () => current),
      defaultAppStatus: vi.fn(async () => ({ mailto: false })),
      onStatusChange: vi.fn(() => () => {}),
      setSettings,
      openDefaultAppSettings: vi.fn(),
    },
  } as never;
  return { setSettings };
}

afterEach(() => {
  window.bulwarkDesktop = undefined;
});

describe('open again after a restart', () => {
  it('is off, and turning it on asks the shell', async () => {
    const { setSettings } = shell({ ...BASE, reopenAfterRestart: false });
    render(<DesktopOsSettings />);
    const toggle = await screen.findByTestId('desktop-reopen-after-restart');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('reopen_after_restart_label')).toBeTruthy();
    await act(async () => { fireEvent.click(toggle); });
    expect(setSettings).toHaveBeenCalledWith({ reopenAfterRestart: true });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('is not offered by a shell that can\'t do it', async () => {
    shell(BASE);
    render(<DesktopOsSettings />);
    await screen.findByText('start_at_login_label');
    expect(screen.queryByTestId('desktop-reopen-after-restart')).toBeNull();
  });
});
