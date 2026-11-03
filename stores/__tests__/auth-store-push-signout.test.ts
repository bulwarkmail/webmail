import { beforeEach, describe, expect, it, vi } from 'vitest';

const endWebPushForSignOut = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/web-push', async (original) => ({ ...(await original<typeof import('@/lib/web-push')>()), endWebPushForSignOut }));

import { useAuthStore } from '../auth-store';

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

  it('not in demo mode', async () => {
    const client = fakeClient();
    useAuthStore.setState({ client, isAuthenticated: true, activeAccountId: null, isDemoMode: true });
    await useAuthStore.getState().logout();
    expect(endWebPushForSignOut).not.toHaveBeenCalled();
    useAuthStore.setState({ isDemoMode: false });
  });
});
