/** One toolbar item as measured with every item shown. */
export interface MeasuredToolbarItem {
  /** Rendered width; 0 when CSS already hides it (e.g. on mobile). */
  width: number;
  /** The flex group it sits in, to give back that group's gap when hidden. */
  group: string;
}

/**
 * The order the reader's toolbar gives way in, as indexes into `priorities`.
 * Labels go before any button (the caller measures without them first). Then
 * the optional buttons, least important (highest number) first. The ones in
 * `required` (Reply, Reply all, Forward, Archive, Move; Delete never takes
 * part) go only when the toolbar still doesn't fit without all the optional
 * ones, in the order `required` lists them: a reader too narrow for six
 * icons.
 */
export function toolbarHideOrder(priorities: number[], required: readonly number[]): number[] {
  const indexes = priorities.map((_, i) => i);
  const optional = indexes
    .filter((i) => !required.includes(priorities[i]))
    .sort((a, b) => priorities[b] - priorities[a]);
  const last = indexes
    .filter((i) => required.includes(priorities[i]))
    .sort((a, b) => required.indexOf(priorities[a]) - required.indexOf(priorities[b]));
  return [...optional, ...last];
}

/**
 * Which items to hide so the toolbar fits, decided from one measuring pass.
 * `items` come least important first; they are hidden in that order until
 * `overflow` (content width minus available width, in px) is used up. A
 * hidden item frees its width plus one gap of its group, unless it was the
 * last visible item there. Returns the indexes into `items` to hide.
 *
 * The toolbar used to hide an item and re-read the layout after each one,
 * which forced a layout per item on every open.
 */
export function itemsToHide(
  items: MeasuredToolbarItem[],
  overflow: number,
  gapOf: Record<string, number>,
): number[] {
  return planToHide(items, overflow, gapOf).hide;
}

/**
 * itemsToHide, and whether hiding them is enough: `fits` is false when even
 * all of `items` gone leave the toolbar too wide, so the caller can drop the
 * main buttons' labels first instead (mail-p2-15).
 */
export function planToHide(
  items: MeasuredToolbarItem[],
  overflow: number,
  gapOf: Record<string, number>,
): { hide: number[]; fits: boolean } {
  const visible: Record<string, number> = {};
  for (const item of items) if (item.width > 0) visible[item.group] = (visible[item.group] ?? 0) + 1;
  const hide: number[] = [];
  let remaining = overflow;
  items.forEach((item, i) => {
    if (remaining <= 0 || item.width === 0) return;
    const left = visible[item.group] ?? 1;
    remaining -= item.width + (left > 1 ? (gapOf[item.group] ?? 0) : 0);
    visible[item.group] = left - 1;
    hide.push(i);
  });
  return { hide, fits: remaining <= 0 };
}
