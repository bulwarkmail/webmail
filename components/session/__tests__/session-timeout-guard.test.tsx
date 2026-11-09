import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTimeoutGuard, DRAFT_FLUSH_TIMEOUT_MS } from '../session-timeout-guard';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore, type AccountEntry } from '@/stores/account-store';
import { usePolicyStore } from '@/stores/policy-store';
import { DEFAULT_POLICY, type SettingsPolicy } from '@/lib/admin/types';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { registerComposeFlush, resetComposeFlushRegistry } from '@/lib/compose-flush-registry';
import { consumeSessionEnd } from '@/lib/session-policy/sign-out-reason';
import { LAST_ACTIVITY_KEY } from '@/lib/session-policy/activity-channel';
import { reportFrameActivity } from '@/lib/session-policy/frame-activity';

/** BroadcastChannel between "tabs" of one test. */
class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;
  constructor(public name: string) {
    FakeBroadcastChannel.instances.push(this);
  }
  postMessage(data: unknown) {
    for (const other of FakeBroadcastChannel.instances) {
      if (other !== this && !other.closed && other.name === this.name) other.onmessage?.({ data } as MessageEvent);
    }
  }
  close() {
    this.closed = true;
  }
}

const START = new Date('2026-10-28T09:00:00Z').getTime();
const SECOND = 1000;

function fakeClient(email: string) {
  return {
    getUsername: () => email,
    getSharedAccounts: () => [],
    getAccountInfo: () => undefined,
    getPrincipalTypes: async () => ({}),
  };
}

function account(id: string, email: string, signedInAt = START): AccountEntry {
  return {
    id, label: email, serverUrl: 'https://mail.example.org', username: email, authMode: 'basic', cookieSlot: 0,
    rememberMe: true, displayName: email, email, avatarColor: '#336699', lastLoginAt: START, signedInAt,
    isConnected: true, hasError: false, isDefault: true,
  };
}

function policyWith(session: { idleMinutes: number; maxHours: number; warnSeconds: number }, scopes: SettingsPolicy['scopes'] = []): SettingsPolicy {
  return { ...DEFAULT_POLICY, organisation: { ...DEFAULT_ORGANISATION_POLICY, session }, scopes };
}

let logoutAll: ReturnType<typeof vi.fn>;
const realGetAllConnectedClients = useAuthStore.getState().getAllConnectedClients;

async function signIn(policy: SettingsPolicy, email = 'org-alice@example.org') {
  usePolicyStore.setState({ rawPolicy: policy });
  useAccountStore.setState({ accounts: [account('alice', email)], activeAccountId: 'alice' });
  useAuthStore.setState({
    isAuthenticated: true,
    isDemoMode: false,
    activeAccountId: 'alice',
    client: fakeClient(email) as never,
    logoutAll: logoutAll as never,
  });
  render(<SessionTimeoutGuard />);
  // The limits are worked out asynchronously (the policy subject).
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('session timeout guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    FakeBroadcastChannel.instances = [];
    localStorage.clear();
    sessionStorage.clear();
    resetComposeFlushRegistry();
    logoutAll = vi.fn(async () => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useAuthStore.setState({ isAuthenticated: false, client: null, activeAccountId: null, getAllConnectedClients: realGetAllConnectedClients });
  });

  it('warns at idle minus warnSeconds and goes away on "Stay signed in"', async () => {
    await signIn(policyWith({ idleMinutes: 1, maxHours: 0, warnSeconds: 30 }));

    await advance(29 * SECOND);
    expect(screen.queryByText('idle_title')).toBeNull();
    await advance(1 * SECOND);
    expect(screen.getByText('idle_title')).toBeTruthy();
    // Enter on the warning keeps the user signed in.
    expect(document.activeElement?.textContent).toBe('stay');

    fireEvent.click(screen.getByText('stay'));
    expect(screen.queryByText('idle_title')).toBeNull();
    await advance(29 * SECOND);
    expect(screen.queryByText('idle_title')).toBeNull();
    expect(logoutAll).not.toHaveBeenCalled();
  });

  it('starts the idle time again on activity in this tab', async () => {
    await signIn(policyWith({ idleMinutes: 1, maxHours: 0, warnSeconds: 30 }));

    await advance(20 * SECOND);
    fireEvent.keyDown(window, { key: 'a' });
    await advance(29 * SECOND);
    expect(screen.queryByText('idle_title')).toBeNull();
    await advance(1 * SECOND);
    expect(screen.getByText('idle_title')).toBeTruthy();
  });

  it('starts the idle time again on activity in another tab', async () => {
    await signIn(policyWith({ idleMinutes: 1, maxHours: 0, warnSeconds: 30 }));
    const otherTab = new FakeBroadcastChannel('bulwark-session-activity');

    await advance(40 * SECOND);
    expect(screen.getByText('idle_title')).toBeTruthy();
    await act(async () => { otherTab.postMessage({ at: Date.now() }); });
    expect(screen.queryByText('idle_title')).toBeNull();

    await advance(59 * SECOND);
    expect(logoutAll).not.toHaveBeenCalled();
  });

  it('tells the other tabs about activity here', async () => {
    await signIn(policyWith({ idleMinutes: 1, maxHours: 0, warnSeconds: 30 }));
    const otherTab = new FakeBroadcastChannel('bulwark-session-activity');
    const heard = vi.fn();
    otherTab.onmessage = (event) => heard((event.data as { at: number }).at);

    await advance(10 * SECOND);
    fireEvent.pointerDown(window);
    expect(heard).toHaveBeenCalledWith(START + 10 * SECOND);
    expect(localStorage.getItem(LAST_ACTIVITY_KEY)).toBe(String(START + 10 * SECOND));
  });

  it('counts input a plugin frame reports like input here, and tells the other tabs', async () => {
    await signIn(policyWith({ idleMinutes: 1, maxHours: 0, warnSeconds: 30 }));
    const otherTab = new FakeBroadcastChannel('bulwark-session-activity');
    const heard = vi.fn();
    otherTab.onmessage = (event) => heard((event.data as { at: number }).at);

    await advance(20 * SECOND);
    act(() => { reportFrameActivity(); });
    expect(heard).toHaveBeenCalledWith(START + 20 * SECOND);
    await advance(29 * SECOND);
    expect(screen.queryByText('idle_title')).toBeNull();
    await advance(1 * SECOND);
    expect(screen.getByText('idle_title')).toBeTruthy();
  });

  it('does not end the idle warning on input a plugin frame reports', async () => {
    await signIn(policyWith({ idleMinutes: 1, maxHours: 0, warnSeconds: 30 }));

    await advance(40 * SECOND);
    expect(screen.getByText('idle_title')).toBeTruthy();
    act(() => { reportFrameActivity(); });
    expect(screen.getByText('idle_title')).toBeTruthy();
    await advance(20 * SECOND);
    expect(logoutAll).toHaveBeenCalled();
  });

  it('saves the drafts, then signs every account out with the reason, at zero', async () => {
    await signIn(policyWith({ idleMinutes: 1, maxHours: 0, warnSeconds: 30 }));
    const order: string[] = [];
    registerComposeFlush(async () => {
      await new Promise((r) => setTimeout(r, 500));
      order.push('draft saved');
    });
    logoutAll.mockImplementation(async () => { order.push('signed out'); });

    await advance(60 * SECOND);
    expect(screen.getByText('signing_out')).toBeTruthy();
    expect(logoutAll).not.toHaveBeenCalled();
    await advance(500);

    expect(order).toEqual(['draft saved', 'signed out']);
    expect(logoutAll).toHaveBeenCalledWith({ endProviderSession: false, keepLocalData: true, sessionLimit: true });
    expect(consumeSessionEnd()).toEqual({ kind: 'idle', minutes: 1 });
  });

  it('signs out after the flush timeout when a draft save hangs', async () => {
    await signIn(policyWith({ idleMinutes: 1, maxHours: 0, warnSeconds: 30 }));
    registerComposeFlush(() => new Promise<void>(() => {}));

    await advance(60 * SECOND);
    await advance(DRAFT_FLUSH_TIMEOUT_MS - 1);
    expect(logoutAll).not.toHaveBeenCalled();
    await advance(1);
    expect(logoutAll).toHaveBeenCalledWith({ endProviderSession: false, keepLocalData: true, sessionLimit: true });
  });

  it('uses the strictest of the signed-in accounts', async () => {
    const policy = policyWith({ idleMinutes: 0, maxHours: 0, warnSeconds: 30 }, [
      { id: 'example', label: 'example.org', match: { domains: ['example.org'] }, policy: { organisation: { session: { idleMinutes: 10 } } } },
      { id: 'two', label: 'org-two.test', match: { domains: ['org-two.test'] }, policy: { organisation: { session: { idleMinutes: 2 } } } },
    ]);
    usePolicyStore.setState({ rawPolicy: policy });
    useAccountStore.setState({ accounts: [account('alice', 'org-alice@example.org'), account('dave', 'org-dave@org-two.test')], activeAccountId: 'alice' });
    const alice = fakeClient('org-alice@example.org');
    const dave = fakeClient('org-dave@org-two.test');
    useAuthStore.setState({
      isAuthenticated: true,
      isDemoMode: false,
      activeAccountId: 'alice',
      client: alice as never,
      logoutAll: logoutAll as never,
      getAllConnectedClients: (() => new Map([['alice', alice], ['dave', dave]])) as never,
    });
    render(<SessionTimeoutGuard />);
    await advance(0);

    // Two minutes (dave's domain), not ten (alice's).
    await advance(2 * 60 * SECOND - 1);
    expect(logoutAll).not.toHaveBeenCalled();
    await advance(1);
    expect(logoutAll).toHaveBeenCalledTimes(1);
    expect(consumeSessionEnd()).toEqual({ kind: 'idle', minutes: 2 });
  });

  it('gives an account in a scope without a timeout none', async () => {
    const policy = policyWith({ idleMinutes: 1, maxHours: 0, warnSeconds: 30 }, [
      { id: 'two', label: 'org-two.test', match: { domains: ['org-two.test'] }, policy: { organisation: { session: { idleMinutes: 0 } } } },
    ]);
    await signIn(policy, 'org-dave@org-two.test');

    await advance(10 * 60 * SECOND);
    expect(screen.queryByText('idle_title')).toBeNull();
    expect(logoutAll).not.toHaveBeenCalled();
  });

  it('warns before the maximum session length and signs out at it', async () => {
    usePolicyStore.setState({ rawPolicy: policyWith({ idleMinutes: 0, maxHours: 1, warnSeconds: 60 }) });
    useAccountStore.setState({ accounts: [account('alice', 'org-alice@example.org', START - 50 * 60 * SECOND)], activeAccountId: 'alice' });
    useAuthStore.setState({
      isAuthenticated: true, isDemoMode: false, activeAccountId: 'alice',
      client: fakeClient('org-alice@example.org') as never, logoutAll: logoutAll as never,
      getAllConnectedClients: (() => new Map()) as never,
    });
    render(<SessionTimeoutGuard />);
    await advance(0);

    // Ten minutes left, ended a minute early for clock skew, warned a minute before that.
    await advance(8 * 60 * SECOND - 1);
    expect(screen.queryByText('max_title')).toBeNull();
    await advance(1);
    expect(screen.getByText('max_title')).toBeTruthy();
    fireEvent.click(screen.getByText('dismiss'));
    expect(screen.queryByText('max_title')).toBeNull();
    await advance(60 * SECOND);
    await advance(0);
    expect(logoutAll).toHaveBeenCalledWith({ endProviderSession: false, keepLocalData: true, sessionLimit: true });
    expect(consumeSessionEnd()).toEqual({ kind: 'max', hours: 1 });
  });

  it('signs out right away after a reload that follows a pause longer than the limit', async () => {
    // Recorded by a tab before the reload, five minutes ago; signed in long before.
    localStorage.setItem(LAST_ACTIVITY_KEY, String(START - 5 * 60 * SECOND));
    usePolicyStore.setState({ rawPolicy: policyWith({ idleMinutes: 1, maxHours: 0, warnSeconds: 30 }) });
    useAccountStore.setState({ accounts: [account('alice', 'org-alice@example.org', START - 60 * 60 * SECOND)], activeAccountId: 'alice' });
    useAuthStore.setState({
      isAuthenticated: true, isDemoMode: false, activeAccountId: 'alice',
      client: fakeClient('org-alice@example.org') as never, logoutAll: logoutAll as never,
    });
    render(<SessionTimeoutGuard />);
    // Moving the mouse while the page loads doesn't bring the session back.
    fireEvent.pointerDown(window);
    await advance(0);

    expect(logoutAll).toHaveBeenCalledWith({ endProviderSession: false, keepLocalData: true, sessionLimit: true });
    expect(consumeSessionEnd()).toEqual({ kind: 'idle', minutes: 1 });
  });

  it('says on the login page when a draft could not be saved', async () => {
    await signIn(policyWith({ idleMinutes: 1, maxHours: 0, warnSeconds: 30 }));
    registerComposeFlush(async () => { throw new Error('save refused'); });

    await advance(60 * SECOND);
    await advance(0);
    expect(logoutAll).toHaveBeenCalled();
    expect(consumeSessionEnd()).toEqual({ kind: 'idle', minutes: 1, draftsUnsaved: true });
  });

  it('does not count scrolling as activity', async () => {
    await signIn(policyWith({ idleMinutes: 1, maxHours: 0, warnSeconds: 30 }));
    await advance(20 * SECOND);
    fireEvent.scroll(window);
    await advance(10 * SECOND);
    expect(screen.getByText('idle_title')).toBeTruthy();
  });

  it('does not count a focused cross-origin frame as activity, and warns above its overlay', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    // The office editor: a cross-origin frame in a z-[100000] overlay.
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[100000]';
    const editor = document.createElement('iframe');
    Object.defineProperty(editor, 'contentDocument', { get: () => null });
    overlay.appendChild(editor);
    document.body.appendChild(overlay);
    try {
      await signIn(policyWith({ idleMinutes: 1, maxHours: 0, warnSeconds: 30 }));
      editor.focus();
      expect(document.activeElement).toBe(editor);

      // Left focused, the editor keeps nothing alive: warned at 30 s, signed out at 60 s.
      await advance(30 * SECOND);
      const warning = screen.getByTestId('session-timeout-dialog');
      expect(Number(/z-\[(\d+)\]/.exec(warning.className)?.[1])).toBeGreaterThan(100000);
      // Later in the body than the overlay, so it paints on top at a higher z-index too.
      expect(overlay.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await advance(30 * SECOND);
      expect(logoutAll).toHaveBeenCalledWith({ endProviderSession: false, keepLocalData: true, sessionLimit: true });
    } finally {
      overlay.remove();
      hasFocus.mockRestore();
    }
  });

  it('asks again for the policy subject of a client that had none', async () => {
    const policy = policyWith({ idleMinutes: 0, maxHours: 0, warnSeconds: 30 }, [
      { id: 'example', label: 'example.org', match: { domains: ['example.org'] }, policy: { organisation: { session: { idleMinutes: 1 } } } },
    ]);
    let username = '';
    const client = { ...fakeClient(''), getUsername: () => username };
    usePolicyStore.setState({ rawPolicy: policy });
    useAccountStore.setState({ accounts: [account('alice', 'org-alice@example.org')], activeAccountId: 'alice' });
    useAuthStore.setState({
      isAuthenticated: true, isDemoMode: false, activeAccountId: 'alice', connectedAccountsRevision: 1,
      client: client as never, logoutAll: logoutAll as never,
    });
    render(<SessionTimeoutGuard />);
    await advance(0);
    await advance(2 * 60 * SECOND);
    expect(logoutAll).not.toHaveBeenCalled();

    // The session is complete now: the subject is known and the domain's minute applies.
    username = 'org-alice@example.org';
    await act(async () => { useAuthStore.setState({ connectedAccountsRevision: 2 }); });
    await advance(0);
    fireEvent.keyDown(window, { key: 'a' });
    await advance(60 * SECOND);
    await advance(0);
    expect(logoutAll).toHaveBeenCalled();
  });
});
