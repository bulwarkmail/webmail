import { act, renderHook } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useSwipeActions, SWIPE_COMMIT_DISTANCE } from "@/hooks/use-swipe-actions";

/** Build a minimal React.TouchEvent-like object with one touch point. */
function touch(x: number, y: number) {
  return { touches: [{ clientX: x, clientY: y }] } as unknown as React.TouchEvent;
}

function drag(result: { current: ReturnType<typeof useSwipeActions> }, from: number, to: number, y = 0) {
  act(() => result.current.swipeHandlers.onTouchStart(touch(from, y)));
  act(() => result.current.swipeHandlers.onTouchMove(touch(to, y)));
  act(() => result.current.swipeHandlers.onTouchEnd());
}

describe("useSwipeActions", () => {
  it("commits the right action when dragged right past the threshold", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useSwipeActions({ enabled: true, hasLeft: true, hasRight: true, onCommit }),
    );
    drag(result, 0, SWIPE_COMMIT_DISTANCE + 20);
    expect(onCommit).toHaveBeenCalledWith("right");
  });

  it("commits the left action when dragged left past the threshold", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useSwipeActions({ enabled: true, hasLeft: true, hasRight: true, onCommit }),
    );
    drag(result, 200, 200 - (SWIPE_COMMIT_DISTANCE + 20));
    expect(onCommit).toHaveBeenCalledWith("left");
  });

  it("does not commit a short drag", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useSwipeActions({ enabled: true, hasLeft: true, hasRight: true, onCommit }),
    );
    drag(result, 0, 30);
    expect(onCommit).not.toHaveBeenCalled();
    expect(result.current.offsetX).toBe(0);
  });

  it("does not commit toward a side with no action", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useSwipeActions({ enabled: true, hasLeft: false, hasRight: true, onCommit }),
    );
    // Big drag to the LEFT, but hasLeft is false.
    drag(result, 200, 200 - (SWIPE_COMMIT_DISTANCE + 40));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("ignores a mostly-vertical drag (list scroll)", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useSwipeActions({ enabled: true, hasLeft: true, hasRight: true, onCommit }),
    );
    act(() => result.current.swipeHandlers.onTouchStart(touch(0, 0)));
    act(() => result.current.swipeHandlers.onTouchMove(touch(8, 60)));
    act(() => result.current.swipeHandlers.onTouchEnd());
    expect(onCommit).not.toHaveBeenCalled();
    expect(result.current.offsetX).toBe(0);
  });

  it("reports a tap to consume after a committed swipe", () => {
    const onCommit = vi.fn();
    const { result } = renderHook(() =>
      useSwipeActions({ enabled: true, hasLeft: true, hasRight: true, onCommit }),
    );
    drag(result, 0, SWIPE_COMMIT_DISTANCE + 20);
    expect(result.current.consumeTap()).toBe(true);
    // Only once.
    expect(result.current.consumeTap()).toBe(false);
  });
});
