import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { clearCachedData } from '../clear-cached-data';

describe('clearCachedData', () => {
  let reload: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    localStorage.clear();
    reload = vi.fn();
    originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('clears re-fetchable caches but keeps accounts, sessions and prefs', () => {
    localStorage.setItem('contact-storage', '1');
    localStorage.setItem('calendar-storage', '1');
    localStorage.setItem('identity-storage', '1');
    localStorage.setItem('calendar-notification-storage', '1');
    // Must survive — losing these is exactly the pain we're avoiding.
    localStorage.setItem('account-registry', 'accounts');
    localStorage.setItem('auth-storage', 'session');
    localStorage.setItem('settings-storage', 'prefs');
    localStorage.setItem('template-storage', 'my templates');

    clearCachedData();

    expect(localStorage.getItem('contact-storage')).toBeNull();
    expect(localStorage.getItem('calendar-storage')).toBeNull();
    expect(localStorage.getItem('identity-storage')).toBeNull();
    expect(localStorage.getItem('calendar-notification-storage')).toBeNull();

    expect(localStorage.getItem('account-registry')).toBe('accounts');
    expect(localStorage.getItem('auth-storage')).toBe('session');
    expect(localStorage.getItem('settings-storage')).toBe('prefs');
    expect(localStorage.getItem('template-storage')).toBe('my templates');
  });

  it('reloads so data is re-fetched fresh', () => {
    clearCachedData();
    expect(reload).toHaveBeenCalledOnce();
  });
});
