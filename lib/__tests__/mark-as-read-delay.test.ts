import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleAutoMarkAsRead } from '../mark-as-read-delay';

describe('scheduleAutoMarkAsRead', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never marks with "Never" (-1)', () => {
    const mark = vi.fn();
    scheduleAutoMarkAsRead(-1, mark);
    vi.advanceTimersByTime(60_000);
    expect(mark).not.toHaveBeenCalled();
  });

  it('marks synchronously with "Instantly" (0)', () => {
    const mark = vi.fn();
    scheduleAutoMarkAsRead(0, mark);
    expect(mark).toHaveBeenCalledTimes(1);
  });

  it('marks once the delay has passed', () => {
    const mark = vi.fn();
    scheduleAutoMarkAsRead(3000, mark);
    vi.advanceTimersByTime(2999);
    expect(mark).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(mark).toHaveBeenCalledTimes(1);
  });

  it('drops a pending delayed mark when cancelled', () => {
    const mark = vi.fn();
    const cancel = scheduleAutoMarkAsRead(3000, mark);
    vi.advanceTimersByTime(1000);
    cancel();
    vi.advanceTimersByTime(10_000);
    expect(mark).not.toHaveBeenCalled();
  });
});
