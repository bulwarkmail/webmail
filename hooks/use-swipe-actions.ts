"use client";

import { useCallback, useRef, useState } from "react";

export type SwipeSide = "left" | "right";

/** Horizontal travel before a touch is claimed as a swipe rather than a tap/scroll. */
const ACTIVATION = 12;
/** Release past this offset (px) fires the action. */
export const SWIPE_COMMIT_DISTANCE = 96;
/** The row stops following the finger past this distance. */
const MAX_OFFSET = 140;

/**
 * Dampen travel past the commit distance so the row feels elastic instead of
 * sliding off under the finger.
 */
function resist(dx: number): number {
  const sign = Math.sign(dx);
  const abs = Math.abs(dx);
  if (abs <= SWIPE_COMMIT_DISTANCE) return dx;
  return sign * Math.min(MAX_OFFSET, SWIPE_COMMIT_DISTANCE + (abs - SWIPE_COMMIT_DISTANCE) * 0.3);
}

export interface UseSwipeActionsOptions {
  /** Off on desktop / when neither side has an action. */
  enabled?: boolean;
  /** Whether a left-swipe (finger moves left) has an action configured. */
  hasLeft: boolean;
  /** Whether a right-swipe (finger moves right) has an action configured. */
  hasRight: boolean;
  /** Fired once on release when the row is dragged past the commit distance. */
  onCommit: (side: SwipeSide) => void;
}

export interface UseSwipeActionsResult {
  swipeHandlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: () => void;
    onTouchCancel: () => void;
  };
  /** Current horizontal offset of the row, in px. 0 when idle. */
  offsetX: number;
  /** The side currently being revealed, or null when idle. */
  side: SwipeSide | null;
  /** True once the finger is past the commit distance (release would fire). */
  willCommit: boolean;
  /** True for a beat after a committed swipe so the caller can suppress the tap. */
  consumeTap: () => boolean;
}

/**
 * Gmail-style horizontal swipe actions for a list row. Pair with
 * `touch-action: pan-y` on the swiped element so vertical scrolling stays
 * native while horizontal drags are handled here (no preventDefault needed).
 *
 * A right-swipe (finger moves right, `offsetX > 0`) maps to the caller's
 * "right" action; a left-swipe maps to "left". A side with no configured
 * action resists hard so the row barely moves.
 */
export function useSwipeActions({
  enabled = true,
  hasLeft,
  hasRight,
  onCommit,
}: UseSwipeActionsOptions): UseSwipeActionsResult {
  const start = useRef<{ x: number; y: number } | null>(null);
  const claimed = useRef(false);
  const justSwiped = useRef(false);
  const [offsetX, setOffsetX] = useState(0);

  const canGo = useCallback(
    (dx: number) => (dx < 0 ? hasLeft : hasRight),
    [hasLeft, hasRight],
  );

  const reset = useCallback(() => {
    start.current = null;
    claimed.current = false;
    setOffsetX(0);
  }, []);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!enabled) return;
      const t = e.touches[0];
      start.current = { x: t.clientX, y: t.clientY };
      claimed.current = false;
    },
    [enabled],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!start.current) return;
      const t = e.touches[0];
      const dx = t.clientX - start.current.x;
      const dy = t.clientY - start.current.y;

      if (!claimed.current) {
        if (Math.abs(dx) > ACTIVATION && Math.abs(dx) > Math.abs(dy)) {
          claimed.current = true;
        } else if (Math.abs(dy) > ACTIVATION) {
          // Vertical scroll — hand it back to the list.
          start.current = null;
          return;
        } else {
          return;
        }
      }
      // A swipe toward a side with no action resists to a token nudge.
      setOffsetX(canGo(dx) ? resist(dx) : dx * 0.15);
    },
    [canGo],
  );

  const onTouchEnd = useCallback(() => {
    if (
      claimed.current &&
      Math.abs(offsetX) >= SWIPE_COMMIT_DISTANCE &&
      canGo(offsetX)
    ) {
      justSwiped.current = true;
      onCommit(offsetX > 0 ? "right" : "left");
    } else if (claimed.current) {
      // A claimed-but-not-committed drag still swallows the tap that follows.
      justSwiped.current = true;
    }
    reset();
  }, [offsetX, canGo, onCommit, reset]);

  const consumeTap = useCallback(() => {
    if (justSwiped.current) {
      justSwiped.current = false;
      return true;
    }
    return false;
  }, []);

  return {
    swipeHandlers: {
      onTouchStart,
      onTouchMove,
      onTouchEnd,
      onTouchCancel: reset,
    },
    offsetX,
    side: offsetX === 0 ? null : offsetX > 0 ? "right" : "left",
    willCommit: Math.abs(offsetX) >= SWIPE_COMMIT_DISTANCE && canGo(offsetX),
    consumeTap,
  };
}
