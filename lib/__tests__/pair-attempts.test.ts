// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginPairStepUp,
  clearPairStepUpFailures,
  isPairStepUpLocked,
  pairAttemptKey,
  recordPairStepUpFailure,
  settlePairStepUp,
} from '@/lib/auth/pair-attempts';

// Failed password step-ups for "Link mobile app": five per mail account
// within fifteen minutes and twenty a day, then the account is locked out of
// the step-up until the window (or the day) runs out.

const OWNER = '0:alice@example.org';
const T0 = 1_800_000_000_000;
const WINDOW_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).__bulwarkPairAttempts;
});

describe('pair step-up attempts', () => {
  it('locks after five failures', () => {
    for (let i = 0; i < 4; i++) recordPairStepUpFailure(OWNER, T0 + i);
    expect(isPairStepUpLocked(OWNER, T0 + 10)).toBe(false);
    recordPairStepUpFailure(OWNER, T0 + 5);
    expect(isPairStepUpLocked(OWNER, T0 + 10)).toBe(true);
  });

  it('unlocks when the fifteen-minute window has passed', () => {
    for (let i = 0; i < 5; i++) recordPairStepUpFailure(OWNER, T0);
    expect(isPairStepUpLocked(OWNER, T0 + WINDOW_MS - 1)).toBe(true);
    expect(isPairStepUpLocked(OWNER, T0 + WINDOW_MS)).toBe(false);
    // A failure after the window starts a new count.
    recordPairStepUpFailure(OWNER, T0 + WINDOW_MS);
    expect(isPairStepUpLocked(OWNER, T0 + WINDOW_MS + 1)).toBe(false);
  });

  it('counts the window from the first failure, not the last', () => {
    recordPairStepUpFailure(OWNER, T0);
    for (let i = 0; i < 4; i++) recordPairStepUpFailure(OWNER, T0 + WINDOW_MS - 10 + i);
    expect(isPairStepUpLocked(OWNER, T0 + WINDOW_MS - 1)).toBe(true);
    expect(isPairStepUpLocked(OWNER, T0 + WINDOW_MS)).toBe(false);
  });

  it('keeps accounts apart', () => {
    for (let i = 0; i < 5; i++) recordPairStepUpFailure(OWNER, T0);
    expect(isPairStepUpLocked('1:alice@example.org', T0)).toBe(false);
    expect(isPairStepUpLocked('0:bob@example.org', T0)).toBe(false);
  });

  it('clears the count after a successful step-up', () => {
    for (let i = 0; i < 5; i++) recordPairStepUpFailure(OWNER, T0);
    clearPairStepUpFailures(OWNER);
    expect(isPairStepUpLocked(OWNER, T0)).toBe(false);
  });

  it('drops entries whose day ran out, so the map stays bounded', () => {
    recordPairStepUpFailure('0:a@example.org', T0);
    recordPairStepUpFailure('0:b@example.org', T0);
    recordPairStepUpFailure('0:c@example.org', T0 + DAY_MS);
    const map = (globalThis as unknown as { __bulwarkPairAttempts: Map<string, unknown> }).__bulwarkPairAttempts;
    expect([...map.keys()]).toEqual(['0:c@example.org']);
  });

  it("caps failures per day well below the mail server ban", () => {
    // 5 per window, window after window: the 21st attempt of the day is refused.
    let now = T0;
    for (let i = 0; i < 20; i++) {
      if (i > 0 && i % 5 === 0) now += WINDOW_MS;
      expect(beginPairStepUp(OWNER, now)).toBe(true);
      settlePairStepUp(OWNER, 'wrong_credential');
    }
    now += WINDOW_MS;
    expect(isPairStepUpLocked(OWNER, now)).toBe(true);
    expect(isPairStepUpLocked(OWNER, T0 + DAY_MS)).toBe(false);
  });

  it('keys an account by server and login name, whatever the cookie slot', () => {
    expect(pairAttemptKey('https://Mail.Example.org/', ' Alice@Example.org')).toBe(pairAttemptKey('https://mail.example.org', 'alice@example.org'));
    expect(pairAttemptKey('https://mail.example.org', 'alice@example.org')).not.toBe(pairAttemptKey('https://other.example', 'alice@example.org'));
  });
});
