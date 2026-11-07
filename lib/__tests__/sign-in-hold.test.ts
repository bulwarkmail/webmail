/**
 * The sign-in page holds back the rest of the catalog and the page-wide hosts
 * the app behind it needs (lib/sign-in-hold.ts): until it is left, or a while
 * after it showed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { afterSignInPage, onSignInPage, SIGN_IN_HOLD_MS } from '@/lib/sign-in-hold';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

describe('onSignInPage', () => {
  it('knows the sign-in page in every spelling', () => {
    for (const path of ['/login', '/de/login', '/webmail/en/login/', '/login/']) expect(onSignInPage(path), path).toBe(true);
    for (const path of ['/', '/en', '/mail/folder/login-help', '/admin/login/x', '/settings']) expect(onSignInPage(path), path).toBe(false);
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
});
