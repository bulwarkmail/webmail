import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A forgotten PIN offline: the HttpOnly session cookie couldn't be deleted. With no
// accounts left, a start would adopt that cookie and sign its login back in, with no PIN.

vi.mock('@/lib/store/client/purge', () => ({ purgeStoreFiles: async () => {}, deleteStorePool: async () => {} }));

let useAuthStore: typeof import('../auth-store').useAuthStore;

function calls(): string[] {
  return (fetch as ReturnType<typeof vi.fn>).mock.calls.map(([url, init]) => `${(init as RequestInit)?.method ?? 'GET'} ${String(url)}`);
}

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  ({ useAuthStore } = await import('../auth-store'));
  const browserNavigation = await import('@/lib/browser-navigation');
  vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});
});

describe('the mark for cookies still to clear', () => {
  it('blocks adoption while the DELETE keeps failing, and tries it first', async () => {
    localStorage.setItem('bulwark-cookies-to-clear', '1');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') throw new TypeError('offline');
      return new Response(JSON.stringify({ serverUrl: 'https://mail.example.test', username: 'alice', password: 'secret' }), { status: 200 });
    }));
    await useAuthStore.getState().checkAuth();
    expect(calls()).toContain('DELETE /api/auth/session?all=true');
    expect(calls()).not.toContain('PUT /api/auth/session');
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(localStorage.getItem('bulwark-cookies-to-clear')).toBe('1');
  });

  it('comes off when the DELETE worked, and nothing is adopted from what was cleared', async () => {
    localStorage.setItem('bulwark-cookies-to-clear', '1');
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => (
      init?.method === 'PUT' ? new Response('{}', { status: 401 }) : new Response('{}', { status: 200 })
    )));
    await useAuthStore.getState().checkAuth();
    expect(localStorage.getItem('bulwark-cookies-to-clear')).toBeNull();
    const list = calls();
    expect(list.indexOf('DELETE /api/auth/session?all=true')).toBeGreaterThanOrEqual(0);
    expect(list.indexOf('DELETE /api/auth/session?all=true')).toBeLessThan(list.indexOf('PUT /api/auth/session'));
  });

  it('isn\'t there normally: adoption goes on as before', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    await useAuthStore.getState().checkAuth();
    expect(calls()).toContain('PUT /api/auth/session');
    expect(calls()).not.toContain('DELETE /api/auth/session?all=true');
  });
});

describe('the app lock and the way to the login page', () => {
  const stored = JSON.stringify({ state: { isAuthenticated: true }, version: 0 });

  it('a page that starts behind the lock has shown nothing, so the login page opens in place', async () => {
    vi.resetModules();
    localStorage.setItem('auth-storage', stored);
    localStorage.setItem('bulwark-app-lock', JSON.stringify({ on: true, locked: true }));
    const auth = await import('../auth-store');
    expect(auth.useAuthStore.getState().isAuthenticated, 'what storage said').toBe(true);
    expect(auth.canEnterLoginInPlace()).toBe(true);
  });

  it('with no lock, a signed-in state from storage still counts as shown', async () => {
    vi.resetModules();
    localStorage.setItem('auth-storage', stored);
    const auth = await import('../auth-store');
    expect(auth.useAuthStore.getState().isAuthenticated).toBe(true);
    expect(auth.canEnterLoginInPlace()).toBe(false);
  });
});
