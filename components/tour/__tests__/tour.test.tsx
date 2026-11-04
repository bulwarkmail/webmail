import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tour on a phone, where the rail's anchors are not rendered, and its
// keyboard handling.

const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('@/i18n/navigation', () => ({ usePathname: () => nav.pathname }));

const tour = vi.hoisted(() => ({
  currentStep: 0,
  nextStep: vi.fn(),
  prevStep: vi.fn(),
  skipStep: vi.fn(),
  stopTour: vi.fn(),
  // The same objects on every render, as the provider's steps are.
  steps: [
    { id: 'one', target: '[data-tour="one"]', titleKey: 'one', descriptionKey: 'one_desc', placement: 'right' },
    { id: 'two', target: '[data-tour="two"]', titleKey: 'two', descriptionKey: 'two_desc', placement: 'right' },
    { id: 'three', target: '[data-tour="three"]', titleKey: 'three', descriptionKey: 'three_desc', placement: 'right' },
    { id: 'files', target: '[data-tour="four"]', titleKey: 'four', descriptionKey: 'four_desc', placement: 'right', page: '/files' },
  ],
}));

vi.mock('../tour-provider', () => ({
  useTour: () => ({
    currentStep: tour.currentStep,
    totalSteps: 3,
    steps: tour.steps,
    nextStep: tour.nextStep,
    prevStep: tour.prevStep,
    skipStep: tour.skipStep,
    stopTour: tour.stopTour,
  }),
}));

const { TourOverlay, findTourTarget, computeTooltipPosition } = await import('../tour-overlay');
const { getTourSteps } = await import('../tour-steps');

/** jsdom lays nothing out: give the elements marked `data-size` a box. */
const realRect = HTMLElement.prototype.getBoundingClientRect;
beforeEach(() => {
  vi.useFakeTimers();
  tour.currentStep = 0;
  nav.pathname = '/';
  tour.nextStep.mockClear();
  tour.prevStep.mockClear();
  tour.skipStep.mockClear();
  tour.stopTour.mockClear();
  HTMLElement.prototype.getBoundingClientRect = function () {
    const sized = this.hasAttribute('data-size');
    return { top: 10, left: 10, width: sized ? 40 : 0, height: sized ? 40 : 0, right: 50, bottom: 50, x: 10, y: 10, toJSON: () => ({}) } as DOMRect;
  };
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  HTMLElement.prototype.getBoundingClientRect = realRect;
  hosts.splice(0).forEach((h) => h.remove());
  document.documentElement.removeAttribute('dir');
  // jsdom has no elementsFromPoint; tests that need it add one.
  delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
});

const hosts: HTMLElement[] = [];
function anchors(html: string) {
  const host = document.createElement('div');
  hosts.push(host);
  host.innerHTML = html;
  document.body.appendChild(host);
}

describe('tour targets', () => {
  it('points at the copy of an anchor that is on screen', () => {
    anchors('<a data-tour="one" id="rail"></a><a data-tour="one" id="tabbar" data-size></a>');
    expect(findTourTarget('[data-tour="one"]')?.id).toBe('tabbar');
  });

  it('ignores a copy in a closed drawer', () => {
    anchors('<div inert><a data-tour="one" id="drawer" data-size></a></div>');
    expect(findTourTarget('[data-tour="one"]')).toBeNull();
  });

  it('ignores a copy covered by something else, like the tab bar under an open message', () => {
    anchors('<a data-tour="one" id="tabbar" data-size></a><div id="reader-bar" data-size></div>');
    const reader = document.getElementById('reader-bar')!;
    (document as { elementsFromPoint?: unknown }).elementsFromPoint = () => [reader, document.body];
    expect(findTourTarget('[data-tour="one"]')).toBeNull();
    // The tour's own layers on top don't count.
    const layer = document.createElement('div');
    layer.setAttribute('data-tour-layer', '');
    const tabbar = document.getElementById('tabbar')!;
    (document as { elementsFromPoint?: unknown }).elementsFromPoint = () => [layer, tabbar, document.body];
    expect(findTourTarget('[data-tour="one"]')?.id).toBe('tabbar');
  });

  it('drops a step whose target is in the page but not shown, instead of leaving the user behind the overlay', () => {
    anchors('<a data-tour="one"></a>');
    render(<TourOverlay />);
    act(() => { vi.advanceTimersByTime(1100); });
    expect(tour.skipStep).toHaveBeenCalledWith(1);
    expect(tour.nextStep).not.toHaveBeenCalled();
  });

  it("waits for the step's app before pointing at an anchor the app being left also has", () => {
    anchors('<a data-tour="four" data-size></a>');
    tour.currentStep = 3;
    nav.pathname = '/settings';
    const { rerender } = render(<TourOverlay />);
    act(() => { vi.advanceTimersByTime(6000); });
    expect(tour.skipStep).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toHaveClass('invisible');
    nav.pathname = '/files';
    rerender(<TourOverlay />);
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.getByRole('dialog', { name: 'four' })).not.toHaveClass('invisible');
  });

  it('has no card that catches taps while it looks for the target', () => {
    render(<TourOverlay />);
    act(() => { vi.advanceTimersByTime(300); });
    const card = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(card).toHaveClass('invisible');
    expect(card.style.pointerEvents).toBe('none');
  });

  it('shows a step whose target is on screen', () => {
    anchors('<a data-tour="one" data-size></a>');
    render(<TourOverlay />);
    act(() => { vi.advanceTimersByTime(1100); });
    expect(tour.nextStep).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'one' })).toBeInTheDocument();
  });

  it('leaves out the shortcuts step on a touch screen and contacts when they are off', () => {
    const ids = (o: Partial<Parameters<typeof getTourSteps>[0]>) =>
      getTourSteps({ isDemoMode: false, supportsCalendar: true, supportsWebDAV: true, ...o }).map((s) => s.id);
    expect(ids({})).toContain('shortcuts');
    expect(ids({ touch: true })).not.toContain('shortcuts');
    expect(ids({})).toContain('nav-contacts');
    expect(ids({ supportsContacts: false })).not.toContain('nav-contacts');
  });

  it('puts the card above a tab at the end of the phone tab bar instead of over it', () => {
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    try {
      const tab = { left: 234, top: 792, width: 78, height: 52 };
      const pos = computeTooltipPosition(tab, 'right', { width: 360, height: 196 });
      expect(pos.top + 196).toBeLessThanOrEqual(tab.top);
      expect(pos.left + 360).toBeLessThanOrEqual(390 - 8);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: hgt });
    }
  });

  it('keeps the card off the target on a phone narrower than the card', () => {
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 568 });
    try {
      const fab = { top: 440, left: 247, width: 56, height: 56 };
      // Measured off screen the card is at its full 360 px.
      const pos = computeTooltipPosition(fab, 'right', { width: 360, height: 196 });
      expect(pos.actualPlacement).toBe('top');
      expect(pos.top + 196).toBeLessThanOrEqual(fab.top);
      expect(pos.left).toBe(8);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: hgt });
    }
  });

  it('leaves out on a phone the steps that point into the rail or the folder drawer', () => {
    const ids = (phone: boolean) =>
      getTourSteps({ isDemoMode: true, supportsCalendar: true, supportsWebDAV: true, touch: phone, phone }).map((s) => s.id);
    for (const id of ['sidebar', 'keywords', 'demo-banner', 'quota']) {
      expect(ids(false), id).toContain(id);
      expect(ids(true), id).not.toContain(id);
    }
    expect(ids(true)[0]).toBe('compose');
    expect(ids(true)).toContain('nav-files');
  });
});

describe('tour keyboard', () => {
  function showStep() {
    anchors('<a data-tour="one" data-size></a>');
    render(<TourOverlay />);
    act(() => { vi.advanceTimersByTime(400); });
  }

  it('lets Enter press the focused Skip button instead of going to the next step', () => {
    showStep();
    const skip = screen.getByRole('button', { name: 'tour.skip' });
    skip.focus();
    act(() => { fireEvent.keyDown(skip, { key: 'Enter' }); });
    expect(tour.nextStep).not.toHaveBeenCalled();
  });

  it('still goes on with Enter when no button has the focus', () => {
    showStep();
    act(() => { fireEvent.keyDown(document.body, { key: 'Enter' }); });
    expect(tour.nextStep).toHaveBeenCalledTimes(1);
  });

  it('leaves Enter and the arrows to a field being typed in', () => {
    showStep();
    const field = document.createElement('input');
    hosts[0].appendChild(field);
    act(() => { fireEvent.keyDown(field, { key: 'Enter' }); });
    act(() => { fireEvent.keyDown(field, { key: 'ArrowRight' }); });
    expect(tour.nextStep).not.toHaveBeenCalled();
  });

  it('mirrors the arrows in right-to-left languages', () => {
    document.documentElement.setAttribute('dir', 'rtl');
    showStep();
    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowLeft' }); });
    expect(tour.nextStep).toHaveBeenCalledTimes(1);
    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowRight' }); });
    expect(tour.prevStep).toHaveBeenCalledTimes(1);
  });
});

// The phone tour said "Click one to read it on the right": a phone has one
// pane at a time. Phone steps have their own text where the layout differs.
describe('tour text on a phone', () => {
  it('uses the phone text of a step on a phone', () => {
    anchors('<a data-tour="one" data-size></a>');
    const step = tour.steps[0] as { phoneDescriptionKey?: string };
    step.phoneDescriptionKey = 'one_desc_phone';
    const spy = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query === '(width < 37.5rem)', media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList);
    try {
      render(<TourOverlay />);
      act(() => { vi.advanceTimersByTime(1100); });
      expect(screen.getByText('one_desc_phone')).toBeInTheDocument();
    } finally {
      delete step.phoneDescriptionKey;
      spy.mockRestore();
    }
  });

  it('never points left or right in the English phone tour', async () => {
    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const en = JSON.parse(readFileSync(resolve(__dirname, '../../../locales/en/common.json'), 'utf-8'));
    const text = (key: string) => key.split('.').reduce((o: Record<string, unknown>, k) => o[k] as Record<string, unknown>, en) as unknown as string;
    const steps = getTourSteps({ isDemoMode: true, supportsCalendar: true, supportsWebDAV: true, touch: true, phone: true });
    const sided = steps
      .map((s) => text(s.phoneDescriptionKey ?? s.descriptionKey))
      .filter((d) => /\b(left|right)\b/i.test(d));
    expect(sided).toEqual([]);
  });
});
