import { describe, expect, it } from 'vitest';
import { selectionRows } from '../selection-view';

// The selection view's buttons go in even lines: none left alone on the last one.

describe('selectionRows', () => {
  it('puts everything on one line when it fits', () => {
    expect(selectionRows(4, 4)).toEqual([4]);
  });

  it('evens out the lines instead of leaving one button alone', () => {
    expect(selectionRows(7, 3)).toEqual([3, 2, 2]);
    expect(selectionRows(9, 4)).toEqual([3, 3, 3]);
    expect(selectionRows(5, 4)).toEqual([3, 2]);
  });

  it('never has a line of one next to longer lines, for any count and width', () => {
    for (let count = 2; count <= 12; count++) {
      for (let perLine = 1; perLine <= 6; perLine++) {
        const lines = selectionRows(count, perLine);
        expect(lines.reduce((a, b) => a + b, 0)).toBe(count);
        expect(Math.max(...lines)).toBeLessThanOrEqual(Math.max(1, perLine));
        if (lines.some((n) => n > 1)) expect(Math.min(...lines)).toBeGreaterThan(1);
      }
    }
  });
});
