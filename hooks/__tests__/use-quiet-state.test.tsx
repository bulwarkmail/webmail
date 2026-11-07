import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useQuietState } from '../use-quiet-state';

// Resets that hand a state the value it already has must not draw the
// component again: right after a commit React would call it once more.

describe('useQuietState', () => {
  it('draws nothing for the value it already has, also from an updater', () => {
    let renders = 0;
    const { result } = renderHook(() => { renders++; return useQuietState<string | null>(null); });
    const before = renders;
    act(() => { result.current[1](null); });
    act(() => { result.current[1]((previous) => previous); });
    expect(renders).toBe(before);
  });

  it('still takes a new value, directly and from an updater', () => {
    const { result } = renderHook(() => useQuietState(1));
    act(() => { result.current[1](2); });
    expect(result.current[0]).toBe(2);
    act(() => { result.current[1]((previous) => previous + 1); });
    expect(result.current[0]).toBe(3);
    // Two updates in one go build on each other, as with useState.
    act(() => { result.current[1]((previous) => previous + 1); result.current[1]((previous) => previous + 1); });
    expect(result.current[0]).toBe(5);
  });
});
