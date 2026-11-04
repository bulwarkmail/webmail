import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopCrashFile, DesktopCrashSendResult, DesktopPrivacyState } from '@/lib/desktop/types';
import { DesktopTelemetrySettings } from '../desktop-telemetry-settings';

// The desktop app's two switches. A browser sees nothing. The shell decides and asks; this
// page only shows what it says, and sends a crash file only when the button is pressed.

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast }));
vi.mock('next-intl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl')>()),
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({ dateTime: (date: Date) => date.toISOString() }),
}));
vi.mock('../settings-section', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-section')>()),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const OFF: DesktopPrivacyState = {
  telemetry: { on: false, forcedOff: false },
  crashReports: { on: false, forcedOff: false, uploadUrl: '' },
};
const CRASH_ON: DesktopPrivacyState = { ...OFF, crashReports: { on: true, forcedOff: false, uploadUrl: '' } };
const FILE: DesktopCrashFile = { id: 'a1', createdAt: Date.parse('2026-11-03T10:00:00Z'), bytes: 2048 };

function bridge(state: DesktopPrivacyState, crashes: DesktopCrashFile[] = [], mode: 'standalone' | 'instance' = 'standalone') {
  const privacy = {
    get: vi.fn(async () => state),
    setTelemetry: vi.fn(async (on: boolean) => ({ ...state, telemetry: { ...state.telemetry, on } })),
    setCrashReports: vi.fn(async (on: boolean) => ({ ...state, crashReports: { ...state.crashReports, on } })),
    setCrashUploadUrl: vi.fn(async (_url: string) => ({ ok: true, state })),
    listCrashes: vi.fn(async () => crashes),
    sendCrash: vi.fn(async (_id: string): Promise<DesktopCrashSendResult> => ({ ok: true })),
    deleteCrashes: vi.fn(async () => {}),
    onChange: vi.fn(() => () => {}),
  };
  (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, platform: 'win32', mode, privacy };
  return privacy;
}

afterEach(() => {
  delete (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
  toast.success.mockClear();
  toast.error.mockClear();
});

const checked = (id: string) => screen.getByTestId(id).getAttribute('aria-checked');

describe('usage info and crash reports', () => {
  it('shows nothing in a browser', async () => {
    const { container } = render(<DesktopTelemetrySettings />);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(container.textContent).toBe('');
  });

  it('shows nothing under a shell without the bridge member', async () => {
    (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop = { version: 1, platform: 'win32' };
    const { container } = render(<DesktopTelemetrySettings />);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(container.textContent).toBe('');
  });

  it('starts with both off, and says what a crash file can hold', async () => {
    bridge(OFF);
    render(<DesktopTelemetrySettings />);
    await screen.findByTestId('desktop-telemetry-toggle');
    expect(checked('desktop-telemetry-toggle')).toBe('false');
    expect(checked('desktop-crash-toggle')).toBe('false');
    expect(screen.getByText('crash_memory')).toBeTruthy();
  });

  it('asks the shell and shows its answer', async () => {
    const privacy = bridge(OFF);
    render(<DesktopTelemetrySettings />);
    fireEvent.click(await screen.findByTestId('desktop-telemetry-toggle'));
    await waitFor(() => expect(privacy.setTelemetry).toHaveBeenCalledWith(true));
    await waitFor(() => expect(checked('desktop-telemetry-toggle')).toBe('true'));
    expect(privacy.setCrashReports).not.toHaveBeenCalled();
  });

  it('shows a switch still off when the user said no in the shell\'s dialog', async () => {
    const privacy = bridge(OFF);
    privacy.setCrashReports.mockResolvedValue(OFF);
    render(<DesktopTelemetrySettings />);
    fireEvent.click(await screen.findByTestId('desktop-crash-toggle'));
    await waitFor(() => expect(privacy.setCrashReports).toHaveBeenCalledWith(true));
    expect(checked('desktop-crash-toggle')).toBe('false');
  });

  it('locks both when a policy forces them off, and says who did', async () => {
    const privacy = bridge({
      telemetry: { on: false, forcedOff: true },
      crashReports: { on: false, forcedOff: true, uploadUrl: '' },
    });
    render(<DesktopTelemetrySettings />);
    const toggle = await screen.findByTestId('desktop-telemetry-toggle');
    expect(toggle.hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('desktop-crash-toggle').hasAttribute('disabled')).toBe(true);
    expect(screen.getAllByText('forced_off')).toHaveLength(2);
    fireEvent.click(toggle);
    expect(privacy.setTelemetry).not.toHaveBeenCalled();
  });

  it('adds the note about the instance\'s own admin only on an instance', async () => {
    bridge(OFF, [], 'instance');
    render(<DesktopTelemetrySettings />);
    await screen.findByTestId('desktop-telemetry-toggle');
    expect(screen.getByText(/instance_note/)).toBeTruthy();
  });
});

describe('crash files', () => {
  it('sends only when the button is pressed', async () => {
    const privacy = bridge(CRASH_ON, [FILE]);
    render(<DesktopTelemetrySettings />);
    const send = await screen.findByTestId('desktop-crash-send');
    expect(privacy.sendCrash).not.toHaveBeenCalled();
    fireEvent.click(send);
    await waitFor(() => expect(privacy.sendCrash).toHaveBeenCalledWith('a1'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('sent'));
  });

  it('says so when no address is set', async () => {
    const privacy = bridge(CRASH_ON, [FILE]);
    privacy.sendCrash.mockResolvedValue({ ok: false, reason: 'no-url' });
    render(<DesktopTelemetrySettings />);
    fireEvent.click(await screen.findByTestId('desktop-crash-send'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('send_no_url'));
  });

  it('says nothing when the user said no in the dialog', async () => {
    const privacy = bridge(CRASH_ON, [FILE]);
    privacy.sendCrash.mockResolvedValue({ ok: false, reason: 'cancelled' });
    render(<DesktopTelemetrySettings />);
    fireEvent.click(await screen.findByTestId('desktop-crash-send'));
    await waitFor(() => expect(privacy.sendCrash).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('asks for the address only with crash reports on, and shows a bad one\'s answer', async () => {
    const privacy = bridge(CRASH_ON);
    privacy.setCrashUploadUrl.mockResolvedValue({ ok: false, state: CRASH_ON });
    render(<DesktopTelemetrySettings />);
    const input = await screen.findByTestId('desktop-crash-url');
    fireEvent.change(input, { target: { value: 'ftp://nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'url_save' }));
    await waitFor(() => expect(privacy.setCrashUploadUrl).toHaveBeenCalledWith('ftp://nope'));
    await screen.findByText('url_invalid');
  });

  it('hides the address with crash reports off', async () => {
    bridge(OFF);
    render(<DesktopTelemetrySettings />);
    await screen.findByTestId('desktop-telemetry-toggle');
    expect(screen.queryByTestId('desktop-crash-url')).toBeNull();
  });

  it('deletes through the shell', async () => {
    const privacy = bridge(CRASH_ON, [FILE]);
    render(<DesktopTelemetrySettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'delete_all' }));
    await waitFor(() => expect(privacy.deleteCrashes).toHaveBeenCalledTimes(1));
  });
});

describe('the text', () => {
  const en = JSON.parse(readFileSync(path.join(process.cwd(), 'locales/en/common.json'), 'utf8')).desktopTelemetry as Record<string, string>;

  it('names everything a heartbeat holds, in plain words', () => {
    for (const word of [/a random ID/, /the app's version numbers/, /operating system/, /how long the app has been running/, /how many plugins and themes/]) {
      expect(en.telemetry_description).toMatch(word);
    }
    expect(en.telemetry_description).not.toMatch(/uptime/i);
  });

  it('says crash reports carry a random ID too', () => {
    expect(en.crash_description).toMatch(/a random ID/);
  });

  it('says a crash file can still hold the text of mail after scrubbing', () => {
    expect(en.crash_memory).toMatch(/can still contain the text of your mail/);
  });
});
