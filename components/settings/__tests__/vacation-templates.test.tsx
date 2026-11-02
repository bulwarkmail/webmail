import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { mockStalwartAccount } from '@/lib/filters/__tests__/sieve-mock';
import { DEFAULT_POLICY } from '@/lib/admin/types';
import { DEFAULT_ORGANISATION_POLICY, type VacationTemplate } from '@/lib/admin/organisation-policy';
import { useAuthStore } from '@/stores/auth-store';
import { useIdentityStore } from '@/stores/identity-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useVacationStore } from '@/stores/vacation-store';
import { VacationSettings } from '../vacation-settings';

// Out-of-office templates from the admin library, in the real vacation card
// with its auto-save: picking a template with a deputy saves nothing until
// the deputy is typed and the user applies it; the dates are shown and
// filled in the user's time zone.

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('@/stores/toast-store', () => ({ toast }));
vi.mock('next-intl', () => {
  const t = (key: string, values?: Record<string, unknown>) => (values ? `${key} ${Object.values(values).join(' ')}` : key);
  return { useTranslations: () => t, useLocale: () => 'en-GB' };
});

const TEMPLATE: VacationTemplate = {
  id: 'holiday',
  name: 'Holiday',
  category: 'Standard',
  subject: 'Away until {end}',
  text: 'I am away until {end}.\nPlease write to {deputy}.\n{name}',
  html: '',
};

const initial = {
  auth: useAuthStore.getState(),
  vacation: useVacationStore.getState(),
  identity: useIdentityStore.getState(),
  policy: usePolicyStore.getState(),
  timeZone: useSettingsStore.getState().timeZone,
};
afterEach(() => {
  useAuthStore.setState(initial.auth, true);
  useVacationStore.setState(initial.vacation, true);
  useIdentityStore.setState(initial.identity, true);
  usePolicyStore.setState(initial.policy, true);
  useSettingsStore.setState({ timeZone: initial.timeZone });
});

async function openCard(library: VacationTemplate[], timeZone = 'Europe/Berlin') {
  const server = mockStalwartAccount('b', [], ['vacation'], {
    vacation: { fromDate: '2026-12-21T08:00:00Z', toDate: '2027-01-03T23:00:00Z', subject: 'Old', textBody: 'Old text' },
  });
  useSettingsStore.setState({ timeZone });
  usePolicyStore.setState({
    policy: { ...DEFAULT_POLICY, organisation: { ...DEFAULT_ORGANISATION_POLICY, vacationTemplates: { library } } },
  });
  useIdentityStore.setState({ identities: [{ id: 'i', name: 'Alice Example', email: 'alice@example.org' } as never] });
  useAuthStore.setState({ client: server.client as never, username: 'alice@example.org' });
  useVacationStore.setState({ isSupported: true });
  render(<VacationSettings />);
  await waitFor(() => expect(useVacationStore.getState().isLoading).toBe(false));
  await screen.findByText('status.label');
  return server;
}

/** Long enough for a save that was due to have started. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 1100)));

describe('out-of-office templates', () => {
  it('shows no picker when the organisation has no templates', async () => {
    await openCard([]);
    expect(screen.queryByTestId('vacation-template-picker')).toBeNull();
  });

  it('saves nothing until the deputy is filled in, then fills every placeholder', async () => {
    const server = await openCard([TEMPLATE]);
    fireEvent.change(screen.getByTestId('vacation-template-select'), { target: { value: 'holiday' } });
    await settle();
    expect(server.client.setVacationResponse).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText('message.body_placeholder') as HTMLTextAreaElement).value).toBe('Old text');

    // Applying without a deputy refuses and says why.
    fireEvent.click(screen.getByTestId('vacation-template-apply'));
    expect(screen.getByText('deputy_missing')).toBeTruthy();
    await settle();
    expect(server.client.setVacationResponse).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('vacation-template-deputy'), { target: { value: 'bob@example.org' } });
    await settle();
    expect(server.client.setVacationResponse).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('vacation-template-apply'));
    // ICU versions differ in commas, not in the day.
    const filled = (screen.getByPlaceholderText('message.body_placeholder') as HTMLTextAreaElement).value;
    expect(filled).toMatch(/^I am away until Monday,? 4 January 2027\.\nPlease write to bob@example\.org\.\nAlice Example$/);
    await waitFor(() => expect(server.client.setVacationResponse).toHaveBeenCalledTimes(1), { timeout: 3000 });
    const sent = server.client.setVacationResponse.mock.calls[0][0] as { subject: string; textBody: string };
    expect(sent.textBody).toBe(filled);
    expect(sent.subject).toMatch(/^Away until Monday,? 4 January 2027$/);
  });

  it('follows a time zone that arrives after the page opened, without saving or shifting the dates', async () => {
    const server = await openCard([], 'UTC');
    const inputs = () => document.querySelectorAll('input[type="datetime-local"]') as NodeListOf<HTMLInputElement>;
    expect(inputs()[1].value).toBe('2027-01-03T23:00');
    // Settings sync brings the user's zone a moment later.
    act(() => useSettingsStore.setState({ timeZone: 'Asia/Tokyo' }));
    expect(inputs()[1].value).toBe('2027-01-04T08:00');
    await settle();
    expect(server.client.setVacationResponse).not.toHaveBeenCalled();
    // An edit afterwards is read on the new clock.
    fireEvent.change(inputs()[0], { target: { value: '2026-12-22T09:00' } });
    await waitFor(() => expect(server.client.setVacationResponse).toHaveBeenCalled(), { timeout: 3000 });
    expect(server.client.setVacationResponse.mock.calls[0][0]).toMatchObject({ fromDate: '2026-12-22T00:00:00.000Z', toDate: '2027-01-03T23:00:00Z' });
  });

  it('shows and fills the dates in the time zone set in Bulwark, not the browser’s', async () => {
    await openCard([{ ...TEMPLATE, text: 'Back {end}', subject: '' }], 'Asia/Tokyo');
    const inputs = document.querySelectorAll('input[type="datetime-local"]');
    expect((inputs[0] as HTMLInputElement).value).toBe('2026-12-21T17:00');
    expect((inputs[1] as HTMLInputElement).value).toBe('2027-01-04T08:00');
    fireEvent.change(screen.getByTestId('vacation-template-select'), { target: { value: 'holiday' } });
    fireEvent.click(screen.getByTestId('vacation-template-apply'));
    expect((screen.getByPlaceholderText('message.body_placeholder') as HTMLTextAreaElement).value)
      .toMatch(/^Back Monday,? 4 January 2027 at 0?8:00$/);
  });
});
