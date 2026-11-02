import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const changed = vi.fn();
const stops = vi.fn(async () => true);
vi.mock('@/lib/vacation-calendar', async (original) => ({
  ...(await original<typeof import('@/lib/vacation-calendar')>()),
  vacationBlockChanged: (...args: unknown[]) => changed(...args),
  ownFilterScriptStops: () => stops(),
}));

import { VacationCalendarBlock, VacationFilterWarning } from '../vacation-calendar-block';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useVacationStore } from '@/stores/vacation-store';

const client = {
  supportsCalendars: () => true,
  supportsSieve: () => true,
  accountSupports: () => true,
  getSieveScripts: vi.fn(async () => []),
  getAccountId: () => 'alice',
  getAllCalendars: vi.fn(async () => [{ id: 'b', isDefault: true, myRights: { mayWriteAll: true } }]),
};

function lock(value: boolean | null) {
  const policy = usePolicyStore.getState().policy;
  usePolicyStore.setState({ policy: { ...policy, defaults: {}, restrictions: value === null ? {} : { vacationBlockCalendar: { locked: true, value } } } });
}

describe('VacationCalendarBlock', () => {
  beforeEach(() => {
    useAuthStore.setState({ client } as never);
    useSettingsStore.setState({ vacationBlockCalendar: true });
    useVacationStore.setState({ isEnabled: true, fromDate: '2026-12-01T08:00:00Z', toDate: '2026-12-05T17:00:00Z', subject: 'Away' });
  });
  afterEach(() => {
    lock(null);
    changed.mockClear();
    useAuthStore.setState({ client: null } as never);
  });

  it('is on by default once both dates are set, and syncs when switched off', async () => {
    const { rerender } = render(<VacationCalendarBlock hasDates={false} />);
    expect(screen.queryByTestId('vacation-block-calendar')).toBeNull();
    rerender(<VacationCalendarBlock hasDates />);
    const box = await screen.findByTestId('vacation-block-calendar') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(useSettingsStore.getState().vacationBlockCalendar).toBe(false);
    expect(changed).toHaveBeenCalledWith(client, undefined, { isEnabled: true, fromDate: '2026-12-01T08:00:00Z', toDate: '2026-12-05T17:00:00Z', subject: 'Away' });
  });

  it('shows the organisation\'s lock with its value and can\'t be changed', async () => {
    lock(false);
    render(<VacationCalendarBlock hasDates />);
    const box = await screen.findByTestId('vacation-block-calendar') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText('org_locked')).toBeInTheDocument();
    expect(box.closest('[inert]')).not.toBeNull();
  });

  it('shows what the sync does for a lock without a value, and nothing when hidden', async () => {
    const policy = usePolicyStore.getState().policy;
    usePolicyStore.setState({ policy: { ...policy, defaults: { vacationBlockCalendar: false }, restrictions: { vacationBlockCalendar: { locked: true } } } });
    const view = render(<VacationCalendarBlock hasDates />);
    expect(((await screen.findByTestId('vacation-block-calendar')) as HTMLInputElement).checked).toBe(false);
    view.unmount();
    usePolicyStore.setState({ policy: { ...policy, defaults: {}, restrictions: { vacationBlockCalendar: { hidden: true } } } });
    const hidden = render(<VacationCalendarBlock hasDates />);
    await waitFor(() => expect(client.getAllCalendars).toHaveBeenCalled());
    expect(hidden.container.querySelector('[data-testid="vacation-block-calendar"]')).toBeNull();
  });

  it('says a managed account\'s calendar can\'t be blocked without write access', async () => {
    client.getAllCalendars.mockResolvedValueOnce([{ id: 'boss:b', isDefault: true, isShared: true, accountId: 'boss', myRights: { mayWriteAll: false, mayWriteOwn: false } }] as never);
    render(<VacationCalendarBlock hasDates accountId="boss" />);
    expect(await screen.findByTestId('vacation-block-no-access')).toHaveTextContent('no_access_managed');
    expect(screen.queryByTestId('vacation-block-calendar')).toBeNull();
  });
});

describe('VacationFilterWarning', () => {
  afterEach(() => useAuthStore.setState({ client: null } as never));

  it('warns when the reply would switch off a filter script of the user\'s own', async () => {
    useAuthStore.setState({ client } as never);
    render(<VacationFilterWarning />);
    await waitFor(() => expect(screen.getByTestId('vacation-filter-warning')).toHaveTextContent('filter_warning'));
    stops.mockResolvedValueOnce(false);
    const other = render(<VacationFilterWarning accountId="boss" />);
    await waitFor(() => expect(stops).toHaveBeenCalledTimes(2));
    expect(other.container.querySelector('[data-testid="vacation-filter-warning"]')).toBeNull();
  });
});
