import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { TimeZonePicker } from '../time-zone-picker';

// pim-p3-14: in the event editor the zone list opened 64px right of the
// field and narrower than it, the search box's focus ring was cut at the
// list's edge, and the row marked was UTC, not the event's zone: the zones
// arrive after the list opened.

vi.mock('@/i18n/detect-locale', () => ({ getEffectiveLocale: () => 'en', detectBrowserLocale: () => 'en' }));

describe('the time zone list in the event editor', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('marks and scrolls to the current zone', async () => {
    render(<TimeZonePicker value="Europe/Berlin" onChange={vi.fn()} withAuto={false} className="w-full" fullWidthMenu defaultOpen />);
    const search = screen.getByRole('combobox', { name: 'time_zone_search' });
    await waitFor(() => {
      const active = document.getElementById(search.getAttribute('aria-activedescendant') ?? '');
      expect(active?.textContent).toMatch(/^Berlin/);
    });
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it('opens at the field\'s start and width, with the search box\'s ring inside', () => {
    render(<TimeZonePicker value="Europe/Berlin" onChange={vi.fn()} withAuto={false} className="w-full" fullWidthMenu defaultOpen />);
    const search = screen.getByRole('combobox', { name: 'time_zone_search' });
    const menu = search.closest('.absolute')!;
    expect(menu.className).toContain('start-0');
    expect(menu.className).toContain('end-0');
    expect(menu.className).not.toMatch(/\bw-(64|72)\b/);
    expect(search.className).toContain('focus-inset');
  });
});
