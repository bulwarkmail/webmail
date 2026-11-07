import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '@/lib/plugin-types';

// The core "Return to my account" strip (#1538) shows only in an impersonated
// session the server can return from, and only when no enabled plugin draws
// the button in its own banner.

const client = vi.hoisted(() => ({
  canReturnToOwnAccount: vi.fn(async () => true),
  returnToOwnAccount: vi.fn(async () => {}),
}));
vi.mock('@/lib/impersonation/return-client', () => client);

import { ImpersonationReturnBar } from '../impersonation-return-bar';
import { resetImpersonationReturnCacheForTests } from '@/hooks/use-impersonation-return';
import { deregister, register, type ActivePlugin } from '@/lib/plugin-sandbox/registry';
import { useAccountStore } from '@/stores/account-store';

const account = {
  id: 'alice@x.test@mail.x.test', label: 'Alice', serverUrl: 'https://mail.x.test', username: 'alice@x.test',
  authMode: 'basic' as const, rememberMe: true, cookieSlot: 0, displayName: 'Alice', email: 'alice@x.test',
  isConnected: true, hasError: false, lastLoginAt: 1, avatarColor: '#000000', isDefault: true,
};

/** An enabled plugin with a banner in the app-top-banner slot. */
function bannerPlugin(permissions: string[], { managed = true, granted = [] as string[] } = {}) {
  register({
    plugin: {
      id: 'banner', name: 'Banner', version: '1.0.0', type: 'hook', permissions, managed, grantedPermissions: granted,
      enabled: true, status: 'running',
    } as unknown as InstalledPlugin,
    code: '',
    tier: 'sandboxed',
    background: {} as ActivePlugin['background'],
    slotOffers: [{ name: 'app-top-banner', order: 50, hasShouldShow: true }],
    hookDisposables: [],
  } as unknown as ActivePlugin);
}

async function renderBar() {
  await act(async () => {
    render(<ImpersonationReturnBar />);
  });
}

describe('ImpersonationReturnBar', () => {
  beforeEach(() => {
    resetImpersonationReturnCacheForTests();
    client.canReturnToOwnAccount.mockReset().mockResolvedValue(true);
    client.returnToOwnAccount.mockReset().mockResolvedValue(undefined);
    useAccountStore.setState({ accounts: [{ ...account, impersonated: true }], activeAccountId: account.id });
  });

  afterEach(() => {
    deregister('banner');
  });

  it('offers the way back in an impersonated session', async () => {
    await renderBar();

    expect(screen.getByTestId('impersonation-return-bar').textContent).toContain('return_notice');
    fireEvent.click(screen.getByRole('button', { name: /return_button/ }));
    expect(client.returnToOwnAccount).toHaveBeenCalledTimes(1);
  });

  it('stays hidden when the server holds nothing to return to', async () => {
    client.canReturnToOwnAccount.mockResolvedValue(false);
    await renderBar();
    expect(screen.queryByTestId('impersonation-return-bar')).toBeNull();
  });

  it('does not ask the server for a session the user opened themselves', async () => {
    useAccountStore.setState({ accounts: [account], activeAccountId: account.id });
    await renderBar();
    expect(screen.queryByTestId('impersonation-return-bar')).toBeNull();
    expect(client.canReturnToOwnAccount).not.toHaveBeenCalled();
  });

  it('steps back for a plugin banner that draws the button itself', async () => {
    bannerPlugin(['ui:app-top-banner', 'auth:impersonation-return']);
    await renderBar();
    expect(screen.queryByTestId('impersonation-return-bar')).toBeNull();
  });

  it('stays for a plugin banner without the permission', async () => {
    bannerPlugin(['ui:app-top-banner', 'auth:emit']);
    await renderBar();
    expect(screen.getByTestId('impersonation-return-bar')).toBeTruthy();
  });

  it('stays when the user has not granted the permission the plugin asks for', async () => {
    bannerPlugin(['ui:app-top-banner', 'auth:impersonation-return'], { managed: false, granted: ['ui:app-top-banner'] });
    await renderBar();
    expect(screen.getByTestId('impersonation-return-bar')).toBeTruthy();
  });

  it('comes back when the plugin goes away', async () => {
    bannerPlugin(['ui:app-top-banner', 'auth:impersonation-return']);
    await renderBar();
    expect(screen.queryByTestId('impersonation-return-bar')).toBeNull();
    act(() => {
      deregister('banner');
    });
    expect(screen.getByTestId('impersonation-return-bar')).toBeTruthy();
  });
});
