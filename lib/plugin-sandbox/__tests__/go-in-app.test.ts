import { afterEach, describe, expect, it, vi } from 'vitest';
import { goInApp, onPageNavigation, resetPageNavigation } from '../page-navigation';

describe('moving the tab', () => {
  afterEach(() => {
    resetPageNavigation();
    vi.unstubAllGlobals();
  });

  it('goes through the router when there is one: a full load would ask for the app lock PIN', () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const pushed: string[] = [];
    onPageNavigation((href) => pushed.push(href));
    goInApp('/calendar', '/en/calendar');
    expect(pushed).toEqual(['/calendar']);
    expect(assign).not.toHaveBeenCalled();
  });

  it('loads the page only where nothing has a router', () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    goInApp('/calendar', '/en/calendar');
    expect(assign).toHaveBeenCalledWith('/en/calendar');
  });
});
