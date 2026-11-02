import {createRef} from 'react';
import {describe, expect, it} from 'vitest';
import {render} from '@testing-library/react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Mail, ShieldFilled, Star, Inbox} from '../components/icons';
import * as ApplicationIcons from '../components/icons/heroicons';
import {Inbox as SidebarInbox} from '../components/icons/sidebar-icons';
import {iconForName} from '../components/icons/named';

describe('Memail Heroicons compatibility', () => {
  it('uses Heroicons for every built-in application glyph without a legacy fallback', () => {
    for (const [name, Icon] of Object.entries(ApplicationIcons)) {
      const markup = renderToStaticMarkup(<Icon/>);
      expect(markup, name).toContain('data-memail-icon-set="heroicons"');
      expect(markup, name).toContain('viewBox="0 0 24 24"');
      expect(markup, name).toContain(`data-memail-icon="${name}"`);
    }
    expect(SidebarInbox).toBe(Inbox);
  });
  it('preserves size, numeric stroke, explicit stroke colors and SVG refs', () => {
    const ref = createRef<SVGSVGElement>();
    render(<Mail ref={ref} size={18} stroke="red" strokeWidth={3} aria-label="Envelope graphic"/>);
    expect(ref.current).toHaveAttribute('width','18');
    expect(ref.current).toHaveAttribute('stroke','red');
    expect(ref.current).toHaveAttribute('stroke-width','3');
    expect(ref.current).not.toHaveAttribute('aria-hidden');
    expect(renderToStaticMarkup(<Mail stroke={2.5}/>)).toContain('stroke-width="2.5"');
  });
  it('distinguishes outlined and filled state and keeps a solid shield', () => {
    const empty = renderToStaticMarkup(<Star fill="none"/>);
    const filled = renderToStaticMarkup(<Star fill="currentColor"/>);
    expect(empty).toContain('fill="none"');
    expect(filled).toContain('fill="currentColor"');
    expect(empty).not.toBe(filled);
    expect(renderToStaticMarkup(<ShieldFilled/>)).toContain('fill="currentColor"');
  });
  it('uses Heroicons for workspace defaults while retaining stored custom icons', () => {
    for (const name of ['inbox','focus','news','mail','calendar','alert-circle']) {
      const Icon = iconForName(`tabler:${name}`)!;
      expect(renderToStaticMarkup(<Icon/>)).toContain('data-memail-icon-set="heroicons"');
    }
    expect(iconForName('tabler:brand-github')).toBeDefined();
  });
});
