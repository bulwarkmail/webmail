/**
 * Only list rows clip tags to one flex line. Badges wrap below the suffix whole.
 * Match the badge's inherited line height plus padding/borders, or its 1rem dot.
 * :has also follows Show colour names, which renders a badge in dot mode.
 * The zero-width strut fills the first line when even its first badge cannot
 * fit. Its negative end margin cancels the leading gap, including in RTL.
 */
export const ROW_TAG_GROUP_CLASS =
  "flex min-w-0 shrink flex-wrap content-start items-center gap-1 overflow-hidden text-[0.6875rem] h-[calc(1lh+0.25rem+2px)] has-[[data-tag-dot]]:h-4 before:content-[''] before:w-0 before:h-full before:shrink-0 before:-me-1";
