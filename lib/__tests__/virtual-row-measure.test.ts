import { describe, expect, it } from 'vitest';
import type { Virtualizer } from '@tanstack/react-virtual';
import { measureVisibleRow } from '@/lib/virtual-row-measure';

const instance = {
  measurementsCache: [{ size: 120 }, { size: 80 }],
  indexFromElement: () => 1,
} as unknown as Virtualizer<HTMLDivElement, HTMLElement>;

const entry = (blockSize: number) => ({ borderBoxSize: [{ blockSize, inlineSize: 300 }] }) as unknown as ResizeObserverEntry;
const row = document.createElement('div');

describe('measureVisibleRow', () => {
  it('takes the measured height, sub-pixels included', () => {
    expect(measureVisibleRow(row, entry(96.5), instance)).toBe(96.5);
  });

  it('keeps the known height of a row in a hidden list', () => {
    expect(measureVisibleRow(row, entry(0), instance)).toBe(80);
  });

  it('reports 0 for a hidden row it knows nothing about', () => {
    const empty = { measurementsCache: [], indexFromElement: () => 0 } as unknown as Virtualizer<HTMLDivElement, HTMLElement>;
    expect(measureVisibleRow(row, entry(0), empty)).toBe(0);
  });
});
