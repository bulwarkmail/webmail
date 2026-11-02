import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Mail, ShieldFilled, Star } from '../components/icons';
import { iconForName } from '../components/icons/named';

describe('Memail icon compatibility', () => {
  it('renders the new glyphs with a duotone layer and inherited color', () => {
    const markup = renderToStaticMarkup(<Mail />);
    expect(markup).toContain('fill="currentColor"');
    expect(markup).toContain('opacity="0.2"');
    expect(markup).toContain('data-memail-glyph');
  });
  it('maps heavy numeric strokes to bold glyphs and preserves explicit colors and filled variants', () => {
    expect(renderToStaticMarkup(<Mail stroke={2.5} />)).not.toContain('opacity="0.2"');
    expect(renderToStaticMarkup(<Mail stroke="red" strokeWidth={3} />)).toContain('fill="red"');
    expect(renderToStaticMarkup(<ShieldFilled />)).toContain('fill="currentColor"');
  });
  it('keeps explicitly unfilled action icons visible and distinguishes starred state', () => {
    const empty = renderToStaticMarkup(<Star fill="none" />);
    const filled = renderToStaticMarkup(<Star fill="currentColor" />);
    expect(empty).toContain('fill="currentColor"');
    expect(empty).not.toContain('fill="none"');
    expect(empty).not.toBe(filled);
  });
  it('renders saved workspace icons through the new glyph family', () => {
    const Icon = iconForName('tabler:inbox')!;
    expect(renderToStaticMarkup(<Icon />)).toContain('data-memail-glyph');
    expect(iconForName('tabler:brand-github')).toBeDefined();
  });
});
