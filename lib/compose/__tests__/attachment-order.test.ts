import { describe, expect, it } from 'vitest';
import { attachmentsForDisplay } from '../attachment-order';

describe('the order of the composer attachment chips', () => {
  it('puts failed files first, and keeps the rest, uploading or not, in the order added', () => {
    const files = [
      { name: 'a.pdf' },
      { name: 'b.pdf', uploading: true },
      { name: 'c.pdf' },
      { name: 'big.zip', uploading: true },
      { name: 'broken.png', error: 'failed' },
    ];
    const shown = attachmentsForDisplay(files);
    expect(shown.map(({ att }) => att.name)).toEqual(['broken.png', 'a.pdf', 'b.pdf', 'c.pdf', 'big.zip']);
    // Each keeps its place in the composer's list, for Remove.
    expect(shown.map(({ index }) => index)).toEqual([4, 0, 1, 2, 3]);
  });
});
