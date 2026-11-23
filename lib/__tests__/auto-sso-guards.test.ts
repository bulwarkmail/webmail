import { beforeEach, describe, expect, it } from 'vitest';
import {
  claimAutoSsoAttempt,
  consumeSignedOut,
  markSignedOut,
  SIGNED_OUT_WINDOW_MS,
  SSO_ATTEMPT_WINDOW_MS,
} from '../auto-sso-guards';

// #1819: both notes lived for the whole tab, so auto-SSO stopped working in it.

const T = 1_800_000_000_000;

beforeEach(() => sessionStorage.clear());

describe('the redirect loop guard', () => {
  it('lets the first attempt through and holds back a second one soon after', () => {
    expect(claimAutoSsoAttempt(T)).toBe(true);
    expect(claimAutoSsoAttempt(T + SSO_ATTEMPT_WINDOW_MS - 1)).toBe(false);
  });

  it('lets an attempt through once the last one is older than the window', () => {
    expect(claimAutoSsoAttempt(T)).toBe(true);
    expect(claimAutoSsoAttempt(T + SSO_ATTEMPT_WINDOW_MS)).toBe(true);
    // ...and that one holds back the next.
    expect(claimAutoSsoAttempt(T + SSO_ATTEMPT_WINDOW_MS + 1)).toBe(false);
  });

  it('ignores the note an earlier build left for good', () => {
    sessionStorage.setItem('sso_attempted', '1');
    expect(claimAutoSsoAttempt(T)).toBe(true);
  });
});

describe('the sign-out note', () => {
  it('counts once, right after the sign-out', () => {
    markSignedOut(T);
    expect(consumeSignedOut(T + 5_000)).toBe(true);
    expect(consumeSignedOut(T + 5_000)).toBe(false);
  });

  it('no longer counts on a visit long after the sign-out, and is gone after it', () => {
    markSignedOut(T);
    expect(consumeSignedOut(T + SIGNED_OUT_WINDOW_MS)).toBe(false);
    expect(sessionStorage.getItem('signed_out')).toBeNull();
  });

  it('ignores the note an earlier build left for good', () => {
    sessionStorage.setItem('signed_out', 'true');
    expect(consumeSignedOut(T)).toBe(false);
  });
});
