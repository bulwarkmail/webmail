/**
 * The composer's attachment chips in the order they're shown: failed first,
 * then still uploading, then the rest, each group in the order added. The
 * list scrolls past about two rows, so the files that need an eye on them
 * are the ones always in view. `index` is the place in the composer's list.
 */
export function attachmentsForDisplay<T extends { error?: unknown; uploading?: boolean }>(
  attachments: readonly T[],
): Array<{ att: T; index: number }> {
  const rank = (att: T) => (att.error ? 0 : att.uploading ? 1 : 2);
  return attachments
    .map((att, index) => ({ att, index }))
    .sort((a, b) => rank(a.att) - rank(b.att) || a.index - b.index);
}
