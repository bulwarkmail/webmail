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

/**
 * Whether a popover that opens under its button fits the window's height: if not,
 * it opens above the button when there's more room there, and either way it gets a
 * height cap and scrolls. Null when it fits as it is.
 */
export function popoverFitHeight(
  popover: { top: number; height: number },
  trigger: { top: number },
  viewportHeight: number,
  margin = 10,
  gap = 4,
): { above: boolean; maxHeight: number } | null {
  if (popover.top + popover.height <= viewportHeight - margin) return null;
  const below = viewportHeight - margin - popover.top;
  const above = trigger.top - gap - margin;
  return above > below
    ? { above: true, maxHeight: Math.min(popover.height, above) }
    : { above: false, maxHeight: Math.max(0, below) };
}
