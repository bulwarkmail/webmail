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

describe('measureVisibleRow keeps a row at the guess it matched', () => {
  const placedWith = (size: number) => ({
    measurementsCache: [{ key: 'a', size: 120 }, { key: 'b', size }],
    itemSizeCache: new Map<string, number>(),
    indexFromElement: () => 1,
  }) as unknown as Virtualizer<HTMLDivElement, HTMLElement>;

  it('stores the size when it equals the guess', () => {
    // The virtualizer stores only sizes that differ from its guess; a row
    // left out of its cache moved when the guess changed under it.
    const v = placedWith(124);
    expect(measureVisibleRow(row, entry(124), v)).toBe(124);
    expect(v.itemSizeCache.get('b')).toBe(124);
  });

  it('leaves a size that differs from the guess to the virtualizer', () => {
    const v = placedWith(96);
    expect(measureVisibleRow(row, entry(124), v)).toBe(124);
    expect(v.itemSizeCache.has('b')).toBe(false);
  });

  it('does not store the known size of a row in a hidden list', () => {
    const v = placedWith(96);
    expect(measureVisibleRow(row, entry(0), v)).toBe(96);
    expect(v.itemSizeCache.has('b')).toBe(false);
  });
});
