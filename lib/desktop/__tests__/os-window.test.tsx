import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulwarkDesktopBridge, DesktopOsPowerEvent, DesktopOsStatus } from '../types';
import type { CalendarEvent } from '@/lib/jmap/types';

/** The window's end: badge, dropped and pasted files, drag-out, waking up, the settings section. */

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}:${JSON.stringify(values)}` : key),
  useLocale: () => 'en',
}));

function setBridge(bridge: Partial<BulwarkDesktopBridge['os']> | undefined, platform: 'win32' | 'darwin' = 'win32') {
  window.bulwarkDesktop = bridge ? ({ version: 1, platform, os: bridge } as unknown as BulwarkDesktopBridge) : undefined;
}

afterEach(() => {
  setBridge(undefined);
  vi.unstubAllGlobals();
});

describe('the badge', () => {
  it('goes to the bridge in the app, and the Badging API is left alone', async () => {
    const { useAppBadge } = await import('@/hooks/use-app-badge');
    const setBadge = vi.fn();
    const setAppBadge = vi.fn(async () => {});
    Object.defineProperty(navigator, 'setAppBadge', { value: setAppBadge, configurable: true });
    setBridge({ setBadge });
    const { rerender } = renderHook(({ count, enabled }) => useAppBadge(count, enabled), { initialProps: { count: 4, enabled: true } });
    expect(setBadge).toHaveBeenLastCalledWith(4);
    rerender({ count: 4, enabled: false });
    expect(setBadge).toHaveBeenLastCalledWith(0);
    expect(setAppBadge).not.toHaveBeenCalled();
  });

  it('a pop-out has no say in it', async () => {
    const { useAppBadge } = await import('@/hooks/use-app-badge');
    const role = await import('@/lib/popout/window-role');
    const popout = vi.spyOn(role, 'isPopoutWindow').mockReturnValue(true);
    const setBadge = vi.fn();
    setBridge({ setBadge });
    renderHook(() => useAppBadge(4, true));
    expect(setBadge).not.toHaveBeenCalled();
    popout.mockRestore();
  });
});

describe('new-mail sound', () => {
  it('is left to the notification path in the app, not played twice', async () => {
    const { desktopPlaysMailSound } = await import('../mail-notifications');
    expect(desktopPlaysMailSound()).toBe(false);
    setBridge({ notify: vi.fn() as never });
    expect(desktopPlaysMailSound()).toBe(true);
  });
});

describe('the policy keeps refreshing', () => {
  const fetchPolicy = vi.fn(async () => {});

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    fetchPolicy.mockClear();
    const { usePolicyStore } = await import('@/stores/policy-store');
    usePolicyStore.setState({ loaded: true, fetching: false, fetchPolicy });
    const { resetPolicyRefresh } = await import('@/hooks/use-policy-refresh');
    resetPolicyRefresh();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (document as unknown as Record<string, unknown>).visibilityState;
  });

  it('in the desktop app while hidden in the tray', async () => {
    const { POLICY_REFRESH_MS, usePolicyRefresh } = await import('@/hooks/use-policy-refresh');
    setBridge({});
    const { unmount } = renderHook(() => usePolicyRefresh());
    vi.advanceTimersByTime(POLICY_REFRESH_MS);
    expect(fetchPolicy).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('but not in a browser tab out of view', async () => {
    const { POLICY_REFRESH_MS, usePolicyRefresh } = await import('@/hooks/use-policy-refresh');
    const { unmount } = renderHook(() => usePolicyRefresh());
    vi.advanceTimersByTime(POLICY_REFRESH_MS);
    expect(fetchPolicy).not.toHaveBeenCalled();
    unmount();
  });
});

function dropEvent(type: string, files: File[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types: files.length ? ['Files'] : ['text/plain'], files, dropEffect: 'none' } });
  return event;
}

describe('files on the window', () => {
  const file = new File(['x'], 'report.pdf');

  beforeEach(async () => {
    const { clearHandoffs, takeHandoff } = await import('@/lib/launch-handoff');
    clearHandoffs();
    takeHandoff('compose');
  });

  it('nothing happens in a browser', async () => {
    const { startWindowFiles } = await import('../window-files');
    const { takeHandoff } = await import('@/lib/launch-handoff');
    const stop = startWindowFiles();
    const event = dropEvent('drop', [file]);
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(takeHandoff('compose')).toBeNull();
    stop();
  });

  it('a drop on the window starts a new draft with the file', async () => {
    const { startWindowFiles } = await import('../window-files');
    const { takeHandoff } = await import('@/lib/launch-handoff');
    setBridge({});
    const stop = startWindowFiles();
    const over = dropEvent('dragover', [file]);
    window.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    const drop = dropEvent('drop', [file]);
    window.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(takeHandoff('compose')?.files).toEqual([file]);
    stop();
  });

  it('a drop something else took is left alone', async () => {
    const { startWindowFiles } = await import('../window-files');
    const { takeHandoff } = await import('@/lib/launch-handoff');
    setBridge({});
    const stop = startWindowFiles();
    const event = dropEvent('drop', [file]);
    event.preventDefault();
    window.dispatchEvent(event);
    expect(takeHandoff('compose')).toBeNull();
    stop();
  });

  it('text dragged around is not a file', async () => {
    const { startWindowFiles } = await import('../window-files');
    setBridge({});
    const stop = startWindowFiles();
    const event = dropEvent('dragover', []);
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    stop();
  });

  it('an open composer takes the file itself', async () => {
    const { setComposerFileTarget, startWindowFiles } = await import('../window-files');
    const { takeHandoff } = await import('@/lib/launch-handoff');
    setBridge({});
    const stop = startWindowFiles();
    const target = vi.fn();
    const clear = setComposerFileTarget(target);
    window.dispatchEvent(dropEvent('drop', [file]));
    expect(target).toHaveBeenCalledWith([file]);
    expect(takeHandoff('compose')).toBeNull();
    clear();
    stop();
  });

  it('a pasted file is taken; pasted text is not', async () => {
    const { startWindowFiles } = await import('../window-files');
    const { takeHandoff } = await import('@/lib/launch-handoff');
    setBridge({});
    const stop = startWindowFiles();
    const paste = (files: File[]) => {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { files } });
      window.dispatchEvent(event);
      return event;
    };
    expect(paste([]).defaultPrevented).toBe(false);
    expect(takeHandoff('compose')).toBeNull();
    expect(paste([file]).defaultPrevented).toBe(true);
    expect(takeHandoff('compose')?.files).toEqual([file]);
    stop();
  });

  it('our own native drag over our own window is not a new file', async () => {
    const { setOwnDragActive, startWindowFiles } = await import('../window-files');
    const { takeHandoff } = await import('@/lib/launch-handoff');
    setBridge({});
    const stop = startWindowFiles();
    setOwnDragActive(true);
    window.dispatchEvent(dropEvent('drop', [file]));
    expect(takeHandoff('compose')).toBeNull();
    setOwnDragActive(false);
    stop();
  });
});

describe('dragging an attachment out', () => {
  const blobUrl = 'blob:https://app/1';
  const source = {
    name: 'report.pdf',
    type: 'application/pdf',
    getBlobUrl: async () => blobUrl,
    getBlob: async () => new Blob([new Uint8Array([1, 2, 3])]),
  };

  async function ready() {
    const { useAttachmentDrag } = await import('@/hooks/use-attachment-drag');
    const hook = renderHook(() => useAttachmentDrag(source, true));
    act(() => hook.result.current.onPointerEnter());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return hook;
  }

  it('in the app: the OS\'s own drag, with the bytes for a real file', async () => {
    const startDrag = vi.fn(async () => true);
    setBridge({ startDrag, copyFiles: vi.fn() as never });
    const hook = await ready();
    const event = { preventDefault: vi.fn(), dataTransfer: { setData: vi.fn(), effectAllowed: '' } };
    hook.result.current.onDragStart(event as never);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.dataTransfer.setData).not.toHaveBeenCalled();
    await waitFor(() => expect(startDrag).toHaveBeenCalled());
    const [files] = startDrag.mock.calls[0] as unknown as [{ name: string; data: Uint8Array }[]];
    expect(files[0].name).toBe('report.pdf');
    expect([...files[0].data]).toEqual([1, 2, 3]);
  });

  it('in the app, a drag before the bytes are here starts nothing and fetches them for the next', async () => {
    const startDrag = vi.fn(async () => true);
    setBridge({ startDrag, copyFiles: vi.fn() as never });
    const { useAttachmentDrag } = await import('@/hooks/use-attachment-drag');
    const hook = renderHook(() => useAttachmentDrag(source, true));
    const event = { preventDefault: vi.fn(), dataTransfer: { setData: vi.fn(), effectAllowed: '' } };
    hook.result.current.onDragStart(event as never);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(startDrag).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    hook.result.current.onDragStart(event as never);
    await waitFor(() => expect(startDrag).toHaveBeenCalled());
  });

  it('in a browser: still DownloadURL, and no copy button', async () => {
    const hook = await ready();
    const event = { preventDefault: vi.fn(), dataTransfer: { setData: vi.fn(), effectAllowed: '' } };
    hook.result.current.onDragStart(event as never);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.dataTransfer.setData).toHaveBeenCalledWith('DownloadURL', `application/pdf:report.pdf:${blobUrl}`);
    expect(hook.result.current.onCopyAsFile).toBeUndefined();
  });

  it('Copy as file hands the bytes to main', async () => {
    const copyFiles = vi.fn(async () => true);
    setBridge({ startDrag: vi.fn() as never, copyFiles });
    const hook = await ready();
    await expect(hook.result.current.onCopyAsFile?.()).resolves.toBe(true);
    const [files] = copyFiles.mock.calls[0] as unknown as [{ name: string; data: Uint8Array }[]];
    expect(files[0].name).toBe('report.pdf');
  });
});

describe('waking up', () => {
  async function started(os: Partial<BulwarkDesktopBridge['os']> = {}) {
    let fire: (event: DesktopOsPowerEvent) => void = () => {};
    setBridge({ onPower: (listener: (event: DesktopOsPowerEvent) => void) => { fire = listener; return () => {}; }, ...os });
    const power = await import('../power');
    return { fire: (event: DesktopOsPowerEvent) => fire(event), power, stop: power.startPowerWatch() };
  }

  it('a resume checks for changes at once, the way a tab coming back does, and only once with the unlock', async () => {
    const { fire, power, stop } = await started();
    const { usePolicyStore } = await import('@/stores/policy-store');
    const fetchPolicy = vi.fn(async () => {});
    usePolicyStore.setState({ loaded: true, fetching: false, fetchPolicy });
    const visible = vi.fn();
    const online = vi.fn();
    const wake = vi.fn();
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', online);
    const stopWake = power.addWakeHandler(wake);
    fire('resume');
    fire('unlock-screen');
    expect(visible).toHaveBeenCalledTimes(1);
    expect(online).toHaveBeenCalledTimes(1);
    expect(fetchPolicy).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledTimes(1);
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('online', online);
    stopWake();
    stop();
  });

  it('a suspend tells the sleep handlers and wakes nothing', async () => {
    const { fire, power, stop } = await started();
    const sleep = vi.fn();
    const visible = vi.fn();
    const stopSleep = power.addSleepHandler(sleep);
    document.addEventListener('visibilitychange', visible);
    fire('suspend');
    fire('lock-screen');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(visible).not.toHaveBeenCalled();
    document.removeEventListener('visibilitychange', visible);
    stopSleep();
    stop();
  });

  it('a network change counts as waking', async () => {
    const connection = new EventTarget();
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { connection }));
    const { power, stop } = await started();
    const wake = vi.fn();
    const stopWake = power.addWakeHandler(wake);
    await new Promise((resolve) => setTimeout(resolve, 0));
    connection.dispatchEvent(new Event('change'));
    expect(wake).toHaveBeenCalled();
    stopWake();
    stop();
  });
});

describe('the summary', () => {
  const event = (id: string, start: string, over: Partial<CalendarEvent> = {}) => ({ id, title: id, start, utcStart: start, status: 'confirmed', showWithoutTime: false, ...over }) as unknown as CalendarEvent;
  const now = new Date('2026-11-03T10:00:00Z').getTime();

  it('the next event is the soonest one still ahead, not cancelled and not all-day', async () => {
    const { nextEventOf } = await import('../os-summary');
    const events = [
      event('later', '2026-11-03T15:00:00Z'),
      event('past', '2026-11-03T09:00:00Z'),
      event('cancelled', '2026-11-03T11:00:00Z', { status: 'cancelled' }),
      event('allday', '2026-11-03T10:30:00Z', { showWithoutTime: true }),
      event('soon', '2026-11-03T12:00:00Z'),
    ];
    expect(nextEventOf(events, now)?.id).toBe('soon');
    expect(nextEventOf([event('past', '2026-11-03T09:00:00Z')], now)).toBeNull();
  });

  describe('with a login', () => {
    const row = { id: 'e1', threadId: 't1', subject: 'Lunch?', from: [{ name: 'Alice', email: 'a@example.org' }] };
    const getEmails = vi.fn(async () => ({ emails: [row], hasMore: false, total: 1 }));
    const fake = { getAccountId: () => 'acc', getEmails, queryCalendarEvents: vi.fn(async () => []) };

    beforeEach(async () => {
      getEmails.mockClear();
      const { useAuthStore } = await import('@/stores/auth-store');
      const { useAccountStore } = await import('@/stores/account-store');
      const { useEmailStore } = await import('@/stores/email-store');
      useAuthStore.setState({ isAuthenticated: true, client: fake as never, activeAccountId: 'alice@one' });
      useAccountStore.setState({ accounts: [{ id: 'alice@one', cookieSlot: 3, serverUrl: 'https://one.example', username: 'alice@example.org' }] as never });
      useEmailStore.setState({ mailboxes: [{ id: 'in', role: 'inbox', name: 'Inbox' }] as never });
    });

    afterEach(async () => {
      const { useAuthStore } = await import('@/stores/auth-store');
      useAuthStore.setState({ isAuthenticated: false, client: null, activeAccountId: null });
      const { setAppLockCheck } = await import('../app-lock-state');
      setAppLockCheck(null);
    });

    it('lists unread mail with what the tray item needs to open it', async () => {
      const { readSummary } = await import('../os-summary');
      const summary = await readSummary('en');
      expect(summary.unread).toEqual([expect.objectContaining({ emailId: 'e1', accountId: 'acc', sender: 'Alice', subject: 'Lunch?' })]);
      expect(JSON.parse(summary.unread[0].context!)).toMatchObject({ emailId: 'e1', slot: 3 });
      expect(getEmails).toHaveBeenCalledWith('in', undefined, 5, 0, undefined, false, { notKeyword: '$seen' });
    });

    it('while locked it is empty, without asking anyone anything', async () => {
      const { setAppLockCheck } = await import('../app-lock-state');
      const { readSummary, EMPTY_SUMMARY } = await import('../os-summary');
      setAppLockCheck(() => true);
      await expect(readSummary('en')).resolves.toEqual(EMPTY_SUMMARY);
      expect(getEmails).not.toHaveBeenCalled();
    });
  });
});

describe('the settings section', () => {
  const settings = { closeToTray: true, startAtLogin: false, startMinimized: false, attentionOnNewMail: true, quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '07:00', showShortcut: null };
  const status = (over = {}): DesktopOsStatus => ({ settings: { ...settings, ...over }, pausedUntil: null, shortcutActive: false });

  function bridgeFor(current: DesktopOsStatus) {
    return {
      getStatus: vi.fn(async () => current),
      setSettings: vi.fn(async (patch: Partial<DesktopOsStatus['settings']>) => ({ ...current, settings: { ...current.settings, ...patch } })),
      onStatusChange: vi.fn(() => () => {}),
      defaultAppStatus: vi.fn(async () => ({ registered: false, mailto: false, webcal: false })),
      openDefaultAppSettings: vi.fn(async () => ({ registered: true, mailto: false, webcal: false })),
    };
  }

  it('a browser never sees it', async () => {
    const { DesktopOsSettings } = await import('@/components/settings/desktop-os-settings');
    const { container } = render(<DesktopOsSettings />);
    expect(container).toBeEmptyDOMElement();
  });

  it('in the app it shows the state and changes it', async () => {
    const { DesktopOsSettings } = await import('@/components/settings/desktop-os-settings');
    const os = bridgeFor(status());
    setBridge(os as never);
    render(<DesktopOsSettings />);
    expect(await screen.findByText('section_title')).toBeInTheDocument();
    expect(screen.queryByText('start_minimized_label')).toBeNull();
    // Second in the section, after Close to tray.
    fireEvent.click(screen.getAllByRole('switch')[1]);
    await waitFor(() => expect(os.setSettings).toHaveBeenCalledWith({ startAtLogin: true }));
    expect(await screen.findByText('start_minimized_label')).toBeInTheDocument();
  });

  it('the button offers the app and opens where the choice is made', async () => {
    const { DesktopOsSettings } = await import('@/components/settings/desktop-os-settings');
    const os = bridgeFor(status());
    setBridge(os as never);
    render(<DesktopOsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'default_app_button' }));
    await waitFor(() => expect(os.openDefaultAppSettings).toHaveBeenCalled());
  });

  it('says when another app holds the shortcut', async () => {
    const { DesktopOsSettings } = await import('@/components/settings/desktop-os-settings');
    setBridge(bridgeFor(status({ showShortcut: 'CommandOrControl+Shift+B' })) as never);
    render(<DesktopOsSettings />);
    expect(await screen.findByText(/show_shortcut_taken/)).toBeInTheDocument();
  });

  it('macOS gets its own word for the bounce', async () => {
    const { DesktopOsSettings } = await import('@/components/settings/desktop-os-settings');
    setBridge(bridgeFor(status()) as never, 'darwin');
    render(<DesktopOsSettings />);
    expect(await screen.findByText('attention_mac_label')).toBeInTheDocument();
  });
});
