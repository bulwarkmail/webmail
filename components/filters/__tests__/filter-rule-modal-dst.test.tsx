import { fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import React from 'react';
import type { FilterRule } from '@/lib/jmap/sieve-types';
import { getBrowserTimeZone } from '@/lib/timezone';
import { useSettingsStore } from '@/stores/settings-store';
import { FilterRuleModal } from '../filter-rule-modal';

vi.mock('@/stores/toast-store', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

// The browser runs on Berlin time, the user's setting says New York. Set
// before the imports run: the app reads the browser zone once and keeps it.
const ORIGINAL_TZ = vi.hoisted(() => {
  const original = process.env.TZ;
  process.env.TZ = 'Europe/Berlin';
  return original;
});
beforeAll(() => {
  expect(getBrowserTimeZone()).toBe('Europe/Berlin');
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const initialSettings = useSettingsStore.getState();
beforeEach(() => {
  useSettingsStore.setState({ timeZone: 'America/New_York' });
});
afterEach(() => {
  useSettingsStore.setState(initialSettings, true);
});

const rule: FilterRule = {
  id: 'r1',
  name: 'Urlaub',
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: '@' }],
  actions: [{ type: 'forward', value: 'kollege@example.com' }],
  stopProcessing: false,
};

it('reads a time the browser zone skips at its DST change on the clock of the user zone', () => {
  const onSave = vi.fn();
  render(<FilterRuleModal mailboxes={[]} rule={rule} periodsSupported onSave={onSave} onClose={vi.fn()} />);
  fireEvent.click(screen.getByLabelText('period_toggle'));
  // 02:30 on 29 March does not exist in Berlin; in New York it is 02:30 EDT.
  fireEvent.change(screen.getByLabelText('period_end'), { target: { value: '2026-03-29T02:30' } });
  fireEvent.click(screen.getByText('save'));
  expect(onSave).toHaveBeenCalledTimes(1);
  expect((onSave.mock.calls[0][0] as FilterRule).activeUntil).toBe('2026-03-29T06:30:00.000Z');
});
