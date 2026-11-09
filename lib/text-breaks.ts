/**
 * Where a long address may wrap: after "@", "+", "-" and "_", and before a dot, as
 * printed addresses do. A browser on its own wraps such a string anywhere once it
 * doesn't fit, which leaves ragged two-letter lines in a narrow column.
 *
 * Returns the pieces; a line break opportunity (<wbr>) goes between each two.
 * Pieces are never shorter than MIN_PIECE characters: "a.b.c" stays whole. The
 * last few characters (".net") stay with the piece before them.
 */
const MIN_PIECE = 3;
const MAX_TAIL = 4;

export function addressBreakPieces(text: string): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const ch of text) {
    if (ch === '.' && current.length >= MIN_PIECE) {
      pieces.push(current);
      current = ch;
      continue;
    }
    current += ch;
    if ((ch === '@' || ch === '+' || ch === '-' || ch === '_') && current.length >= MIN_PIECE) {
      pieces.push(current);
      current = '';
    }
  }
  if (current) {
    // A short tail, such as ".net", joins the piece before it: no line holds only that.
    if (current.length <= MAX_TAIL && pieces.length) pieces[pieces.length - 1] += current;
    else pieces.push(current);
  }
  return pieces;
}
