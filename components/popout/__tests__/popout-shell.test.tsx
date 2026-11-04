import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBroadcastChannel } from '@/lib/__tests__/fixtures/fake-broadcast-channel';
import { registerComposeFlush } from '@/lib/compose-flush-registry';
import { SIGNED_OUT_KEY } from '@/lib/sign-out-cleanup';
import { openPopoutChannel } from '@/lib/popout/channel';
import { sealFor } from '@/lib/popout/sealed';
import { SHARED_SESSION_ENDED_EVENT, useAuthStore } from '@/stores/auth-store';
import { PopoutShell } from '../popout-shell';

// How a pop-out's session ends. The next-intl mock returns the key.

vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }) }));

const original = useAuthStore.getState();
let close: ReturnType<typeof vi.spyOn>;
let mounts: number;

function Child() {
  useEffect(() => {
    mounts += 1;
  }, []);
  return <div data-testid="content">Typed text</div>;
}

const settle = async (ms = 10) => {
  for (let round = 0; round < 5; round++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
};

async function mount(kind: 'message' | 'compose', session: 'ready' | 'no-session' = 'ready') {
  useAuthStore.setState({ startSharedSession: vi.fn(async () => session) as never, activeAccountId: 'alice' });
  render(<PopoutShell kind={kind}><Child /></PopoutShell>);
  await settle();
}

function endSession() {
  act(() => { window.dispatchEvent(new Event(SHARED_SESSION_ENDED_EVENT)); });
}

function signOutElsewhere() {
  act(() => { window.dispatchEvent(new StorageEvent('storage', { key: SIGNED_OUT_KEY, newValue: String(Date.now()) })); });
}

beforeEach(() => {
  FakeBroadcastChannel.reset();
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  close = vi.spyOn(window, 'close').mockImplementation(() => {});
  mounts = 0;
});

afterEach(() => {
  cleanup();
  useAuthStore.setState(original);
  close.mockRestore();
  vi.unstubAllGlobals();
});

describe('when the session is refused', () => {
  it('stops showing a message', async () => {
    await mount('message');
    expect(screen.getByTestId('content')).toBeTruthy();
    endSession();
    expect(screen.queryByTestId('content')).toBeNull();
    expect(screen.getByText('session_ended_title')).toBeTruthy();
  });

  it('keeps a composer on screen, the same one, with the text in it', async () => {
    await mount('compose');
    endSession();
    expect(screen.getByTestId('content')).toBeTruthy();
    expect(mounts).toBe(1);
    const line = document.querySelector<HTMLElement>('[data-popout-session-ended]')!;
    expect(line).toBeTruthy();
    // It's the window's top row: room for the window's controls, and its own
    // "Close window" gives way to the window's close where there is one.
    expect(line.hasAttribute('data-window-top-row')).toBe(true);
    expect(screen.getByRole('button', { name: 'close_window' }).hasAttribute('data-own-window-close')).toBe(true);
  });
});

describe('with no session at all', () => {
  it('shows a composer that holds text, and says why it can\'t send', async () => {
    await mount('compose', 'no-session');
    expect(screen.getByTestId('content')).toBeTruthy();
    expect(document.querySelector('[data-popout-session-ended]')).toBeTruthy();
  });

  it('shows no message', async () => {
    await mount('message', 'no-session');
    expect(screen.queryByTestId('content')).toBeNull();
  });
});

describe('when another window signs everyone out', () => {
  it('saves the typing first, then closes', async () => {
    const order: string[] = [];
    const stop = registerComposeFlush(async () => { order.push('saved'); });
    close.mockImplementation(() => { order.push('closed'); });
    await mount('compose');
    signOutElsewhere();
    await settle();
    expect(order).toEqual(['saved', 'closed']);
    stop();
  });

  it('stays open when the typing could not be saved', async () => {
    const stop = registerComposeFlush(async () => { throw new Error('The draft was not saved'); });
    await mount('compose');
    signOutElsewhere();
    await settle();
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByTestId('content')).toBeTruthy();
    expect(document.querySelector('[data-popout-session-ended]')).toBeTruthy();
    stop();
  });

  it('closes a message window', async () => {
    await mount('message');
    signOutElsewhere();
    await settle();
    expect(close).toHaveBeenCalled();
  });
});

describe('when a login leaves the list', () => {
  it('closes when no window holds it any more', async () => {
    const main = openPopoutChannel(() => {})!;
    await mount('message');
    main.post({ type: 'account-removed', accountId: 'alice' });
    await waitFor(() => expect(close).toHaveBeenCalled(), { timeout: 3000 });
    main.close();
  });

  it('stays when another tab still holds it: a new tab dropped a login it could not restore', async () => {
    const main = openPopoutChannel((message) => {
      if (message.type !== 'session-request') return;
      void sealFor(message.publicKey, { activeAccountId: 'alice', sessions: [{ accountId: 'alice' }] })
        .then((sealed) => main.post({ type: 'session-answer', requestId: message.requestId, sealed }));
    })!;
    await mount('message');
    main.post({ type: 'account-removed', accountId: 'alice' });
    await settle(250);
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByTestId('content')).toBeTruthy();
    main.close();
  });

  it('ignores another login', async () => {
    const main = openPopoutChannel(() => {})!;
    await mount('message');
    main.post({ type: 'account-removed', accountId: 'bob' });
    await settle(250);
    expect(close).not.toHaveBeenCalled();
    main.close();
  });
});
