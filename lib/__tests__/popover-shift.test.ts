import { describe, expect, it } from 'vitest';
import { popoverShift } from '../popover-shift';

describe('popoverShift', () => {
  const bounds = { left: 0, right: 320 };

  it('leaves a popover that fits where it is', () => {
    expect(popoverShift({ left: 20, right: 200 }, bounds)).toBe(0);
  });

  it('pulls one past the end back inside, with the margin', () => {
    expect(popoverShift({ left: 180, right: 350 }, bounds)).toBe(-38);
  });

  it('pushes one past the start back inside, for right-to-left', () => {
    expect(popoverShift({ left: -30, right: 140 }, bounds)).toBe(38);
  });

  it('keeps the start edge inside when it is wider than the bounds', () => {
    expect(popoverShift({ left: 100, right: 500 }, bounds)).toBe(-92);
  });
});
