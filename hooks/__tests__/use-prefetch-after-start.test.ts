import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('usePrefetchAfterStart', () => {
  it('lets links on "/" prefetch after the timeout when the address never moves on', async () => {
    const { usePrefetchAfterStart, START_PREFETCH_TIMEOUT_MS } = await import('../use-prefetch-after-start');
    const { result } = renderHook(() => usePrefetchAfterStart('/'));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(START_PREFETCH_TIMEOUT_MS));
    expect(result.current).toBe(true);
  });

  it('lets links prefetch at once on any other page', async () => {
    const { usePrefetchAfterStart } = await import('../use-prefetch-after-start');
    const { result } = renderHook(() => usePrefetchAfterStart('/calendar'));
    expect(result.current).toBe(true);
  });
});
