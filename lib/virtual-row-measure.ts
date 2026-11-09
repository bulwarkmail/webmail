import type { Virtualizer } from '@tanstack/react-virtual';

/**
 * A virtualizer's measureElement with sub-pixel row heights that ignores a row
 * measuring 0 because its list is hidden. A Pro tab in the background is
 * display:none and its rows report no height: taken at face value the list
 * collapses, and coming back it grows row by row and scrolls away from where
 * it was. No visible row is 0 high, so the known size stands then.
 *
 * A row whose height matches the guess it was placed with is kept at that
 * height. The virtualizer stores only sizes that differ from its guess, so
 * such a row went on following the guess, and the list's guesses change as
 * it measures other rows: a row with an attachment chip then moved to the
 * height of a row without one, and the row below covered its chips.
 */
export function measureVisibleRow<TItem extends Element>(
  element: TItem,
  entry: ResizeObserverEntry | undefined,
  instance: Virtualizer<HTMLDivElement, TItem>,
): number {
  const size = entry?.borderBoxSize?.[0]?.blockSize ?? element.getBoundingClientRect().height;
  const placed = instance.measurementsCache[instance.indexFromElement(element)];
  if (size > 0) {
    if (placed && placed.size === size && !instance.itemSizeCache.has(placed.key)) {
      instance.itemSizeCache.set(placed.key, size);
    }
    return size;
  }
  return placed?.size ?? size;
}
