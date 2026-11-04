import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulwarkDesktopBridge } from '@/lib/desktop/types';
import { registerDesktopSurface, resetDesktopCommands } from '@/lib/desktop/commands';
import { readDesktopPrefs, resetDesktopPrefsCache, setDesktopPref } from '@/lib/desktop/preferences';
import { resetDesktopLanguages } from '@/lib/desktop/languages';
import { registerComposeFlush, resetComposeFlushRegistry } from '@/lib/compose-flush-registry';
import { useToastStore } from '@/stores/toast-store';
import { useAuthStore } from '@/stores/auth-store';
import { useLocaleStore } from '@/stores/locale-store';
import { useOfflineStore } from '@/lib/offline/state';
import { offerReturnedComposer, takeReturnedComposer } from '@/lib/popout/return-to-main';

const push = vi.fn();
const route = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ push }), usePathname: () => route.pathname }));

// The catalog on screen: its language, and text that says which one it came from.
const intl = vi.hoisted(() => ({ locale: 'en', prefix: '', messages: {} as object }));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => `${intl.prefix}${key}`,
  useLocale: () => intl.locale,
  useMessages: () => intl.messages,
}));

const canPrint = vi.fn(() => true);
const canDownload = vi.fn(() => true);
vi.mock('@/lib/device-policy', () => ({ canPrintAnywhere: () => canPrint(), canDownloadAnywhere: () => canDownload() }));
vi.mock('@/hooks/use-device-policy', () => ({ useStrictestDevices: () => strictest.current }));
const strictest = vi.hoisted(() => ({ current: {} as object }));

const resolveExternalLink = vi.fn(async (ctx: { href: string }) => ctx.href as string | null);
vi.mock('@/lib/plugin-hook-result', () => ({ resolveExternalLink: (ctx: { href: string }) => resolveExternalLink(ctx) }));
const requestInternalMailto = vi.fn((_raw: string) => true);
vi.mock('@/lib/protocol-handlers/mailto', () => ({ requestInternalMailto: (raw: string) => requestInternalMailto(raw) }));
const allowed = vi.hoisted(() => ({ dictionary: true }));
vi.mock('@/lib/desktop/dictionary-download', () => ({ dictionaryDownloadAllowed: () => allowed.dictionary }));
const signOut = vi.hoisted(() => ({ full: [] as (() => void)[], before: [] as (() => Promise<void>)[] }));
vi.mock('@/lib/sign-out-cleanup', async (original) => ({
  ...(await original<object>()),
  onFullSignOut: (task: () => void) => signOut.full.push(task),
  onBeforeSignOut: (task: () => Promise<void>) => signOut.before.push(task),
}));

const { DesktopHost } = await import('../desktop-host');

function fakeBridge() {
  let command: ((id: string) => void) | null = null;
  let flush: (() => Promise<unknown>) | null = null;
  let missing: ((language: string) => void) | null = null;
  const parts = {
    setState: vi.fn(),
    setLanguages: vi.fn(),
    sessionReady: vi.fn(),
    sessionEnded: vi.fn(),
    setRestoreEnabled: vi.fn(),
    setTheme: vi.fn(),
    openExternal: vi.fn(),
    allowDownload: vi.fn(),
    clearFiles: vi.fn(),
  };
  const bridge = {
    version: 1,
    platform: 'win32',
    menu: { setState: parts.setState, onCommand: (listener: (id: string) => void) => { command = listener; return () => {}; } },
    shell: { openExternal: parts.openExternal, setLanguages: parts.setLanguages },
    spellcheck: { missing: async () => [], onMissing: (listener: (language: string) => void) => { missing = listener; return () => {}; }, allowDownload: parts.allowDownload },
    clipboard: { copyFile: async () => true, clearFiles: parts.clearFiles },
    windows: { sessionReady: parts.sessionReady, sessionEnded: parts.sessionEnded, setRestoreEnabled: parts.setRestoreEnabled },
    theme: { set: parts.setTheme, system: async () => ({ dark: false, highContrast: false }) },
    lifecycle: { onFlushRequest: (handler: () => Promise<unknown>) => { flush = handler; return () => {}; } },
  };
  window.bulwarkDesktop = bridge as unknown as BulwarkDesktopBridge;
  return { ...parts, run: (id: string) => act(() => command!(id)), flush: () => flush!(), missing: (language: string) => act(() => missing!(language)) };
}

const original = useAuthStore.getState();

beforeEach(() => {
  route.pathname = '/';
  Object.assign(intl, { locale: 'en', prefix: '', messages: {} });
  push.mockClear();
  resolveExternalLink.mockClear();
  resolveExternalLink.mockImplementation(async (ctx) => ctx.href);
  requestInternalMailto.mockClear();
  requestInternalMailto.mockReturnValue(true);
  allowed.dictionary = true;
  signOut.full.length = 0;
  signOut.before.length = 0;
  resetDesktopLanguages();
  canPrint.mockReturnValue(true);
  canDownload.mockReturnValue(true);
  localStorage.clear();
  resetDesktopPrefsCache();
  useAuthStore.setState({ isAuthenticated: true, getAllConnectedClients: () => new Map() } as never);
});

afterEach(() => {
  cleanup();
  window.bulwarkDesktop = undefined;
  resetDesktopCommands();
  useAuthStore.setState(original);
  window.history.replaceState(null, '', '/');
});

describe('DesktopHost', () => {
  it('does nothing in a browser', () => {
    expect(() => render(<DesktopHost />)).not.toThrow();
  });

  it('File > New event, task and contact open that app with its editor; Settings opens in this window', async () => {
    const { peekParkedAppCommand } = await import('@/lib/app-commands');
    const shell = fakeBridge();
    render(<DesktopHost />);
    shell.run('file.newEvent');
    expect(push).toHaveBeenLastCalledWith('/calendar');
    expect(peekParkedAppCommand()).toBe('new-event');
    shell.run('file.newTask');
    expect(push).toHaveBeenLastCalledWith('/calendar');
    expect(peekParkedAppCommand()).toBe('new-task');
    shell.run('file.newContact');
    expect(push).toHaveBeenLastCalledWith('/contacts');
    expect(peekParkedAppCommand()).toBe('new-contact');
    shell.run('file.settings');
    expect(push).toHaveBeenLastCalledWith('/settings');
  });

  it('tells the menus which part of the app is on screen, and offers the New lines once signed in', async () => {
    route.pathname = '/calendar';
    const shell = fakeBridge();
    render(<DesktopHost />);
    await waitFor(() => expect(shell.setState).toHaveBeenCalled());
    const state = shell.setState.mock.lastCall![0];
    expect(state).toMatchObject({ 'section.calendar': true, 'file.newEvent': true, 'file.newContact': true, 'file.settings': true, 'file.import': true });
    expect(state['section.mail']).toBeUndefined();
  });

  it('runs a command from what\'s on the page first', () => {
    const shell = fakeBridge();
    render(<DesktopHost />);
    const onPage = vi.fn();
    registerDesktopSurface({ handlers: { 'go.inbox': onPage }, state: {} });
    shell.run('go.inbox');
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it('with nothing there, the commands that work anywhere still do', () => {
    const shell = fakeBridge();
    render(<DesktopHost />);
    shell.run('go.calendar');
    expect(push).toHaveBeenLastCalledWith('/calendar');
    shell.run('go.contacts');
    expect(push).toHaveBeenLastCalledWith('/contacts');
  });

  it('a link to a folder goes through the router, encoded', () => {
    const shell = fakeBridge();
    render(<DesktopHost />);
    shell.run('link.folder:sent');
    expect(push).toHaveBeenLastCalledWith('/mail/folder/sent');
  });

  it('an unknown command does nothing', () => {
    const shell = fakeBridge();
    render(<DesktopHost />);
    expect(() => shell.run('nonsense')).not.toThrow();
    expect(push).not.toHaveBeenCalled();
  });

  it('tells the shell what the organisation allows', async () => {
    canPrint.mockReturnValue(false);
    canDownload.mockReturnValue(false);
    const shell = fakeBridge();
    render(<DesktopHost />);
    await waitFor(() => expect(shell.setState).toHaveBeenCalled());
    expect(shell.setState.mock.lastCall![0]).toMatchObject({ 'file.print': false, 'file.savePdf': false, 'policy.download': false });
  });

  it('signed in: it says so once, for windows from last time and waiting links', async () => {
    const shell = fakeBridge();
    render(<DesktopHost />);
    await waitFor(() => expect(shell.sessionReady).toHaveBeenCalledTimes(1));
  });

  it('not signed in, or in a pop-out with a borrowed session: it doesn\'t', async () => {
    const shell = fakeBridge();
    useAuthStore.setState({ isAuthenticated: false } as never);
    const first = render(<DesktopHost />);
    await act(async () => {});
    expect(shell.sessionReady).not.toHaveBeenCalled();
    first.unmount();
    useAuthStore.setState({ isAuthenticated: true } as never);
    window.history.replaceState(null, '', '/popout/compose');
    render(<DesktopHost />);
    await act(async () => {});
    expect(shell.sessionReady).not.toHaveBeenCalled();
  });

  it('passes the restore setting on', async () => {
    const shell = fakeBridge();
    render(<DesktopHost />);
    await waitFor(() => expect(shell.setRestoreEnabled).toHaveBeenLastCalledWith(true));
    act(() => setDesktopPref('restoreWindows', false));
    await waitFor(() => expect(shell.setRestoreEnabled).toHaveBeenLastCalledWith(false));
  });

  it('says which languages are in use', async () => {
    const shell = fakeBridge();
    act(() => useLocaleStore.setState({ locale: 'de' }));
    intl.locale = 'de';
    render(<DesktopHost />);
    await waitFor(() => expect(shell.setLanguages).toHaveBeenCalled());
    expect(shell.setLanguages.mock.lastCall![0]).toMatchObject({ ui: 'de' });
  });

  it('follows the text on screen, not only the stored choice', async () => {
    const shell = fakeBridge();
    // English chosen, but the first render still has the catalog the server picked from the OS.
    act(() => useLocaleStore.setState({ locale: 'en' }));
    Object.assign(intl, { locale: 'de', prefix: 'de:', messages: { de: true } });
    const view = render(<DesktopHost />);
    await waitFor(() => expect(shell.setLanguages).toHaveBeenCalled());
    // The chosen catalog lands a render later.
    Object.assign(intl, { locale: 'en', prefix: 'en:', messages: { en: true } });
    view.rerender(<DesktopHost />);
    await waitFor(() => expect(shell.setLanguages.mock.lastCall![0].labels.menuFile).toBe('en:desktopUi.menu.file'));
    expect(shell.setLanguages.mock.lastCall![0]).toMatchObject({ ui: 'en' });
  });

  describe('Open Link in a native menu', () => {
    const openLink = (url: string) => `link.open:${JSON.stringify({ url, text: 'click' })}`;

    it('goes past the same check as a click on it', async () => {
      const shell = fakeBridge();
      render(<DesktopHost />);
      shell.run(openLink('https://example.org/a'));
      await waitFor(() => expect(shell.openExternal).toHaveBeenCalledWith('https://example.org/a'));
      expect(resolveExternalLink).toHaveBeenCalledWith(expect.objectContaining({ href: 'https://example.org/a', text: 'click' }));
    });

    it('a plugin can stop it', async () => {
      resolveExternalLink.mockResolvedValue(null);
      const shell = fakeBridge();
      render(<DesktopHost />);
      shell.run(openLink('https://example.org/a'));
      await waitFor(() => expect(resolveExternalLink).toHaveBeenCalled());
      await act(async () => {});
      expect(shell.openExternal).not.toHaveBeenCalled();
    });

    it('a plugin can send it elsewhere', async () => {
      resolveExternalLink.mockResolvedValue('https://safe.example.org/');
      const shell = fakeBridge();
      render(<DesktopHost />);
      shell.run(openLink('https://example.org/a'));
      await waitFor(() => expect(shell.openExternal).toHaveBeenCalledWith('https://safe.example.org/'));
    });

    it('a mail address goes to the app\'s composer', async () => {
      const shell = fakeBridge();
      render(<DesktopHost />);
      shell.run(openLink('mailto:a@example.org'));
      await waitFor(() => expect(requestInternalMailto).toHaveBeenCalledWith('mailto:a@example.org'));
      expect(shell.openExternal).not.toHaveBeenCalled();
    });

    it('tells the shell it has this path, so an older page keeps the direct way', async () => {
      const shell = fakeBridge();
      render(<DesktopHost />);
      await waitFor(() => expect(shell.setState).toHaveBeenCalled());
      expect(shell.setState.mock.lastCall![0]).toMatchObject({ 'link.check': true });
    });
  });

  it('hands the shell its menus in the interface language', async () => {
    const shell = fakeBridge();
    act(() => useLocaleStore.setState({ locale: 'fr' }));
    render(<DesktopHost />);
    await waitFor(() => expect(shell.setLanguages).toHaveBeenCalled());
    const { labels } = shell.setLanguages.mock.lastCall![0];
    // The test's next-intl gives the key back.
    expect(labels.menuFile).toBe('desktopUi.menu.file');
    expect(labels.menuReply).toBe('context_menu.reply');
    expect(labels.unsentMany).toBe('desktopUi.closing.unsent_many');
  });

  describe('a language with no checker in the OS', () => {
    afterEach(() => resetComposeFlushRegistry());
    const toasts = () => useToastStore.getState().toasts;

    it('the composer asks once, and only a yes opens the downloads', async () => {
      useToastStore.setState({ toasts: [] });
      const shell = fakeBridge();
      render(<DesktopHost />);
      await act(async () => {});
      shell.missing('nl-NL');
      // No composer open: nobody is writing yet.
      expect(toasts()).toHaveLength(0);
      const stop = registerComposeFlush(async () => {});
      await waitFor(() => expect(toasts()).toHaveLength(1));
      expect(shell.allowDownload).not.toHaveBeenCalled();
      act(() => toasts()[0].action!.onClick());
      expect(shell.allowDownload).toHaveBeenCalledTimes(1);
      expect(readDesktopPrefs().dictionaryDownload).toBe('yes');
      stop();
    });

    it('never a second time', async () => {
      useToastStore.setState({ toasts: [] });
      setDesktopPref('dictionaryDownload', 'no');
      const shell = fakeBridge();
      render(<DesktopHost />);
      await act(async () => {});
      const stop = registerComposeFlush(async () => {});
      shell.missing('nl-NL');
      await act(async () => {});
      expect(toasts()).toHaveLength(0);
      stop();
    });

    it('never in no-third-party mode, even after an old yes', async () => {
      useToastStore.setState({ toasts: [] });
      allowed.dictionary = false;
      setDesktopPref('dictionaryDownload', 'yes');
      const first = fakeBridge();
      const view = render(<DesktopHost />);
      await act(async () => {});
      expect(first.allowDownload).not.toHaveBeenCalled();
      view.unmount();
      setDesktopPref('dictionaryDownload', 'ask');
      const shell = fakeBridge();
      render(<DesktopHost />);
      await act(async () => {});
      const stop = registerComposeFlush(async () => {});
      shell.missing('nl-NL');
      await act(async () => {});
      expect(toasts()).toHaveLength(0);
      stop();
    });

    it('a yes from before opens them at the next start', async () => {
      setDesktopPref('dictionaryDownload', 'yes');
      const shell = fakeBridge();
      render(<DesktopHost />);
      await act(async () => {});
      expect(shell.allowDownload).toHaveBeenCalledTimes(1);
    });
  });

  it('signing out takes the files copied to the clipboard with it', async () => {
    const shell = fakeBridge();
    render(<DesktopHost />);
    await act(async () => {});
    signOut.full[0]();
    expect(shell.clearFiles).toHaveBeenCalledTimes(1);
    await signOut.before[0]();
    expect(shell.clearFiles).toHaveBeenCalledTimes(2);
  });

  it('a quit is told how much mail is waiting', async () => {
    const shell = fakeBridge();
    render(<DesktopHost />);
    act(() => useOfflineStore.setState({ outbox: [{ id: 1 }, { id: 2 }] } as never));
    await expect(shell.flush()).resolves.toEqual({ unsent: 2 });
    act(() => useOfflineStore.setState({ outbox: [] } as never));
  });
});

describe('quick compose and the way back', () => {
  afterEach(() => {
    takeReturnedComposer();
  });

  it('tells the shell when nobody is signed in any more, so a shortcut goes to the sign-in', async () => {
    const shell = fakeBridge();
    useAuthStore.setState({ isAuthenticated: true });
    render(<DesktopHost />);
    await waitFor(() => expect(shell.sessionReady).toHaveBeenCalled());
    expect(shell.sessionEnded).not.toHaveBeenCalled();
    act(() => useAuthStore.setState({ isAuthenticated: false }));
    await waitFor(() => expect(shell.sessionEnded).toHaveBeenCalledOnce());
  });

  it('goes to the mail page for a composer coming back, with none on screen', async () => {
    fakeBridge();
    render(<DesktopHost />);
    push.mockClear();
    offerReturnedComposer({ returnId: 'r1', payload: { mode: 'compose' }, answer: () => {}, sendReady: () => {} });
    expect(push).toHaveBeenCalledWith('/');
  });
});
