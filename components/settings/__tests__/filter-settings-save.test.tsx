import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { FilterRule, SieveCapabilities } from '@/lib/jmap/sieve-types';
import { getBrowserTimeZone } from '@/lib/timezone';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { useFilterStore } from '@/stores/filter-store';
import { useSettingsStore } from '@/stores/settings-store';
import { FilterSettings } from '../filter-settings';

// Editing a rule on the settings page: the real page, rule dialog, filter
// store and script generator; only the server write is caught. The dialog
// hands back the whole rule and the page merges it into the stored one, so
// whatever the dialog switches off has to come through that merge.

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

const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/stores/toast-store', () => ({ toast: { error: toastError, success: vi.fn(), info: vi.fn() } }));

const CAPABILITIES: SieveCapabilities = {
  implementation: 'Stalwart',
  maxSizeScript: 102400,
  sieveExtensions: ['fileinto', 'mailbox', 'mailboxid', 'imap4flags', 'date', 'relational', 'spamtest', 'spamtestplus', 'comparator-i;ascii-numeric'],
  notificationMethods: [],
  externalLists: [],
  maxNumberRedirects: 1,
};

const rule = (extra: Partial<FilterRule> = {}): FilterRule => ({
  id: 'r1',
  name: 'ZRTEST',
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: '@' }],
  actions: [{ type: 'star' }],
  stopProcessing: false,
  ...extra,
});

const initial = {
  auth: useAuthStore.getState(),
  email: useEmailStore.getState(),
  filter: useFilterStore.getState(),
  settings: useSettingsStore.getState(),
};

let updateSieveScript: ReturnType<typeof vi.fn>;

beforeEach(() => {
  toastError.mockClear();
  updateSieveScript = vi.fn(async () => {});
  useSettingsStore.setState({ timeZone: 'Europe/Berlin', dateLocale: 'en-GB', timeFormat: '24h' });
  useAuthStore.setState({ client: { updateSieveScript, getSieveAccountId: () => 'primary' } as never });
  useEmailStore.setState({ fetchMailboxes: vi.fn(async () => {}) as never });
});

afterEach(() => {
  useAuthStore.setState(initial.auth, true);
  useEmailStore.setState(initial.email, true);
  useFilterStore.setState(initial.filter, true);
  useSettingsStore.setState(initial.settings, true);
});

function showSettings(stored: FilterRule) {
  useFilterStore.setState({
    rules: [stored],
    isSupported: true,
    isLoading: false,
    isOpaque: false,
    activeScriptId: 'script-1',
    selectedAccountId: 'primary',
    sieveCapabilities: CAPABILITIES,
    selectAccount: vi.fn(async () => {}),
  });
  render(<FilterSettings />);
}

function openSettings(stored: FilterRule) {
  showSettings(stored);
  fireEvent.click(screen.getByText(stored.name));
  return within(screen.getByRole('dialog'));
}

async function saveAndReadBack(dialog: ReturnType<typeof within>) {
  fireEvent.click(dialog.getByText('save'));
  await waitFor(() => expect(updateSieveScript).toHaveBeenCalledTimes(1));
  expect(toastError).not.toHaveBeenCalled();
  return { stored: useFilterStore.getState().rules[0], script: updateSieveScript.mock.calls[0][1] as string };
}

describe('saving an edited rule on the settings page', () => {
  it('drops an end that was cleared, along with a moved start', async () => {
    // 1 Oct 05:14 - 07:14 in Berlin; then the start goes to 2 Oct 05:14 and
    // the end is cleared in the picker.
    const dialog = openSettings(rule({ activeFrom: '2026-10-01T03:14:00.000Z', activeUntil: '2026-10-01T05:14:00.000Z' }));
    fireEvent.change(dialog.getByLabelText('period_start'), { target: { value: '2026-10-02T05:14' } });
    fireEvent.change(dialog.getByLabelText('period_end'), { target: { value: '' } });
    const { stored, script } = await saveAndReadBack(dialog);

    expect(stored.activeFrom).toBe('2026-10-02T03:14:00.000Z');
    expect(stored.activeUntil).toBeUndefined();
    expect(script).toContain('currentdate :zone "+0000" :value "ge" "time" "03:14:00"');
    expect(script).not.toContain('"le" "time"');
    expect(script).not.toContain('activeUntil');
    expect(screen.getByText(/2 Oct 2026, 05:14 – …/)).toBeInTheDocument();
  });

  it('removes the period when it is switched off', async () => {
    const dialog = openSettings(rule({ activeFrom: '2026-10-01T03:14:00.000Z', activeUntil: '2026-10-01T05:14:00.000Z' }));
    fireEvent.click(dialog.getByLabelText('period_toggle'));
    const { stored, script } = await saveAndReadBack(dialog);

    expect(stored.activeFrom).toBeUndefined();
    expect(stored.activeUntil).toBeUndefined();
    expect(script).not.toContain('currentdate');
    expect(script).not.toContain('"date"');
  });

  it('lets a folder rule stop taking spam out of Junk again', async () => {
    const dialog = openSettings(rule({
      actions: [{ type: 'move', value: 'News', mailboxId: 'mb-news' }],
      includeSpam: true,
    }));
    fireEvent.click(dialog.getByLabelText('include_spam'));
    const { stored, script } = await saveAndReadBack(dialog);

    expect(stored.includeSpam).toBeUndefined();
    expect(script).toContain('not spamtest :percent :value "ge"');
    expect(script).not.toContain('includeSpam');
  });

  it('counts the vacation forwarding that keeps a copy against the redirect limit', () => {
    const forwarding = rule({ actions: [{ type: 'forward', value: 'chef@example.com' }] });
    const vacationForward = { enabled: true, to: 'kollege@example.com', keepCopy: true };
    // CAPABILITIES allows one redirect per message.
    const warningFor = (state: Record<string, unknown>) => {
      useFilterStore.setState(state);
      const dialog = openSettings(forwarding);
      const shown = dialog.queryByText('forward_limit') !== null;
      cleanup();
      return shown;
    };
    // With the auto-reply or without: forwarding runs either way.
    expect(warningFor({ includeVacation: true, vacationForward })).toBe(true);
    expect(warningFor({ includeVacation: false, vacationForward })).toBe(true);
    // Not when only forwarded (the rules do not run then), nor while it is off.
    expect(warningFor({ includeVacation: true, vacationForward: { ...vacationForward, keepCopy: false } })).toBe(false);
    expect(warningFor({ includeVacation: true, vacationForward: { ...vacationForward, enabled: false } })).toBe(false);
  });

  it('counts the vacation forwarding that keeps a copy in the list of rules too', () => {
    const forwarding = rule({ actions: [{ type: 'forward', value: 'chef@example.com' }] });
    const vacationForward = { enabled: true, to: 'kollege@example.com', keepCopy: true };
    const listWarns = (state: Record<string, unknown>) => {
      useFilterStore.setState(state);
      showSettings(forwarding);
      const shown = screen.queryByText('forward_limit') !== null;
      cleanup();
      return shown;
    };
    expect(listWarns({ vacationForward })).toBe(true);
    // Only forwarded, a message never reaches the rules.
    expect(listWarns({ vacationForward: { ...vacationForward, keepCopy: false } })).toBe(false);
    expect(listWarns({ vacationForward: { ...vacationForward, enabled: false } })).toBe(false);
  });

  it('keeps what the dialog left alone', async () => {
    const period = { activeFrom: '2026-10-01T03:14:30.000Z', activeUntil: '2026-10-01T05:14:00.000Z' };
    const dialog = openSettings(rule({ ...period, actions: [{ type: 'move', value: 'News', mailboxId: 'mb-news' }], includeSpam: true }));
    const { stored } = await saveAndReadBack(dialog);

    expect(stored).toMatchObject({ ...period, includeSpam: true, name: 'ZRTEST', enabled: true });
  });
});
