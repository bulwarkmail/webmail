import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { FilterPanelHost } from '../filter-panel-host';

// Mountain View moves the filter button into the global top bar. The panel
// follows it there, given an anchor; without one it stays in the flow of the
// message-list column, which is the default layout's arrangement.

describe('FilterPanelHost', () => {
  it('renders in place when there is no anchor', () => {
    const { container } = render(
      <FilterPanelHost anchor={null}><span>filters</span></FilterPanelHost>
    );

    expect(container).toContainElement(screen.getByText('filters'));
    expect(container.querySelector('[data-mv-filter-panel]')).toBeNull();
  });

  it('lines the panel up with the anchor: same leading edge, same width, just below', () => {
    const anchor = document.createElement('div');
    anchor.getBoundingClientRect = () =>
      ({ left: 165, width: 505, top: 56, bottom: 56, right: 670, height: 0, x: 165, y: 56, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(anchor);

    const { container } = render(
      <FilterPanelHost anchor={anchor}><span>filters</span></FilterPanelHost>
    );

    const panel = document.querySelector<HTMLElement>('[data-mv-filter-panel]')!;
    expect(panel).toContainElement(screen.getByText('filters'));
    expect(container).not.toContainElement(panel);
    expect(panel.style.left).toBe('165px');
    expect(panel.style.width).toBe('505px');
    expect(Number.parseInt(panel.style.top, 10)).toBeGreaterThanOrEqual(56);

    anchor.remove();
  });

  it('draws it at the end of <body>, above the sidebar column and not inside the top bar', () => {
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);

    render(<FilterPanelHost anchor={anchor}><span>filters</span></FilterPanelHost>);

    const panel = document.querySelector<HTMLElement>('[data-mv-filter-panel]')!;
    // The sidebar column is z-50 and later in the document than the top bar,
    // so inside the bar the panel lost that tie and was painted over.
    expect(anchor).not.toContainElement(panel);
    expect(panel.parentElement).toBe(document.body);
    expect(panel.className).toContain('fixed');
    expect(panel.className).toContain('z-50');

    anchor.remove();
  });
});
