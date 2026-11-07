import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDateTime } from '../utils';

// The reader formats its dates on every draw. toLocaleString builds an
// Intl.DateTimeFormat each time; formatDateTime keeps one per locale and
// options, and writes exactly what toLocaleString wrote.

const date = new Date('2026-03-14T15:09:26Z');

afterEach(() => { vi.restoreAllMocks(); });

describe('formatDateTime', () => {
  it('writes what toLocaleString writes', () => {
    const cases: Array<[Parameters<typeof formatDateTime>[2], Intl.DateTimeFormatOptions]> = [
      [undefined, { hour: '2-digit', minute: '2-digit', hour12: false }],
      [{ weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }],
      [{ year: 'numeric', month: 'long', day: 'numeric', dateOnly: true }, { year: 'numeric', month: 'long', day: 'numeric' }],
      [{ dateOnly: true }, {}],
    ];
    for (const [options, expected] of cases) {
      const out = formatDateTime(date, '24h', options);
      expect(out).toBe(date.toLocaleString(undefined, { ...expected, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
    }
  });

  it('builds no formatter per call for dates with fields', () => {
    formatDateTime(date, '12h', { weekday: 'long', day: 'numeric' });
    // toLocaleString builds an Intl.DateTimeFormat for each call.
    const perCall = vi.spyOn(Date.prototype, 'toLocaleString');
    for (let i = 0; i < 5; i++) formatDateTime(new Date(date.getTime() + i * 60_000), '12h', { weekday: 'long', day: 'numeric' });
    expect(perCall).not.toHaveBeenCalled();
  });
});
