import { fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import { getBrowserTimeZone } from '@/lib/timezone';
import { useSettingsStore } from '@/stores/settings-store';
import { FilterRuleModal } from '../filter-rule-modal';
import { RuleSummary, VisualRuleSummary } from '@/components/settings/filter-settings';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/stores/toast-store', () => ({ toast: { error: toastError, success: vi.fn(), info: vi.fn() } }));

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

// The browser reports UTC while the user's time zone setting says Berlin, so
// the times show which of the two the dialog and the list follow. Set before
// the imports run: the app reads the browser zone once and keeps it.
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
  toastError.mockClear();
  useSettingsStore.setState({ timeZone: 'Europe/Berlin', dateLocale: 'en-GB', timeFormat: '24h' });
});
afterEach(() => {
  useSettingsStore.setState(initialSettings, true);
  vi.useRealTimers();
});

function openModal(props: Partial<React.ComponentProps<typeof FilterRuleModal>> = {}) {
  const onSave = vi.fn();
  render(<FilterRuleModal mailboxes={[]} onSave={onSave} onClose={vi.fn()} {...props} />);
  return { onSave, saved: () => onSave.mock.calls[0][0] as FilterRule };
}

const toggle = () => screen.getByLabelText('period_toggle') as HTMLInputElement;
const startInput = () => screen.getByLabelText('period_start') as HTMLInputElement;
const endInput = () => screen.getByLabelText('period_end') as HTMLInputElement;
const save = () => fireEvent.click(screen.getByText('save'));

describe('filter rule period (dialog)', () => {
  it('is offered only where the server supports it', () => {
    openModal({ rule: rule() });
    expect(screen.queryByLabelText('period_toggle')).toBeNull();
  });

  it('saves the period as the UTC moments of the times entered in the user time zone', () => {
    const { onSave, saved } = openModal({ rule: rule(), periodsSupported: true });
    fireEvent.click(toggle());
    expect(screen.getByText('period_hint')).toBeInTheDocument();
    // Berlin: CEST (+02:00) on 5 Oct, CET (+01:00) after the switch on 25 Oct.
    fireEvent.change(startInput(), { target: { value: '2026-10-05T08:00' } });
    fireEvent.change(endInput(), { target: { value: '2026-10-26T18:00' } });
    save();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(saved()).toMatchObject({
      activeFrom: '2026-10-05T06:00:00.000Z',
      activeUntil: '2026-10-26T17:00:00.000Z',
    });
  });

  it('keeps the start open', () => {
    const { saved } = openModal({ rule: rule(), periodsSupported: true });
    fireEvent.click(toggle());
    fireEvent.change(endInput(), { target: { value: '2026-10-16T18:00' } });
    save();
    expect(saved().activeUntil).toBe('2026-10-16T16:00:00.000Z');
    expect(saved().activeFrom).toBeUndefined();
  });

  it('keeps the end open', () => {
    const { saved } = openModal({ rule: rule(), periodsSupported: true });
    fireEvent.click(toggle());
    fireEvent.change(startInput(), { target: { value: '2026-10-05T08:00' } });
    save();
    expect(saved().activeFrom).toBe('2026-10-05T06:00:00.000Z');
    expect(saved().activeUntil).toBeUndefined();
  });

  it('asks for a start or an end when the period is on but empty', () => {
    const { onSave } = openModal({ rule: rule(), periodsSupported: true });
    fireEvent.click(toggle());
    save();
    expect(onSave).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('validation_period_empty');
  });

  it('will not take a date without its time for an open end', () => {
    const { onSave } = openModal({ rule: rule(), periodsSupported: true });
    fireEvent.click(toggle());
    fireEvent.change(startInput(), { target: { value: '2026-10-05T08:00' } });
    // A browser reads a field it holds half filled in as empty, often without
    // an event; jsdom never holds one, so the field says so here.
    Object.defineProperty(endInput(), 'validity', { value: { badInput: true }, configurable: true });
    save();
    expect(onSave).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('validation_period_invalid');
  });

  it('refuses a year it cannot store, rather than leave that end open', () => {
    const { onSave } = openModal({ rule: rule(), periodsSupported: true });
    fireEvent.click(toggle());
    fireEvent.change(startInput(), { target: { value: '2026-10-05T08:00' } });
    fireEvent.change(endInput(), { target: { value: '20266-10-16T18:00' } });
    save();
    expect(onSave).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('validation_period_invalid');

    // The last minute of 9999 in New York is year 10000 in UTC already.
    toastError.mockClear();
    useSettingsStore.setState({ timeZone: 'America/New_York' });
    fireEvent.change(endInput(), { target: { value: '9999-12-31T23:59' } });
    save();
    expect(onSave).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('validation_period_invalid');
  });

  it('offers no year past 9999', () => {
    openModal({ rule: rule(), periodsSupported: true });
    fireEvent.click(toggle());
    expect(startInput().max).toBe('9999-12-31T23:59');
    expect(endInput().max).toBe('9999-12-31T23:59');
  });

  it('refuses an end that is not after the start', () => {
    const { onSave } = openModal({ rule: rule(), periodsSupported: true });
    fireEvent.click(toggle());
    fireEvent.change(startInput(), { target: { value: '2026-10-16T18:00' } });
    fireEvent.change(endInput(), { target: { value: '2026-10-16T18:00' } });
    save();
    expect(onSave).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('validation_period_order');
  });

  it('shows a saved period in the user time zone', () => {
    openModal({
      rule: rule({ activeFrom: '2026-10-05T06:00:00.000Z', activeUntil: '2026-10-26T17:00:00.000Z' }),
      periodsSupported: true,
    });
    expect(toggle().checked).toBe(true);
    expect(startInput().value).toBe('2026-10-05T08:00');
    expect(endInput().value).toBe('2026-10-26T18:00');
  });

  it('keeps a saved boundary exactly while it is left as shown', () => {
    // 08:00:30, shown as 08:00; and 02:30 CEST on the night the clocks go
    // back, when 02:30 comes twice.
    const period = { activeFrom: '2026-10-05T06:00:30.000Z', activeUntil: '2026-10-25T00:30:00.000Z' };
    const { saved } = openModal({ rule: rule(period), periodsSupported: true });
    expect(startInput().value).toBe('2026-10-05T08:00');
    expect(endInput().value).toBe('2026-10-25T02:30');
    save();
    expect(saved()).toMatchObject(period);
  });

  it('reads a changed boundary from the input and keeps the other one', () => {
    const { saved } = openModal({
      rule: rule({ activeFrom: '2026-10-05T06:00:30.000Z', activeUntil: '2026-10-16T16:00:00.000Z' }),
      periodsSupported: true,
    });
    fireEvent.change(endInput(), { target: { value: '2026-10-18T12:00' } });
    save();
    expect(saved()).toMatchObject({
      activeFrom: '2026-10-05T06:00:30.000Z',
      activeUntil: '2026-10-18T10:00:00.000Z',
    });
  });

  it('drops the period when it is switched off', () => {
    const { saved } = openModal({ rule: rule({ activeUntil: '2026-10-16T16:00:00.000Z' }), periodsSupported: true });
    fireEvent.click(toggle());
    save();
    expect(saved().activeFrom).toBeUndefined();
    expect(saved().activeUntil).toBeUndefined();
  });

  it('shows a saved period where the server does not offer periods, so it can be removed', () => {
    const { saved } = openModal({ rule: rule({ activeUntil: '2026-10-16T16:00:00.000Z' }) });
    expect(toggle().checked).toBe(true);
    fireEvent.click(toggle());
    // The switch stays where it was, so a slip can be undone.
    expect(toggle().checked).toBe(false);
    save();
    expect(saved().activeUntil).toBeUndefined();
  });

  it('does not run a rule with a period on existing messages', () => {
    openModal({
      initialRule: rule({ actions: [{ type: 'mark_read' }] }),
      offerApplyToExisting: true,
      periodsSupported: true,
    });
    const applyExisting = screen.getByLabelText('apply_existing') as HTMLInputElement;
    expect(applyExisting.disabled).toBe(false);
    fireEvent.click(toggle());
    expect(applyExisting.disabled).toBe(true);
    expect(screen.getByText('apply_existing_period')).toBeInTheDocument();
  });
});

describe('filter rule period (list)', () => {
  // 14:00 in Berlin
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
