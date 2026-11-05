/**
 * Every message row reads a media query on every render (useSwipeRows). A
 * fresh window.matchMedia() per read made a search's result render on the
 * bench rig measurably slower: the page keeps one MediaQueryList per query,
 * whose `matches` follows the window by itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useMediaQuery } from '../use-media-query';

afterEach(() => vi.unstubAllGlobals());

function stubMatchMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const list = {
    matches: initial,
    media: '(pointer: coarse)',
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  };
  const matchMedia = vi.fn(() => list);
  vi.stubGlobal('matchMedia', matchMedia);
  return {
    matchMedia,
    change(matches: boolean) {
      list.matches = matches;
      for (const l of listeners) l();
    },
  };
}

describe('useMediaQuery', () => {
  it('asks the browser once per query, however often rows render', () => {
    const media = stubMatchMedia(false);
    const rows = Array.from({ length: 20 }, () => renderHook(() => useMediaQuery('(pointer: coarse)')));
    for (const row of rows) for (let i = 0; i < 3; i++) row.rerender();
    expect(media.matchMedia).toHaveBeenCalledTimes(1);
  });

  it('still follows the window when the query starts or stops matching', () => {
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery('(width < 40rem)'));
    expect(result.current).toBe(false);
    act(() => media.change(true));
    expect(result.current).toBe(true);
  });

  it('starts over when matchMedia itself is replaced', () => {
    stubMatchMedia(false);
    expect(renderHook(() => useMediaQuery('(hover: none)')).result.current).toBe(false);
    stubMatchMedia(true);
    expect(renderHook(() => useMediaQuery('(hover: none)')).result.current).toBe(true);
  });
});
