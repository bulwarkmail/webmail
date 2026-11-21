import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';

// api.user.returnToOwnAccount (#1538): a plugin's impersonation banner can
// take the admin back to their own account. It gets a function and nothing
// else; the return itself is the core one (POST /api/auth/impersonate/return,
// sign-out when there is nothing to return to).

const client = vi.hoisted(() => ({ returnToOwnAccount: vi.fn(async () => {}) }));
vi.mock('@/lib/impersonation/return-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/impersonation/return-client')>()),
  returnToOwnAccount: client.returnToOwnAccount,
}));
const popout = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/popout/window-role', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/popout/window-role')>()),
  isPopoutWindow: () => popout.value,
}));

const { dispatchApiCall } = await import('../plugin-sandbox/host-api');
const { useAccountStore } = await import('@/stores/account-store');
const { useAuthStore } = await import('@/stores/auth-store');

const plugin = (permissions: string[]) => ({
  id: 'impersonation-notice', name: 'Impersonation Notice', version: '1.5.0', author: 'a', description: 'd', type: 'hook',
  permissions, managed: true, entrypoint: 'index.js', enabled: true, status: 'running', settings: {}, httpPostAllowedOrigins: [],
} as unknown as InstalledPlugin);

const account = {
  id: 'alice@x.test@mail.x.test', label: 'Alice', serverUrl: 'https://mail.x.test', username: 'alice@x.test',
  authMode: 'basic' as const, rememberMe: true, cookieSlot: 0, displayName: 'Alice', email: 'alice@x.test',
  isConnected: true, hasError: false, lastLoginAt: 1, avatarColor: '#000000', isDefault: true,
};

describe('api.user.returnToOwnAccount', () => {
  let logout: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(() => {
    client.returnToOwnAccount.mockClear();
    popout.value = false;
    logout = vi.fn<() => Promise<void>>(async () => {});
    useAuthStore.setState({ logout });
    useAccountStore.setState({ accounts: [{ ...account, impersonated: true }], activeAccountId: account.id });
  });

  it('returns through the core flow for a plugin with the permission', async () => {
    const result = await dispatchApiCall(plugin(['auth:impersonation-return']), 'user.returnToOwnAccount', ['ignored']);
    expect(result).toBeUndefined();
    expect(client.returnToOwnAccount).toHaveBeenCalledTimes(1);
  });

  it('is refused without the permission, even with auth:emit', async () => {
    await expect(dispatchApiCall(plugin(['auth:emit', 'ui:app-top-banner']), 'user.returnToOwnAccount', []))
      .rejects.toThrow('lacks permission "auth:impersonation-return"');
    expect(client.returnToOwnAccount).not.toHaveBeenCalled();
  });

  it('does nothing in a session the user opened themselves, so it is no way to sign them out', async () => {
    useAccountStore.setState({ accounts: [account], activeAccountId: account.id });
    await expect(dispatchApiCall(plugin(['auth:impersonation-return']), 'user.returnToOwnAccount', []))
      .rejects.toThrow('not an impersonation');
    expect(client.returnToOwnAccount).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
  });

  it('is refused in a pop-out window', async () => {
    popout.value = true;
    await expect(dispatchApiCall(plugin(['auth:impersonation-return']), 'user.returnToOwnAccount', []))
      .rejects.toThrow('pop-out');
    expect(client.returnToOwnAccount).not.toHaveBeenCalled();
  });
});

describe('the app-top-banner slot prop canReturn', () => {
  it('reaches only a plugin with auth:impersonation-return', async () => {
    const { slotPropsFor } = await import('../plugin-sandbox/permissions');
    const props = { username: 'alice@x.test', impersonated: true, canReturn: true };
    expect(slotPropsFor(plugin(['ui:app-top-banner', 'account:read', 'auth:impersonation-return']), 'app-top-banner', props))
      .toEqual(props);
    expect(slotPropsFor(plugin(['ui:app-top-banner', 'account:read', 'auth:emit']), 'app-top-banner', props))
      .toEqual({ username: 'alice@x.test', impersonated: true });
  });
});
