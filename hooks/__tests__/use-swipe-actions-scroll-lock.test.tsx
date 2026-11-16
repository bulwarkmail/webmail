import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useSwipeActions } from "@/hooks/use-swipe-actions";

function Row({ enabled = true }: { enabled?: boolean }) {
  const { swipeHandlers, offsetX } = useSwipeActions({
    enabled,
    hasLeft: true,
    hasRight: true,
    onCommit: vi.fn(),
  });
  return (
    <div data-testid="row" data-offset={offsetX} style={{ touchAction: "pan-y" }} {...swipeHandlers}>
      row
    </div>
  );
}

const at = (x: number, y: number) => ({ touches: [{ clientX: x, clientY: y }] });

function setup(enabled = true) {
  render(<Row enabled={enabled} />);
  const row = screen.getByTestId("row");
  fireEvent.touchStart(row, at(100, 100));
  return row;
}

describe("useSwipeActions scroll lock", () => {
  it("keeps the list still while a row is being swiped, even when the finger drifts vertically", () => {
    const row = setup();
    expect(fireEvent.touchMove(row, at(130, 104))).toBe(false);
    expect(fireEvent.touchMove(row, at(170, 140))).toBe(false);
    expect(Number(row.dataset.offset)).toBeGreaterThan(0);
  });

  it("holds the list still while a clearly horizontal drag is still building up", () => {
    const row = setup();
    expect(fireEvent.touchMove(row, at(108, 101))).toBe(false);
  });

  it("lets a vertical drag scroll the list", () => {
    const row = setup();
    expect(fireEvent.touchMove(row, at(102, 108))).toBe(true);
    expect(fireEvent.touchMove(row, at(104, 140))).toBe(true);
    expect(fireEvent.touchMove(row, at(160, 150))).toBe(true);
    expect(Number(row.dataset.offset)).toBe(0);
  });

  it("does not move the row once the browser has already started scrolling", () => {
    const row = setup();
    fireEvent.touchMove(row, { ...at(130, 110), cancelable: false });
    fireEvent.touchMove(row, at(170, 115));
    expect(Number(row.dataset.offset)).toBe(0);
  });

  it("never blocks scrolling when swiping is off", () => {
    const row = setup(false);
    expect(fireEvent.touchMove(row, at(130, 104))).toBe(true);
  });
});
