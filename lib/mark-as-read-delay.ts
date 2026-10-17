// Automatic "mark as read" timing for surfaces that mark a message read
// because it was shown. Used by thread expansion and Pro folder rows; same
// rules as the reading pane (`mail-app.tsx`) and `useMarkReadWhenShown`.
//
// `markAsReadDelay` is the user's setting in milliseconds: -1 = never,
// 0 = instantly, anything else = after that many milliseconds. Surfaces that
// skipped the setting marked mail read even with "Never" selected.

const noop = () => {};

/**
 * Runs `mark` according to `markAsReadDelay` and returns a function that
 * cancels a still-pending delayed mark. "Never" (any negative value) does
 * nothing; 0 runs `mark` synchronously.
 */
export function scheduleAutoMarkAsRead(markAsReadDelay: number, mark: () => void): () => void {
  if (markAsReadDelay < 0) return noop;
  if (markAsReadDelay === 0) {
    mark();
    return noop;
  }
  const timeout = setTimeout(mark, markAsReadDelay);
  return () => clearTimeout(timeout);
}
