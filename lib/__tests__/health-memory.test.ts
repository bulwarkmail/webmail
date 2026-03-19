import { describe, expect, it } from 'vitest';

import { calculateHeapUsagePercent } from '@/lib/health-memory';

describe('calculateHeapUsagePercent', () => {
  it('uses heap size limit when available', () => {
    const percent = calculateHeapUsagePercent(45, 50, 200);
    expect(percent).toBeCloseTo(22.5, 5);
  });

  it('falls back to heap total when heap size limit is unavailable', () => {
    const percent = calculateHeapUsagePercent(45, 50, 0);
    expect(percent).toBeCloseTo(90, 5);
  });

  it('returns 0 when denominator is invalid', () => {
    expect(calculateHeapUsagePercent(45, 0, 0)).toBe(0);
  });
});
