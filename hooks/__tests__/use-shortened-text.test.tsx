import { render, screen } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { useShortenedText } from '../use-shortened-text';

const CANDIDATES = ['Work/Clients/Acme/Sales', 'Work/../Acme/Sales', 'Work/.../Sales'];

/**
 * Reports `width` for the observed element and measures text at 10px per
 * character, so a width of N*10 fits any candidate of N characters or fewer.
 */
function stubMeasurement(width: number) {
  // Implementing the interface rather than passing an anonymous class keeps the
  // members the hook never calls from reading as dead code.
  class StubResizeObserver implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}

    /** The hook observes once on mount; hand it `width` straight back. */
    observe(target: Element) {
      this.callback([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], this);
    }

    unobserve() {}

    disconnect() {}
  }

  vi.stubGlobal('ResizeObserver', StubResizeObserver);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    font: '',
    measureText: (text: string) => ({ width: text.length * 10 }),
  } as unknown as CanvasRenderingContext2D);
}

function Probe({ candidates }: { candidates: string[] }) {
  const [ref, text] = useShortenedText(candidates);
  return <span ref={ref} data-testid="probe">{text}</span>;
}

function renderProbe(candidates: string[]): string {
  render(<Probe candidates={candidates} />);
  return screen.getByTestId('probe').textContent ?? '';
}

describe('useShortenedText', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns the longest candidate where the DOM cannot be measured', () => {
    // No ResizeObserver: server rendering, and jsdom by default. Showing the
    // whole path beats shortening it on a guess.
    expect(renderProbe(CANDIDATES)).toBe('Work/Clients/Acme/Sales');
  });

  it('keeps the full path when the element is wide enough', () => {
    stubMeasurement(230);
    expect(renderProbe(CANDIDATES)).toBe('Work/Clients/Acme/Sales');
  });

  it('steps down only as far as the width requires', () => {
    stubMeasurement(200);
    expect(renderProbe(CANDIDATES)).toBe('Work/../Acme/Sales');
  });

  it('falls back to the shortest candidate when none of them fit', () => {
    stubMeasurement(40);
    expect(renderProbe(CANDIDATES)).toBe('Work/.../Sales');
  });
});
