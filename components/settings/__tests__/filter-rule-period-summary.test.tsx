import { render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import { getBrowserTimeZone } from '@/lib/timezone';
import { useSettingsStore } from '@/stores/settings-store';
import { RuleSummary, VisualRuleSummary } from '../filter-settings';

vi.mock('@/stores/toast-store', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const rule = (extra: Partial<FilterRule> = {}): FilterRule => ({
  id: 'r1',
  name: 'Urlaub',
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: '@' }],
  actions: [{ type: 'forward', value: 'kollege@example.com' }, { type: 'discard' }],
  stopProcessing: false,
  ...extra,
});

const ORIGINAL_TZ = vi.hoisted(() => {
  const original = process.env.TZ;
  process.env.TZ = 'UTC';
  return original;
});
beforeAll(() => {
  expect(getBrowserTimeZone()).toBe('UTC');
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const initialSettings = useSettingsStore.getState();
beforeEach(() => {
  useSettingsStore.setState({ timeZone: 'Europe/Berlin', dateLocale: 'en-GB', timeFormat: '24h' });
});
afterEach(() => {
  useSettingsStore.setState(initialSettings, true);
  vi.useRealTimers();
});

describe('filter rule period (list)', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-10T12:00:00.000Z'), toFake: ['Date'] }));

  const periods = [
    ['scheduled', { activeFrom: '2026-10-12T06:00:00.000Z', activeUntil: '2026-10-16T16:00:00.000Z' }, '12 Oct 2026, 08:00 – 16 Oct 2026, 18:00'],
    ['active', { activeFrom: '2026-10-05T06:00:00.000Z', activeUntil: '2026-10-16T16:00:00.000Z' }, '5 Oct 2026, 08:00 – 16 Oct 2026, 18:00'],
    ['expired', { activeFrom: '2026-10-01T06:00:00.000Z', activeUntil: '2026-10-09T16:00:00.000Z' }, '1 Oct 2026, 08:00 – 9 Oct 2026, 18:00'],
    ['active', { activeUntil: '2026-10-16T16:00:00.000Z' }, '… – 16 Oct 2026, 18:00'],
    ['scheduled', { activeFrom: '2026-10-12T06:00:00.000Z' }, '12 Oct 2026, 08:00 – …'],
  ] as const;

  it.each(periods)('shows a %s period in the detailed view', (status, period, range) => {
    render(<VisualRuleSummary rule={rule(period)} />);
    expect(screen.getByText('period_title')).toBeInTheDocument();
    expect(screen.getByText(range)).toBeInTheDocument();
    expect(screen.getByText(`(period_status_${status})`)).toBeInTheDocument();
  });

  it.each(periods)('shows a %s period in the compact view', (status, period, range) => {
    render(<RuleSummary rule={rule(period)} />);
    expect(screen.getByText(`· ${range} (period_status_${status})`)).toBeInTheDocument();
  });

  it('shows the period of a rule that is off without saying it is active', () => {
    const off = rule({ enabled: false, activeFrom: '2026-10-05T06:00:00.000Z', activeUntil: '2026-10-16T16:00:00.000Z' });
    const { unmount } = render(<VisualRuleSummary rule={off} />);
    expect(screen.getByText('5 Oct 2026, 08:00 – 16 Oct 2026, 18:00')).toBeInTheDocument();
    expect(screen.queryByText(/period_status_/)).toBeNull();
    unmount();
    render(<RuleSummary rule={off} />);
    expect(screen.getByText('· 5 Oct 2026, 08:00 – 16 Oct 2026, 18:00')).toBeInTheDocument();
    expect(screen.queryByText(/period_status_/)).toBeNull();
  });

  it('shows no period for a rule without one', () => {
    const { unmount } = render(<VisualRuleSummary rule={rule()} />);
    expect(screen.queryByText('period_title')).toBeNull();
    unmount();
    const { container } = render(<RuleSummary rule={rule()} />);
    expect(container.textContent).not.toContain('·');
  });
});
