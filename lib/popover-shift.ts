/**
 * How far a popover has to move sideways to stay `margin` px inside `bounds`.
 * When it is wider than the bounds its start edge wins, so the first entries
 * stay reachable.
 */
export function popoverShift(
  popover: { left: number; right: number },
  bounds: { left: number; right: number },
  margin = 8,
): number {
  const overEnd = popover.right - (bounds.right - margin);
  const shift = overEnd > 0 ? -overEnd : 0;
  const overStart = bounds.left + margin - (popover.left + shift);
  return overStart > 0 ? shift + overStart : shift;
}
