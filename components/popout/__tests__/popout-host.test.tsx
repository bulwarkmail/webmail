import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBroadcastChannel } from '@/lib/__tests__/fixtures/fake-broadcast-channel';
import { openPopoutChannel, watchMainWindow, type PopoutMessage, type RescuedDraft } from '@/lib/popout/channel';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useToastStore } from '@/stores/toast-store';
import { PopoutHost } from '../popout-host';

// The main window's side of pop-outs. The next-intl mock returns the key.

const DRAFT: RescuedDraft = {
  to: ['a@example.test'], subject: 'Closing', body: 'text', cc: [], bcc: [], draftId: 'old', attachments: [],
};

const original = { auth: useAuthStore.getState(), email: useEmailStore.getState(), accounts: useAccountStore.getState() };
let heard: PopoutMessage[];
let popout: NonNullable<ReturnType<typeof openPopoutChannel>>;
let client: { createDraft: ReturnType<typeof vi.fn>; getAuthHeader: () => string; isOfflineOnly: () => boolean };
let release: Array<() => void>;

// Rounds, not one long wait: a message and its answer are two hops, and a busy
// machine can run a single timer before the second hop is even queued.
const settle = async (ms = 10) => {
  for (let round = 0; round < 5; round++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
};

/** Web Locks with one holder and a queue, as a browser has. */
function stubLocks() {
  let held = false;
  const waiting: Array<() => void> = [];
  release = [];
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request(_name: string, options: { signal?: AbortSignal }, callback: () => Promise<unknown>) {
        const start = () => {
          held = true;
          void callback().then(() => {
            held = false;
            waiting.shift()?.();
          });
        };
        if (held) waiting.push(start);
        else start();
        return Promise.resolve();
      },
    },
  });
}

beforeEach(() => {
  FakeBroadcastChannel.reset();
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  stubLocks();
  heard = [];
  popout = openPopoutChannel((message) => heard.push(message))!;
  client = { createDraft: vi.fn(async () => 'new'), getAuthHeader: () => 'Bearer main', isOfflineOnly: () => false };
  useAccountStore.setState({
    accounts: [{ id: 'alice', serverUrl: 'https://mail.example.test', username: 'alice', authMode: 'oauth', cookieSlot: 0 } as never],
    activeAccountId: 'alice',
  });
  useAuthStore.setState({
    isAuthenticated: true,
    isDemoMode: false,
    activeAccountId: 'alice',
    client: client as never,
    getAllConnectedClients: () => new Map([['alice', client]]) as never,
    getClientForAccount: (id: string) => (id === 'alice' ? client : undefined) as never,
  });
  useEmailStore.setState({ refreshCurrentMailbox: vi.fn(async () => {}) as never, fetchMailboxes: vi.fn(async () => {}) as never, pendingUndoSend: null });
  useToastStore.getState().clearToasts();
});

afterEach(() => {
  cleanup();
  popout.close();
  useAuthStore.setState(original.auth);
  useEmailStore.setState(original.email);
  useAccountStore.setState(original.accounts);
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
});

describe('PopoutHost', () => {
  it('lends the session to a pop-out that asks', async () => {
    render(<PopoutHost />);
    popout.post({ type: 'session-request', requestId: 'r1' });
    await settle();
    expect(heard).toContainEqual({
      type: 'session-answer',
      requestId: 'r1',
      answer: { activeAccountId: 'alice', sessions: [expect.objectContaining({ accountId: 'alice', authHeader: 'Bearer main', authMode: 'oauth' })] },
    });
  });

  it('says nothing while it has no session to lend, so a pop-out goes on to the cookies', async () => {
    useAuthStore.setState({ isAuthenticated: false });
    render(<PopoutHost />);
    popout.post({ type: 'session-request', requestId: 'r1' });
    await settle();
    expect(heard.filter((message) => message.type === 'session-answer')).toEqual([]);
  });

  it('renews a token the server refused, once, in this window', async () => {
    const refresh = vi.fn(async () => 'next');
    useAuthStore.setState({ refreshAccessToken: refresh as never });
    render(<PopoutHost />);
    popout.post({ type: 'session-request', requestId: 'r1', accountId: 'alice', rejectedAuthHeader: 'Bearer main' });
    await settle();
    expect(refresh).toHaveBeenCalledWith({ accountId: 'alice' });
    refresh.mockClear();
    popout.post({ type: 'session-request', requestId: 'r2', accountId: 'alice', rejectedAuthHeader: 'Bearer older' });
    await settle();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('saves a closing window\'s draft, replacing its version', async () => {
    render(<PopoutHost />);
    popout.post({ type: 'draft-rescue', draft: DRAFT });
    await settle();
    expect(client.createDraft).toHaveBeenCalledTimes(1);
    expect(client.createDraft.mock.calls[0].slice(0, 2)).toEqual([['a@example.test'], 'Closing']);
    expect(client.createDraft.mock.calls[0][7]).toBe('old');
  });

  it('saves it once with two main windows open', async () => {
    render(<><PopoutHost /><PopoutHost /></>);
    popout.post({ type: 'draft-rescue', draft: DRAFT });
    await settle();
    expect(client.createDraft).toHaveBeenCalledTimes(1);
  });

  it('says so when the save fails: the text is gone otherwise', async () => {
    client.createDraft.mockRejectedValueOnce(new Error('nope'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<PopoutHost />);
    popout.post({ type: 'draft-rescue', draft: DRAFT });
    await settle();
    expect(useToastStore.getState().toasts.map((toast) => toast.type)).toEqual(['error']);
  });

  it('takes over the send\'s outcome once, and offers Undo here', async () => {
    render(<><PopoutHost /><PopoutHost /></>);
    const pending = { submissionId: 's', sendAt: '2030-01-01T00:00:00Z', isSmime: false };
    popout.post({ type: 'sent', requestId: 'r1', notice: { accountId: 'alice', pendingUndoSend: pending } });
    await settle();
    expect(heard.filter((message) => message.type === 'sent-ack')).toHaveLength(1);
    expect(useEmailStore.getState().pendingUndoSend).toEqual(pending);
    expect(useToastStore.getState().toasts).toEqual([]);

    useEmailStore.setState({ pendingUndoSend: null });
    popout.post({ type: 'sent', requestId: 'r2', notice: { accountId: 'alice' } });
    await settle();
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('refreshes the list and counts when a pop-out changed mail, once for a burst', async () => {
    render(<PopoutHost />);
    popout.post({ type: 'mail-changed', accountId: 'alice' });
    popout.post({ type: 'mail-changed', accountId: 'alice' });
    await settle(400);
    expect(useEmailStore.getState().refreshCurrentMailbox).toHaveBeenCalledTimes(1);
    expect(useEmailStore.getState().fetchMailboxes).toHaveBeenCalledTimes(1);
  });

  it('tells pop-outs when its own list changed, since no push reports that to them', async () => {
    render(<PopoutHost />);
    act(() => useEmailStore.setState({ emails: [{ id: 'x' } as never] }));
    await settle(120);
    expect(heard).toContainEqual({ type: 'state-change' });
  });

  it('tells pop-outs when an account went away', async () => {
    render(<PopoutHost />);
    act(() => useAccountStore.setState({ accounts: [] }));
    await settle();
    expect(heard).toContainEqual({ type: 'account-removed', accountId: 'alice' });
  });
});

describe('watchMainWindow', () => {
  it('knows a main window is there, and hands it the draft', async () => {
    render(<PopoutHost />);
    await settle();
    const main = watchMainWindow();
    await settle();
    expect(main.alive()).toBe(true);
    expect(main.rescue(DRAFT)).toBe(true);
    await settle();
    expect(client.createDraft).toHaveBeenCalledTimes(1);
    main.stop();
  });

  it('knows at once when the last one closed, and takes nothing then', async () => {
    render(<PopoutHost />);
    await settle();
    const main = watchMainWindow();
    await settle();
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    cleanup();
    await settle();
    expect(main.alive()).toBe(false);
    expect(main.rescue(DRAFT)).toBe(false);
    expect(client.createDraft).not.toHaveBeenCalled();
    main.stop();
  });

  it('is not fooled by a closing window that still runs long enough to hear the ping', async () => {
    render(<PopoutHost />);
    await settle();
    const main = watchMainWindow();
    await settle();
    // Still mounted: the page is on its way out, its scripts haven't stopped.
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    await settle();
    expect(main.alive()).toBe(false);
    expect(main.rescue(DRAFT)).toBe(false);
    main.stop();
  });

  it('takes nothing with no main window from the start', async () => {
    const main = watchMainWindow();
    await settle();
    expect(main.rescue(DRAFT)).toBe(false);
    main.stop();
  });
});
