import { describe, expect, it } from 'vitest';
import { fitRowTags, type RowTagSize } from '../row-tag-fit';

const sizes: RowTagSize[] = [60, 192, 80, 50].map(named => ({ named, minimumNamed: 40, compact: 16 }));
const tags = (available: number, text: number, variant: 'badge' | 'dot' = 'badge') => fitRowTags(available, text, sizes, 4, variant);

describe('row tag allocation (measured inputs, not browser geometry)', () => {
  it.each([40, 600, 2400])('reserves complete compact tags before %s px of sender text', text => {
    const fit = tags(200, text);
    expect(fit.items).toHaveLength(4);
    expect(fit.width).toBeLessThanOrEqual(200);
    expect(fit.items.every(item => item.width >= 16)).toBe(true);
    if (text > 200) expect(fit.items.map(item => item.variant)).toEqual(['dot', 'dot', 'dot', 'dot']);
  });

  it('uses extra room for names, including a safely truncated long name, then restores them', () => {
    const narrow = tags(200, 40);
    expect(narrow.items[0]).toEqual({ variant: 'badge', width: 60 });
    expect(narrow.items[1].variant).toBe('badge');
    expect(narrow.items[1].width).toBeGreaterThanOrEqual(40);
    expect(narrow.items[1].width).toBeLessThan(192);
    expect(narrow.width).toBeLessThanOrEqual(160);
    const wide = tags(600, 40);
    expect(wide.items.map(item => item.width)).toEqual(sizes.map(size => size.named));
    expect(wide.items.every(item => item.variant === 'badge')).toBe(true);
    expect(tags(200, 40)).toEqual(narrow);
  });

  it('omits whole suffix dots only when the compact group cannot fit', () => {
    expect(tags(76, 2400).items).toHaveLength(4);
    expect(tags(75, 2400).items).toHaveLength(3);
    expect(tags(16, 2400).items).toEqual([{ variant: 'dot', width: 16 }]);
    expect(tags(15.9, 2400).items).toEqual([]);
    expect(tags(-10, 2400).items).toEqual([]);
  });

  it('keeps the pane-selected compact form and handles fractional widths conservatively', () => {
    expect(tags(600, 40, 'dot').items.every(item => item.variant === 'dot')).toBe(true);
    const result = fitRowTags(36.9, 1200, [{ named: 60, minimumNamed: 40, compact: 16.5 }, { named: 60, minimumNamed: 40, compact: 16.5 }], 4, 'badge');
    expect(result.items).toHaveLength(1);
    expect(result.width).toBe(16.5);
  });

  it('reserves measured named compact minima for show-colour-names, not hardcoded dot sizes', () => {
    const names = sizes.map(size => ({ ...size, compact: size.minimumNamed }));
    const result = fitRowTags(200, 2400, names, 4, 'badge');
    expect(result.items).toHaveLength(4);
    expect(result.items.every(item => item.variant === 'badge' && item.width >= 40)).toBe(true);
    expect(fitRowTags(39, 2400, names, 4, 'badge').items).toHaveLength(0);
  });
});
