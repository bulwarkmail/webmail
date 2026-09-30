"use client";

import { useEffect, useRef, useState } from 'react';
import { IS_LITE } from '@/lib/lite';
import { getPathPrefix } from '@/lib/browser-navigation';
import { clearPendingLitePath, liteSegmentsFromPath, peekPendingLitePath } from '@/lib/lite-link-segments';
import type { AppSurface } from '@/lib/deep-links';

/**
 * Route segments for a surface's deep link.
 *
 * Outside Lite this is the identity: the `[[...segments]]` page already passed
 * the segments Next parsed. In the static Lite build the prerendered params
 * are always empty, so the segments are read from the address bar instead -
 * once, on the first client render, which is when every surface consumes
 * them. A deep link the 404 shim parked (hosts without rewrites) is replayed
 * here as well, and the URL bar is put back to the link that was requested.
 *
 * Returns `undefined` only when the caller passed `undefined` outside Lite,
 * preserving the "no route segments, check the Pro handoff" signal.
 */
export function useLiteLinkSegments(surface: AppSurface, linkSegments?: string[]): string[] | undefined {
  const restoreUrl = useRef<string | null>(null);
  const [segments] = useState<string[] | undefined>(() => {
    if (!IS_LITE || typeof window === 'undefined') return linkSegments;
    const prefix = getPathPrefix();
    // Peek, don't consume: this initializer may run more than once when the
    // first render attempt is thrown away (a sibling suspending on
    // useSearchParams), and the parked link must still be there for the retry.
    const pending = peekPendingLitePath(surface, prefix);
    if (pending) {
      restoreUrl.current = pending;
      return liteSegmentsFromPath(pending, surface, prefix);
    }
    return liteSegmentsFromPath(window.location.pathname, surface, prefix);
  });

  // Consume the parked link and restore its URL in an effect, i.e. once this
  // render has committed. Next's router writes its own canonical URL (the
  // surface root it hydrated) from an insertion effect during hydration, which
  // would undo a replaceState made while rendering.
  useEffect(() => {
    const url = restoreUrl.current;
    if (!url) return;
    restoreUrl.current = null;
    clearPendingLitePath();
    try {
      window.history.replaceState(window.history.state, '', url);
    } catch {
      // A hardened browser may refuse; the segments still apply.
    }
  }, []);

  return segments;
}
