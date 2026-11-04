import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRef } from 'react';
import { CalendarSearchField } from '../calendar-search';

// pim-21: at 150 % in German the search box read "Termine durchs". A field
// too narrow for "Search events" now says "Search"; its name stays whole.

/** The field is `width` px wide inside; text measures 10px per character. */
function stubWidth(width: number) {
  vi.stubGlobal('ResizeObserver', class implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], this);
    }
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    font: '',
    measureText: (text: string) => ({ width: text.length * 10 }),
  } as unknown as CanvasRenderingContext2D);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CalendarSearchField placeholder', () => {
  it('says the short word in a narrow field', () => {
    // "search.title" is 12 characters: 120px does not fit in 96.
    stubWidth(96);
    render(<CalendarSearchField value="" onChange={vi.fn()} />);
    const input = screen.getByRole('searchbox');
    expect(input.getAttribute('placeholder')).toBe('search_short');
    expect(input.getAttribute('aria-label')).toBe('search.title');
  });

  it('keeps the whole phrase where it fits', () => {
    stubWidth(200);
    render(<CalendarSearchField value="" onChange={vi.fn()} />);
    expect(screen.getByRole('searchbox').getAttribute('placeholder')).toBe('search.title');
  });

  it('still hands the input to the page', () => {
    stubWidth(200);
    const ref = createRef<HTMLInputElement>();
    render(<CalendarSearchField ref={ref} value="" onChange={vi.fn()} />);
    expect(ref.current).toBe(screen.getByRole('searchbox'));
  });
});
