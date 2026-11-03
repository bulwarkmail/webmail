import type { Virtualizer } from '@tanstack/react-virtual';

/**
 * A virtualizer's measureElement with sub-pixel row heights that ignores a row
 * measuring 0 because its list is hidden. A Pro tab in the background is
 * display:none and its rows report no height: taken at face value the list
 * collapses, and coming back it grows row by row and scrolls away from where
 * it was. No visible row is 0 high, so the known size stands then.
 */
export function measureVisibleRow<TItem extends Element>(
  element: TItem,
  entry: ResizeObserverEntry | undefined,
  instance: Virtualizer<HTMLDivElement, TItem>,
): number {
  const size = entry?.borderBoxSize?.[0]?.blockSize ?? element.getBoundingClientRect().height;
  if (size > 0) return size;
  return instance.measurementsCache[instance.indexFromElement(element)]?.size ?? size;
}
