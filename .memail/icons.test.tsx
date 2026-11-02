import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Mail, ShieldFilled } from '../components/icons';
import { iconForName } from '../components/icons/named';

describe('Memail icon compatibility', () => {
  it('renders outline glyphs with visible strokes and no solid fill', () => {
    const markup = renderToStaticMarkup(<Mail />);
    expect(markup).toContain('fill="none"');
    expect(markup).toContain('stroke="currentColor"');
    expect(markup).toContain('stroke-width="1.75"');
  });
  it('preserves upstream numeric stroke, SVG stroke color, refs and filled variants', () => {
    expect(renderToStaticMarkup(<Mail stroke={2.5} />)).toContain('stroke-width="2.5"');
    expect(renderToStaticMarkup(<Mail stroke="red" strokeWidth={3} />)).toContain('stroke="red"');
    expect(renderToStaticMarkup(<ShieldFilled />)).toContain('fill="currentColor"');
  });
  it('renders saved workspace icons through the same outline adapter', () => {
    const Icon = iconForName('tabler:inbox')!;
    expect(renderToStaticMarkup(<Icon />)).toContain('stroke-width="1.75"');
    expect(iconForName('tabler:brand-github')).toBeDefined();
  });
});
