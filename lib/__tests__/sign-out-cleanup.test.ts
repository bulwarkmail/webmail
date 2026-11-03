import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/plugin-storage', () => ({
  fileStorage: { clearFiles: vi.fn(async () => {}) },
}));

import { fileStorage } from '@/lib/plugin-storage';
import { broadcastSignOut, onSignedOutElsewhere, purgeSignedOutData } from '@/lib/sign-out-cleanup';
import { handOffFiles, pendingHandoffs } from '@/lib/launch-handoff';

// A full sign-out left search history, open tabs (with subjects), Files
// favourites and staged attachment bytes behind for the next person at the
// computer, and other tabs kept showing the signed-out accounts' mail.

beforeEach(() => localStorage.clear());

describe('purgeSignedOutData', () => {
  it('forgets files and links on their way into an account', () => {
    handOffFiles([new File(['x'], 'a.ics')], 'calendar');
    expect(pendingHandoffs()).toHaveLength(1);
    purgeSignedOutData();
    expect(pendingHandoffs()).toHaveLength(0);
  });

  it("removes the accounts' leftovers and keeps device preferences", () => {
    for (const key of [
      'email-snapshot', 'pro-tabs', 'search-history-storage', 'calendar-storage',
      'files-favorites', 'files-recent-files', 'files-path-stack', 'bulwark-delegate-names',
      'bulwark-offline-accounts', 'bulwark-offline-choices', 'bulwark-offline-health',
      'settings-storage', 'theme-storage', 'locale-storage', 'template-storage', 'files-view-mode',
    ]) localStorage.setItem(key, 'x');

    purgeSignedOutData();

    expect(Object.keys(localStorage).sort()).toEqual([
      'files-view-mode', 'locale-storage', 'settings-storage', 'template-storage', 'theme-storage',
    ]);
    expect(fileStorage.clearFiles).toHaveBeenCalled();
  });
});

describe('cross-tab sign-out', () => {
  let stop: (() => void) | null = null;
  afterEach(() => stop?.());

  it('reaches listeners through a storage event and leaves no key behind', () => {
    const seen = vi.fn();
    stop = onSignedOutElsewhere(seen);

    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    broadcastSignOut();
    const [key, value] = setItem.mock.calls[0];
    setItem.mockRestore();
    expect(localStorage.getItem(key)).toBeNull();

    // What another tab receives.
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }));
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: null }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'settings-storage', newValue: '{}' }));
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
