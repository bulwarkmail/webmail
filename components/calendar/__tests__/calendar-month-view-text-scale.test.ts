import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k, useFormatter: () => ({}) }));

const { monthGridMetrics } = await import('../calendar-month-view');

describe('monthGridMetrics', () => {
  it('keeps the 24px chip with a mouse at normal text size', () => {
    const m = monthGridMetrics(false, 1);
    expect(m.chipHeight).toBe(24);
    expect(m.overlayTop).toBe(30);
    expect(m.baseRowMinHeight).toBe(30 + 4 + 8 + 4 * 26);
  });

  it('grows the rows and the day number strip with larger text', () => {
    const m = monthGridMetrics(false, 2);
    expect(m.chipHeight).toBe(50);
    expect(m.overlayTop).toBe(60);
    expect(m.baseRowMinHeight).toBe(60 + 4 + 8 + 4 * 52);
  });

  it('does not shrink chips below the target size for smaller text', () => {
    expect(monthGridMetrics(false, 0.875).chipHeight).toBe(24);
  });
});
