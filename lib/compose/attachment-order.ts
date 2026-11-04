/**
 * The composer's attachment chips in the order they're shown: failed first,
 * then the rest in the order added. A file still uploading keeps its place:
 * moved to the front, it jumped to the end once done and went out of sight
 * past the rows on screen (compose-p2-11). `index` is the place in the
 * composer's list.
 */
export function attachmentsForDisplay<T extends { error?: unknown; uploading?: boolean }>(
  attachments: readonly T[],
): Array<{ att: T; index: number }> {
  const rank = (att: T) => (att.error ? 0 : 1);
  return attachments
    .map((att, index) => ({ att, index }))
    .sort((a, b) => rank(a.att) - rank(b.att) || a.index - b.index);
}
