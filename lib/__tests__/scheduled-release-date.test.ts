import { describe, it, expect } from 'vitest';
import { scheduledReleaseDate } from '../jmap/client';

describe('scheduledReleaseDate', () => {
  it('drops the milliseconds toISOString() adds', () => {
    expect(scheduledReleaseDate('2026-09-28T04:45:00.000Z')).toBe('2026-09-28T04:45:00Z');
  });

  it('truncates non-zero milliseconds (undo-send delays are computed from Date.now())', () => {
    expect(scheduledReleaseDate('2026-09-28T04:45:10.987Z')).toBe('2026-09-28T04:45:10Z');
  });

  it('normalises an offset date to UTC', () => {
    expect(scheduledReleaseDate('2026-09-28T06:45:00+02:00')).toBe('2026-09-28T04:45:00Z');
  });
});
