/**
 * The sign-in page holds back the rest of the catalog and the page-wide hosts
 * the app behind it needs (lib/sign-in-hold.ts): until it is left, or a while
 * after it showed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { afterSignInPage, endSignInHold, onSignInPage, resetSignInHold, SIGN_IN_HOLD_MS } from '@/lib/sign-in-hold';

beforeEach(() => {
  vi.useFakeTimers();
  resetSignInHold();
});
afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

describe('onSignInPage', () => {
  it('knows the sign-in page with and without a locale or base path', () => {
    for (const path of ['/login', '/de/login', '/login/', '/zh-TW/login']) expect(onSignInPage(path, ''), path).toBe(true);
    for (const path of ['/webmail/login', '/webmail/en/login/']) expect(onSignInPage(path, '/webmail'), path).toBe(true);
  });

  it('is not fooled by other pages that end in login', () => {
    for (const path of ['/', '/en', '/admin/login', '/en/admin/login', '/mail/folder/login', '/en/mail/folder/x/login', '/xx/login', '/mail/folder/inbox']) {
      expect(onSignInPage(path, ''), path).toBe(false);
    }
    expect(onSignInPage('/login', '/webmail')).toBe(false);
    expect(onSignInPage('/webmail/admin/login', '/webmail')).toBe(false);
  });
});

describe('afterSignInPage', () => {
  it('runs at once anywhere else', () => {
    const fn = vi.fn();
    afterSignInPage(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('waits on the sign-in page until it is left', () => {
    window.history.replaceState(null, '', '/en/login');
    const fn = vi.fn();
    afterSignInPage(fn);
    vi.advanceTimersByTime(500);
    expect(fn).not.toHaveBeenCalled();
    window.history.pushState(null, '', '/en');
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(SIGN_IN_HOLD_MS);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs on a sign-in page that stays up once the hold is over', () => {
    window.history.replaceState(null, '', '/login');
    const fn = vi.fn();
    afterSignInPage(fn);
    vi.advanceTimersByTime(SIGN_IN_HOLD_MS - 200);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('can be cancelled', () => {
    window.history.replaceState(null, '', '/login');
    const fn = vi.fn();
    afterSignInPage(fn)();
    vi.advanceTimersByTime(SIGN_IN_HOLD_MS * 2);
    expect(fn).not.toHaveBeenCalled();
  });

  it('stops waiting once the sign-in leaves the page', () => {
    window.history.replaceState(null, '', '/en/login');
    const fn = vi.fn();
    afterSignInPage(fn);
    vi.advanceTimersByTime(300);
    expect(fn).not.toHaveBeenCalled();
    endSignInHold();
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(1);
    const later = vi.fn();
    afterSignInPage(later);
    expect(later).toHaveBeenCalledTimes(1);
  });
});
