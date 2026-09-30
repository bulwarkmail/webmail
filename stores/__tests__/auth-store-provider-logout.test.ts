import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as browserNavigation from '@/lib/browser-navigation';
import * as iframeBridge from '@/lib/iframe-bridge';
import {
  useAuthStore,
  consumeSignedOut,
  pickEndSessionSlot,
  redirectToLogin,
  saveRedirectAfterLogin,
} from '../auth-store';
import { useAccountStore, type AccountEntry } from '../account-store';

// Sign-out ordering and RP-initiated logout (#905).

type FetchInit = Parameters<typeof fetch>[1];
type Handler = (init?: FetchInit) => unknown;

const IDP_LOGOUT = 'https://id.example.com/realms/mail/protocol/openid-connect/logout?client_id=webmail&id_token_hint=eyJ.x.y';

const ok = (body: object = {}) => ({ ok: true, status: 200, json: async () => body });

/** Route fetch calls by "METHOD url"; records every call in order. */
function mockFetch(routes: Record<string, Handler>) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: Parameters<typeof fetch>[0], init?: FetchInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    calls.push(key);
    const handler = routes[key];
    if (!handler) throw new Error(`Unexpected fetch call: ${key}`);
    return handler(init);
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

/** A promise plus its resolver, for requests the test answers later. */
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function account(overrides: Partial<AccountEntry> = {}): AccountEntry {
  return {
    id: 'alice@example.com@mail.example.com',
    label: 'Alice',
    serverUrl: 'https://mail.example.com',
    username: 'alice@example.com',
    authMode: 'oauth',
    cookieSlot: 0,
    rememberMe: true,
    providerSession: true,
    displayName: 'Alice',
    email: 'alice@example.com',
    avatarColor: '#336699',
    lastLoginAt: 0,
    isConnected: true,
    hasError: false,
    isDefault: true,
    ...overrides,
  };
}

function signIn(accounts: AccountEntry[], activeId = accounts[0]?.id ?? null) {
  useAccountStore.setState({ accounts, activeAccountId: activeId, defaultAccountId: accounts[0]?.id ?? null });
  const active = accounts.find((a) => a.id === activeId);
  useAuthStore.setState({
    isAuthenticated: true,
    authMode: active?.authMode ?? 'oauth',
    activeAccountId: activeId,
    username: active?.username ?? null,
    serverUrl: active?.serverUrl ?? null,
  });
}

let replaceSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  window.history.pushState({}, '', '/en/mail');
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  useAuthStore.setState({
    isAuthenticated: false,
    isLoading: false,
    error: null,
    serverUrl: null,
    username: null,
    client: null,
    identities: [],
    primaryIdentity: null,
    authMode: 'basic',
    rememberMe: false,
    accessToken: null,
    tokenExpiresAt: null,
    connectionLost: false,
    activeAccountId: null,
    isDemoMode: false,
  });
  replaceSpy = vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('single-account sign-out and the identity provider', () => {
  it('navigates to the provider logout once the credentials are cleared', async () => {
    signIn([account()]);
    const { calls } = mockFetch({
      'DELETE /api/auth/session?slot=0': () => ok(),
      'DELETE /api/auth/token?slot=0&end_session=true': () => ok({ ok: true, end_session_url: IDP_LOGOUT }),
    });

    await useAuthStore.getState().logout();

    expect(calls).toContain('DELETE /api/auth/token?slot=0&end_session=true');
    // One top-level navigation, to the provider - not the login page too.
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).toHaveBeenCalledWith(IDP_LOGOUT);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    // The login page must not sign straight back in through auto-SSO, once.
    expect(consumeSignedOut()).toBe(true);
    expect(consumeSignedOut()).toBe(false);
  });

  it('keeps the page signed in until the cleanup finished, so the auth guards cannot leave first', async () => {
    signIn([account()]);
    const tokenDelete = deferred();
    mockFetch({
      'DELETE /api/auth/session?slot=0': () => ok(),
      'DELETE /api/auth/token?slot=0&end_session=true': () => tokenDelete.promise,
    });

    const signedOut = useAuthStore.getState().logout();
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));

    // The client is gone (no more requests), but the guards that redirect a
    // signed-out page to /login are not triggered yet.
    expect(useAuthStore.getState().client).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(replaceSpy).not.toHaveBeenCalled();

    tokenDelete.resolve(ok({ end_session_url: IDP_LOGOUT }));
    await signedOut;

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(replaceSpy).toHaveBeenCalledWith(IDP_LOGOUT);
  });

  it('finishes on the login page when the provider has no logout endpoint', async () => {
    signIn([account()]);
    mockFetch({
      'DELETE /api/auth/session?slot=0': () => ok(),
      'DELETE /api/auth/token?slot=0&end_session=true': () => ok({ ok: true }),
    });

    await useAuthStore.getState().logout();

    expect(replaceSpy).toHaveBeenCalledWith('/en/login');
    expect(sessionStorage.getItem('signed_out')).toBe('true');
  });

  it.each([
    ['a non-https URL', 'http://id.example.com/logout'],
    ['a script URL', 'javascript:alert(1)'],
    ['a malformed URL', 'not a url'],
  ])('refuses %s as the provider logout', async (_label, url) => {
    signIn([account()]);
    mockFetch({
      'DELETE /api/auth/session?slot=0': () => ok(),
      'DELETE /api/auth/token?slot=0&end_session=true': () => ok({ end_session_url: url }),
    });

    await useAuthStore.getState().logout();

    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).toHaveBeenCalledWith('/en/login');
  });

  it('leaves the provider alone when the session expired on its own', async () => {
    signIn([account()]);
    const { calls } = mockFetch({
      'PUT /api/auth/token?slot=0&force=true': () => ({ ok: false, status: 401, json: async () => ({}) }),
      'DELETE /api/auth/session?slot=0': () => ok(),
      'DELETE /api/auth/token?slot=0': () => ok(),
    });

    await useAuthStore.getState().refreshAccessToken();
    await vi.waitFor(() => expect(replaceSpy).toHaveBeenCalled());

    expect(calls).toContain('DELETE /api/auth/token?slot=0');
    expect(replaceSpy).toHaveBeenCalledWith('/en/login');
    expect(sessionStorage.getItem('session_expired')).toBe('true');
    // Signing in again should stay one click (auto-SSO allowed).
    expect(sessionStorage.getItem('signed_out')).toBeNull();
  });

  it('leaves the provider alone for a password sign-in', async () => {
    signIn([account({ providerSession: false })]);
    const { calls } = mockFetch({
      'DELETE /api/auth/session?slot=0': () => ok(),
      'DELETE /api/auth/token?slot=0': () => ok(),
    });

    await useAuthStore.getState().logout();

    expect(calls).toEqual(['DELETE /api/auth/session?slot=0', 'DELETE /api/auth/token?slot=0']);
    expect(replaceSpy).toHaveBeenCalledWith('/en/login');
  });

  it('leaves the provider to the embedding portal', async () => {
    vi.spyOn(iframeBridge, 'isEmbedded').mockReturnValue(true);
    signIn([account()]);
    const { calls } = mockFetch({
      'DELETE /api/auth/session?slot=0': () => ok(),
      'DELETE /api/auth/token?slot=0': () => ok(),
    });

    await useAuthStore.getState().logout();

    expect(calls).not.toContain('DELETE /api/auth/token?slot=0&end_session=true');
  });

  it('reports a cleanup the server failed instead of dropping it', async () => {
    signIn([account()]);
    mockFetch({
      'DELETE /api/auth/session?slot=0': () => ok(),
      'DELETE /api/auth/token?slot=0&end_session=true': () => ({ ok: false, status: 500, json: async () => ({}) }),
    });

    await useAuthStore.getState().logout();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('/api/auth/token?slot=0&end_session=true: HTTP 500'));
    expect(replaceSpy).toHaveBeenCalledWith('/en/login');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('gives up waiting on a cleanup that does not answer, leaving it to finish in the background', async () => {
    vi.useFakeTimers();
    signIn([account()]);
    const { fn } = mockFetch({
      'DELETE /api/auth/session?slot=0': () => new Promise(() => {}),
      'DELETE /api/auth/token?slot=0&end_session=true': () => new Promise(() => {}),
    });

    const signedOut = useAuthStore.getState().logout();
    await vi.advanceTimersByTimeAsync(8_000);
    await signedOut;

    expect(replaceSpy).toHaveBeenCalledWith('/en/login');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('finishing it in the background'));
    // keepalive lets the requests outlive the navigation.
    for (const [, init] of fn.mock.calls) expect(init?.keepalive).toBe(true);
  });
});

describe('sign-out and a token renewal in flight', () => {
  it('clears the slot only after the renewal landed, and does not sync its context back', async () => {
    signIn([account()]);
    const renewal = deferred();
    const { calls } = mockFetch({
      'PUT /api/auth/token?slot=0&force=true': () => renewal.promise,
      'POST /api/auth/stalwart-context': () => ok(),
      'DELETE /api/auth/session?slot=0': () => ok(),
      'DELETE /api/auth/token?slot=0&end_session=true': () => ok(),
    });

    const refreshed = useAuthStore.getState().refreshAccessToken();
    const signedOut = useAuthStore.getState().logout();
    await new Promise((r) => setTimeout(r, 20));

    // The renewal's response could still set cookies: nothing is cleared yet.
    expect(calls).toEqual(['PUT /api/auth/token?slot=0&force=true']);

    renewal.resolve(ok({ access_token: 'renewed', expires_in: 3600 }));
    await signedOut;

    expect(await refreshed).toBeNull();
    expect(calls.indexOf('DELETE /api/auth/token?slot=0&end_session=true')).toBeGreaterThan(0);
    expect(calls).not.toContain('POST /api/auth/stalwart-context');
  });

  it('cancels a renewal that outlasts the wait, so its response cannot restore the cookies', async () => {
    vi.useFakeTimers();
    signIn([account()]);
    const { calls } = mockFetch({
      'PUT /api/auth/token?slot=0&force=true': (init) => new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          calls.push('abort renewal');
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }),
      'DELETE /api/auth/session?slot=0': () => ok(),
      'DELETE /api/auth/token?slot=0&end_session=true': () => ok(),
    });

    const refreshed = useAuthStore.getState().refreshAccessToken();
    const signedOut = useAuthStore.getState().logout();
    await vi.advanceTimersByTimeAsync(3_000);
    await signedOut;

    expect(await refreshed).toBeNull();
    expect(calls.indexOf('abort renewal')).toBeGreaterThan(-1);
    expect(calls.indexOf('abort renewal')).toBeLessThan(calls.indexOf('DELETE /api/auth/token?slot=0&end_session=true'));
    // The failed renewal is not retried after the sign-out.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls.filter((c) => c.startsWith('PUT'))).toHaveLength(1);
  });

  it('does not start a renewal for a slot being signed out', async () => {
    signIn([account()]);
    const tokenDelete = deferred();
    const { calls } = mockFetch({
      'DELETE /api/auth/session?slot=0': () => ok(),
      'DELETE /api/auth/token?slot=0&end_session=true': () => tokenDelete.promise,
    });

    const signedOut = useAuthStore.getState().logout();
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(await useAuthStore.getState().refreshAccessToken()).toBeNull();
    expect(calls.some((c) => c.startsWith('PUT'))).toBe(false);

    tokenDelete.resolve(ok());
    await signedOut;
  });
});

describe('signing out of several accounts', () => {
  // Two providers: Alice and Carol signed in through SSO at different
  // issuers, Bob with a password.
  const alice = account({ id: 'alice', cookieSlot: 0, providerSession: true });
  const bob = account({ id: 'bob', cookieSlot: 1, providerSession: false, isDefault: false });
  const carol = account({ id: 'carol', cookieSlot: 2, providerSession: true, isDefault: false });

  it('picks the active account when it signed in through a provider', () => {
    expect(pickEndSessionSlot([alice, bob, carol], 'carol')).toBe(2);
  });

  it('otherwise picks the first account that signed in through a provider', () => {
    expect(pickEndSessionSlot([alice, bob, carol], 'bob')).toBe(0);
    expect(pickEndSessionSlot([bob, carol], null)).toBe(2);
  });

  it('picks none when no account signed in through a provider', () => {
    expect(pickEndSessionSlot([bob], 'bob')).toBeNull();
    expect(pickEndSessionSlot([account({ providerSession: undefined })], null)).toBeNull();
  });

  it('clears every slot, then ends the chosen provider session', async () => {
    signIn([alice, bob, carol], 'carol');
    const { calls } = mockFetch({
      'DELETE /api/auth/session?all=true': () => ok(),
      'DELETE /api/auth/token?all=true&end_session_slot=2': () => ok({ end_session_url: IDP_LOGOUT }),
    });

    await useAuthStore.getState().logoutAll();

    expect(calls).toHaveLength(2);
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(replaceSpy).toHaveBeenCalledWith(IDP_LOGOUT);
    expect(useAccountStore.getState().accounts).toEqual([]);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('clears every slot and finishes on the login page when no account used a provider', async () => {
    signIn([bob]);
    const { calls } = mockFetch({
      'DELETE /api/auth/session?all=true': () => ok(),
      'DELETE /api/auth/token?all=true': () => ok(),
    });

    await useAuthStore.getState().logoutAll();

    expect(calls).toEqual(['DELETE /api/auth/session?all=true', 'DELETE /api/auth/token?all=true']);
    expect(replaceSpy).toHaveBeenCalledWith('/en/login');
  });
});

// Leaving for the provider is final for the page, so that state is never
// reset - no test in this file relies on redirectToLogin() navigating.
describe('after leaving for the provider logout', () => {
  it('keeps the page auth guards from cancelling that navigation', async () => {
    signIn([account()]);
    mockFetch({
      'DELETE /api/auth/session?slot=0': () => ok(),
      'DELETE /api/auth/token?slot=0&end_session=true': () => ok({ end_session_url: IDP_LOGOUT }),
    });

    await useAuthStore.getState().logout();
    expect(replaceSpy).toHaveBeenLastCalledWith(IDP_LOGOUT);

    // What every page guard does when it sees the signed-out state. A second
    // location.replace() would win over the one to the provider.
    saveRedirectAfterLogin();
    redirectToLogin();

    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('redirect_after_login')).toBeNull();
  });
});
