import { afterEach, describe, expect, it } from 'vitest';
import { hexKeywordColor, isHexTagColor, parseHexColor } from '../tag-hex-color';

describe('parseHexColor', () => {
  it('reads six digits with or without #, in any case, and lowercases them', () => {
    expect(parseHexColor('#1a73e8')).toBe('#1a73e8');
    expect(parseHexColor('1a73e8')).toBe('#1a73e8');
    expect(parseHexColor('#1A73E8')).toBe('#1a73e8');
    expect(parseHexColor('1A73e8')).toBe('#1a73e8');
  });

  it('expands three digits', () => {
    expect(parseHexColor('#ABC')).toBe('#aabbcc');
    expect(parseHexColor('0a0')).toBe('#00aa00');
  });

  it('ignores spaces around the code', () => {
    expect(parseHexColor('  #1a73e8 ')).toBe('#1a73e8');
    expect(parseHexColor('\tabc\n')).toBe('#aabbcc');
  });

  it('refuses anything else', () => {
    for (const input of ['#12', '#ggg', 'red', '#1234567', '', '#', '##abc', '#1234', '# abc']) {
      expect(parseHexColor(input)).toBeNull();
    }
  });
});

describe('isHexTagColor', () => {
  it('accepts only a stored lowercase #rrggbb', () => {
    expect(isHexTagColor('#1a73e8')).toBe(true);
    expect(isHexTagColor('#1A73E8')).toBe(false);
    expect(isHexTagColor('1a73e8')).toBe(false);
    expect(isHexTagColor('#abc')).toBe(false);
    expect(isHexTagColor('blue')).toBe(false);
    expect(isHexTagColor('')).toBe(false);
  });
});

describe('hexKeywordColor', () => {
  afterEach(() => {
    document.head.querySelector('style[data-tag-hex-colors]')?.remove();
  });

  it('names a class for each part of the tag', () => {
    expect(hexKeywordColor('#1a73e8')).toEqual({
      dot: 'tag-hex-1a73e8-dot',
      icon: 'tag-hex-1a73e8-icon',
      fill: 'tag-hex-1a73e8-fill',
      border: 'tag-hex-1a73e8-border',
      text: 'tag-hex-1a73e8-text',
      rowTint: 'tag-hex-1a73e8-rowtint',
    });
  });

  it('adds the rules for a colour once, to one style element', () => {
    hexKeywordColor('#1a73e8');
    hexKeywordColor('#1a73e8');
    hexKeywordColor('#00aa00');

    const styles = document.head.querySelectorAll('style[data-tag-hex-colors]');
    expect(styles).toHaveLength(1);
    const css = styles[0].textContent ?? '';
    expect(css.match(/\.tag-hex-1a73e8-dot\{/g)).toHaveLength(1);
    expect(css).toContain('.tag-hex-1a73e8-dot{background-color:#1a73e8}');
    expect(css).toContain('.tag-hex-1a73e8-text{color:var(--color-foreground)}');
    expect(css).toContain('.tag-hex-1a73e8-fill{background-color:var(--color-background);background-image:linear-gradient(color-mix(in srgb, #1a73e8 10%, transparent)');
    expect(css).toContain('.tag-hex-1a73e8-rowtint{background-color:color-mix(in srgb, #1a73e8 10%, transparent)}');
    expect(css).toContain('.tag-hex-00aa00-dot{');
  });

  it('adds the rules again when the style element was removed', () => {
    hexKeywordColor('#1a73e8');
    document.head.querySelector('style[data-tag-hex-colors]')?.remove();
    hexKeywordColor('#1a73e8');
    expect(document.head.querySelector('style[data-tag-hex-colors]')?.textContent).toContain('.tag-hex-1a73e8-dot{');
  });
});
