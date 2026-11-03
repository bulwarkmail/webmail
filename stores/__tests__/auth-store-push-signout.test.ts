import { beforeEach, describe, expect, it, vi } from 'vitest';

const endWebPushForSignOut = vi.hoisted(() => vi.fn(async () => {}));
const dropAllWebPushRegistrations = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/web-push', async (original) => ({ ...(await original<typeof import('@/lib/web-push')>()), endWebPushForSignOut, dropAllWebPushRegistrations }));

import { setClientForTests, useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';

function fakeClient() {
  return { disconnect: vi.fn(), getAccountId: () => 'jmap-a' } as unknown as NonNullable<ReturnType<typeof useAuthStore.getState>['client']>;
}

describe('signing out ends the login\'s push registration', () => {
  beforeEach(() => {
    endWebPushForSignOut.mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });

  it('when the user signs out', async () => {
    const client = fakeClient();
    useAuthStore.setState({ client, isAuthenticated: true, activeAccountId: null, isDemoMode: false });
    await useAuthStore.getState().logout();
    expect(endWebPushForSignOut).toHaveBeenCalledWith(client);
  });

  it('when a wipe signs the login out', async () => {
    const client = fakeClient();
    useAuthStore.setState({ client, isAuthenticated: true, activeAccountId: null, isDemoMode: false });
    await useAuthStore.getState().logout({ endProviderSession: false });
    expect(endWebPushForSignOut).toHaveBeenCalledWith(client);
  });

  it('not when the session only ran out: it comes back with the next sign-in', async () => {
    const client = fakeClient();
    useAuthStore.setState({ client, isAuthenticated: true, activeAccountId: null, isDemoMode: false });
    await useAuthStore.getState().logout({ endProviderSession: false, keepLocalData: true });
    expect(endWebPushForSignOut).not.toHaveBeenCalled();
  });

  it('removing a login ends its push while its client can still reach the server', async () => {
    let accountId = 'jmap-b';
    const order: string[] = [];
    const client = {
      disconnect: vi.fn(() => { order.push('disconnect'); accountId = ''; }),
      getAccountId: () => accountId,
    } as unknown as Parameters<typeof setClientForTests>[1];
    endWebPushForSignOut.mockImplementationOnce(async (seen: { getAccountId: () => string }) => {
      await Promise.resolve();
      order.push(`push ended for ${seen.getAccountId()}`);
    });
    setClientForTests('login-b', client);
    useAccountStore.setState({ accounts: [{ id: 'login-b', cookieSlot: 1, username: 'b', serverUrl: 'https://x' }] as never });
    useAuthStore.setState({ activeAccountId: 'login-a', isDemoMode: false });

    useAuthStore.getState().removeAccount('login-b');
    await vi.waitFor(() => expect(order).toContain('disconnect'));

    expect(order).toEqual(['push ended for jmap-b', 'disconnect']);
  });

  it('a login the session threw out keeps its push for the next sign-in', async () => {
    const client = fakeClient();
    setClientForTests('login-c', client);
    useAccountStore.setState({ accounts: [{ id: 'login-c', cookieSlot: 1, username: 'c', serverUrl: 'https://x' }] as never });
    useAuthStore.setState({ activeAccountId: 'login-a', isDemoMode: false });

    useAuthStore.getState().removeAccount('login-c', 'evicted');
    await vi.waitFor(() => expect(client.disconnect).toHaveBeenCalled());

    expect(endWebPushForSignOut).not.toHaveBeenCalled();
  });

  it('signs out even if the push code cannot be loaded', async () => {
    const client = fakeClient();
    endWebPushForSignOut.mockRejectedValueOnce(new Error('chunk failed'));
    useAuthStore.setState({ client, isAuthenticated: true, activeAccountId: null, isDemoMode: false });
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().client).toBeNull();
  });

  it('signing out of everything also covers logins with no connection', async () => {
    dropAllWebPushRegistrations.mockClear();
    useAuthStore.setState({ isDemoMode: false });
    await useAuthStore.getState().logoutAll();
    expect(dropAllWebPushRegistrations).toHaveBeenCalledTimes(1);
  });

  it('not in demo mode', async () => {
    const client = fakeClient();
    useAuthStore.setState({ client, isAuthenticated: true, activeAccountId: null, isDemoMode: true });
    await useAuthStore.getState().logout();
    expect(endWebPushForSignOut).not.toHaveBeenCalled();
    useAuthStore.setState({ isDemoMode: false });
  });
});
