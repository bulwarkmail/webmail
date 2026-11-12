import { beforeEach, describe, expect, it, vi } from 'vitest';

// The bell's list (stores/notification-center-store.ts, localStorage key
// `notification-center`) keeps the last 50 error and warning toasts and every
// plugin notification: file names, people's names, whatever a plugin wrote. Once
// everyone has signed out none of it is left, in storage or in the store's memory,
// for the next person who signs in on this browser. The same goes for the other
// keys a device wipe takes and a sign-out of everyone takes too.

vi.mock('@/lib/plugin-storage', () => ({
  fileStorage: { clearFiles: vi.fn(async () => {}) },
}));

import { purgeSignedOutData } from '@/lib/sign-out-cleanup';
import { recordNotification, reloadNotificationCenter, useNotificationCenterStore } from '@/stores/notification-center-store';

beforeEach(() => {
  localStorage.clear();
  useNotificationCenterStore.setState({ entries: [] });
});

function leaveNotices(): void {
  // An app toast (components/email/email-composer.tsx upload_failed) and a plugin's notice.
  recordNotification({ level: 'error', title: 'Could not upload "Termination letter J. Fakename.pdf"', body: '' });
  recordNotification({ level: 'info', title: 'Invoice 2026-114 from Fake Supplier Ltd', body: 'Total 1,234.00 EUR, due 30 November', pluginId: 'e-invoice', pluginName: 'E-invoice' });
}

describe('a full sign-out and the notification list', () => {
  it('control: the list is kept in localStorage while signed in', () => {
    leaveNotices();
    expect(localStorage.getItem('notification-center')).toContain('Fakename');
    expect(useNotificationCenterStore.getState().entries).toHaveLength(2);
  });

  it('leaves none of it in localStorage', () => {
    leaveNotices();
    purgeSignedOutData();
    expect(localStorage.getItem('notification-center')).toBeNull();
  });

  it('leaves none of it in the store the next sign-in in this tab reads', () => {
    leaveNotices();
    purgeSignedOutData();
    expect(useNotificationCenterStore.getState().entries).toEqual([]);
    // And a fresh page load finds nothing either.
    reloadNotificationCenter();
    expect(useNotificationCenterStore.getState().entries).toEqual([]);
  });

  it('also when the local store is kept for a later sign-in (a forced sign-out)', () => {
    leaveNotices();
    purgeSignedOutData({ keepLocalStore: true });
    expect(localStorage.getItem('notification-center')).toBeNull();
    expect(useNotificationCenterStore.getState().entries).toEqual([]);
  });
});

describe('a full sign-out and the other keys a device wipe takes', () => {
  it.each([
    // A plugin sign-in still waiting for its provider: it mustn't finish for the next person.
    ['plugin-oauth-states', JSON.stringify({ ['a'.repeat(48)]: { pluginId: 'calendar-sync', created: Date.now() } })],
    // The global search's last scope.
    ['global-search', JSON.stringify({ state: { scope: 'mail' }, version: 1 })],
    // When the last person asked for fresh sender icons.
    ['favicon-refresh', JSON.stringify({ state: { refreshedAt: 1_700_000_000_000 }, version: 0 })],
  ])('removes %s, also when the local store is kept', (key, value) => {
    localStorage.setItem(key, value);
    purgeSignedOutData();
    expect(localStorage.getItem(key)).toBeNull();
    localStorage.setItem(key, value);
    purgeSignedOutData({ keepLocalStore: true });
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('keeps the user names the login form suggests', () => {
    localStorage.setItem('webmail_usernames', JSON.stringify(['alice']));
    purgeSignedOutData();
    expect(localStorage.getItem('webmail_usernames')).toBe(JSON.stringify(['alice']));
  });

  it('keeps the local store\'s own keys for a sign-out the app decided on', () => {
    localStorage.setItem('bulwark-offline-accounts', '["alice"]');
    localStorage.setItem('notification-center', JSON.stringify([{ id: '1', time: 1, level: 'info', title: 'x', body: '', read: false }]));
    purgeSignedOutData({ keepLocalStore: true });
    expect(localStorage.getItem('bulwark-offline-accounts')).toBe('["alice"]');
    expect(localStorage.getItem('notification-center')).toBeNull();
  });
});
