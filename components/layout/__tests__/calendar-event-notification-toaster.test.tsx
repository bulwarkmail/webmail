import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarEventNotification } from '@/lib/jmap/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}));
const info = vi.fn();
const warning = vi.fn();
vi.mock('@/stores/toast-store', () => ({ toast: { info: (...a: unknown[]) => info(...a), warning: (...a: unknown[]) => warning(...a) } }));

const { useCalendarEventNotificationStore } = await import('@/stores/calendar-event-notification-store');
const { CalendarEventNotificationToaster } = await import('../calendar-event-notification-toaster');

const note = (id: string, over: Partial<CalendarEventNotification> = {}): CalendarEventNotification => ({
  id,
  created: '2026-11-06T10:00:00Z',
  type: 'updated',
  calendarEventId: `e-${id}`,
  isDraft: false,
  changedBy: { name: 'Alice', email: 'alice@example.com' },
  event: { title: `Event ${id}` },
  ...over,
} as CalendarEventNotification);

const client = {
  supportsCalendars: () => true,
  getCalendarEventNotifications: async () => [],
  destroyCalendarEventNotifications: async () => {},
} as unknown as IJMAPClient;

function show(pending: CalendarEventNotification[]) {
  render(<CalendarEventNotificationToaster client={client} />);
  act(() => useCalendarEventNotificationStore.setState({ pending }));
}

beforeEach(() => {
  info.mockClear();
  warning.mockClear();
  useCalendarEventNotificationStore.setState({ pending: [] });
});

describe('CalendarEventNotificationToaster', () => {
  it('shows a few notifications one toast each', () => {
    show([note('1'), note('2'), note('3', { type: 'destroyed' })]);
    expect(info).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('sums up many at once in one toast (a script filled the calendars)', () => {
    show(Array.from({ length: 1680 }, (_, i) => note(String(i))));
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('summary {"count":1680}');
    expect(warning).not.toHaveBeenCalled();
  });

  it('does not count the user\'s own drafts', () => {
    show([note('1'), note('2'), note('3'), note('4', { isDraft: true }), note('5', { isDraft: true })]);
    expect(info).toHaveBeenCalledTimes(3);
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('summary'));
  });
});
