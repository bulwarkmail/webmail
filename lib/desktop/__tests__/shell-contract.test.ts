import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BulwarkDesktopBridge } from '../types';

/** What the webmail owes the shell: saving on close, leaving nothing behind on sign-out. */

function setBridge(bridge: Partial<BulwarkDesktopBridge> | undefined) {
  window.bulwarkDesktop = bridge as BulwarkDesktopBridge | undefined;
}

afterEach(() => {
  setBridge(undefined);
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('saving drafts before a window closes', () => {
  function lifecycleBridge() {
    const handlers = new Set<() => Promise<unknown>>();
    setBridge({
      version: 1,
      platform: 'win32',
      lifecycle: {
        onFlushRequest: (handler) => {
          handlers.add(handler);
          return () => handlers.delete(handler);
        },
      },
    });
    return handlers;
  }

  it('asks to be told only while a composer is open', async () => {
    const handlers = lifecycleBridge();
    const { registerComposeFlush } = await import('@/lib/compose-flush-registry');
    expect(handlers.size).toBe(0);
    const stop = registerComposeFlush(async () => {});
    expect(handlers.size).toBe(1);
    const stopSecond = registerComposeFlush(async () => {});
    expect(handlers.size).toBe(1);
    stop();
    expect(handlers.size).toBe(1);
    stopSecond();
    expect(handlers.size).toBe(0);
  });

  it('a request runs every composer\'s flush and answers when they are done', async () => {
    const handlers = lifecycleBridge();
    const { registerComposeFlush } = await import('@/lib/compose-flush-registry');
    const saved: string[] = [];
    let release = () => {};
    const stopA = registerComposeFlush(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      saved.push('a');
    });
    const stopB = registerComposeFlush(async () => {
      saved.push('b');
    });
    let answered = false;
    const answer = [...handlers][0]().then(() => (answered = true));
    await Promise.resolve();
    expect(answered).toBe(false);
    release();
    await answer;
    expect(saved.sort()).toEqual(['a', 'b']);
    stopA();
    stopB();
  });

  it('a composer that hangs does not hold the answer past its limit', async () => {
    vi.useFakeTimers();
    try {
      const handlers = lifecycleBridge();
      const { registerComposeFlush } = await import('@/lib/compose-flush-registry');
      const stop = registerComposeFlush(() => new Promise(() => {}));
      let answered = false;
      void [...handlers][0]().then(() => (answered = true));
      await vi.advanceTimersByTimeAsync(3001);
      expect(answered).toBe(true);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('in a browser nothing is asked of a bridge that is not there', async () => {
    const { registerComposeFlush } = await import('@/lib/compose-flush-registry');
    expect(() => registerComposeFlush(async () => {})()).not.toThrow();
  });
});

describe('the last account on a server', () => {
  async function accountsOn(...servers: string[]) {
    const { useAccountStore } = await import('@/stores/account-store');
    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
    const base = { rememberMe: true, lastLoginAt: 0, isConnected: true, hasError: false, isDefault: false, authMode: 'basic' as const };
    const ids = servers.map((serverUrl, index) =>
      useAccountStore.getState().addAccount({ ...base, label: `u${index}`, serverUrl, username: `u${index}`, displayName: `u${index}`, email: `u${index}@example.org` }),
    );
    return { ids, remove: (id: string) => useAccountStore.getState().removeAccount(id) };
  }

  function forgetBridge() {
    const forget = vi.fn();
    setBridge({ version: 1, platform: 'win32', servers: { prepare: vi.fn(), noteSession: vi.fn(), forget } });
    return forget;
  }

  it('leaving takes the server off the list', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    const forget = forgetBridge();
    const { ids, remove } = await accountsOn('https://mail.example.org');
    remove(ids[0]);
    expect(forget).toHaveBeenCalledWith('https://mail.example.org', 'signed-out');
  });

  it('with another account still there, it stays', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    const forget = forgetBridge();
    const { ids, remove } = await accountsOn('https://mail.example.org', 'https://mail.example.org/');
    remove(ids[0]);
    expect(forget).not.toHaveBeenCalled();
    remove(ids[1]);
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it('outside the desktop build nothing is called', async () => {
    const forget = forgetBridge();
    const { ids, remove } = await accountsOn('https://mail.example.org');
    remove(ids[0]);
    expect(forget).not.toHaveBeenCalled();
  });
});

describe('a plain http account in the desktop build', () => {
  async function client(serverUrl: string) {
    const { JMAPClient } = await import('@/lib/jmap/client');
    const instance = new JMAPClient(serverUrl, 'u', 'p');
    (instance as unknown as { session: unknown }).session = { eventSourceUrl: `${serverUrl}/jmap/eventsource/`, capabilities: {} };
    return instance;
  }

  it('polls: no push stream to pin the app origin\'s sockets', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    expect((await client('http://192.0.2.5:8080')).getEventSourceUrl()).toBeNull();
  }, 60_000);

  it('an https account keeps its stream', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    expect((await client('https://mail.example.org')).getEventSourceUrl()).toBe('https://mail.example.org/jmap/eventsource/');
  }, 60_000);

  it('a server build keeps it for any server', async () => {
    expect((await client('http://192.0.2.5:8080')).getEventSourceUrl()).toBe('http://192.0.2.5:8080/jmap/eventsource/');
  }, 60_000);

  it('a blob gets back the type the route took off', async () => {
    vi.stubEnv('NEXT_PUBLIC_BULWARK_DESKTOP', '1');
    const { withDesktopBlobType } = await import('../jmap-route');
    const blob = new Blob(['x'], { type: 'application/octet-stream' });
    expect(withDesktopBlobType(blob, 'http://192.0.2.5:8080', 'image/png').type).toBe('image/png');
    expect(withDesktopBlobType(blob, 'https://mail.example.org', 'image/png')).toBe(blob);
  });
});
