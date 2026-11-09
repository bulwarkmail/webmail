import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastActivity, noteActivity, watchIdle } from '../idle';

const MINUTE = 60_000;

describe('time without use', () => {
  let stop: () => void = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  function watch(minutes: number) {
    const onIdle = vi.fn();
    stop = watchIdle({ timeoutMs: () => minutes * MINUTE, onIdle });
    return onIdle;
  }

  it('locks once the time has passed with nothing happening', () => {
    const onIdle = watch(5);
    vi.advanceTimersByTime(5 * MINUTE - 20_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('using this window starts it over', () => {
    const onIdle = watch(5);
    vi.advanceTimersByTime(4 * MINUTE);
    window.dispatchEvent(new KeyboardEvent('keydown'));
    vi.advanceTimersByTime(4 * MINUTE);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('using another window or tab counts too', () => {
    const onIdle = watch(5);
    vi.advanceTimersByTime(4 * MINUTE);
    // Another tab writes the shared key.
    noteActivity(Date.now());
    vi.advanceTimersByTime(4 * MINUTE);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2 * MINUTE);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('tells the other tabs about use here, but not on every mouse move', () => {
    watch(5);
    const before = lastActivity();
    vi.advanceTimersByTime(1000);
    window.dispatchEvent(new Event('pointermove'));
    expect(lastActivity()).toBe(before);
    vi.advanceTimersByTime(5000);
    window.dispatchEvent(new Event('pointermove'));
    expect(lastActivity()).toBe(Date.now());
  });

  it('coming back after the time counts as too late, not as use', () => {
    const onIdle = watch(5);
    // The machine slept: no timer ran, and the clock jumped.
    vi.setSystemTime(Date.now() + 6 * MINUTE);
    window.dispatchEvent(new KeyboardEvent('keydown'));
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('a changed timeout applies at once', () => {
    let minutes = 60;
    const onIdle = vi.fn();
    stop = watchIdle({ timeoutMs: () => minutes * MINUTE, onIdle });
    vi.advanceTimersByTime(2 * MINUTE);
    expect(onIdle).not.toHaveBeenCalled();
    minutes = 1;
    vi.advanceTimersByTime(10_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('fires once and stops listening', () => {
    const onIdle = watch(1);
    vi.advanceTimersByTime(2 * MINUTE);
    vi.advanceTimersByTime(10 * MINUTE);
    window.dispatchEvent(new KeyboardEvent('keydown'));
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});
