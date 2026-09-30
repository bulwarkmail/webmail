import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { Suspense, createElement } from 'react';

const liteState = vi.hoisted(() => ({ IS_LITE: false }));

vi.mock('@/lib/lite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lite')>();
  return {
    ...actual,
    get IS_LITE() {
      return liteState.IS_LITE;
    },
  };
});

import { useLiteLinkSegments } from '@/hooks/use-lite-link-segments';
import { LITE_PENDING_PATH_KEY } from '@/lib/lite';

describe('useLiteLinkSegments', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, '', '/en/mail/thread/t1?open=1');
  });

  it('is the identity outside the static build', () => {
    liteState.IS_LITE = false;
    expect(renderHook(() => useLiteLinkSegments('mail', ['folder', 'inbox'])).result.current).toEqual(['folder', 'inbox']);
    // `undefined` stays undefined: the surfaces use it to fall back to the Pro handoff.
    expect(renderHook(() => useLiteLinkSegments('mail', undefined)).result.current).toBeUndefined();
  });

  it('reads the segments from the address bar in the static build', () => {
    liteState.IS_LITE = true;
    const { result } = renderHook(() => useLiteLinkSegments('mail', []));
    expect(result.current).toEqual(['thread', 't1']);
    expect(window.location.search).toBe('?open=1');
  });

  it('yields no segments for a different surface', () => {
    liteState.IS_LITE = true;
    expect(renderHook(() => useLiteLinkSegments('calendar', [])).result.current).toEqual([]);
  });

  it('replays a parked deep link and restores the URL bar', () => {
    liteState.IS_LITE = true;
    window.history.replaceState({}, '', '/en/calendar/');
    sessionStorage.setItem(LITE_PENDING_PATH_KEY, '/en/calendar/week/2026-09-17?view=1');

    const { result } = renderHook(() => useLiteLinkSegments('calendar', []));

    expect(result.current).toEqual(['week', '2026-09-17']);
    expect(`${window.location.pathname}${window.location.search}`).toBe('/en/calendar/week/2026-09-17?view=1');
    expect(sessionStorage.getItem(LITE_PENDING_PATH_KEY)).toBeNull();
  });

  it('survives a discarded first render (a sibling suspending on useSearchParams)', async () => {
    liteState.IS_LITE = true;
    window.history.replaceState({}, '', '/en/contacts/');
    sessionStorage.setItem(LITE_PENDING_PATH_KEY, '/en/contacts/c1/edit');

    // React throws the first render attempt away when something below the
    // Suspense boundary suspends, then renders again from scratch. The hook's
    // state initializer runs twice; the parked link must still be there.
    let suspended = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: Array<string[] | undefined> = [];
    function Surface() {
      const segments = useLiteLinkSegments('contacts', []);
      seen.push(segments);
      if (!suspended) {
        suspended = true;
        throw gate;
      }
      return createElement('span', { 'data-testid': 'segments' }, JSON.stringify(segments));
    }
    render(createElement(Suspense, { fallback: null }, createElement(Surface)));
    release();
    await waitFor(() => expect(screen.getByTestId('segments').textContent).toBe('["c1","edit"]'));
    // The initializer ran again for the retry and still found the parked link
    // (consuming it in the first attempt would have left the retry with []).
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((s) => JSON.stringify(s) === '["c1","edit"]')).toBe(true);
    expect(`${window.location.pathname}`).toBe('/en/contacts/c1/edit');
    expect(sessionStorage.getItem(LITE_PENDING_PATH_KEY)).toBeNull();
  });

  it('leaves a link parked for another surface untouched', () => {
    liteState.IS_LITE = true;
    window.history.replaceState({}, '', '/en/mail/');
    sessionStorage.setItem(LITE_PENDING_PATH_KEY, '/en/files/folder/x');

    expect(renderHook(() => useLiteLinkSegments('mail', [])).result.current).toEqual([]);
    expect(sessionStorage.getItem(LITE_PENDING_PATH_KEY)).toBe('/en/files/folder/x');
    expect(window.location.pathname).toBe('/en/mail/');
  });

  it('is stable across re-renders (read once on mount)', () => {
    liteState.IS_LITE = true;
    const { result, rerender } = renderHook(() => useLiteLinkSegments('mail', []));
    const first = result.current;
    window.history.replaceState({}, '', '/en/mail/thread/t2');
    rerender();
    expect(result.current).toBe(first);
  });
});
