import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBroadcastChannel } from './fixtures/fake-broadcast-channel';
import { isPopoutPath, mainWindowStorage } from '@/lib/popout/window-role';

// Pop-out windows: which paths are one, when they are on offer, how they open,
// and how a draft moves to one.

function stubDisplay({ standalone = true, fine = true }: { standalone?: boolean; fine?: boolean } = {}) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('pointer: fine') ? fine : query.includes('display-mode: standalone') ? standalone : false,
    addEventListener() {},
    removeEventListener() {},
  }));
  window.matchMedia = globalThis.matchMedia;
}

beforeEach(() => {
  FakeBroadcastChannel.reset();
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  Object.defineProperty(navigator, 'locks', { value: { request: vi.fn() }, configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.bulwarkDesktop;
  Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
  window.history.replaceState(null, '', '/');
});

describe('isPopoutPath', () => {
  it('knows the two routes, with or without locale and mount prefix', () => {
    for (const path of ['/popout/compose', '/en/popout/compose', '/zh-TW/popout/message/abc', '/webmail/de/popout/message/abc', '/popout/compose/']) {
      expect(isPopoutPath(path), path).toBe(true);
    }
  });

  it('does not take other pages for one', () => {
    // A folder in Files can have any name, and a mail folder too.
    for (const path of ['/', '/mail', '/files/popout/compose', '/en/mail/folder/popout', '/popout', '/popout/message', '/popout/message/a/b', '/en/files/popout/message/x']) {
      expect(isPopoutPath(path), path).toBe(false);
    }
  });
});

describe('mainWindowStorage', () => {
  it('lets a main window write, and a pop-out only read', () => {
    localStorage.setItem('account-registry', 'before');
    const storage = mainWindowStorage();

    storage.setItem('account-registry', 'main');
    expect(localStorage.getItem('account-registry')).toBe('main');

    window.history.replaceState(null, '', '/en/popout/compose');
    expect(storage.getItem('account-registry')).toBe('main');
    storage.setItem('account-registry', 'popout');
    storage.removeItem('account-registry');
    expect(localStorage.getItem('account-registry')).toBe('main');
  });
});

describe('popoutsAvailable', () => {
  async function available() {
    const { popoutsAvailable } = await import('@/lib/popout/support');
    return popoutsAvailable();
  }

  it('is off in a browser tab: the app behaves as it always has', async () => {
    stubDisplay({ standalone: false });
    expect(await available()).toBe(false);
  });

  it('is on in an installed app on a device with a pointer', async () => {
    stubDisplay();
    expect(await available()).toBe(true);
  });

  it('is off in an installed app on a touch device, where window.open leaves the app', async () => {
    stubDisplay({ fine: false });
    expect(await available()).toBe(false);
  });

  it('asks the bridge too: display-mode is `browser` in Electron', async () => {
    stubDisplay({ standalone: false });
    window.bulwarkDesktop = { windows: {} };
    expect(await available()).toBe(true);
  });

  it('is off without Web Locks or BroadcastChannel, which keep the session safe across windows', async () => {
    stubDisplay();
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
    expect(await available()).toBe(false);
    Object.defineProperty(navigator, 'locks', { value: { request: vi.fn() }, configurable: true });
    vi.stubGlobal('BroadcastChannel', undefined);
    expect(await available()).toBe(false);
  });

  it('is off in Lite, which has no such route', async () => {
    vi.resetModules();
    vi.doMock('@/lib/lite', async (original) => ({ ...await original<object>(), IS_LITE: true }));
    stubDisplay();
    const { popoutsAvailable } = await import('@/lib/popout/support');
    expect(popoutsAvailable()).toBe(false);
    vi.doUnmock('@/lib/lite');
    vi.resetModules();
  });
});

describe('opening windows', () => {
  it('opens a message as a popup in the app, with its login and account', async () => {
    const { openMessageWindow } = await import('@/lib/popout/open');
    const open = vi.spyOn(window, 'open').mockReturnValue({ focus: vi.fn(), closed: false } as unknown as Window);
    expect(openMessageWindow({ emailId: 'm/1', localAccountId: 'login-b', ownerAccountId: 'group' })).toBe(true);
    const [url, name, features] = open.mock.calls[0];
    expect(url).toBe('/popout/message/m%2F1?account=login-b&owner=group');
    expect(name).toBe('bulwark-message-m_1');
    expect(features).toMatch(/^popup=yes,width=\d+,height=\d+,left=\d+,top=\d+$/);
    // In an installed app noopener sends the window to the system browser.
    expect(features).not.toContain('noopener');
  });

  it('focuses the window a message already has, without loading it again', async () => {
    const { openMessageWindow } = await import('@/lib/popout/open');
    const focus = vi.fn();
    const open = vi.spyOn(window, 'open').mockReturnValue({ focus, closed: false } as unknown as Window);
    openMessageWindow({ emailId: 'twice' });
    openMessageWindow({ emailId: 'twice' });
    expect(open).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(2);
  });

  it('opens it again once that window was closed', async () => {
    const { openMessageWindow } = await import('@/lib/popout/open');
    const first = { focus: vi.fn(), closed: false };
    const open = vi.spyOn(window, 'open').mockReturnValue(first as unknown as Window);
    openMessageWindow({ emailId: 'reopened' });
    first.closed = true;
    openMessageWindow({ emailId: 'reopened' });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('leaves it to the bridge when the bridge opens windows, under the same name', async () => {
    const { openMessageWindow } = await import('@/lib/popout/open');
    const bridgeOpen = vi.fn();
    window.bulwarkDesktop = { windows: { open: bridgeOpen } };
    const open = vi.spyOn(window, 'open');
    expect(openMessageWindow({ emailId: 'bridged' })).toBe(true);
    expect(openMessageWindow({ emailId: 'bridged' })).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(bridgeOpen.mock.calls[0][1]).toMatchObject({ name: 'bulwark-message-bridged' });
    expect(bridgeOpen.mock.calls[1][1].name).toBe(bridgeOpen.mock.calls[0][1].name);
  });

  it('says false when a blocker stops the window', async () => {
    const { openComposerWindow, openMessageWindow } = await import('@/lib/popout/open');
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(openMessageWindow({ emailId: 'blocked' })).toBe(false);
    expect(openComposerWindow()).toBeNull();
  });
});

describe('moving a draft to a pop-out', () => {
  const payload = { mode: 'reply' as const, initialData: { draftId: 'saved-3', subject: 'Hi' } as never };
  const settle = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

  // The module keeps its channel while a handoff is pending.
  beforeEach(() => vi.resetModules());

  it('hands the draft to the window that asks, once it is ready, under the same draft id', async () => {
    const { createComposeHandoff, receiveComposeHandoff } = await import('@/lib/popout/compose-handoff');
    const handoff = createComposeHandoff()!;
    const received = receiveComposeHandoff(handoff.id);
    await settle();
    // The pop-out is open and waiting; the save hasn't finished.
    let done = false;
    void received.then(() => { done = true; });
    await settle();
    expect(done).toBe(false);

    handoff.complete(payload);
    await expect(received).resolves.toMatchObject({ mode: 'reply', initialData: { draftId: 'saved-3' } });
  });

  it('tells the pop-out when the move is called off', async () => {
    const { createComposeHandoff, receiveComposeHandoff } = await import('@/lib/popout/compose-handoff');
    const handoff = createComposeHandoff()!;
    const received = receiveComposeHandoff(handoff.id);
    await settle();
    handoff.cancel();
    await expect(received).resolves.toBeNull();
  });

  it('gives up when nothing comes in time', async () => {
    const { receiveComposeHandoff } = await import('@/lib/popout/compose-handoff');
    await expect(receiveComposeHandoff('nobody-has-this', 10)).resolves.toBeNull();
  });

  it('starts a reload of the pop-out from what it holds, with no opener needed', async () => {
    const { rememberComposePayload, receiveComposeHandoff } = await import('@/lib/popout/compose-handoff');
    rememberComposePayload('kept', payload);
    FakeBroadcastChannel.reset();
    vi.stubGlobal('BroadcastChannel', undefined);
    await expect(receiveComposeHandoff('kept')).resolves.toMatchObject({ initialData: { draftId: 'saved-3' } });
  });
});

describe('asking a main window for the session', () => {
  it('takes the first answer and goes on without one after the timeout', async () => {
    const { openPopoutChannel, requestWindowSession } = await import('@/lib/popout/channel');
    await expect(requestWindowSession({}, 10)).resolves.toBeNull();

    const main = openPopoutChannel((message) => {
      if (message.type === 'session-request') {
        main?.post({ type: 'session-answer', requestId: message.requestId, answer: { activeAccountId: 'a', sessions: [] } });
      }
    });
    await expect(requestWindowSession({}, 1000)).resolves.toEqual({ activeAccountId: 'a', sessions: [] });
    main?.close();
  });
});
