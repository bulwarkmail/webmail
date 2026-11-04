import { describe, expect, it } from 'vitest';
import { attachmentsForDisplay } from '../attachment-order';

describe('the order of the composer attachment chips', () => {
  it('puts failed, then uploading files first, and keeps the rest in the order added', () => {
    const files = [
      { name: 'a.pdf' },
      { name: 'b.pdf', uploading: true },
      { name: 'c.pdf' },
      { name: 'big.zip', uploading: true },
      { name: 'broken.png', error: 'failed' },
    ];
    const shown = attachmentsForDisplay(files);
    expect(shown.map(({ att }) => att.name)).toEqual(['broken.png', 'b.pdf', 'big.zip', 'a.pdf', 'c.pdf']);
    // Each keeps its place in the composer's list, for Remove.
    expect(shown.map(({ index }) => index)).toEqual([4, 1, 3, 0, 2]);
  });
});
