import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDate } from '../utils';
import { useSettingsStore } from '@/stores/settings-store';

// The list formats every row's date on every render. formatDate keeps its
// Intl.DateTimeFormat instances instead of building one per call (which each
// toLocale*String call does), without changing a single output.

describe('formatDate formatters', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useSettingsStore.setState({ dateFormat: 'smart', timeFormat: '24h', dateLocale: 'auto' });
  });

  it('builds a formatter once per locale and option set, not once per row', () => {
    useSettingsStore.setState({ dateFormat: 'smart', timeFormat: '12h', dateLocale: 'auto', timeZone: 'Europe/Berlin' });
    const old = new Date(Date.now() - 40 * 86_400_000);
    formatDate(old); // warm
    const Real = Intl.DateTimeFormat;
    let built = 0;
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(((...args: ConstructorParameters<typeof Intl.DateTimeFormat>) => {
      built++;
      return new Real(...args);
    }) as never);
    vi.spyOn(Date.prototype, 'toLocaleDateString').mockImplementation(function (this: Date, ...args) { built++; return Real.prototype.format.call(new Real(...args), this); });
    vi.spyOn(Date.prototype, 'toLocaleTimeString').mockImplementation(function (this: Date, ...args) { built++; return Real.prototype.format.call(new Real(...args), this); });
    vi.spyOn(Date.prototype, 'toLocaleString').mockImplementation(function (this: Date, ...args) { built++; return Real.prototype.format.call(new Real(...args), this); });

    for (let i = 0; i < 50; i++) formatDate(new Date(old.getTime() - i * 60_000));

    expect(built).toBe(0);
  });

  it.each([
    ['smart', '24h', 'auto'],
    ['smart', '12h', 'en-GB'],
    ['smart', '24h', 'iso'],
    ['full', '12h', 'auto'],
    ['full', '24h', 'en-US'],
    ['relative', '24h', 'auto'],
  ] as const)('formats as the toLocale* calls did (%s, %s, %s)', (dateFormat, timeFormat, dateLocale) => {
    useSettingsStore.setState({ dateFormat, timeFormat, dateLocale, timeZone: 'America/New_York' });
    const now = Date.now();
    const zone = 'America/New_York';
    const hour12 = timeFormat === '12h';
    const numeric = dateLocale === 'auto' ? 'en-US' : dateLocale === 'iso' ? 'en-CA' : dateLocale;
    for (const ago of [5 * 60_000, 3 * 86_400_000, 40 * 86_400_000, 400 * 86_400_000]) {
      const d = new Date(now - ago);
      const got = formatDate(d);
      if (dateFormat === 'full') {
        expect(got).toBe(d.toLocaleString(numeric, { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12 }));
      } else if (dateFormat === 'smart' && ago > 7 * 86_400_000 && dateLocale === 'auto'
        && d.toLocaleDateString('en-US', { timeZone: zone, year: 'numeric' }) === new Date(now).toLocaleDateString('en-US', { timeZone: zone, year: 'numeric' })) {
        // Earlier this year: day and month (mail-16).
        expect(got).toBe(d.toLocaleDateString('en-US', { timeZone: zone, month: 'short', day: 'numeric' }));
      } else if (dateFormat === 'smart' && ago > 7 * 86_400_000) {
        expect(got).toBe(d.toLocaleDateString(numeric, { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }));
      } else if (dateFormat === 'smart' && ago > 86_400_000) {
        const weekday = d.toLocaleDateString('en-US', { timeZone: zone, weekday: 'short' });
        expect(got).toBe(`${weekday} ${d.toLocaleTimeString('en-US', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12 })}`);
      } else {
        expect(got.length).toBeGreaterThan(0);
      }
    }
  });

  it("works out a row's date once, not on every render, and again when a setting changes", () => {
    useSettingsStore.setState({ dateFormat: 'smart', timeFormat: '24h', dateLocale: 'auto', timeZone: 'Europe/Berlin' });
    const date = new Date(Date.now() - 3 * 86_400_000);
    const parts = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    const first = formatDate(date);
    const worked = parts.mock.calls.length;
    expect(worked).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) expect(formatDate(date)).toBe(first);
    expect(parts.mock.calls.length).toBe(worked);
    useSettingsStore.setState({ timeFormat: '12h' });
    formatDate(date);
    expect(parts.mock.calls.length).toBeGreaterThan(worked);
  });
});
