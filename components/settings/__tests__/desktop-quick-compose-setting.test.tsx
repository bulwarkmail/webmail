import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopOsStatus, DesktopQuickComposeStatus } from '@/lib/desktop/types';
import { DesktopOsSettings } from '../desktop-os-settings';
import { DesktopQuickComposeSetting } from '../desktop-quick-compose-setting';

// The shell decides what's held. This page shows what it says, and that includes keys another
// app has: a shortcut that does nothing must not look as if it works.

vi.mock('next-intl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl')>()),
  useTranslations: () => (key: string, values?: Record<string, string>) => (values?.keys ? `${key}:${values.keys}` : key),
}));
vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const KEYS = 'CommandOrControl+Alt+N';
const HELD: DesktopQuickComposeStatus = { shortcut: KEYS, active: true, locked: false, builtIn: KEYS };

afterEach(() => {
  delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
});

describe('DesktopQuickComposeSetting', () => {
  const show = (status: Partial<DesktopQuickComposeStatus>, platform = 'win32') => {
    const onChange = vi.fn();
    render(<DesktopQuickComposeSetting status={{ ...HELD, ...status }} platform={platform} onChange={onChange} />);
    return onChange;
  };

  it('names the keys while they work', () => {
    show({});
    expect(screen.getByText('description:Ctrl+Alt+N')).toBeTruthy();
    expect(screen.getByTestId('quick-compose-keys').textContent).toBe('Ctrl+Alt+N');
    expect(screen.queryByText('taken:Ctrl+Alt+N')).toBeNull();
  });

  it('says so when another app holds the keys', () => {
    show({ active: false });
    expect(screen.getByText('taken:Ctrl+Alt+N')).toBeTruthy();
    expect(screen.queryByText('description:Ctrl+Alt+N')).toBeNull();
  });

  it('turned off, it names no keys and no conflict', () => {
    show({ shortcut: null, active: false });
    expect(screen.getByText('description_off')).toBeTruthy();
    expect(screen.queryByTestId('quick-compose-keys')).toBeNull();
    expect(screen.queryByText(/^taken/)).toBeNull();
  });

  it('the switch turns it off, and on again with the usual keys', () => {
    const onChange = show({});
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenLastCalledWith(null);
    const again = vi.fn();
    render(<DesktopQuickComposeSetting status={{ shortcut: null, active: false, locked: false, builtIn: 'CommandOrControl+Alt+M' }} platform="win32" onChange={again} />);
    fireEvent.click(screen.getAllByRole('switch')[1]);
    expect(again).toHaveBeenLastCalledWith('CommandOrControl+Alt+M');
  });

  it('takes new keys from a press, and ignores a press that can\'t be a shortcut', () => {
    const onChange = show({});
    fireEvent.click(screen.getByTestId('quick-compose-keys'));
    const recorder = screen.getByTestId('quick-compose-recording');
    fireEvent.keyDown(recorder, { key: 'c', code: 'KeyC', ctrlKey: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('quick-compose-recording')).toBeTruthy();
    fireEvent.keyDown(recorder, { key: 'm', code: 'KeyM', ctrlKey: true, altKey: true });
    expect(onChange).toHaveBeenCalledWith('CommandOrControl+Alt+M');
    expect(screen.queryByTestId('quick-compose-recording')).toBeNull();
  });

  it('Esc leaves things as they were', () => {
    const onChange = show({});
    fireEvent.click(screen.getByTestId('quick-compose-keys'));
    fireEvent.keyDown(screen.getByTestId('quick-compose-recording'), { key: 'Escape', code: 'Escape' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('quick-compose-keys')).toBeTruthy();
  });

  it('a press while recording goes no further, or the app\'s own shortcuts would run', () => {
    const heard = vi.fn();
    document.addEventListener('keydown', heard);
    show({});
    fireEvent.click(screen.getByTestId('quick-compose-keys'));
    fireEvent.keyDown(screen.getByTestId('quick-compose-recording'), { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true });
    document.removeEventListener('keydown', heard);
    expect(heard).not.toHaveBeenCalled();
  });

  it('set by a policy, the row is locked and says who set it', () => {
    show({ locked: true });
    expect(screen.getByRole('switch').closest('[inert]')).not.toBeNull();
  });
});

describe('on the desktop settings page', () => {
  function bridge(status: Partial<DesktopOsStatus>) {
    const full = {
      settings: { closeToTray: true, startAtLogin: false, startMinimized: false, attentionOnNewMail: true, quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '07:00', showShortcut: null },
      pausedUntil: null,
      shortcutActive: false,
      ...status,
    };
    const setSettings = vi.fn(async (patch: object) => ({ ...full, settings: { ...full.settings, ...patch }, quickCompose: { shortcut: null, active: false, locked: false, builtIn: KEYS } }));
    (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop = {
      version: 1,
      platform: 'win32',
      mode: 'standalone',
      os: {
        getStatus: async () => full,
        setSettings,
        defaultAppStatus: async () => ({ registered: false, mailto: false, webcal: false }),
        onStatusChange: () => () => {},
      },
    };
    return setSettings;
  }

  it('sends the choice to the shell, and shows what comes back', async () => {
    const setSettings = bridge({ quickCompose: HELD });
    render(<DesktopOsSettings />);
    const keys = await screen.findByTestId('quick-compose-keys');
    fireEvent.click(keys.parentElement!.querySelector('[role="switch"]')!);
    expect(setSettings).toHaveBeenCalledWith({ quickComposeShortcut: null });
    await screen.findByText('description_off');
  });

  it('shows nothing about it under a shell that doesn\'t know it', async () => {
    bridge({});
    render(<DesktopOsSettings />);
    await screen.findByText('default_app_button');
    expect(screen.queryByText('label')).toBeNull();
  });
});
