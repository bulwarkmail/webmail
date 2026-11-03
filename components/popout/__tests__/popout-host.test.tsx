import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeBroadcastChannel } from '@/lib/__tests__/fixtures/fake-broadcast-channel';
import { openPopoutChannel, requestWindowSession, watchMainWindow, askRescuedDraftId, type PopoutMessage, type RescuedDraft } from '@/lib/popout/channel';
import { takeRescuedDraft } from '@/lib/popout/rescued-drafts';
import { createSessionOpener } from '@/lib/popout/sealed';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useToastStore } from '@/stores/toast-store';
import { PopoutHost } from '../popout-host';

// The main window's side of pop-outs. The next-intl mock returns the key.

const DRAFT: RescuedDraft = {
  localAccountId: 'alice',
  to: ['a@example.test'], subject: 'Closing', body: 'text', cc: [], bcc: [], draftId: 'old', attachments: [],
  state: { subject: 'Closing' } as never,
};

const original = { auth: useAuthStore.getState(), email: useEmailStore.getState(), accounts: useAccountStore.getState() };
let heard: PopoutMessage[];
let popout: NonNullable<ReturnType<typeof openPopoutChannel>>;
let client: { createDraft: ReturnType<typeof vi.fn>; getAuthHeader: () => string; isOfflineOnly: () => boolean };
let lockRequests: string[];

// Rounds, not one long wait: a message and its answer are two hops, and a busy
// machine can run a single timer before the second hop is even queued.
const settle = async (ms = 10) => {
  for (let round = 0; round < 5; round++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }
};

/** Web Locks with one holder per name, as a browser has. */
function stubLocks() {
  const held = new Set<string>();
  lockRequests = [];
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request(name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => Promise<unknown>) {
        lockRequests.push(name);
        if (options.ifAvailable && held.has(name)) return Promise.resolve(callback(null));
        held.add(name);
        return Promise.resolve(callback({}));
      },
    },
  });
}

beforeEach(() => {
  FakeBroadcastChannel.reset();
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  // The bridge makes pop-outs available without stubbing the display mode.
  window.bulwarkDesktop = { windows: {} };
  stubLocks();
  sessionStorage.clear();
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
  delete window.bulwarkDesktop;
  useAuthStore.setState(original.auth);
  useEmailStore.setState(original.email);
  useAccountStore.setState(original.accounts);
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
});

const answers = () => heard.filter((message) => message.type === 'session-answer');

describe('in an ordinary browser tab', () => {
  it('runs nothing: no channel and no lock', async () => {
    delete window.bulwarkDesktop;
    const opened = FakeBroadcastChannel.open.size;
    render(<PopoutHost />);
    await settle();
    expect(FakeBroadcastChannel.open.size).toBe(opened);
    expect(lockRequests).toEqual([]);
    popout.post({ type: 'main-ping' });
    await settle();
    expect(heard).toEqual([]);
  });
});

describe('PopoutHost', () => {
  it('holds no lock while idle, which would keep the page out of the back/forward cache', async () => {
    render(<PopoutHost />);
    await settle();
    expect(lockRequests).toEqual([]);
  });

  it('lends the session to a pop-out that asks, sealed', async () => {
    render(<PopoutHost />);
    await settle();
    await expect(requestWindowSession({}, 2000)).resolves.toMatchObject({
      activeAccountId: 'alice',
      sessions: [{ accountId: 'alice', authHeader: 'Bearer main', authMode: 'oauth' }],
    });
    expect(JSON.stringify(heard)).not.toContain('Bearer main');
  });

  it('says nothing while it has no session to lend, so a pop-out goes on to the cookies', async () => {
    useAuthStore.setState({ isAuthenticated: false });
    render(<PopoutHost />);
    await settle();
    await expect(requestWindowSession({}, 100)).resolves.toBeNull();
  });

  it('says nothing about a login it does not hold, so the window that holds it answers first', async () => {
    render(<PopoutHost />);
    await settle();
    await expect(requestWindowSession({ accountId: 'bob' }, 100)).resolves.toBeNull();
    expect(answers()).toEqual([]);
  });

  it('renews a token the server refused, once, in this window', async () => {
    const refresh = vi.fn(async () => 'next');
    useAuthStore.setState({ refreshAccessToken: refresh as never });
    render(<PopoutHost />);
    await settle();
    await requestWindowSession({ accountId: 'alice', rejectedAuthHeader: 'Bearer main' }, 2000);
    expect(refresh).toHaveBeenCalledWith({ accountId: 'alice' });
    refresh.mockClear();
    await requestWindowSession({ accountId: 'alice', rejectedAuthHeader: 'Bearer older' }, 2000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('saves a closing window\'s draft, replacing its version', async () => {
    render(<PopoutHost />);
    await settle();
    popout.post({ type: 'draft-rescue', draft: DRAFT });
    await settle();
    expect(client.createDraft).toHaveBeenCalledTimes(1);
    expect(client.createDraft.mock.calls[0].slice(0, 2)).toEqual([['a@example.test'], 'Closing']);
    expect(client.createDraft.mock.calls[0][7]).toBe('old');
  });

  it('saves it once with two main windows open', async () => {
    render(<><PopoutHost /><PopoutHost /></>);
    await settle();
    popout.post({ type: 'draft-rescue', draft: { ...DRAFT, rescueKey: 'k' } });
    await settle();
    expect(client.createDraft).toHaveBeenCalledTimes(1);
  });

  it('keeps the text for the "Continue draft" slot when the save fails, and says so', async () => {
    client.createDraft.mockRejectedValueOnce(new Error('Server down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<PopoutHost />);
    await settle();
    popout.post({ type: 'draft-rescue', draft: DRAFT });
    await settle();
    expect(useToastStore.getState().toasts.map((toast) => toast.type)).toEqual(['error']);
    expect(takeRescuedDraft()).toMatchObject({ subject: 'Closing', unsaved: true });
  });

  it('keeps the text too when the login is gone by then', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useAuthStore.setState({ getClientForAccount: () => undefined });
    render(<PopoutHost />);
    await settle();
    popout.post({ type: 'draft-rescue', draft: DRAFT });
    await settle();
    expect(takeRescuedDraft()).toMatchObject({ subject: 'Closing' });
  });

  it('tells a reloaded pop-out which id its text was saved under', async () => {
    render(<PopoutHost />);
    await settle();
    popout.post({ type: 'draft-rescue', draft: { ...DRAFT, rescueKey: 'k1' } });
    await settle();
    await expect(askRescuedDraftId('k1', 1000)).resolves.toBe('new');
    await expect(askRescuedDraftId('nobody', 50)).resolves.toBeNull();
  });

  it('takes over the send\'s outcome once, and offers Undo here', async () => {
    render(<><PopoutHost /><PopoutHost /></>);
    await settle();
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
    await settle();
    popout.post({ type: 'mail-changed', accountId: 'alice' });
    popout.post({ type: 'mail-changed', accountId: 'alice' });
    await settle(400);
    expect(useEmailStore.getState().refreshCurrentMailbox).toHaveBeenCalledTimes(1);
    expect(useEmailStore.getState().fetchMailboxes).toHaveBeenCalledTimes(1);
  });

  it('tells pop-outs when its own list changed, since no push reports that to them', async () => {
    render(<PopoutHost />);
    await settle();
    act(() => useEmailStore.setState({ emails: [{ id: 'x' } as never] }));
    await settle(120);
    expect(heard).toContainEqual({ type: 'state-change' });
  });

  it('tells pop-outs when an account went away', async () => {
    render(<PopoutHost />);
    await settle();
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

  it('won\'t hand a draft to a window that doesn\'t hold its login', async () => {
    render(<PopoutHost />);
    await settle();
    const main = watchMainWindow();
    await settle();
    expect(main.alive('alice')).toBe(true);
    expect(main.alive('bob')).toBe(false);
    expect(main.rescue({ ...DRAFT, localAccountId: 'bob' })).toBe(false);
    await settle();
    expect(client.createDraft).not.toHaveBeenCalled();
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
    const late = openPopoutChannel(() => {})!;
    late.post({ type: 'main-ping' });
    await settle();
    late.close();
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

describe('sealed answers', () => {
  it('open only for the window that asked', async () => {
    render(<PopoutHost />);
    await settle();
    const other = await createSessionOpener();
    const mine = await createSessionOpener();
    popout.post({ type: 'session-request', requestId: 'r', publicKey: mine.publicKey });
    await settle();
    const [answer] = answers();
    expect(answer).toBeTruthy();
    if (answer.type !== 'session-answer') throw new Error('unreachable');
    await expect(mine.open(answer.sealed)).resolves.toMatchObject({ activeAccountId: 'alice' });
    await expect(other.open(answer.sealed)).rejects.toThrow();
  });
});
