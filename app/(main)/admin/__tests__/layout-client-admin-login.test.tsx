import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The sidebar offers the console when any signed-in login is a Stalwart
// admin (#1532), so the console has to accept that login too, not only the
// open one.

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => '/admin/settings',
}));
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/browser-navigation', () => ({
  apiFetch,
  getPathPrefix: () => '',
  withBasePath: (href: string) => href,
}));
vi.mock('@/components/admin/admin-shell', () => ({
  AdminShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('../_unsaved-changes-guard', () => ({ UnsavedChangesGuard: () => null }));

const { AdminLayoutClient } = await import('../_layout-client');
const { useAccountStore } = await import('@/stores/account-store');
const { useAuthStore } = await import('@/stores/auth-store');

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function account(id: string, cookieSlot: number) {
  return {
    id, label: id, serverUrl: 'https://mail.example.com', username: id, authMode: 'basic' as const,
    cookieSlot, rememberMe: true, displayName: id, email: id, avatarColor: '#000',
    lastLoginAt: 0, isConnected: true, hasError: false, isDefault: cookieSlot === 0,
  };
}

describe('admin layout with several logins', () => {
  beforeEach(() => {
    replace.mockReset();
    apiFetch.mockReset();
    useAccountStore.setState({
      accounts: [account('user@example.com', 0), account('admin@example.com', 1)],
      activeAccountId: 'user@example.com',
    });
    useAuthStore.setState({ activeAccountId: 'user@example.com' });
  });

  it('signs in with the admin login when the open login is not an admin', async () => {
    apiFetch.mockImplementation(async (_url: string, init: { method?: string; headers?: Record<string, string> }) => {
      if (init.method === 'POST') return json({ ok: true });
      return init.headers?.['X-JMAP-Cookie-Slot'] === '1'
        ? json({ enabled: false, authenticated: false, stalwartAdmin: true, stalwartAutoLogin: true })
        : json({ enabled: false, authenticated: false, stalwartAdmin: false, stalwartAutoLogin: false });
    });

    render(<AdminLayoutClient><p>page</p></AdminLayoutClient>);

    expect(await screen.findByText('page')).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledWith('/api/admin/auth', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-JMAP-Cookie-Slot': '1' }),
    }));
    expect(replace).not.toHaveBeenCalled();
  });

  it('still leaves when no login is an admin', async () => {
    apiFetch.mockImplementation(async () => json({ enabled: false, authenticated: false, stalwartAdmin: false, stalwartAutoLogin: false }));

    render(<AdminLayoutClient><p>page</p></AdminLayoutClient>);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('page')).toBeNull();
  });
});
