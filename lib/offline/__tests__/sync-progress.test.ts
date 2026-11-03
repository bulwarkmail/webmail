import { describe, expect, it } from 'vitest';
import { minutesLeft, nextProgress, progressWorthShowing } from '../sync-progress';

const event = (phase: string, done: number, total: number | null) => ({ area: 'mail', phase, done, total });

describe('the time left', () => {
  it('says nothing until it has seen enough', () => {
    const start = nextProgress(undefined, event('bodies', 0, 1000), 0);
    expect(minutesLeft(start)).toBeNull();
    expect(minutesLeft(nextProgress(start, event('bodies', 100, 1000), 1_000))).toBeNull();
  });

  it('works from the rate of this phase', () => {
    const start = nextProgress(undefined, event('bodies', 0, 6000), 0);
    // 100 a second: 59 s left rounds up.
    expect(minutesLeft(nextProgress(start, event('bodies', 100, 6000), 1_000))).toBeNull();
    expect(minutesLeft(nextProgress(start, event('bodies', 600, 6000), 6_000))).toBe(1);
  });

  it('while listing, counts the bodies that come after', () => {
    const start = nextProgress(undefined, event('list', 0, 50_000), 0);
    const left = minutesLeft(nextProgress(start, event('list', 7_000, 50_000), 5_000));
    // Bench rig: 35 s to list, about 7 minutes in all.
    expect(left).toBeGreaterThanOrEqual(5);
    expect(left).toBeLessThanOrEqual(10);
  });

  it('starts over with each phase', () => {
    const list = nextProgress(undefined, event('list', 1000, 1000), 0);
    const bodies = nextProgress(list, event('bodies', 10, 1000), 60_000);
    expect(bodies.startedAt).toBe(60_000);
    expect(bodies.startedDone).toBe(10);
  });

  it('starts the sample over after a gap: time asleep isn\'t the rate', () => {
    const start = nextProgress(undefined, event('bodies', 0, 10_000), 0);
    const before = nextProgress(start, event('bodies', 100, 10_000), 10_000);
    const after = nextProgress(before, event('bodies', 200, 10_000), 10_000 + 3_600_000);
    expect(after.startedAt).toBe(10_000 + 3_600_000);
    expect(after.startedDone).toBe(200);
    expect(minutesLeft(after)).toBeNull();
  });

  it('has no time without a total, or when done', () => {
    const open = nextProgress(undefined, event('list', 0, null), 0);
    expect(minutesLeft(nextProgress(open, event('list', 500, null), 10_000))).toBeNull();
    const done = nextProgress(undefined, event('bodies', 0, 100), 0);
    expect(minutesLeft(nextProgress(done, event('bodies', 100, 100), 10_000))).toBeNull();
  });
});

describe('what is worth a line', () => {
  it('a big job or an unknown one, not a few new messages', () => {
    expect(progressWorthShowing(undefined)).toBe(false);
    expect(progressWorthShowing(nextProgress(undefined, event('bodies', 1, 3), 0))).toBe(false);
    expect(progressWorthShowing(nextProgress(undefined, event('bodies', 1, 500), 0))).toBe(true);
    expect(progressWorthShowing(nextProgress(undefined, event('list', 500, null), 0))).toBe(true);
  });
});
