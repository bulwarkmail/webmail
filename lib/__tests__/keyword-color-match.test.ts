import { describe, expect, it } from 'vitest';
import { nearestKeywordColor } from '../keyword-color-match';
import { KEYWORD_PALETTE } from '@/stores/settings-store';

describe('nearestKeywordColor', () => {
  it('matches a palette colour to itself', () => {
    expect(nearestKeywordColor('#ef4444')).toBe('red');
    expect(nearestKeywordColor('#3b82f6')).toBe('blue');
  });

  it('reads the shorthand form and ignores case', () => {
    expect(nearestKeywordColor('#F00')).toBe(nearestKeywordColor('#ff0000'));
  });

  it('picks the lightness as well as the hue', () => {
    // Gmail's own label palette: a pale blue and a deep one.
    expect(nearestKeywordColor('#b6cff5')).toBe('blue-light');
    expect(nearestKeywordColor('#0b4f6c')).toMatch(/^(cyan|blue|teal)-dark$/);
  });

  it('calls a desaturated colour gray rather than a washed-out hue', () => {
    expect(nearestKeywordColor('#999999')).toMatch(/^gray/);
  });

  it('always names a colour the palette actually has', () => {
    for (const hex of ['#fb4c2f', '#42d692', '#b99aff', '#ffdeb5', '#ffad46']) {
      const key = nearestKeywordColor(hex);
      expect(key).not.toBeNull();
      expect(KEYWORD_PALETTE[key!]).toBeDefined();
    }
  });

  it('says nothing when the server kept no colour', () => {
    expect(nearestKeywordColor(null)).toBeNull();
    expect(nearestKeywordColor('rebeccapurple')).toBeNull();
  });
});
