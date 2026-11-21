import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJSONStorage } from 'zustand/middleware';
import * as browserNavigation from '@/lib/browser-navigation';
import { useAccountStore, type AccountEntry } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import {
  parseAccountRegistry,
  returnToOwnAccount,
  sendAccountRegistry,
} from '@/lib/impersonation/return-client';

// The page's side of "Return to my account" (#1538): the account list goes to
// the server before the handoff drops it, and comes back with the return.

const admin: AccountEntry = {
  id: 'admin@mail.example', label: 'Admin', serverUrl: 'https://mail.example', username: 'admin', authMode: 'oauth',
  rememberMe: true, cookieSlot: 0, displayName: 'Admin', email: 'admin@mail.example', isConnected: true, hasError: false,
  lastLoginAt: 1, avatarColor: '#000000', isDefault: true,
};
const second: AccountEntry = { ...admin, id: 'ops@mail.example', username: 'ops', email: 'ops@mail.example', cookieSlot: 1, authMode: 'basic', isDefault: false };
const target: AccountEntry = { ...admin, id: 'alice@mail.example', username: 'alice', email: 'alice@mail.example', authMode: 'basic', impersonated: true };

function persisted(name: string): { state: Record<string, unknown> } | null {
  const raw = localStorage.getItem(name);
  return raw ? JSON.parse(raw) : null;
}

describe('impersonation return, browser side', () => {
  let replace: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let logout: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(() => {
    localStorage.clear();
    useAccountStore.persist.setOptions({ storage: createJSONStorage(() => localStorage) });
    useAuthStore.persist.setOptions({ storage: createJSONStorage(() => localStorage) });
    replace = vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    logout = vi.fn<() => Promise<void>>(async () => {});
    useAuthStore.setState({ logout });
    window.history.replaceState({}, '', '/en/mail');
  });

  afterEach(() => {
    replace.mockRestore();
    vi.unstubAllGlobals();
  });

  it('sends the account list before the handoff drops it', () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    useAccountStore.setState({ accounts: [admin, second], activeAccountId: second.id, defaultAccountId: admin.id });

    sendAccountRegistry();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/impersonate/return');
    expect(init.method).toBe('PUT');
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(String(init.body))).toMatchObject({
      accounts: [{ id: admin.id }, { id: second.id }],
      activeAccountId: second.id,
      defaultAccountId: admin.id,
    });
  });

  it("does not send an impersonation's own account list", () => {
    useAccountStore.setState({ accounts: [target], activeAccountId: target.id, defaultAccountId: target.id });
    sendAccountRegistry();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('brings the account list back and reloads after a return', async () => {
    useAccountStore.setState({ accounts: [target], activeAccountId: target.id, defaultAccountId: target.id });
    useAuthStore.setState({ isAuthenticated: true, username: 'alice', activeAccountId: target.id });
    expect(persisted('auth-storage')).not.toBeNull();
    fetchMock.mockResolvedValue(Response.json({
      ok: true,
      registry: { accounts: [admin, second], activeAccountId: second.id, defaultAccountId: admin.id },
    }));

    await returnToOwnAccount();

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/impersonate/return', { method: 'POST' });
    const registry = persisted('account-registry')!.state as { accounts: AccountEntry[]; activeAccountId: string };
    expect(registry.accounts.map((a) => a.id)).toEqual([admin.id, second.id]);
    expect(registry.accounts.every((a) => !a.isConnected)).toBe(true);
    expect(registry.activeAccountId).toBe(second.id);
    // The target's state is gone and stays gone while the page reloads.
    expect(persisted('auth-storage')).toBeNull();
    useAccountStore.getState().updateAccount(target.id, { lastLoginAt: 5 });
    expect(JSON.stringify(persisted('account-registry'))).not.toContain(target.id);
    expect(replace).toHaveBeenCalledWith('/en');
    expect(logout).not.toHaveBeenCalled();
  });

  it('signs out, as before, when there is nothing to return to', async () => {
    useAccountStore.setState({ accounts: [target], activeAccountId: target.id, defaultAccountId: target.id });
    fetchMock.mockResolvedValue(Response.json({ error: 'Nothing to return to' }, { status: 410 }));

    await returnToOwnAccount();

    expect(logout).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    expect(JSON.stringify(persisted('account-registry'))).toContain(target.id);
  });

  it('keeps only well-formed accounts from the list it gets back', () => {
    const parsed = parseAccountRegistry({
      accounts: [admin, { ...second, cookieSlot: 99 }, { id: 'x' }, null, { ...second, authMode: 'magic' }],
      activeAccountId: second.id,
      defaultAccountId: admin.id,
    });
    expect(parsed?.accounts.map((a) => a.id)).toEqual([admin.id]);
    expect(parsed?.activeAccountId).toBeNull();
    expect(parsed?.defaultAccountId).toBe(admin.id);
    expect(parseAccountRegistry({ accounts: [] })).toBeNull();
    expect(parseAccountRegistry('nope')).toBeNull();
  });
});
