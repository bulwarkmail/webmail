import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A full sign-out takes what a device wipe takes of the users' things, so the next
// person at this browser finds none of it. That covers this tab's sessionStorage, which
// outlives the navigation to the login page: a rescued draft (text a closing pop-out
// couldn't save, which the mail view offers as "Continue draft"), links waiting for the
// next sign-in, a plugin provider's answer. It also covers the notifications still on
// screen with a sender and a subject, and the file names and paths an older version
// kept under `webdav-`. The device wipe's own list is the sign-out's plus what a
// sign-out keeps on purpose, and the last case holds that.

const endWebPushForSignOut = vi.hoisted(() => vi.fn(async (_client: unknown) => {}));
vi.mock('@/lib/web-push', async (original) => ({ ...(await original<typeof import('@/lib/web-push')>()), endWebPushForSignOut }));

import { useAuthStore } from '@/stores/auth-store';
import { keepRescuedDraft } from '@/lib/popout/rescued-drafts';
import { purgeSignedOutData } from '@/lib/sign-out-cleanup';

function fakeClient() {
  return { disconnect: vi.fn(), getAccountId: () => 'jmap-a' } as unknown as NonNullable<ReturnType<typeof useAuthStore.getState>['client']>;
}

const onScreen = [
  { tag: 'bulwark-mail:jmap-a', title: 'Secret sender (alice)', body: 'Secret subject', close: vi.fn() },
  { tag: 'calendar-reminder:k1', title: 'Secret meeting', body: 'In 10 minutes', close: vi.fn() },
];

async function signOut(): Promise<void> {
  useAuthStore.setState({ client: fakeClient(), isAuthenticated: true, activeAccountId: null, isDemoMode: false });
  await useAuthStore.getState().logout();
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  for (const notification of onScreen) notification.close.mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  Object.defineProperty(window.navigator, 'serviceWorker', {
    configurable: true,
    value: {
      controller: null,
      ready: new Promise(() => {}),
      getRegistration: async () => ({
        getNotifications: async () => onScreen,
        pushManager: { getSubscription: async () => null },
      }),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window.navigator as { serviceWorker?: unknown }).serviceWorker;
});

describe('a full sign-out and what the next person in this tab finds', () => {
  it('takes a rescued draft out of this tab', async () => {
    keepRescuedDraft({ mode: 'compose', subject: 'Secret draft subject', body: 'Secret draft text of Alice' } as never);
    expect(sessionStorage.getItem('bulwark-rescued-drafts')).toContain('Secret draft text');
    localStorage.setItem('pro-tabs', 'x');
    await signOut();
    // This was the full sign-out: its storage list went.
    expect(localStorage.getItem('pro-tabs')).toBeNull();
    expect(sessionStorage.getItem('bulwark-rescued-drafts')).toBeNull();
  });

  it("takes the file names and paths an older version kept for the WebDAV area", async () => {
    localStorage.setItem('webdav-recent-files', JSON.stringify([{ name: 'Secret contract.pdf', path: '/Secret contract.pdf', timestamp: 1 }]));
    localStorage.setItem('webdav-favorites', JSON.stringify(['/Secret folder']));
    localStorage.setItem('webdav-last-path', '/Secret folder');
    await signOut();
    for (const key of ['webdav-recent-files', 'webdav-favorites', 'webdav-last-path']) expect([key, localStorage.getItem(key)]).toEqual([key, null]);
  });

  it('closes the notifications still on screen with a sender and subject, or an event', async () => {
    await signOut();
    await vi.waitFor(() => {
      for (const notification of onScreen) expect(notification.close).toHaveBeenCalled();
    }, { timeout: 2000 });
  });

  it('takes the links waiting for the next sign-in and a plugin provider\'s answer', async () => {
    sessionStorage.setItem('bulwark:pending-mailto', JSON.stringify({ to: ['secret@example.org'], body: 'Secret text', createdAt: Date.now() }));
    sessionStorage.setItem('bulwark:pending-webcal', JSON.stringify({ url: 'https://example.org/secret.ics', createdAt: Date.now() }));
    sessionStorage.setItem('plugin-oauth-callback', JSON.stringify({ code: 'c0de', state: 's' }));
    localStorage.setItem('plugin-oauth-callback', JSON.stringify({ code: 'c0de', state: 's' }));
    localStorage.setItem('dismissed-unsub-banners', JSON.stringify(['<secret-id@example.org>']));
    await signOut();
    for (const key of ['bulwark:pending-mailto', 'bulwark:pending-webcal', 'plugin-oauth-callback']) expect([key, sessionStorage.getItem(key)]).toEqual([key, null]);
    for (const key of ['plugin-oauth-callback', 'dismissed-unsub-banners']) expect([key, localStorage.getItem(key)]).toEqual([key, null]);
  });

  it('leaves where signing in again goes: the app\'s own sign-out at an expired session writes it just before', async () => {
    sessionStorage.setItem('redirect_after_login', '/mail/folder/inbox');
    purgeSignedOutData({ keepLocalStore: true });
    expect(sessionStorage.getItem('redirect_after_login')).toBe('/mail/folder/inbox');
  });

  it('does the same for a sign-out the app decided on, which keeps the local store', () => {
    keepRescuedDraft({ mode: 'compose', subject: 'S', body: 'Secret draft text' } as never);
    localStorage.setItem('webdav-last-path', '/Secret folder');
    sessionStorage.setItem('bulwark:pending-mailto', '{}');
    purgeSignedOutData({ keepLocalStore: true });
    expect(sessionStorage.getItem('bulwark-rescued-drafts')).toBeNull();
    expect(localStorage.getItem('webdav-last-path')).toBeNull();
    expect(sessionStorage.getItem('bulwark:pending-mailto')).toBeNull();
  });
});

describe('the device wipe\'s list and the sign-out\'s', () => {
  it('a sign-out takes every key a wipe takes, except the ones it keeps on purpose', async () => {
    const { SHARED_LOCAL_KEYS, SHARED_LOCAL_PREFIXES } = await import('@/lib/offline/device-wipe');
    for (const key of SHARED_LOCAL_KEYS) localStorage.setItem(key, 'x');
    for (const prefix of SHARED_LOCAL_PREFIXES) localStorage.setItem(`${prefix}anything`, 'x');
    purgeSignedOutData();
    // A key added to the wipe's list for a user's data belongs on the sign-out's list too
    // (lib/sign-out-cleanup.ts). Only a deliberate decision adds one here.
    expect(Object.keys(localStorage).sort()).toEqual(['template-storage', 'webmail_usernames']);
  });
});
